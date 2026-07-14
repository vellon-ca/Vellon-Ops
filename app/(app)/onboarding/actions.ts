"use server";

import { headers } from "next/headers";
import { requirePlatformOwner } from "@/lib/auth/guard";
import {
  mgcjSupabase,
  stripePost,
  stripeGet,
  stripeConfigured,
} from "@/lib/connectors/mgcj";
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

// ── Step 4: Stripe Connect ──────────────────────────────────────────
export type StripeStatus = {
  accountId: string;
  onboardingUrl: string | null;
  chargesEnabled: boolean;
  payoutsEnabled: boolean;
  detailsSubmitted: boolean;
};

// Create the Express account + an onboarding link. Stamps stripe_account_id on
// the company immediately (stripe_onboarded stays false, so no funds route yet).
export async function startStripeOnboarding(input: {
  companyId: string;
}): Promise<ActionResult<StripeStatus>> {
  const owner = await requirePlatformOwner();
  if (!stripeConfigured())
    return { ok: false, error: "Stripe secret key not configured." };

  const mgcj = mgcjSupabase();
  const { data: company } = await mgcj
    .from("companies")
    .select("name, stripe_account_id")
    .eq("id", input.companyId)
    .maybeSingle();
  if (!company) return { ok: false, error: "Company not found." };

  // Reuse an existing account if the step is being re-run.
  let accountId = company.stripe_account_id as string | null;
  if (!accountId) {
    const acct = await stripePost("/accounts", {
      type: "express",
      country: "CA",
      "capabilities[card_payments][requested]": "true",
      "capabilities[transfers][requested]": "true",
      "business_profile[name]": company.name,
      "metadata[company_id]": input.companyId,
    });
    if (acct.error)
      return { ok: false, error: acct.error.message ?? "Stripe account create failed." };
    accountId = acct.id;

    await mgcj
      .from("companies")
      .update({ stripe_account_id: accountId, stripe_onboarded: false })
      .eq("id", input.companyId);

    await writeAudit({
      actorUserId: owner.id,
      projectSlug: "mgcj",
      action: "stripe.account_create",
      target: input.companyId,
      after: { stripe_account_id: accountId },
    });
  }

  const origin =
    (await headers()).get("origin") ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000";
  const link = await stripePost("/account_links", {
    account: accountId!,
    refresh_url: `${origin}/onboarding`,
    return_url: `${origin}/onboarding`,
    type: "account_onboarding",
  });
  if (link.error)
    return { ok: false, error: link.error.message ?? "Stripe link create failed." };

  return {
    ok: true,
    data: {
      accountId: accountId!,
      onboardingUrl: link.url,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
    },
  };
}

// Poll Stripe for the account's readiness; flip stripe_onboarded once charges
// are enabled (the gate all three payment functions key off).
export async function refreshStripeStatus(input: {
  companyId: string;
}): Promise<ActionResult<StripeStatus>> {
  const owner = await requirePlatformOwner();

  const mgcj = mgcjSupabase();
  const { data: company } = await mgcj
    .from("companies")
    .select("stripe_account_id, stripe_onboarded")
    .eq("id", input.companyId)
    .maybeSingle();
  if (!company?.stripe_account_id)
    return { ok: false, error: "No Stripe account for this company yet." };

  const acct = await stripeGet(`/accounts/${company.stripe_account_id}`);
  if (acct.error)
    return { ok: false, error: acct.error.message ?? "Could not load Stripe account." };

  const chargesEnabled = !!acct.charges_enabled;
  if (chargesEnabled && !company.stripe_onboarded) {
    await mgcj
      .from("companies")
      .update({ stripe_onboarded: true })
      .eq("id", input.companyId);
    await writeAudit({
      actorUserId: owner.id,
      projectSlug: "mgcj",
      action: "stripe.onboarded",
      target: input.companyId,
      after: { stripe_onboarded: true },
    });
  }

  return {
    ok: true,
    data: {
      accountId: company.stripe_account_id,
      onboardingUrl: null,
      chargesEnabled,
      payoutsEnabled: !!acct.payouts_enabled,
      detailsSubmitted: !!acct.details_submitted,
    },
  };
}
