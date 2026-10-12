"use server";

import { requirePlatformOwner } from "@/lib/auth/guard";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit";
import { loadSpoke, spokeSupabase } from "@/lib/connectors/spoke";

export type PlatformSettings = {
  legalName: string | null;
  businessNumber: string | null;
  hstNumber: string | null;
  mailingAddress: string | null;
  paymentInstructions: string | null;
};

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

// NOTE: platform_settings is HUB-GLOBAL and deliberately takes no slug and no
// write gate. It holds Vellon's OWN legal name, business/HST numbers and
// payment instructions — the invoice letterhead — not anything derived from a
// spoke. Gating it on environment would only stop you editing Vellon's own
// details while a dev spoke happens to be selected, which protects nothing.
// This is not a missed Tier 1 gate; do not "fix" it into one.
export async function getPlatformSettings(): Promise<Result<PlatformSettings>> {
  await requirePlatformOwner();

  const { data, error } = await supabaseAdmin
    .from("platform_settings")
    .select("legal_name, business_number, hst_number, mailing_address, payment_instructions")
    .eq("id", 1)
    .maybeSingle();
  if (error) return { ok: false, error: error.message };

  return {
    ok: true,
    data: {
      legalName: data?.legal_name ?? null,
      businessNumber: data?.business_number ?? null,
      hstNumber: data?.hst_number ?? null,
      mailingAddress: data?.mailing_address ?? null,
      paymentInstructions: data?.payment_instructions ?? null,
    },
  };
}

export async function updatePlatformSettings(
  input: PlatformSettings,
): Promise<Result<PlatformSettings>> {
  const owner = await requirePlatformOwner();

  const { data: before } = await supabaseAdmin
    .from("platform_settings")
    .select("legal_name, business_number, hst_number, mailing_address, payment_instructions")
    .eq("id", 1)
    .maybeSingle();

  const after = {
    legal_name: input.legalName?.trim() || null,
    business_number: input.businessNumber?.trim() || null,
    hst_number: input.hstNumber?.trim() || null,
    mailing_address: input.mailingAddress?.trim() || null,
    payment_instructions: input.paymentInstructions?.trim() || null,
    updated_at: new Date().toISOString(),
    updated_by: owner.id,
  };

  const { error } = await supabaseAdmin
    .from("platform_settings")
    .update(after)
    .eq("id", 1);
  if (error) return { ok: false, error: error.message };

  await writeAudit({
    actorUserId: owner.id,
    action: "platform_settings.update",
    target: "platform_settings",
    before,
    after,
  });

  return { ok: true, data: input };
}

// ── Tax on Vellon's fee ──────────────────────────────────────────────
// The switch lives in the SPOKE (mgcj platform_fee_tax, migration
// 20261013000000): card capture reads it there, and so does ops_revenue, which
// the invoice generator sums. One switch per project, so dev can be
// "registered" for testing while prod is not. The hst_number above is only the
// number PRINTED on the document — it gates nothing.
//
// A spoke-only write, so no hub tier applies (lib/connectors/spoke.ts): a dev
// spoke's switch taxes dev rides and nothing else.

export type FeeTaxConfig = {
  /** 'YYYY-MM-DD' in Atlantic time, or null when the fee is not taxed. */
  registeredFromDate: string | null;
  /** True once that instant has passed. */
  active: boolean;
};

const ATLANTIC = "America/Halifax";

// 'YYYY-MM-DD' in Atlantic time for an instant.
function atlanticDate(iso: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: ATLANTIC,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

// The instant an Atlantic calendar day starts. The offset is read for that
// day rather than assumed: it is -03:00 in summer and -04:00 in winter.
function atlanticMidnight(date: string): string {
  const guess = new Date(`${date}T04:00:00Z`);
  const offset =
    new Intl.DateTimeFormat("en-CA", { timeZone: ATLANTIC, timeZoneName: "longOffset" })
      .formatToParts(guess)
      .find((p) => p.type === "timeZoneName")
      ?.value.replace("GMT", "") || "-04:00";
  return new Date(`${date}T00:00:00${offset}`).toISOString();
}

function toConfig(registeredFrom: string | null): FeeTaxConfig {
  return {
    registeredFromDate: registeredFrom ? atlanticDate(registeredFrom) : null,
    active: !!registeredFrom && new Date(registeredFrom).getTime() <= Date.now(),
  };
}

export async function getFeeTax(slug: string): Promise<Result<FeeTaxConfig>> {
  await requirePlatformOwner();
  const spoke = await loadSpoke(slug);
  const { data, error } = await spokeSupabase(spoke)
    .from("platform_fee_tax")
    .select("registered_from")
    .eq("id", 1)
    .maybeSingle();
  if (error) {
    return {
      ok: false,
      error:
        `Could not read the fee-tax switch on "${spoke.name}" (${error.message}). ` +
        `It needs mgcj migration 20261013000000_fee_tax.sql applied to that project.`,
    };
  }
  return { ok: true, data: toConfig((data?.registered_from as string | null) ?? null) };
}

export async function updateFeeTax(
  slug: string,
  input: { registeredFromDate: string | null },
): Promise<Result<FeeTaxConfig>> {
  const owner = await requirePlatformOwner();
  const spoke = await loadSpoke(slug);

  let registeredFrom: string | null = null;
  if (input.registeredFromDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.registeredFromDate)) {
      return { ok: false, error: "Enter the date as YYYY-MM-DD." };
    }
    registeredFrom = atlanticMidnight(input.registeredFromDate);
    if (Number.isNaN(new Date(registeredFrom).getTime())) {
      return { ok: false, error: "That is not a real date." };
    }
    // Production charges real companies real tax from this date, on documents
    // that must carry the number. Refuse to turn it on without one.
    if (spoke.environment === "prod") {
      const { data: settings } = await supabaseAdmin
        .from("platform_settings")
        .select("hst_number")
        .eq("id", 1)
        .maybeSingle();
      if (!settings?.hst_number) {
        return {
          ok: false,
          error: "Enter Vellon's GST/HST number above before turning fee tax on for production.",
        };
      }
    }
  }

  const mgcj = spokeSupabase(spoke);
  const { data: before } = await mgcj
    .from("platform_fee_tax")
    .select("registered_from")
    .eq("id", 1)
    .maybeSingle();

  const { error } = await mgcj.from("platform_fee_tax").upsert({
    id: 1,
    registered_from: registeredFrom,
    updated_at: new Date().toISOString(),
    updated_by: owner.id,
  });
  if (error) return { ok: false, error: error.message };

  await writeAudit({
    actorUserId: owner.id,
    projectSlug: spoke.slug,
    action: "platform_fee_tax.update",
    target: "platform_fee_tax",
    before,
    after: { registered_from: registeredFrom },
  });

  return { ok: true, data: toConfig(registeredFrom) };
}
