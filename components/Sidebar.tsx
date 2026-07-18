"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV = [
  { href: "/overview", label: "Overview" },
  { href: "/companies", label: "Companies" },
  { href: "/onboarding", label: "Onboarding" },
  { href: "/revenue", label: "Revenue" },
  { href: "/health", label: "DB / Ops health" },
  { href: "/reports", label: "Reports" },
  { href: "/configuration", label: "Configuration" },
];

export function Sidebar({ email }: { email: string | null }) {
  const pathname = usePathname();

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/40">
      <div className="px-5 py-5">
        <Link href="/projects" className="flex items-center gap-2">
          <div className="h-6 w-6 rounded-md bg-accent" />
          <span className="text-sm font-semibold tracking-tight text-zinc-100">
            Vellon Ops
          </span>
        </Link>
        <Link
          href="/projects"
          className="mt-1 block text-xs text-zinc-500 hover:text-zinc-300"
        >
          &larr; Projects
        </Link>
      </div>

      <nav className="flex-1 space-y-1 px-3">
        {NAV.map((item) => {
          const active =
            pathname === item.href || pathname.startsWith(item.href + "/");
          return (
            <Link
              key={item.href}
              href={item.href}
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
