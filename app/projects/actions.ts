"use server";

import { requirePlatformOwner } from "@/lib/auth/guard";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { writeAudit } from "@/lib/audit";

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export type ProjectRow = {
  id: string;
  name: string;
  slug: string;
  icon: string | null;
  color: string | null;
  status: string;
  dashboardUrl: string | null;
  environment: "prod" | "dev";
};

function dashboardUrlFrom(links: unknown): string | null {
  if (!links || typeof links !== "object") return null;
  const url = (links as Record<string, unknown>).dashboard;
  return typeof url === "string" ? url : null;
}

export async function listProjects(): Promise<ActionResult<ProjectRow[]>> {
  await requirePlatformOwner();

  const { data, error } = await supabaseAdmin
    .from("projects")
    .select("id, name, slug, icon, color, status, links, environment")
    .order("name", { ascending: true });
  if (error) return { ok: false, error: error.message };

  return {
    ok: true,
    data: (data ?? []).map((p) => ({
      id: p.id,
      name: p.name,
      slug: p.slug,
      icon: p.icon,
      color: p.color,
      status: p.status,
      dashboardUrl: dashboardUrlFrom(p.links),
      environment: (p.environment ?? "prod") as "prod" | "dev",
    })),
  };
}

export async function updateProject(input: {
  id: string;
  name: string;
  icon?: string | null;
  color?: string | null;
  dashboardUrl?: string | null;
}): Promise<ActionResult<{ id: string }>> {
  const owner = await requirePlatformOwner();

  const name = input.name.trim();
  if (!name) return { ok: false, error: "Name is required." };
  if (input.color && !/^#[0-9a-fA-F]{6}$/.test(input.color.trim()))
    return { ok: false, error: "Color must be a hex value, e.g. #E8500A." };

  const { data: before } = await supabaseAdmin
    .from("projects")
    .select("slug, name, icon, color, links")
    .eq("id", input.id)
    .maybeSingle();
  if (!before) return { ok: false, error: "Project not found." };

  const links: Record<string, unknown> = {
    ...((before.links as Record<string, unknown>) ?? {}),
  };
  const dashboardUrl = input.dashboardUrl?.trim();
  if (dashboardUrl) links.dashboard = dashboardUrl;
  else delete links.dashboard;

  const icon = input.icon?.trim() || null;
  const color = input.color?.trim() || null;

  const { error } = await supabaseAdmin
    .from("projects")
    .update({ name, icon, color, links })
    .eq("id", input.id);
  if (error) return { ok: false, error: error.message };

  await writeAudit({
    actorUserId: owner.id,
    projectSlug: before.slug,
    action: "project.update",
    target: input.id,
    before: {
      name: before.name,
      icon: before.icon,
      color: before.color,
      links: before.links,
    },
    after: { name, icon, color, links },
  });

  return { ok: true, data: { id: input.id } };
}
