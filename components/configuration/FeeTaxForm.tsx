"use client";

import { useEffect, useState, useTransition } from "react";
import {
  getFeeTax,
  updateFeeTax,
  type FeeTaxConfig,
} from "@/app/(app)/[slug]/configuration/actions";

const card = "mt-8 rounded-xl border border-zinc-800 bg-zinc-900/40 p-6";
const input =
  "rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-accent";
const label = "block text-sm font-medium text-zinc-400";

// Whether Vellon's OWN fee carries GST/HST on this project, and from when.
// Per project (it lives in the spoke's platform_fee_tax table) so dev can be
// "registered" for testing while prod is not. The registration NUMBER is the
// HST number field above — hub-global, and only what gets printed.
export function FeeTaxForm({ slug }: { slug: string }) {
  const [config, setConfig] = useState<FeeTaxConfig | null>(null);
  const [date, setDate] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    getFeeTax(slug).then((res) => {
      if (!res.ok) return setError(res.error);
      setConfig(res.data);
      setDate(res.data.registeredFromDate ?? "");
    });
  }, [slug]);

  function save(next: string | null) {
    setError(null);
    setSaved(null);
    startTransition(async () => {
      const res = await updateFeeTax(slug, { registeredFromDate: next });
      if (!res.ok) return setError(res.error);
      setConfig(res.data);
      setDate(res.data.registeredFromDate ?? "");
      setSaved(next ? "Saved — fee tax is on from that date." : "Saved — fee tax is off.");
    });
  }

  return (
    <div className={card}>
      <h2 className="text-base font-semibold text-zinc-100">Tax on Vellon&apos;s fee</h2>
      <p className="mt-1 text-sm text-zinc-500">
        Once Vellon is GST/HST-registered, its fee is taxed at each company&apos;s
        own rate, on top of the fee: taken with the fee on a card fare, and
        added to the monthly invoice on a cash fare. This switch is for{" "}
        <span className="text-zinc-300">this project only</span>. Rides before
        the date are never taxed, and changing it never rewrites a ride that
        was already charged.
      </p>

      {error && (
        <p className="mt-4 rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      {config && (
        <div className="mt-5 space-y-4">
          <p className="text-sm text-zinc-300">
            {config.registeredFromDate
              ? config.active
                ? `On since ${config.registeredFromDate}.`
                : `Scheduled: turns on ${config.registeredFromDate}.`
              : "Off — Vellon's fee is not taxed on this project."}
          </p>
          <div className="space-y-1.5">
            <label className={label}>Registered from (Atlantic time, start of day)</label>
            <div className="flex flex-wrap items-center gap-2">
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className={input}
              />
              <button
                type="button"
                disabled={pending || !date || date === config.registeredFromDate}
                onClick={() => save(date)}
                className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              >
                {pending ? "Saving…" : "Save"}
              </button>
              {config.registeredFromDate && (
                <button
                  type="button"
                  disabled={pending}
                  onClick={() => save(null)}
                  className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800/50 disabled:opacity-50"
                >
                  Turn off
                </button>
              )}
            </div>
          </div>
          {saved && <p className="text-sm text-emerald-400">{saved}</p>}
        </div>
      )}
    </div>
  );
}
