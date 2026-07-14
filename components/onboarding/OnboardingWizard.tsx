"use client";

import { useState, useTransition } from "react";
import {
  createCompany,
  createDispatcher,
  addInvites,
  type InviteResult,
} from "@/app/(app)/onboarding/actions";

const STEPS = ["Company", "Dispatcher", "Invites", "Done"] as const;

const input =
  "w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-accent";
const label = "block text-sm font-medium text-zinc-400";

export function OnboardingWizard() {
  const [step, setStep] = useState(0);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // carried state
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState("");
  const [dispatcherId, setDispatcherId] = useState<string | null>(null);
  const [invites, setInvites] = useState<InviteResult[]>([]);
  const [driverRows, setDriverRows] = useState([{ name: "", phone: "" }]);

  function run<T>(fn: () => Promise<T>) {
    setError(null);
    startTransition(async () => {
      await fn();
    });
  }

  return (
    <div>
      <h1 className="text-xl font-semibold text-zinc-100">Onboard a company</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Creates the company, its first dispatcher, and driver invite codes in
        the mgcj backend. Stripe onboarding is a separate step (coming next).
      </p>

      {/* stepper */}
      <ol className="mt-6 flex gap-2 text-xs">
        {STEPS.map((s, i) => (
          <li
            key={s}
            className={
              "rounded-full px-3 py-1 " +
              (i === step
                ? "bg-accent text-white"
                : i < step
                  ? "bg-zinc-800 text-zinc-300"
                  : "bg-zinc-900 text-zinc-600")
            }
          >
            {i + 1}. {s}
          </li>
        ))}
      </ol>

      {error && (
        <p className="mt-4 rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          {error}
        </p>
      )}

      <div className="mt-6 max-w-lg rounded-xl border border-zinc-800 bg-zinc-900/40 p-6">
        {step === 0 && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              run(async () => {
                const res = await createCompany({
                  name: String(f.get("name")),
                  platformFeePercent: Number(f.get("fee")),
                  baseFare: Number(f.get("base")),
                  ratePerKm: Number(f.get("rate")),
                  hstNumber: String(f.get("hst") || ""),
                  studentDiscountEnabled: false,
                });
                if (!res.ok) return setError(res.error);
                setCompanyId(res.data.companyId);
                setCompanyName(res.data.name);
                setStep(1);
              });
            }}
          >
            <div className="space-y-1.5">
              <label className={label}>Company name</label>
              <input name="name" required className={input} />
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <label className={label}>Fee %</label>
                <input
                  name="fee"
                  type="number"
                  step="0.1"
                  defaultValue={5}
                  required
                  className={input}
                />
              </div>
              <div className="space-y-1.5">
                <label className={label}>Base fare</label>
                <input
                  name="base"
                  type="number"
                  step="0.01"
                  defaultValue={4}
                  required
                  className={input}
                />
              </div>
              <div className="space-y-1.5">
                <label className={label}>Per km</label>
                <input
                  name="rate"
                  type="number"
                  step="0.01"
                  defaultValue={2}
                  required
                  className={input}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <label className={label}>HST number (optional)</label>
              <input name="hst" className={input} />
            </div>
            <button
              type="submit"
              disabled={pending}
              className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {pending ? "Creating…" : "Create company"}
            </button>
          </form>
        )}

        {step === 1 && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              run(async () => {
                const res = await createDispatcher({
                  companyId: companyId!,
                  name: String(f.get("dname")),
                  phone: String(f.get("dphone")),
                });
                if (!res.ok) return setError(res.error);
                setDispatcherId(res.data.userId);
                setStep(2);
              });
            }}
          >
            <p className="text-sm text-zinc-500">
              First dispatcher for <span className="text-zinc-300">{companyName}</span>.
              They log into the dashboard with this phone via OTP.
            </p>
            <div className="space-y-1.5">
              <label className={label}>Dispatcher name</label>
              <input name="dname" required className={input} />
            </div>
            <div className="space-y-1.5">
              <label className={label}>Phone (E.164)</label>
              <input
                name="dphone"
                placeholder="+19025551234"
                required
                className={input}
              />
            </div>
            <button
              type="submit"
              disabled={pending}
              className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {pending ? "Creating…" : "Create dispatcher"}
            </button>
          </form>
        )}

        {step === 2 && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                const res = await addInvites({
                  companyId: companyId!,
                  drivers: driverRows.filter((d) => d.phone.trim()),
                  createdBy: dispatcherId,
                });
                if (!res.ok) return setError(res.error);
                setInvites(res.data.invites);
                setStep(3);
              });
            }}
          >
            <p className="text-sm text-zinc-500">
              Add drivers for {companyName}. Each gets a unique code tied to their
              phone; they enter it to register.
            </p>
            <div className="space-y-2">
              {driverRows.map((row, i) => (
                <div key={i} className="flex gap-2">
                  <input
                    placeholder="Name (optional)"
                    value={row.name}
                    onChange={(e) =>
                      setDriverRows((rows) =>
                        rows.map((r, j) =>
                          j === i ? { ...r, name: e.target.value } : r,
                        ),
                      )
                    }
                    className={input}
                  />
                  <input
                    placeholder="+19025551234"
                    value={row.phone}
                    onChange={(e) =>
                      setDriverRows((rows) =>
                        rows.map((r, j) =>
                          j === i ? { ...r, phone: e.target.value } : r,
                        ),
                      )
                    }
                    className={input}
                  />
                  {driverRows.length > 1 && (
                    <button
                      type="button"
                      onClick={() =>
                        setDriverRows((rows) => rows.filter((_, j) => j !== i))
                      }
                      className="shrink-0 rounded-md border border-zinc-700 px-3 text-sm text-zinc-400 hover:bg-zinc-800/50"
                    >
                      ✕
                    </button>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={() =>
                setDriverRows((rows) => [...rows, { name: "", phone: "" }])
              }
              className="text-xs text-accent hover:text-accent-hover"
            >
              + Add another driver
            </button>
            <button
              type="submit"
              disabled={pending}
              className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {pending ? "Generating…" : "Generate invite codes"}
            </button>
          </form>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <div>
              <p className="text-sm font-medium text-zinc-200">
                ✅ {companyName} onboarded
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                Dispatcher created · {invites.length} driver invite
                {invites.length === 1 ? "" : "s"} generated
              </p>
            </div>
            <div>
              <p className={label}>Driver invite codes</p>
              <div className="mt-2 space-y-2">
                {invites.map((inv) => (
                  <div
                    key={inv.code}
                    className="flex items-center justify-between rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm"
                  >
                    <span className="text-zinc-400">
                      {inv.name || inv.phone}
                      {inv.name && (
                        <span className="ml-2 text-zinc-600">{inv.phone}</span>
                      )}
                    </span>
                    <code className="font-mono text-zinc-100">{inv.code}</code>
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-md border border-amber-900/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-300/90">
              Stripe not set up yet — this company can't take card payouts until
              Stripe onboarding is completed (coming next).
            </div>
            <button
              onClick={() => {
                setStep(0);
                setCompanyId(null);
                setCompanyName("");
                setDispatcherId(null);
                setInvites([]);
                setDriverRows([{ name: "", phone: "" }]);
              }}
              className="w-full rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800/50"
            >
              Onboard another
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
