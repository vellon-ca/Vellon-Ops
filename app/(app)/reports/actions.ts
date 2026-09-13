"use server";

import { requirePlatformOwner } from "@/lib/auth/guard";
import { mgcjSupabase } from "@/lib/connectors/mgcj";
import { writeAudit } from "@/lib/audit";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export type DispatchReport = {
  id: string;
  // Human-readable reference (mgcj 20260777), e.g. "DP-K7M4Q2". The prefix is
  // stored, so a ref names which of the three report tables it belongs to.
  reportRef: string;
  companyId: string;
  companyName: string;
  adminName: string | null;
  category: "bug" | "driver_issue" | "billing" | "feature_request" | "other";
  message: string;
  status: "open" | "resolved";
  createdAt: string;
};

export type TechnicalReport = {
  id: string;
  reportRef: string;
  reporterId: string;
  reporterName: string | null;
  reporterRole: "passenger" | "driver";
  companyId: string | null;
  companyName: string | null;
  rideId: string | null;
  category: "bug" | "payment" | "account" | "other";
  message: string;
  status: "open" | "resolved";
  createdAt: string;
};

export type Reports = {
  dispatch: DispatchReport[];
  technical: TechnicalReport[];
};

// Both tables are email-only at the source (Resend, on insert) — this is the
// only queryable view of either. technical_reports' RLS only lets a reporter
// read their own rows, so both reads go through the service-role connector.
export async function getReports(): Promise<ActionResult<Reports>> {
  await requirePlatformOwner();
  const mgcj = mgcjSupabase();

  const [{ data: dispatchRows, error: dErr }, { data: technicalRows, error: tErr }] =
    await Promise.all([
      mgcj
        .from("dispatch_reports")
        .select("id, report_ref, company_id, admin_id, category, message, status, created_at")
        .order("created_at", { ascending: false }),
      mgcj
        .from("technical_reports")
        .select(
          "id, report_ref, reporter_id, reporter_role, company_id, ride_id, category, message, status, created_at",
        )
        .order("created_at", { ascending: false }),
    ]);

  if (dErr) return { ok: false, error: dErr.message };
  if (tErr) return { ok: false, error: tErr.message };

  const companyIds = new Set<string>();
  for (const r of dispatchRows ?? []) companyIds.add(r.company_id);
  for (const r of technicalRows ?? []) if (r.company_id) companyIds.add(r.company_id);

  const profileIds = new Set<string>();
  for (const r of dispatchRows ?? []) profileIds.add(r.admin_id);
  for (const r of technicalRows ?? []) profileIds.add(r.reporter_id);

  const [{ data: companies }, { data: profiles }] = await Promise.all([
    companyIds.size > 0
      ? mgcj.from("companies").select("id, name").in("id", [...companyIds])
      : Promise.resolve({ data: [] as { id: string; name: string }[] }),
    profileIds.size > 0
      ? mgcj.from("profiles").select("id, name").in("id", [...profileIds])
      : Promise.resolve({ data: [] as { id: string; name: string | null }[] }),
  ]);

  const companyName = new Map((companies ?? []).map((c) => [c.id, c.name]));
  const profileName = new Map((profiles ?? []).map((p) => [p.id, p.name]));

  const dispatch: DispatchReport[] = (dispatchRows ?? []).map((r) => ({
    id: r.id,
    reportRef: r.report_ref,
    companyId: r.company_id,
    companyName: companyName.get(r.company_id) ?? "—",
    adminName: profileName.get(r.admin_id) ?? null,
    category: r.category,
    message: r.message,
    status: r.status,
    createdAt: r.created_at,
  }));

  const technical: TechnicalReport[] = (technicalRows ?? []).map((r) => ({
    id: r.id,
    reportRef: r.report_ref,
    reporterId: r.reporter_id,
    reporterName: profileName.get(r.reporter_id) ?? null,
    reporterRole: r.reporter_role,
    companyId: r.company_id,
    companyName: r.company_id ? (companyName.get(r.company_id) ?? "—") : null,
    rideId: r.ride_id,
    category: r.category,
    message: r.message,
    status: r.status,
    createdAt: r.created_at,
  }));

  return { ok: true, data: { dispatch, technical } };
}

export async function resolveReport(input: {
  source: "dispatch" | "technical";
  id: string;
}): Promise<ActionResult<{ id: string }>> {
  const owner = await requirePlatformOwner();
  const mgcj = mgcjSupabase();
  const table = input.source === "dispatch" ? "dispatch_reports" : "technical_reports";

  const { data: before } = await mgcj
    .from(table)
    .select("status")
    .eq("id", input.id)
    .maybeSingle();
  if (!before) return { ok: false, error: "Report not found." };
  if (before.status === "resolved") return { ok: true, data: { id: input.id } };

  const { error } = await mgcj
    .from(table)
    .update({ status: "resolved" })
    .eq("id", input.id);
  if (error) return { ok: false, error: error.message };

  await writeAudit({
    actorUserId: owner.id,
    projectSlug: "mgcj",
    action: `${input.source}_report.resolve`,
    target: input.id,
    before: { status: before.status },
    after: { status: "resolved" },
  });

  return { ok: true, data: { id: input.id } };
}
