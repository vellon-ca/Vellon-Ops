"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import {
  createCompany,
  createDispatcher,
  addInvites,
  startStripeOnboarding,
  refreshStripeStatus,
  type InviteResult,
  type StripeStatus,
  type CompanyRow,
} from "@/app/(app)/onboarding/actions";

const STEPS = ["Company", "Dispatcher", "Invites", "Stripe", "Done"] as const;

const input =
  "w-full rounded-md border border-zinc-800 bg-zinc-950 px-3 py-2 text-sm text-zinc-100 outline-none focus:border-accent";
const label = "block text-sm font-medium text-zinc-400";

type CompanyInput = {
  name: string;
  platformFeePercent: number;
  baseFare: number;
  ratePerKm: number;
  hstNumber: string;
};

// The first step of a resumed company that still has real work left. company +
// dispatcher are the required steps; invites and Stripe are optional/skippable,
// so we never bounce a resumed run back to step 0 or 1 once they're done.
function resumeStep(r: CompanyRow): number {
  if (!r.dispatcherName) return 1; // Dispatcher
  if (r.stripeOnboarded || r.stripeAccountId) return 3; // Stripe (ready or in-progress)
  return 2; // dispatcher done, Stripe not started → offer invites next
}

export function OnboardingWizard({
  resume,
  onChanged,
}: {
  resume?: CompanyRow | null;
  onChanged?: () => void;
}) {
  const [step, setStep] = useState(0);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // carried state
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [companyName, setCompanyName] = useState("");
  const [dispatcherId, setDispatcherId] = useState<string | null>(null);
  const [invites, setInvites] = useState<InviteResult[]>([]);
  const [driverRows, setDriverRows] = useState([{ name: "", phone: "" }]);
  const [stripe, setStripe] = useState<StripeStatus | null>(null);
  // Set on every successful status poll so a check that doesn't change the
  // outcome still gives the user visible feedback that it ran.
  const [stripeCheckedAt, setStripeCheckedAt] = useState<string | null>(null);

  // Same-name guard: hold the last attempted company so "Create anyway" can
  // re-submit it with force=true.
  const [dupInput, setDupInput] = useState<CompanyInput | null>(null);

  function run<T>(fn: () => Promise<T>) {
    setError(null);
    startTransition(async () => {
      await fn();
    });
  }

  function resetWizard() {
    setStep(0);
    setCompanyId(null);
    setCompanyName("");
    setDispatcherId(null);
    setInvites([]);
    setDriverRows([{ name: "", phone: "" }]);
    setStripe(null);
    setStripeCheckedAt(null);
    setDupInput(null);
    setError(null);
  }

  // Seed the wizard when the parent hands us a company to resume. The parent
  // passes a fresh object per Resume click, so identity change = re-seed.
  const prevResume = useRef<CompanyRow | null>(null);
  useEffect(() => {
    if (!resume || resume === prevResume.current) return;
    prevResume.current = resume;
    resetWizard();
    setCompanyId(resume.id);
    setCompanyName(resume.name);
    setStep(resumeStep(resume));
    // Pull live Stripe state (and a fresh link) if an account already exists.
    if (resume.stripeAccountId) {
      startTransition(async () => {
        const res = await refreshStripeStatus({ companyId: resume.id });
        if (res.ok) {
          setStripe(res.data);
          setStripeCheckedAt(new Date().toLocaleTimeString());
        }
      });
    }
  }, [resume]);

  function submitCompany(data: CompanyInput, force: boolean) {
    run(async () => {
      const res = await createCompany({
        name: data.name,
        platformFeePercent: data.platformFeePercent,
        baseFare: data.baseFare,
        ratePerKm: data.ratePerKm,
        hstNumber: data.hstNumber,
        studentDiscountEnabled: false,
        force,
      });
      if (!res.ok) {
        setError(res.error);
        if (res.duplicate) setDupInput(data);
        return;
      }
      setDupInput(null);
      setCompanyId(res.data.companyId);
      setCompanyName(res.data.name);
      setStep(1);
      onChanged?.();
    });
  }

  return (
    <div>
      <h1 className="text-xl font-semibold text-zinc-100">Onboard a company</h1>
      <p className="mt-1 text-sm text-zinc-500">
        Creates the company, its first dispatcher, driver invite codes, and
        Stripe payout onboarding in the mgcj backend. Steps can be skipped and
        revisited.
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
        <div className="mt-4 rounded-md border border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-300">
          <p>{error}</p>
          {dupInput && step === 0 && (
            <button
              type="button"
              disabled={pending}
              onClick={() => submitCompany(dupInput, true)}
              className="mt-2 rounded-md border border-red-800/60 px-3 py-1 text-xs text-red-200 hover:bg-red-900/30 disabled:opacity-50"
            >
              Create anyway
            </button>
          )}
        </div>
      )}

      <div className="mt-6 max-w-lg rounded-xl border border-zinc-800 bg-zinc-900/40 p-6">
        {step === 0 && (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              const f = new FormData(e.currentTarget);
              submitCompany(
                {
                  name: String(f.get("name")),
                  platformFeePercent: Number(f.get("fee")),
                  baseFare: Number(f.get("base")),
                  ratePerKm: Number(f.get("rate")),
                  hstNumber: String(f.get("hst") || ""),
                },
                false,
              );
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
                onChanged?.();
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
                onChanged?.();
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
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setInvites([]);
                  setStep(3);
                }}
                className="rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-400 hover:bg-zinc-800/50"
              >
                Skip for now
              </button>
              <button
                type="submit"
                disabled={pending}
                className="flex-1 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              >
                {pending ? "Generating…" : "Generate invite codes"}
              </button>
            </div>
          </form>
        )}

        {step === 3 && (
          <div className="space-y-4">
            <p className="text-sm text-zinc-500">
              Set up Stripe payouts for {companyName}. This creates a Connect
              account and gives you an onboarding link to send them. The company
              only goes payment-ready once Stripe confirms it.
            </p>

            {!stripe && (
              <button
                type="button"
                disabled={pending}
                onClick={() =>
                  run(async () => {
                    const res = await startStripeOnboarding({
                      companyId: companyId!,
                    });
                    if (!res.ok) return setError(res.error);
                    setStripe(res.data);
                    onChanged?.();
                  })
                }
                className="w-full rounded-md bg-accent px-3 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
              >
                {pending ? "Creating…" : "Create Stripe account"}
              </button>
            )}

            {stripe && (
              <div className="space-y-3">
                {stripe.chargesEnabled ? (
                  <div className="rounded-md border border-emerald-900/40 bg-emerald-950/30 px-3 py-2 text-sm text-emerald-300">
                    ✅ Stripe onboarded — this company is payment-ready.
                  </div>
                ) : (
                  <>
                    <div className="space-y-1.5">
                      <label className={label}>Onboarding link (send to company)</label>
                      <input
                        readOnly
                        value={stripe.onboardingUrl ?? ""}
                        onFocus={(e) => e.currentTarget.select()}
                        className={input + " text-xs"}
                      />
                    </div>
                    <button
                      type="button"
                      disabled={pending}
                      onClick={() =>
                        run(async () => {
                          const res = await refreshStripeStatus({
                            companyId: companyId!,
                          });
                          if (!res.ok) return setError(res.error);
                          setStripe(res.data);
                          setStripeCheckedAt(new Date().toLocaleTimeString());
                          onChanged?.();
                        })
                      }
                      className="w-full rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800/50 disabled:opacity-50"
                    >
                      {pending ? "Checking…" : "Check status"}
                    </button>
                    {!stripe.onboardingUrl && (
                      <p className="text-xs text-amber-300/80">
                        Couldn&apos;t generate a fresh onboarding link — click
                        Check status to try again.
                      </p>
                    )}
                    {stripeCheckedAt && (
                      <p className="text-xs text-zinc-500">
                        {stripe.detailsSubmitted
                          ? "Details submitted — Stripe is still reviewing. This can take a few minutes."
                          : "Not completed yet — the company still needs to finish the Stripe form via the link above."}{" "}
                        <span className="text-zinc-600">
                          (checked {stripeCheckedAt})
                        </span>
                      </p>
                    )}
                  </>
                )}
              </div>
            )}

            <div className="flex gap-2 pt-2">
              <button
                type="button"
                onClick={() => setStep(4)}
                className="w-full rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-300 hover:bg-zinc-800/50"
              >
                {stripe?.chargesEnabled ? "Finish" : "Skip / finish later"}
              </button>
            </div>
          </div>
        )}

        {step === 4 && (
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
            {invites.length > 0 && (
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
            )}
            {stripe?.chargesEnabled ? (
              <div className="rounded-md border border-emerald-900/40 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300">
                Stripe onboarded — card payouts route to this company.
              </div>
            ) : (
              <div className="rounded-md border border-amber-900/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-300/90">
                Stripe not finished — card fares won&apos;t route to this company
                until its Stripe onboarding is completed. You can revisit later.
              </div>
            )}
            <button
              onClick={resetWizard}
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
