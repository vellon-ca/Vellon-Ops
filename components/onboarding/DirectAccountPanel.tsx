"use client";

// The company's OWN Stripe account (direct charges), beside the older Express
// step in the onboarding wizard. Design:
// mgcj-app/.claude/notes/direct-charges-design.md (§3, §11).
//
// Vellon creates the account here; the owner fills in Stripe's form from the
// dispatch dashboard. There is no link to copy on purpose — a setup link lives
// five minutes, so one pasted into an email is dead before it is read.
//
// "Can take cards" and "gets paid out" are shown separately because Stripe
// decides them separately: cards went active the moment the form was
// submitted while payouts waited on an ID check.

import { useEffect, useState, useTransition } from "react";
import {
  createDirectAccount,
  getDirectAccountStatus,
  type DirectAccountStatus,
} from "@/app/(app)/[slug]/onboarding/actions";

function Row({ name, status }: { name: string; status: string | null }) {
  const tone =
    status === "active"
      ? "text-emerald-300"
      : status === "pending"
        ? "text-amber-300"
        : "text-red-300";
  return (
    <div className="flex items-center justify-between text-sm">
      <span className="text-zinc-400">{name}</span>
      <span className={tone}>{status ?? "not reported"}</span>
    </div>
  );
}

export function DirectAccountPanel({
  slug,
  companyId,
  companyName,
}: {
  slug: string;
  companyId: string;
  companyName: string;
}) {
  const [status, setStatus] = useState<DirectAccountStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function apply(
    res: Awaited<ReturnType<typeof getDirectAccountStatus>>,
  ) {
    if (!res.ok) return setError(res.error);
    setError(null);
    setStatus(res.data);
    setCheckedAt(new Date().toLocaleTimeString());
  }

  useEffect(() => {
    startTransition(async () => apply(await getDirectAccountStatus(slug, { companyId })));
  }, [slug, companyId]);

  return (
    <div className="space-y-3 rounded-md border border-zinc-800 p-3">
      <div>
        <p className="text-sm font-medium text-zinc-200">
          Card payments account (direct charges)
        </p>
        <p className="mt-1 text-xs text-zinc-500">
          {companyName}&apos;s own Stripe account: it is the merchant, Stripe
          bills it for processing, and Vellon receives only its fee. Not used
          for charges until cutover — the step above still runs today&apos;s
          card flow.
        </p>
      </div>

      {status && !status.accountId && (
        <>
          <p className="text-xs text-amber-300/80">
            Who pays Stripe&apos;s fees and who owns a negative balance are
            fixed when the account is created and cannot be changed.
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () =>
                apply(await createDirectAccount(slug, { companyId })),
              )
            }
            className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
          >
            {pending ? "Creating…" : "Create card payments account"}
          </button>
        </>
      )}

      {status?.accountId && (
        <>
          <code className="block font-mono text-xs text-zinc-400">{status.accountId}</code>
          <Row name="Taking card payments" status={status.card} />
          <Row name="Payouts to their bank" status={status.payouts} />
          <div className="flex items-center justify-between text-sm">
            <span className="text-zinc-400">Statement descriptor</span>
            <span className="text-zinc-300">
              {status.statementDescriptor ?? "not set yet"}
            </span>
          </div>
          {status.outstanding.length > 0 && (
            <div>
              <p className="text-xs text-zinc-500">Stripe still needs from the owner</p>
              <ul className="mt-1 space-y-0.5 font-mono text-xs text-zinc-400">
                {status.outstanding.map((o) => (
                  <li key={o}>{o}</li>
                ))}
              </ul>
            </div>
          )}
          <p className="text-xs text-zinc-500">
            The owner finishes Stripe&apos;s form from the dispatch dashboard:
            Settings → Card payments. There is no link to send — it would
            expire in five minutes.
          </p>
          <button
            type="button"
            disabled={pending}
            onClick={() =>
              startTransition(async () =>
                apply(await getDirectAccountStatus(slug, { companyId })),
              )
            }
            className="w-full rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800/50 disabled:opacity-50"
          >
            {pending ? "Checking…" : "Check status"}
            {checkedAt && !pending && (
              <span className="ml-2 text-zinc-600">(checked {checkedAt})</span>
            )}
          </button>
        </>
      )}

      {!status && !error && <p className="text-xs text-zinc-500">Loading…</p>}
      {error && <p className="text-xs text-red-300">{error}</p>}
    </div>
  );
}
