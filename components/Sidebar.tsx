"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

// Paths are relative to the spoke: every module now lives under /<slug>/.
const NAV = [
  { path: "overview", label: "Overview" },
  { path: "companies", label: "Companies" },
  { path: "onboarding", label: "Onboarding" },
  { path: "revenue", label: "Revenue" },
  { path: "health", label: "DB / Ops health" },
  { path: "reports", label: "Reports" },
  { path: "configuration", label: "Configuration" },
];

export function Sidebar({
  email,
  slug,
  projectName,
  environment,
}: {
  email: string | null;
  slug: string;
  projectName: string;
  environment: "prod" | "dev";
}) {
  const pathname = usePathname();
  const isDev = environment !== "prod";

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/40">
      <div className="px-5 py-5">
        <Link href="/projects" className="flex items-center gap-2">
          <div className="h-6 w-6 rounded-md bg-accent" />
          <span className="text-sm font-semibold tracking-tight text-zinc-100">
            Vellon Ops
          </span>
        </Link>
        {/* Which spoke you are looking at is load-bearing, not decoration:
            the modules below read and write a real customer database, and a
            dev spoke's numbers are indistinguishable from prod's at a glance. */}
        <div className="mt-2 flex items-center gap-2">
          <span className="truncate text-xs text-zinc-300">{projectName}</span>
          {isDev && (
            <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-400">
              {environment}
            </span>
          )}
        </div>
        <Link
          href="/projects"
          className="mt-1 block text-xs text-zinc-500 hover:text-zinc-300"
        >
          &larr; Projects
        </Link>
      </div>

      <nav className="flex-1 space-y-1 px-3">
        {NAV.map((item) => {
          const href = `/${slug}/${item.path}`;
          const active = pathname === href || pathname.startsWith(href + "/");
          return (
            <Link
              key={item.path}
              href={href}
              className={
                "block rounded-md px-3 py-2 text-sm transition-colors " +
                (active
                  ? "bg-zinc-800 text-zinc-100"
                  : "text-zinc-400 hover:bg-zinc-800/50 hover:text-zinc-200")
              }
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-zinc-800 p-3">
        <p className="truncate px-2 pb-2 text-xs text-zinc-500">{email}</p>
        <form action="/auth/signout" method="post">
          <button
            type="submit"
            className="w-full rounded-md px-3 py-2 text-left text-sm text-zinc-400 transition-colors hover:bg-zinc-800/50 hover:text-zinc-200"
          >
            Sign out
          </button>
        </form>
      </div>
    </aside>
  );
}
