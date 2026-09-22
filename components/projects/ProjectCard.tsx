"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { updateProject, type ProjectRow } from "@/app/projects/actions";

const DEFAULT_COLOR = "#E8500A";

export function ProjectCard({ project }: { project: ProjectRow }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState(project.name);
  const [icon, setIcon] = useState(project.icon ?? "");
  const [color, setColor] = useState(project.color ?? DEFAULT_COLOR);
  const [dashboardUrl, setDashboardUrl] = useState(project.dashboardUrl ?? "");

  function cancel() {
    setName(project.name);
    setIcon(project.icon ?? "");
    setColor(project.color ?? DEFAULT_COLOR);
    setDashboardUrl(project.dashboardUrl ?? "");
    setError(null);
    setEditing(false);
  }

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await updateProject({
        id: project.id,
        name,
        icon,
        color,
        dashboardUrl,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setEditing(false);
      router.refresh();
    });
  }

  if (editing) {
    return (
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <div className="space-y-3">
          {error && (
            <p className="rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-300">
              {error}
            </p>
          )}

          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-400">
              Name
            </label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-accent"
            />
          </div>

          <div className="flex gap-3">
            <div className="w-20">
              <label className="mb-1 block text-xs font-medium text-zinc-400">
                Icon
              </label>
              <input
                value={icon}
                onChange={(e) => setIcon(e.target.value)}
                placeholder="🚕"
                maxLength={4}
                className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-center text-sm text-zinc-100 outline-none focus:border-accent"
              />
            </div>
            <div className="flex-1">
              <label className="mb-1 block text-xs font-medium text-zinc-400">
                Color
              </label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={/^#[0-9a-fA-F]{6}$/.test(color) ? color : DEFAULT_COLOR}
                  onChange={(e) => setColor(e.target.value)}
                  className="h-8 w-8 shrink-0 cursor-pointer rounded border border-zinc-800 bg-zinc-950 p-0.5"
                />
                <input
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                  placeholder={DEFAULT_COLOR}
                  className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-accent"
                />
              </div>
            </div>
          </div>

          <div>
            <label className="mb-1 block text-xs font-medium text-zinc-400">
              Dashboard URL
            </label>
            <input
              value={dashboardUrl}
              onChange={(e) => setDashboardUrl(e.target.value)}
              placeholder="https://…"
              className="w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-1.5 text-sm text-zinc-100 outline-none focus:border-accent"
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={cancel}
              disabled={pending}
              className="rounded-md px-3 py-1.5 text-sm text-zinc-400 transition-colors hover:bg-zinc-800/50 hover:text-zinc-200 disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={pending}
              className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="group relative rounded-xl border border-zinc-800 bg-zinc-900/50 p-5 transition-colors hover:border-zinc-700 hover:bg-zinc-900">
      <button
        type="button"
        onClick={() => setEditing(true)}
        aria-label="Edit project"
        className="absolute right-3 top-3 rounded-md p-1.5 text-zinc-600 opacity-0 transition-opacity hover:bg-zinc-800 hover:text-zinc-300 group-hover:opacity-100"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M12 20h9" />
          <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z" />
        </svg>
      </button>

      <Link
        href={`/${project.slug}/overview`}
        className="flex items-center gap-3 pr-6"
      >
        <div
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-lg"
          style={{ backgroundColor: project.color || DEFAULT_COLOR }}
        >
          {project.icon}
        </div>
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-zinc-100">
            {project.name}
          </p>
          <p className="truncate text-xs text-zinc-500">{project.slug}</p>
        </div>
      </Link>

      <div className="mt-3 flex items-center gap-3">
        {/* A dev spoke reads a different customer database. Its revenue and
            ride counts look exactly as real as prod's, so the distinction has
            to be visible before you click in, not only after. */}
        {project.environment !== "prod" && (
          <span className="inline-block rounded-full bg-amber-500/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-400">
            {project.environment}
          </span>
        )}
        {project.status !== "active" && (
          <span className="inline-block rounded-full border border-zinc-700 px-2 py-0.5 text-[10px] uppercase tracking-wide text-zinc-500">
            {project.status}
          </span>
        )}
        {project.dashboardUrl && (
          <a
            href={project.dashboardUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-zinc-500 hover:text-zinc-300"
          >
            Dashboard ↗
          </a>
        )}
      </div>
    </div>
  );
}
