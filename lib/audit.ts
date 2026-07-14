import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";

// Append an immutable record of a mutating platform-owner action to the
// vellon-ops audit_log. Best-effort: a logging failure must never block or
// undo the action it describes, so we swallow (but console.error) errors.
export async function writeAudit(entry: {
  actorUserId: string;
  projectSlug?: string;
  action: string;
  target?: string;
  before?: unknown;
  after?: unknown;
}) {
  try {
    let projectId: string | null = null;
    if (entry.projectSlug) {
      const { data } = await supabaseAdmin
        .from("projects")
        .select("id")
        .eq("slug", entry.projectSlug)
        .maybeSingle();
      projectId = data?.id ?? null;
    }

    await supabaseAdmin.from("audit_log").insert({
      actor_user_id: entry.actorUserId,
      project_id: projectId,
      action: entry.action,
      target: entry.target ?? null,
      before: entry.before ?? null,
      after: entry.after ?? null,
    });
  } catch (e) {
    console.error("[audit] failed to write audit_log entry:", e);
  }
}
