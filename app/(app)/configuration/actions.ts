"use server";

import { requirePlatformOwner } from "@/lib/auth/guard";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit";

export type PlatformSettings = {
  legalName: string | null;
  businessNumber: string | null;
  hstNumber: string | null;
  mailingAddress: string | null;
  paymentInstructions: string | null;
};

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

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
