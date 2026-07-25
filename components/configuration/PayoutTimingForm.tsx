"use client";

import { useEffect, useState, useTransition } from "react";
import {
  getPayoutConfig,
  updatePayoutConfig,
  type PayoutConfig,
  type PayoutPushSummary,
} from "@/app/(app)/configuration/actions";

const card = "rounded-xl border border-zinc-800 bg-zinc-900/40 p-6";
const input =
  "w-32 rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-accent";
const label = "block text-sm font-medium text-zinc-400";

function pushMessage(p: PayoutPushSummary): string {
  if (p.skipped) return "Saved. (Stripe not configured — existing accounts not updated.)";
  const parts: string[] = [];
  if (p.updated) parts.push(`${p.updated} account${p.updated === 1 ? "" : "s"} updated`);
  if (p.flooredToStripeMin)
    parts.push(`${p.flooredToStripeMin} set to Stripe's minimum (target was below the CA floor)`);
  if (p.failed) parts.push(`${p.failed} failed`);
  return parts.length ? `Saved. ${parts.join(", ")}.` : "Saved. No existing Stripe accounts to update.";
}

export function PayoutTimingForm() {
  const [config, setConfig] = useState<PayoutConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedMsg, setSavedMsg] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    getPayoutConfig().then((res) => {
      if (res.ok) setConfig(res.data);
      else setError(res.error);
    });
  }, []);

  function submit(f: FormData) {
    setError(null);
    setSavedMsg(null);
    startTransition(async () => {
      const res = await updatePayoutConfig({
        driverDelayDays: Number(f.get("driverDelayDays")),
        companyDelayDays: Number(f.get("companyDelayDays")),
      });
      if (!res.ok) return setError(res.error);
      setConfig(res.data.config);
      setSavedMsg(pushMessage(res.data.push));
    });
  }

  return (
    <div className="mt-10">
      <h2 className="text-lg font-semibold text-zinc-100">Payout timing</h2>
      <p className="mt-1 text-sm text-zinc-500">
        How many days Stripe holds funds before automatically paying out. Applied
        to new Connect accounts and pushed to existing ones on save. Stripe floors
        Canadian payouts at ~2&ndash;3 business days, so a value below that resolves
        to Stripe&apos;s minimum rather than zero.
      </p>

      {error && (
        <p className="mt-4 rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      {!config && !error && <p className="mt-6 text-sm text-zinc-500">Loading…</p>}

      {config && (
        <form
          className={`mt-6 max-w-lg space-y-5 ${card}`}
          onSubmit={(e) => {
            e.preventDefault();
            submit(new FormData(e.currentTarget));
          }}
        >
          <div className="space-y-1.5">
            <label className={label}>Driver payout delay (days)</label>
            <input
              name="driverDelayDays"
              type="number"
              min={0}
              max={31}
              step={1}
              defaultValue={config.driverDelayDays}
              className={input}
            />
            <p className="text-xs text-zinc-500">
              driver_direct drivers&apos; own Stripe accounts.
            </p>
          </div>
          <div className="space-y-1.5">
            <label className={label}>Company payout delay (days)</label>
            <input
              name="companyDelayDays"
              type="number"
              min={0}
              max={31}
              step={1}
              defaultValue={config.companyDelayDays}
              className={input}
            />
            <p className="text-xs text-zinc-500">
              company_settles taxi-company accounts. Set to 0 for the fastest
              Stripe allows.
            </p>
          </div>
          <div className="flex items-center gap-3 pt-1">
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save payout timing"}
            </button>
            {savedMsg && !pending && (
              <span className="text-xs text-emerald-400">{savedMsg}</span>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
