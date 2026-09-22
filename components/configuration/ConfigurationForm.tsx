"use client";

import { useEffect, useState, useTransition } from "react";
import {
  getPlatformSettings,
  updatePlatformSettings,
  type PlatformSettings,
} from "@/app/(app)/[slug]/configuration/actions";

const card = "rounded-xl border border-zinc-800 bg-zinc-900/40 p-6";
const input =
  "w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-accent";
const label = "block text-sm font-medium text-zinc-400";

export function ConfigurationForm({ slug }: { slug: string }) {
  const [settings, setSettings] = useState<PlatformSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    getPlatformSettings().then((res) => {
      if (res.ok) setSettings(res.data);
      else setError(res.error);
    });
  }, []);

  function submit(f: FormData) {
    setError(null);
    setSaved(false);
    startTransition(async () => {
      const res = await updatePlatformSettings({
        legalName: String(f.get("legalName") || ""),
        businessNumber: String(f.get("businessNumber") || ""),
        hstNumber: String(f.get("hstNumber") || ""),
        mailingAddress: String(f.get("mailingAddress") || ""),
        paymentInstructions: String(f.get("paymentInstructions") || ""),
      });
      if (!res.ok) return setError(res.error);
      setSettings(res.data);
      setSaved(true);
    });
  }

  return (
    <div>
      <h1 className="text-xl font-semibold text-zinc-100">Configuration</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Vellon&apos;s own business details — used as the letterhead/footer on
        generated cash invoices. Every field is optional; leave anything blank
        until it&apos;s actually available (e.g. before incorporation) and the
        invoice PDF will just omit that section.
      </p>

      {error && (
        <p className="mt-4 rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      {!settings && !error && <p className="mt-6 text-sm text-zinc-500">Loading…</p>}

      {settings && (
        <form
          className={`mt-6 max-w-lg space-y-4 ${card}`}
          onSubmit={(e) => {
            e.preventDefault();
            submit(new FormData(e.currentTarget));
          }}
        >
          <div className="space-y-1.5">
            <label className={label}>Legal name</label>
            <input
              name="legalName"
              placeholder="e.g. Vellon Inc. — once incorporated"
              defaultValue={settings.legalName ?? ""}
              className={input}
            />
          </div>
          <div className="space-y-1.5">
            <label className={label}>Business number</label>
            <input
              name="businessNumber"
              defaultValue={settings.businessNumber ?? ""}
              className={input}
            />
          </div>
          <div className="space-y-1.5">
            <label className={label}>HST number</label>
            <input
              name="hstNumber"
              defaultValue={settings.hstNumber ?? ""}
              className={input}
            />
          </div>
          <div className="space-y-1.5">
            <label className={label}>Mailing address</label>
            <input
              name="mailingAddress"
              defaultValue={settings.mailingAddress ?? ""}
              className={input}
            />
          </div>
          <div className="space-y-1.5">
            <label className={label}>Payment instructions</label>
            <textarea
              name="paymentInstructions"
              rows={3}
              placeholder="e.g. Interac e-Transfer to billing@vellon.ca"
              defaultValue={settings.paymentInstructions ?? ""}
              className={input}
            />
          </div>
          <div className="flex items-center gap-3 pt-2">
            <button
              type="submit"
              disabled={pending}
              className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {pending ? "Saving…" : "Save"}
            </button>
            {saved && !pending && (
              <span className="text-xs text-emerald-400">Saved.</span>
            )}
          </div>
        </form>
      )}
    </div>
  );
}
