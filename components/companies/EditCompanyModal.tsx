"use client";

import { useEffect, useState, useTransition } from "react";
import {
  getCompanyForEdit,
  updateCompany,
  type CompanyDetail,
} from "@/app/(app)/[slug]/onboarding/actions";

const input =
  "w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-accent";
const label = "block text-sm font-medium text-zinc-400";

export function EditCompanyModal({
  slug,
  companyId,
  onClose,
  onSaved,
}: {
  slug: string;
  companyId: string;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [company, setCompany] = useState<CompanyDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    let cancelled = false;
    getCompanyForEdit(slug, companyId).then((res) => {
      if (cancelled) return;
      if (res.ok) setCompany(res.data);
      else setError(res.error);
    });
    return () => {
      cancelled = true;
    };
  }, [companyId]);

  function submit(f: FormData) {
    setError(null);
    startTransition(async () => {
      const res = await updateCompany(slug, {
        companyId,
        name: String(f.get("name")),
        platformFeePercent: Number(f.get("fee")),
        baseFare: Number(f.get("base")),
        ratePerKm: Number(f.get("rate")),
        hstNumber: String(f.get("hst") || ""),
        billingEmail: String(f.get("billingEmail") || ""),
        billingAddress: String(f.get("billingAddress") || ""),
      });
      if (!res.ok) return setError(res.error);
      onSaved();
    });
  }

  return (
    <div className="fixed inset-0 z-20 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-950 p-6 shadow-xl">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-zinc-100">
            Edit {company?.name ?? "company"}
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-500 hover:text-zinc-300"
          >
            ✕
          </button>
        </div>

        {error && (
          <p className="mt-3 rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
            {error}
          </p>
        )}

        {!company && !error && (
          <p className="mt-4 text-sm text-zinc-500">Loading…</p>
        )}

        {company && (
          <form
            className="mt-4 space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              submit(new FormData(e.currentTarget));
            }}
          >
            <div className="space-y-1.5">
              <label className={label}>Company name</label>
              <input name="name" required defaultValue={company.name} className={input} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <label className={label}>Fee %</label>
                <input
                  name="fee"
                  type="number"
                  step="0.1"
                  required
                  defaultValue={company.platformFeePercent}
                  className={input}
                />
              </div>
              <div className="space-y-1.5">
                <label className={label}>Base fare</label>
                <input
                  name="base"
                  type="number"
                  step="0.01"
                  required
                  defaultValue={company.baseFare}
                  className={input}
                />
              </div>
              <div className="space-y-1.5">
                <label className={label}>Per km</label>
                <input
                  name="rate"
                  type="number"
                  step="0.01"
                  required
                  defaultValue={company.ratePerKm}
                  className={input}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className={label}>HST number (optional)</label>
              <input name="hst" defaultValue={company.hstNumber ?? ""} className={input} />
            </div>
            <div className="space-y-1.5">
              <label className={label}>Billing email (optional)</label>
              <input
                name="billingEmail"
                type="email"
                defaultValue={company.billingEmail ?? ""}
                className={input}
              />
            </div>
            <div className="space-y-1.5">
              <label className={label}>Billing address (optional)</label>
              <input
                name="billingAddress"
                defaultValue={company.billingAddress ?? ""}
                className={input}
              />
            </div>
            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="flex-1 rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800/50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={pending}
                className="flex-1 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              >
                {pending ? "Saving…" : "Save"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
