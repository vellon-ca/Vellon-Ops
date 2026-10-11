"use server";

import { headers } from "next/headers";
import { requirePlatformOwner } from "@/lib/auth/guard";
import {
  loadSpoke,
  spokeSupabase,
  spokeStripePost,
  spokeStripeGet,
  spokeStripeConfigured,
  spokeStripeV2Get,
  spokeStripeV2Post,
  type Spoke,
} from "@/lib/connectors/spoke";
import { writeAudit } from "@/lib/audit";
import {
  validateSlug,
  validateSuffix,
  validateTaxRate,
  validateTaxLabel,
} from "@/lib/companyIdentity";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; duplicate?: boolean };

// ── Step 1: create company ──────────────────────────────────────────
export async function createCompany(
  slug: string,
  input: {
  name: string;
  platformFeePercent: number;
  baseFare: number;
  ratePerKm: number;
  hstNumber?: string;
  billingEmail?: string;
  billingAddress?: string;
  studentDiscountEnabled: boolean;
  studentDiscountPct?: number;
  // Optional. Blank -> derived from the name by mgcj's trg_set_company_slug.
  // Supplied -> used verbatim, because the slug is what the mobile build's
  // COMPANY_SLUG resolves against.
  slug?: string;
  // Set true to bypass the same-name guard (a genuinely distinct company that
  // happens to share a name with an existing one).
  force?: boolean;
  },
): Promise<ActionResult<{ companyId: string; name: string }>> {
  const owner = await requirePlatformOwner();

  const name = input.name.trim();
  if (!name) return { ok: false, error: "Company name is required." };
  if (input.platformFeePercent < 0 || input.platformFeePercent > 100)
    return { ok: false, error: "Platform fee must be between 0 and 100%." };
  if (input.baseFare < 0 || input.ratePerKm < 0)
    return { ok: false, error: "Fare values can't be negative." };

  const spoke = await loadSpoke(slug);
  const mgcj = spokeSupabase(spoke);

  // Soft duplicate-name guard. The companies list is the real defence against
  // accidental re-onboarding (resume instead of restart); this just catches a
  // fresh run against a name that already exists so it isn't done blindly.
  if (!input.force) {
    const { data: existing } = await mgcj
      .from("companies")
      .select("id, name")
      .ilike("name", name)
      .limit(1)
      .maybeSingle();
    if (existing)
      return {
        ok: false,
        duplicate: true,
        error: `A company named "${existing.name}" already exists. Resume it from the list below, or choose "Create anyway" if this is a separate company.`,
      };
  }

  // The slug is OPTIONAL here and that is deliberate. Left empty, mgcj's
  // trg_set_company_slug derives it from the name — which is what stops this
  // INSERT failing with 23502, as it did from 20260929050000 until
  // 20261001010000 (the column was made NOT NULL and backfilled, but a backfill
  // is not a default). Supplied, it wins: the slug is what src/lib/brand.ts's
  // COMPANY_SLUG resolves against, so for a company getting its own app build it
  // should be chosen rather than derived from "M & G Cab Ltd".
  const companySlug = input.slug?.trim().toLowerCase() || undefined;
  const slugError = validateSlug(companySlug ?? "");
  if (slugError) return { ok: false, error: slugError };

  const { data, error } = await mgcj
    .from("companies")
    .insert({
      name,
      ...(companySlug ? { slug: companySlug } : {}),
      platform_fee_percent: input.platformFeePercent,
      base_fare: input.baseFare,
      rate_per_km: input.ratePerKm,
      hst_number: input.hstNumber?.trim() || null,
      billing_email: input.billingEmail?.trim() || null,
      billing_address: input.billingAddress?.trim() || null,
      student_discount_enabled: input.studentDiscountEnabled,
      student_discount_pct: input.studentDiscountEnabled
        ? (input.studentDiscountPct ?? 0)
        : 0,
      active: true,
      stripe_onboarded: false,
    })
    .select("id")
    .single();

  if (error || !data) {
    // The unique index is on lower(slug), so a chosen slug can collide with a
    // company created earlier. 23505 here is a naming clash, not a fault.
    if (error?.code === "23505")
      return {
        ok: false,
        error: `The slug "${companySlug}" is already taken by another company. Choose a different one, or leave it blank to have one derived.`,
      };
    return { ok: false, error: error?.message ?? "Failed to create company." };
  }

  await writeAudit({
    actorUserId: owner.id,
    projectSlug: spoke.slug,
    action: "company.create",
    target: data.id,
    after: { name, platform_fee_percent: input.platformFeePercent },
  });

  return { ok: true, data: { companyId: data.id, name } };
}

// ── Step 2: create the company's admin (email-OTP, vendor-provisioned) ──
// EMAIL, not phone, since 2026-09-26 — Phase 1 of
// mgcj-app/.claude/notes/email-auth-design.md makes email the ONLY dispatch
// credential. No phone is collected: an admin-typed number is unverified, and
// writing it to profiles.phone would make phone_is_registered() /
// phone_is_dispatch() answer yes for a number nobody proved they hold.
// Admin accounts are a vendor-managed seat — Vellon provisions them here via
// service role, never self-serve — see mgcj-app's
// 20260715_dispatcher_role_split.sql / 20260716_dispatcher_only_management.sql.
// Every company needs exactly one to start; additional staff below this level
// are 'dispatcher' rows, which the admin themself provisions from the
// dashboard's own create-staff-account flow, and which this wizard can also
// optionally seed at onboarding time via createDispatchers.
export async function createAdmin(
  slug: string,
  input: {
  companyId: string;
  name: string;
  email: string;
  },
): Promise<ActionResult<{ userId: string }>> {
  const owner = await requirePlatformOwner();

  const name = input.name.trim();
  // Lowercased: GoTrue normalizes the credential, and email_is_dispatch()
  // compares case-insensitively, so the profiles copy must match.
  const email = input.email.trim().toLowerCase();
  if (!name) return { ok: false, error: "Admin name is required." };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return { ok: false, error: "Enter a valid email address." };

  const spoke = await loadSpoke(slug);
  const mgcj = spokeSupabase(spoke);

  // Idempotent: if this company already has an admin (e.g. a resumed run, or a
  // step recomputed wrong), return that one instead of trying to create a
  // second auth user — auth.admin.createUser hard-errors on a duplicate email
  // exactly as it did on a duplicate phone.
  const { data: existingAdmin } = await mgcj
    .from("profiles")
    .select("id, name")
    .eq("company_id", input.companyId)
    .eq("role", "admin")
    .limit(1)
    .maybeSingle();
  if (existingAdmin) return { ok: true, data: { userId: existingAdmin.id } };

  // email_confirm: true is what makes the seat usable on day one — an
  // unconfirmed address cannot receive a sign-in code.
  // Announce the address to the mgcj signup gate before creating the account.
  // before_user_created rejects any email account creation with no unexpired
  // slip, and Supabase does not document whether that hook fires for the Admin
  // API — required if it does, harmless if it does not. Must precede createUser.
  const { error: aErr } = await mgcj.rpc("allow_staff_email", {
    p_email: email,
    p_note: "vellon-ops:createAdmin",
  });
  if (aErr) return { ok: false, error: aErr.message };

  const { data: created, error: cErr } = await mgcj.auth.admin.createUser({
    email,
    email_confirm: true,
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
      email,
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
    projectSlug: spoke.slug,
    action: "admin.create",
    target: created.user.id,
    after: { company_id: input.companyId, name, email },
  });

  return { ok: true, data: { userId: created.user.id } };
}

// ── Step 3 (optional): seed dispatcher accounts ─────────────────────
// Day-to-day dispatch staff, distinct from the admin seat above — can
// configure day-to-day dispatch (rides, drivers, announcements) but not
// company pricing/config or other staff (see mgcj-app's
// 20260715_dispatcher_role_split.sql). Normally an admin provisions these
// themselves from the dashboard (create-staff-account Edge Function); this
// just lets Vellon seed the first few at onboarding time so the company isn't
// stuck with one login. Entirely optional — a company with only an admin is a
// valid, complete onboarding.
export type DispatcherResult = { userId: string; name: string; email: string };

export async function createDispatchers(
  slug: string,
  input: {
  companyId: string;
  dispatchers: { name: string; email: string }[];
  },
): Promise<ActionResult<{ created: DispatcherResult[] }>> {
  const owner = await requirePlatformOwner();

  const dispatchers = input.dispatchers
    .map((d) => ({ name: d.name.trim(), email: d.email.trim().toLowerCase() }))
    .filter((d) => d.name && d.email);
  if (dispatchers.length === 0) return { ok: true, data: { created: [] } };
  for (const d of dispatchers) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(d.email))
      return { ok: false, error: `Invalid email: ${d.email}` };
  }

  const spoke = await loadSpoke(slug);
  const mgcj = spokeSupabase(spoke);
  const created: DispatcherResult[] = [];

  for (const d of dispatchers) {
    // Same signup-gate slip as createAdmin above, once per seat.
    const { error: aErr } = await mgcj.rpc("allow_staff_email", {
      p_email: d.email,
      p_note: "vellon-ops:createDispatchers",
    });
    if (aErr) return { ok: false, error: aErr.message };

    const { data: user, error: cErr } = await mgcj.auth.admin.createUser({
      email: d.email,
      email_confirm: true,
    });
    if (cErr || !user.user)
      return { ok: false, error: cErr?.message ?? `Failed to create account for ${d.email}.` };

    const { error: pErr } = await mgcj.from("profiles").upsert(
      {
        id: user.user.id,
        role: "dispatcher",
        company_id: input.companyId,
        name: d.name,
        email: d.email,
        is_active: true,
      },
      { onConflict: "id" },
    );
    if (pErr) {
      await mgcj.auth.admin.deleteUser(user.user.id);
      return { ok: false, error: pErr.message };
    }

    created.push({ userId: user.user.id, name: d.name, email: d.email });
  }

  await writeAudit({
    actorUserId: owner.id,
    projectSlug: spoke.slug,
    action: "dispatcher.create",
    target: input.companyId,
    after: { count: created.length, dispatchers: created },
  });

  return { ok: true, data: { created } };
}

// ── Step 4: mint driver invite codes ────────────────────────────────
function genCode() {
  // Unambiguous uppercase set (no 0/O/1/I).
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < 8; i++)
    out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

export type InviteResult = { code: string; phone: string; name: string | null };

export async function addInvites(
  slug: string,
  input: {
  companyId: string;
  // Each invite is tied to a specific driver phone (driver_invites.phone is NOT
  // NULL and is matched against the phone at driver signup).
  drivers: { name?: string; phone: string }[];
  createdBy?: string | null;
  },
): Promise<ActionResult<{ invites: InviteResult[] }>> {
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

  const spoke = await loadSpoke(slug);
  const mgcj = spokeSupabase(spoke);
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
    projectSlug: spoke.slug,
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

// Mint a fresh Stripe hosted-onboarding link. Account links are single-use and
// expire quickly, so we always generate a new one at the moment it's needed
// rather than storing/reusing a stale URL.
async function mintAccountLink(
  spoke: Spoke,
  accountId: string,
): Promise<string | null> {
  const origin =
    (await headers()).get("origin") ??
    process.env.NEXT_PUBLIC_APP_URL ??
    "http://localhost:3000";
  const link = await spokeStripePost(spoke, "/account_links", {
    account: accountId,
    refresh_url: `${origin}/${spoke.slug}/onboarding`,
    return_url: `${origin}/${spoke.slug}/onboarding`,
    type: "account_onboarding",
  });
  if (link.error) return null;
  return link.url ?? null;
}

// Create the Express account + an onboarding link. Stamps stripe_account_id on
// the company immediately (stripe_onboarded stays false, so no funds route yet).
export async function startStripeOnboarding(
  slug: string,
  input: {
  companyId: string;
  },
): Promise<ActionResult<StripeStatus>> {
  const owner = await requirePlatformOwner();
  if (!spokeStripeConfigured(await loadSpoke(slug)))
    return { ok: false, error: "Stripe secret key not configured." };

  const spoke = await loadSpoke(slug);
  const mgcj = spokeSupabase(spoke);
  const { data: company } = await mgcj
    .from("companies")
    .select("name, stripe_account_id")
    .eq("id", input.companyId)
    .maybeSingle();
  if (!company) return { ok: false, error: "Company not found." };

  // Reuse an existing account if the step is being re-run.
  let accountId = company.stripe_account_id as string | null;
  if (!accountId) {
    const acct = await spokeStripePost(spoke, "/accounts", {
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
      projectSlug: spoke.slug,
      action: "stripe.account_create",
      target: input.companyId,
      after: { stripe_account_id: accountId },
    });
  }

  const onboardingUrl = await mintAccountLink(spoke, accountId!);
  if (!onboardingUrl)
    return { ok: false, error: "Stripe link create failed." };

  return {
    ok: true,
    data: {
      accountId: accountId!,
      onboardingUrl,
      chargesEnabled: false,
      payoutsEnabled: false,
      detailsSubmitted: false,
    },
  };
}

// Poll Stripe for the account's readiness; flip stripe_onboarded once charges
// are enabled (the gate all three payment functions key off). If it isn't ready
// yet, mint a *fresh* onboarding link so the caller (Check status, or a resumed
// run) always has a live link to hand the company — never a blanked-out field.
export async function refreshStripeStatus(
  slug: string,
  input: {
  companyId: string;
  },
): Promise<ActionResult<StripeStatus>> {
  const owner = await requirePlatformOwner();

  const spoke = await loadSpoke(slug);
  const mgcj = spokeSupabase(spoke);
  const { data: company } = await mgcj
    .from("companies")
    .select("stripe_account_id, stripe_onboarded")
    .eq("id", input.companyId)
    .maybeSingle();
  if (!company?.stripe_account_id)
    return { ok: false, error: "No Stripe account for this company yet." };

  const acct = await spokeStripeGet(spoke, `/accounts/${company.stripe_account_id}`);
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
      projectSlug: spoke.slug,
      action: "stripe.onboarded",
      target: input.companyId,
      after: { stripe_onboarded: true },
    });
  }

  return {
    ok: true,
    data: {
      accountId: company.stripe_account_id,
      onboardingUrl: chargesEnabled
        ? null
        : await mintAccountLink(spoke, company.stripe_account_id),
      chargesEnabled,
      payoutsEnabled: !!acct.payouts_enabled,
      detailsSubmitted: !!acct.details_submitted,
    },
  };
}

// ── Direct charges: the company's OWN Stripe account ────────────────
// Design: mgcj-app/.claude/notes/direct-charges-design.md (§3, §11).
//
// Separate from the Express flow above, on separate columns
// (stripe_direct_*). The live card flow still routes transfers off
// stripe_account_id, so that flow and its columns stay as they are until
// cutover.
//
// This is the ONLY place the account is created. Who pays Stripe's fees and
// who owns a negative balance cannot be changed afterwards, so it is made
// once, here, with the decided configuration — never from the dashboard.
//
// No setup link is minted here. A link lives five minutes, so it cannot be
// sent to anyone; the owner opens the form from the dispatch dashboard
// (Settings → Card payments), which mints one on the click.
export type DirectAccountStatus = {
  accountId: string | null;
  // Stripe's capability words, verbatim ('active', 'pending', 'restricted', …).
  card: string | null;
  payouts: string | null;
  // What the owner still has to provide, as Stripe's requirement codes. Entries
  // Stripe is itself reviewing are left out, as in the dashboard.
  outstanding: string[];
  // What the cardholder's statement will read. Stripe takes it from the
  // website the owner types into the form, so check it once they are done.
  statementDescriptor: string | null;
};

const DIRECT_MIGRATION_MSG =
  "This project is missing mgcj-app migration 20261012000000_direct_charge_account.sql.";

type DirectCompany = {
  name: string;
  billing_email: string | null;
  stripe_direct_account_id: string | null;
  stripe_direct_card_status: string | null;
  stripe_direct_payouts_status: string | null;
};

async function loadDirectCompany(
  spoke: Spoke,
  companyId: string,
): Promise<{ company: DirectCompany } | { error: string }> {
  const { data, error } = await spokeSupabase(spoke)
    .from("companies")
    .select(
      "name, billing_email, stripe_direct_account_id, stripe_direct_card_status, stripe_direct_payouts_status",
    )
    .eq("id", companyId)
    .maybeSingle();
  if (error)
    return { error: error.code === "42703" ? DIRECT_MIGRATION_MSG : error.message };
  if (!data) return { error: "Company not found." };
  return { company: data as DirectCompany };
}

// Reads the account at Stripe and writes the two status columns when they have
// moved — the same sync the dashboard's company-card-setup function does, so a
// check from either side leaves the row current.
async function readDirectAccount(
  spoke: Spoke,
  companyId: string,
  company: DirectCompany,
): Promise<ActionResult<DirectAccountStatus>> {
  const accountId = company.stripe_direct_account_id!;
  // Capabilities and requirements come back ONLY when asked for with include=.
  const acct = await spokeStripeV2Get(
    spoke,
    `/v2/core/accounts/${encodeURIComponent(accountId)}` +
      "?include=configuration.merchant&include=requirements",
  );
  if (acct?.error)
    return { ok: false, error: acct.error.message ?? "Could not load the Stripe account." };

  const merchant = acct?.configuration?.merchant;
  const card: string | null = merchant?.capabilities?.card_payments?.status ?? null;
  const payouts: string | null =
    merchant?.capabilities?.stripe_balance?.payouts?.status ?? null;
  const entries: Array<{ description?: string; awaiting_action_from?: string }> =
    acct?.requirements?.entries ?? [];

  if (
    card !== company.stripe_direct_card_status ||
    payouts !== company.stripe_direct_payouts_status
  ) {
    await spokeSupabase(spoke)
      .from("companies")
      .update({
        stripe_direct_card_status: card,
        stripe_direct_payouts_status: payouts,
        stripe_direct_synced_at: new Date().toISOString(),
      })
      .eq("id", companyId);
  }

  return {
    ok: true,
    data: {
      accountId,
      card,
      payouts,
      outstanding: entries
        .filter((e) => e.awaiting_action_from !== "stripe")
        .map((e) => e.description)
        .filter((d): d is string => !!d),
      statementDescriptor: merchant?.statement_descriptor?.descriptor ?? null,
    },
  };
}

export async function getDirectAccountStatus(
  slug: string,
  input: { companyId: string },
): Promise<ActionResult<DirectAccountStatus>> {
  await requirePlatformOwner();
  const spoke = await loadSpoke(slug);
  if (!spokeStripeConfigured(spoke))
    return { ok: false, error: "Stripe secret key not configured." };

  const loaded = await loadDirectCompany(spoke, input.companyId);
  if ("error" in loaded) return { ok: false, error: loaded.error };
  if (!loaded.company.stripe_direct_account_id)
    return {
      ok: true,
      data: { accountId: null, card: null, payouts: null, outstanding: [], statementDescriptor: null },
    };
  return readDirectAccount(spoke, input.companyId, loaded.company);
}

export async function createDirectAccount(
  slug: string,
  input: { companyId: string },
): Promise<ActionResult<DirectAccountStatus>> {
  const owner = await requirePlatformOwner();
  const spoke = await loadSpoke(slug);
  if (!spokeStripeConfigured(spoke))
    return { ok: false, error: "Stripe secret key not configured." };

  const loaded = await loadDirectCompany(spoke, input.companyId);
  if ("error" in loaded) return { ok: false, error: loaded.error };
  const { company } = loaded;

  // Re-running the step reads the account that exists; it never makes a second.
  if (company.stripe_direct_account_id)
    return readDirectAccount(spoke, input.companyId, company);

  // Stripe writes to this address itself (it bills the company and chases
  // missing documents), so it is not guessed from a staff login.
  if (!company.billing_email)
    return {
      ok: false,
      error: "Set the company's billing email first — Stripe contacts the owner there.",
    };

  // The idempotency key is the company, so a double click, or a retry after
  // the write below failed, gets the SAME account back. A second account could
  // not be merged or reconfigured, only abandoned.
  const acct = await spokeStripeV2Post(
    spoke,
    "/v2/core/accounts",
    {
      display_name: company.name,
      contact_email: company.billing_email,
      // Config A: the company has a real Stripe login, Stripe bills it for
      // processing and owns its negative balances. Fixed at creation.
      dashboard: "full",
      identity: { country: "ca", entity_type: "company" },
      configuration: {
        merchant: {
          mcc: "4121", // taxicabs and limousines
          capabilities: { card_payments: { requested: true } },
        },
      },
      defaults: {
        currency: "cad",
        locales: ["en-CA"],
        profile: {
          doing_business_as: company.name,
          product_description:
            "Taxi service. Passengers pay their fare by card at the end of the ride.",
        },
        responsibilities: { fees_collector: "stripe", losses_collector: "stripe" },
      },
      metadata: { company_id: input.companyId },
    },
    `direct-account:${input.companyId}`,
  );
  if (acct?.error || !acct?.id)
    return { ok: false, error: acct?.error?.message ?? "Stripe account create failed." };

  const accountId = acct.id as string;
  const { error: writeError } = await spokeSupabase(spoke)
    .from("companies")
    .update({ stripe_direct_account_id: accountId })
    .eq("id", input.companyId)
    .is("stripe_direct_account_id", null);
  if (writeError)
    return {
      ok: false,
      error: `Stripe account ${accountId} was created but could not be saved: ${writeError.message}. Run the step again — it will return the same account.`,
    };

  await writeAudit({
    actorUserId: owner.id,
    projectSlug: spoke.slug,
    action: "stripe.direct_account_create",
    target: input.companyId,
    after: { stripe_direct_account_id: accountId },
  });

  return readDirectAccount(spoke, input.companyId, {
    ...company,
    stripe_direct_account_id: accountId,
  });
}

// ── Companies list (completed + in-progress onboarding) ─────────────
// Onboarding progress is *derived* from mgcj's own tables — the source of
// truth — rather than tracked in a separate table that could drift. Each
// company's state falls out of what actually exists:
//   • company row              → step 0 done (always, if it's in this list)
//   • an admin profile         → admin created (required)
//   • dispatcher profiles      → dispatchers seeded (optional step)
//   • driver_invites rows      → invites minted (optional step)
//   • stripe_account_id        → Stripe onboarding started
//   • stripe_onboarded = true  → card-ready
export type CompanyRow = {
  id: string;
  name: string;
  adminName: string | null;
  dispatcherCount: number;
  inviteCount: number;
  stripeAccountId: string | null;
  stripeOnboarded: boolean;
};

export async function listCompanies(
  slug: string,
): Promise<ActionResult<CompanyRow[]>> {
  await requirePlatformOwner();
  const spoke = await loadSpoke(slug);
  const mgcj = spokeSupabase(spoke);

  const { data: companies, error } = await mgcj
    .from("companies")
    .select("id, name, stripe_account_id, stripe_onboarded")
    .order("name", { ascending: true });
  if (error) return { ok: false, error: error.message };
  if (!companies || companies.length === 0) return { ok: true, data: [] };

  const ids = companies.map((c) => c.id);

  // First admin per company (their name), dispatcher counts, and invite
  // counts. All small at this scale, so fetch the rows and fold in JS rather
  // than N round-trips.
  const [{ data: admins }, { data: dispatchers }, { data: invites }] = await Promise.all([
    mgcj
      .from("profiles")
      .select("company_id, name")
      .eq("role", "admin")
      .in("company_id", ids),
    mgcj
      .from("profiles")
      .select("company_id")
      .eq("role", "dispatcher")
      .in("company_id", ids),
    mgcj.from("driver_invites").select("company_id").in("company_id", ids),
  ]);

  const adminByCompany = new Map<string, string | null>();
  for (const a of admins ?? [])
    if (!adminByCompany.has(a.company_id))
      adminByCompany.set(a.company_id, a.name ?? null);

  const dispatcherCountByCompany = new Map<string, number>();
  for (const d of dispatchers ?? [])
    dispatcherCountByCompany.set(
      d.company_id,
      (dispatcherCountByCompany.get(d.company_id) ?? 0) + 1,
    );

  const inviteCountByCompany = new Map<string, number>();
  for (const inv of invites ?? [])
    inviteCountByCompany.set(
      inv.company_id,
      (inviteCountByCompany.get(inv.company_id) ?? 0) + 1,
    );

  const rows: CompanyRow[] = companies.map((c) => ({
    id: c.id,
    name: c.name,
    adminName: adminByCompany.get(c.id) ?? null,
    dispatcherCount: dispatcherCountByCompany.get(c.id) ?? 0,
    inviteCount: inviteCountByCompany.get(c.id) ?? 0,
    stripeAccountId: (c.stripe_account_id as string | null) ?? null,
    stripeOnboarded: !!c.stripe_onboarded,
  }));

  return { ok: true, data: rows };
}

// ── Company detail (Companies page edit modal + Onboarding resume) ──
export type CompanyDetail = CompanyRow & {
  platformFeePercent: number;
  baseFare: number;
  ratePerKm: number;
  hstNumber: string | null;
  billingEmail: string | null;
  billingAddress: string | null;
  // Vellon-owned, never dispatcher-editable: a typo in either edits a document
  // somebody relies on. `statementDescriptorSuffix` is what the passenger's bank
  // statement reads after "VELLON INC.*"; `taxRatePercent` is the rate frozen
  // onto each ride at completion and printed on the receipt.
  slug: string;
  statementDescriptorSuffix: string | null;
  taxRatePercent: number;
  /** What the tax is CALLED on documents — HST, GST, 'GST + QST'. */
  taxLabel: string;
};

export async function getCompanyForEdit(
  slug: string,
  companyId: string,
): Promise<ActionResult<CompanyDetail>> {
  await requirePlatformOwner();
  const spoke = await loadSpoke(slug);
  const mgcj = spokeSupabase(spoke);

  const { data: company, error } = await mgcj
    .from("companies")
    .select(
      "id, name, slug, platform_fee_percent, base_fare, rate_per_km, hst_number, billing_email, billing_address, statement_descriptor_suffix, tax_rate_percent, tax_label, stripe_account_id, stripe_onboarded",
    )
    .eq("id", companyId)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };
  if (!company) return { ok: false, error: "Company not found." };

  const [{ data: admin }, { count: dispatcherCount }, { count: inviteCount }] = await Promise.all([
    mgcj
      .from("profiles")
      .select("name")
      .eq("company_id", companyId)
      .eq("role", "admin")
      .limit(1)
      .maybeSingle(),
    mgcj
      .from("profiles")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId)
      .eq("role", "dispatcher"),
    mgcj
      .from("driver_invites")
      .select("id", { count: "exact", head: true })
      .eq("company_id", companyId),
  ]);

  return {
    ok: true,
    data: {
      id: company.id,
      name: company.name,
      adminName: admin?.name ?? null,
      dispatcherCount: dispatcherCount ?? 0,
      inviteCount: inviteCount ?? 0,
      stripeAccountId: (company.stripe_account_id as string | null) ?? null,
      stripeOnboarded: !!company.stripe_onboarded,
      platformFeePercent: Number(company.platform_fee_percent),
      baseFare: Number(company.base_fare),
      ratePerKm: Number(company.rate_per_km),
      hstNumber: company.hst_number,
      billingEmail: company.billing_email,
      billingAddress: company.billing_address,
      slug: company.slug as string,
      statementDescriptorSuffix:
        (company.statement_descriptor_suffix as string | null) ?? null,
      taxRatePercent: Number(company.tax_rate_percent),
      taxLabel: (company.tax_label as string | null) || "HST",
    },
  };
}

export async function updateCompany(
  slug: string,
  input: {
  companyId: string;
  name: string;
  platformFeePercent: number;
  baseFare: number;
  ratePerKm: number;
  hstNumber?: string;
  billingEmail?: string;
  billingAddress?: string;
  slug: string;
  statementDescriptorSuffix?: string;
  taxRatePercent: number;
  taxLabel: string;
  },
): Promise<ActionResult<{ companyId: string }>> {
  const owner = await requirePlatformOwner();

  const name = input.name.trim();
  if (!name) return { ok: false, error: "Company name is required." };
  if (input.platformFeePercent < 0 || input.platformFeePercent > 100)
    return { ok: false, error: "Platform fee must be between 0 and 100%." };
  if (input.baseFare < 0 || input.ratePerKm < 0)
    return { ok: false, error: "Fare values can't be negative." };

  // Each mirrors a database constraint, so the worst case is a 23514/23505 we
  // would otherwise surface as a raw Postgres string.
  const companySlug = input.slug.trim().toLowerCase();
  if (!companySlug) return { ok: false, error: "Slug is required." };
  const slugError = validateSlug(companySlug);
  if (slugError) return { ok: false, error: slugError };

  const suffix = input.statementDescriptorSuffix?.trim() || null;
  const suffixError = validateSuffix(suffix ?? "");
  if (suffixError) return { ok: false, error: suffixError };

  const taxError = validateTaxRate(input.taxRatePercent);
  if (taxError) return { ok: false, error: taxError };

  const taxLabel = input.taxLabel.trim();
  const taxLabelError = validateTaxLabel(taxLabel);
  if (taxLabelError) return { ok: false, error: taxLabelError };

  const spoke = await loadSpoke(slug);
  const mgcj = spokeSupabase(spoke);

  const { data: before } = await mgcj
    .from("companies")
    .select(
      "name, slug, platform_fee_percent, base_fare, rate_per_km, hst_number, billing_email, billing_address, statement_descriptor_suffix, tax_rate_percent, tax_label",
    )
    .eq("id", input.companyId)
    .maybeSingle();

  const after = {
    name,
    platform_fee_percent: input.platformFeePercent,
    base_fare: input.baseFare,
    rate_per_km: input.ratePerKm,
    hst_number: input.hstNumber?.trim() || null,
    billing_email: input.billingEmail?.trim() || null,
    billing_address: input.billingAddress?.trim() || null,
    slug: companySlug,
    statement_descriptor_suffix: suffix,
    tax_rate_percent: input.taxRatePercent,
    tax_label: taxLabel,
  };

  // Note what this does NOT do: renaming a company does not re-derive its slug or
  // its suffix. Both triggers are INSERT-only, on purpose — re-deriving the
  // suffix would change the statement line for card holds already authorised
  // under the old one, which is the value a passenger disputing a charge is
  // comparing against. If a rename should move them, it is an explicit edit here.
  const { error } = await mgcj
    .from("companies")
    .update(after)
    .eq("id", input.companyId);
  if (error) {
    if (error.code === "23505")
      return {
        ok: false,
        error: `The slug "${companySlug}" is already taken by another company.`,
      };
    return { ok: false, error: error.message };
  }

  await writeAudit({
    actorUserId: owner.id,
    projectSlug: spoke.slug,
    action: "company.update",
    target: input.companyId,
    before,
    after,
  });

  return { ok: true, data: { companyId: input.companyId } };
}
