"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { listCompanies, type CompanyRow } from "@/app/(app)/[slug]/onboarding/actions";
import { EditCompanyModal } from "./EditCompanyModal";

// The overall onboarding state a row is in, derived from its pieces.
function overallStatus(r: CompanyRow): { text: string; className: string } {
  if (!r.adminName)
    return {
      text: "Needs setup",
      className: "border-zinc-700 bg-zinc-800/40 text-zinc-300",
    };
  if (r.stripeOnboarded)
    return {
      text: "Fully ready",
      className: "border-emerald-900/40 bg-emerald-950/30 text-emerald-300",
    };
  return {
    text: "Cash-ready · Stripe pending",
    className: "border-amber-900/40 bg-amber-950/30 text-amber-300/90",
  };
}

function StripeCell({ r }: { r: CompanyRow }) {
  if (r.stripeOnboarded)
    return <span className="text-emerald-300">✅ Onboarded</span>;
  if (r.stripeAccountId)
    return <span className="text-amber-300/90">⏳ Pending</span>;
  return <span className="text-zinc-600">— not started</span>;
}

export function CompaniesDashboard({ slug }: { slug: string }) {
  const [rows, setRows] = useState<CompanyRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await listCompanies(slug);
    if (res.ok) {
      setRows(res.data);
      setError(null);
    } else {
      setError(res.error);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <h1 className="text-xl font-semibold text-zinc-100">Companies</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Every company in the mgcj backend — fee/fare/billing details, onboarding
        progress, and Stripe status.
      </p>

      {error && (
        <p className="mt-4 rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <div className="mt-4 overflow-x-auto rounded-xl border border-zinc-800">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-xs uppercase tracking-wide text-zinc-500">
              <th className="px-4 py-3 font-medium">Company</th>
              <th className="px-4 py-3 font-medium">Admin</th>
              <th className="px-4 py-3 font-medium">Dispatchers</th>
              <th className="px-4 py-3 font-medium">Drivers</th>
              <th className="px-4 py-3 font-medium">Stripe</th>
              <th className="px-4 py-3 font-medium">Status</th>
              <th className="px-4 py-3" />
            </tr>
          </thead>
          <tbody>
            {rows === null && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-zinc-500">
                  Loading…
                </td>
              </tr>
            )}
            {rows?.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-6 text-center text-zinc-500">
                  No companies yet.{" "}
                  <Link href="/onboarding" className="text-accent">
                    Onboard one →
                  </Link>
                </td>
              </tr>
            )}
            {rows?.map((r) => {
              const status = overallStatus(r);
              const incomplete = !(r.adminName && r.stripeOnboarded);
              return (
                <tr key={r.id} className="border-b border-zinc-900 last:border-0">
                  <td className="px-4 py-3 font-medium text-zinc-100">{r.name}</td>
                  <td className="px-4 py-3 text-zinc-400">
                    {r.adminName ? (
                      <span className="text-zinc-300">✅ {r.adminName}</span>
                    ) : (
                      <span className="text-zinc-600">— none yet</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-zinc-400">
                    {r.dispatcherCount > 0 ? (
                      `${r.dispatcherCount} dispatcher${r.dispatcherCount === 1 ? "" : "s"}`
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-zinc-400">
                    {r.inviteCount > 0 ? (
                      `${r.inviteCount} invite${r.inviteCount === 1 ? "" : "s"}`
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                  <td className="px-4 py-3">
                    <StripeCell r={r} />
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={
                        "inline-block rounded-full border px-2.5 py-0.5 text-xs " +
                        status.className
                      }
                    >
                      {status.text}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      {incomplete && (
                        <Link
                          href={`/onboarding?resume=${r.id}`}
                          className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800/50"
                        >
                          Resume onboarding →
                        </Link>
                      )}
                      <button
                        type="button"
                        onClick={() => setEditing(r.id)}
                        className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800/50"
                      >
                        Edit
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {editing && (
        <EditCompanyModal
          slug={slug}
          companyId={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
    </div>
  );
}
