"use server";

import { requirePlatformOwner } from "@/lib/auth/guard";
import { mgcjSupabase } from "@/lib/connectors/mgcj";
import { writeAudit } from "@/lib/audit";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

// ── Step 1: create company ──────────────────────────────────────────
export async function createCompany(input: {
  name: string;
  platformFeePercent: number;
  baseFare: number;
  ratePerKm: number;
  hstNumber?: string;
  studentDiscountEnabled: boolean;
  studentDiscountPct?: number;
}): Promise<ActionResult<{ companyId: string; name: string }>> {
  const owner = await requirePlatformOwner();

  const name = input.name.trim();
  if (!name) return { ok: false, error: "Company name is required." };
  if (input.platformFeePercent < 0 || input.platformFeePercent > 100)
    return { ok: false, error: "Platform fee must be between 0 and 100%." };
  if (input.baseFare < 0 || input.ratePerKm < 0)
    return { ok: false, error: "Fare values can't be negative." };

  const mgcj = mgcjSupabase();
  const { data, error } = await mgcj
    .from("companies")
    .insert({
      name,
      platform_fee_percent: input.platformFeePercent,
      base_fare: input.baseFare,
      rate_per_km: input.ratePerKm,
      hst_number: input.hstNumber?.trim() || null,
      student_discount_enabled: input.studentDiscountEnabled,
      student_discount_pct: input.studentDiscountEnabled
        ? (input.studentDiscountPct ?? 0)
        : 0,
      active: true,
      stripe_onboarded: false,
    })
    .select("id")
    .single();

  if (error || !data)
    return { ok: false, error: error?.message ?? "Failed to create company." };

  await writeAudit({
    actorUserId: owner.id,
    projectSlug: "mgcj",
    action: "company.create",
    target: data.id,
    after: { name, platform_fee_percent: input.platformFeePercent },
  });

  return { ok: true, data: { companyId: data.id, name } };
}

// ── Step 2: create first dispatcher (phone-OTP admin) ───────────────
export async function createDispatcher(input: {
  companyId: string;
  name: string;
  phone: string;
}): Promise<ActionResult<{ userId: string }>> {
  const owner = await requirePlatformOwner();

  const name = input.name.trim();
  const phone = input.phone.trim();
  if (!name) return { ok: false, error: "Dispatcher name is required." };
  if (!/^\+[1-9]\d{7,14}$/.test(phone))
    return { ok: false, error: "Phone must be E.164 format, e.g. +19025551234." };

  const mgcj = mgcjSupabase();

  const { data: created, error: cErr } = await mgcj.auth.admin.createUser({
    phone,
    phone_confirm: true,
  });
  if (cErr || !created.user)
    return { ok: false, error: cErr?.message ?? "Failed to create auth user." };

  // Upsert is correct whether or not a handle_new_user trigger already made a
  // (passenger-default) profile row — it forces role=admin + company scope.
  const { error: pErr } = await mgcj.from("profiles").upsert(
    {
      id: created.user.id,
      role: "admin",
      company_id: input.companyId,
      name,
      phone,
      is_active: true,
    },
    { onConflict: "id" },
  );
  if (pErr) {
    // Roll back the orphaned auth user so a retry is clean.
    await mgcj.auth.admin.deleteUser(created.user.id);
    return { ok: false, error: pErr.message };
  }

  await writeAudit({
    actorUserId: owner.id,
    projectSlug: "mgcj",
    action: "dispatcher.create",
    target: created.user.id,
    after: { company_id: input.companyId, name, phone },
  });

  return { ok: true, data: { userId: created.user.id } };
}

// ── Step 3: mint driver invite codes ────────────────────────────────
function genCode() {
  // Unambiguous uppercase set (no 0/O/1/I).
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++)
    out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export type InviteResult = { code: string; phone: string; name: string | null };

export async function addInvites(input: {
  companyId: string;
  // Each invite is tied to a specific driver phone (driver_invites.phone is NOT
  // NULL and is matched against the phone at driver signup).
  drivers: { name?: string; phone: string }[];
  createdBy?: string | null;
}): Promise<ActionResult<{ invites: InviteResult[] }>> {
  const owner = await requirePlatformOwner();

  const drivers = input.drivers
    .map((d) => ({ name: d.name?.trim() || null, phone: d.phone.trim() }))
    .filter((d) => d.phone);
  if (drivers.length === 0)
    return { ok: false, error: "Add at least one driver phone number." };
  for (const d of drivers) {
    if (!/^\+[1-9]\d{7,14}$/.test(d.phone))
      return { ok: false, error: `Invalid phone: ${d.phone} (use E.164, e.g. +19025551234).` };
  }

  const mgcj = mgcjSupabase();
  const invites: InviteResult[] = [];

  for (const d of drivers) {
    // Retry on the rare unique-code collision (23505).
    let inserted = false;
    for (let attempt = 0; attempt < 5 && !inserted; attempt++) {
      const code = genCode();
      const { error } = await mgcj.from("driver_invites").insert({
        code,
        company_id: input.companyId,
        phone: d.phone,
        name: d.name,
        used: false,
        created_by: input.createdBy ?? null,
      });
      if (!error) {
        invites.push({ code, phone: d.phone, name: d.name });
        inserted = true;
      } else if (error.code !== "23505") {
        return { ok: false, error: error.message };
      }
    }
    if (!inserted)
      return { ok: false, error: "Could not generate a unique invite code." };
  }

  await writeAudit({
    actorUserId: owner.id,
    projectSlug: "mgcj",
    action: "invites.create",
    target: input.companyId,
    after: { count: invites.length, invites },
  });

  return { ok: true, data: { invites } };
}
