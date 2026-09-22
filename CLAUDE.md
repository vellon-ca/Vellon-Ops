# CLAUDE.md — vellon-ops

This is Vellon's own internal back-office console — used by Victor (the vendor), not by taxi-company dispatchers or drivers. Gated to a `platform_owners` allowlist (`lib/auth/guard.ts::requirePlatformOwner()`, checked with the service role so RLS never needs to expose that table to the browser).

**For shared project context** (architecture principles, revenue model, cross-repo technical learnings), see the root-level `CLAUDE.md` at `/home/victor/Documents/projects/CLAUDE.md`. This file only covers what's specific to this repo.

---

## Repo-Specific Stack Details

- Next.js 15 (App Router) + React 19 + TypeScript, Tailwind for styling.
- Server Actions (`"use server"` files named `actions.ts` per route segment) rather than API routes — every module's page is a client shell calling into its sibling `actions.ts`.
- **Its own Supabase project** — separate from the shared mgcj-app/mgcj-dashboard backend (project ref `hhsqwmftrrmtodvvuyxq`). This project owns `platform_owners`, `audit_log`, `projects`, `metric_snapshots`, `invoices`, `platform_settings`, and a private `invoices` Storage bucket for generated PDFs.
- Env vars (`.env.local`, gitignored): `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` for vellon-ops's own project, plus `MGCJ_SUPABASE_URL`/`MGCJ_SUPABASE_SERVICE_ROLE` (and `MGCJ_STRIPE_SECRET`) for the mgcj connector.
- Migrations live in `supabase/migrations/` (numbered `000N_*.sql`, not dated like mgcj-app's), applied by hand via **this project's own** Supabase SQL editor — do not confuse it with the mgcj SQL editor. Some features (e.g. Revenue) need migrations applied in both projects; `revenue/actions.ts`'s `missingMigrationMsg()` lists the exact files/order when a migration is missing.

---

## Architecture: hub-and-spoke

vellon-ops is built as a **hub**, with mgcj as its first **spoke** — deliberately, since the roadmap is more than one customer project eventually plugging in the same way. `lib/connectors/mgcj.ts` is a plain factory (not a shared singleton) so the pattern generalizes: each spoke gets privileged service-role access via its own connector, called from server actions only (`import "server-only"` at the top of every connector/guard file). The `projects` table (see `app/projects/`) is the hub's registry of connected spokes — currently just the one `mgcj` row.

Don't assume future spokes share mgcj's schema — the connector pattern exists precisely because they won't.

---

## Modules (`app/(app)/`)

- **`overview/`** — landing dashboard after login: revenue-at-a-glance, per-company cards, sparkline. Pulls from `revenue/actions.ts`'s functions rather than duplicating queries.
- **`revenue/`** — the Revenue module (analytics) and the cash-invoice generator/sender, both in one `actions.ts`. See "Revenue & Invoicing" below — this is the module most tied to mgcj's `rides`/`companies` schema and the most likely to break silently if that schema shifts.
- **`onboarding/`** — the only path for adding a new company today (`createCompany`/`createDispatcher`/company-settings edit). Fully manual, Victor-in-the-loop — no self-serve signup. Every mutating action here writes to `audit_log` via `lib/audit.ts::writeAudit()` with a `before`/`after` snapshot, which is genuinely useful later (see the fee-rate-history callout below) — don't skip `writeAudit` calls when adding new mutations here.
- **`companies/`** — read-only roster view of onboarded companies (`components/companies/CompaniesDashboard.tsx`).
- **`health/`** — system health checks against the mgcj project: pg_cron job status/failures, table bloat (`cron.job_run_details`/`net._http_response` — see the root CLAUDE.md's "Supabase DB size" note), and a set of ad hoc "detector" queries (`Detector` type) for data-consistency issues.
- **`configuration/`** — `platform_settings` (legal name, business number, HST number, mailing address, payment instructions) — feeds directly into invoice PDFs, see below.

---

## Revenue & Invoicing (`revenue/actions.ts`)

- All numbers are derived from mgcj's `rides`/`companies` tables via the `ops_revenue` Postgres RPC (defined in the **mgcj** project, `mgcj-app/supabase/migrations/20260714_ops_revenue.sql`, most recently updated by `20260719_ride_fee_percent_snapshot.sql`) — there is no revenue ledger of its own here. `fetchRevRows()` is the one call site; everything else (Overview cards, byCompany/byMonth breakdowns, invoice generation) reduces over its rows.
- **Time axis**: `rides.completed_at`, frozen once on the transition into `'completed'` — never `updated_at` (see root CLAUDE.md's "Never bucket revenue/invoicing off `updated_at`" learning; this was a real production bug, not a hypothetical).
- **Fee rate**: as of 2026-07-19, `ops_revenue` sums each ride's own frozen `platform_fee_percent_at_completion`, not the company's live `platform_fee_percent` — a company's rate change now only affects rides completed after the change (see root CLAUDE.md's matching learning). `fee_percent` returned by the RPC is a **blended, display-only** value (`fee_total / fares_total`); never re-derive a dollar amount from `fares_total * fee_percent` — always use the RPC's own `fee_total`/`amount_due` accumulation, since a mid-period rate change makes `fee_percent` a blend that can't reconstruct the true per-ride total.
- **Invoices** (`invoices` table, this project's own DB): one row per company × month, generated as `draft` from live mgcj data by `generateInvoices()`. `draft` invoices are freely regenerable; `sent`/`paid` invoices are locked (excluded from regeneration) and keep whatever `fee_percent`/`amount_due` they were snapshotted with at generation time — this is what makes them a stable historical record even if mgcj's live data or fee rates change later.
- **PDF generation** (`lib/pdf/invoice.ts`, via `pdf-lib`) and **email delivery** (`lib/email/invoiceEmail.ts`, via Resend, sent as `Vellon <billing@vellon.ca>`) both read from the already-snapshotted `invoices` row, company billing info (from mgcj), and `platform_settings` (this project) — never recompute fare/fee numbers at send time.
- **Reconstructing historical fee-rate changes**: if a company's `platform_fee_percent` is ever edited, `onboarding/actions.ts`'s `updateCompanySettings()` writes a `company.update` `audit_log` entry with both `before` and `after` values and a timestamp — this is the *only* record of "what was the rate on date X" outside of whatever gets frozen onto rides going forward. Useful precedent if a future backfill/reconciliation ever needs to reconstruct a rate-change history.

---

## Known Local Issues / WIP

- No automated tests (no test runner configured).
- No CLAUDE.md existed for this repo before 2026-07-19 — if you find stale detail here, it likely just hasn't been updated yet rather than being deliberately wrong; fix it when you notice it drifting from the code.

---

## CI (`.github/workflows/`)

- **`secret-scan.yml`** — gitleaks over full history.
- **`build.yml`** — `npm ci` + `npm run build` + `npm run typecheck`. Runs with **dummy**
  env and needs no secrets: every route is dynamic (server-rendered on demand), so nothing
  queries Supabase or Stripe while compiling. The dummy `MGCJ_STRIPE_SECRET` still starts
  with `sk_` because `lib/connectors/mgcj.ts` throws otherwise, by design.

No `--no-lint` flag: ESLint is not a dependency and there is no config, so `next build` runs
no linting and the CI command stays byte-identical to what Vercel runs. (Note `next lint`
drops into an interactive setup prompt, which would hang a runner — don't add it casually.)

Typecheck is a separate step from the build so a type error reports as a type error.

---

## Deployment

Vercel project `vellon-ops`, scope `victor-onyebuchi-s-projects` (a **personal** Vercel
account hosting an org repo — works, but it is the same identity split that GitHub just
closed, and it is on the consolidation list). Production branch `main`; every branch push
also builds a Preview.

**Node is pinned by `engines.node` in `package.json`, not by the Vercel project setting.**
Vercel reads `engines`, and so does CI via `node-version-file`. Don't add a `.nvmrc` —
Vercel does not read one, so it would be a second copy free to drift from the value
actually used.

**Moving the repo to a GitHub org silently breaks deployment** (hit 2026-09-21, on the
move to `vellon-ca`). The Vercel GitHub App is installed per account/org and does **not**
follow a transferred repo, so the project keeps showing the old path, keeps reporting as
connected, and simply receives no events. There is no error anywhere — pushes just stop
producing deployments, while GitHub Actions checks stay green because they moved correctly.

Diagnosing it: compare the newest deployment's age against the last push
(`npx vercel ls`). A gap is the whole signal. `npx vercel git connect` fails with
"Make sure there aren't any typos and that you have access to the repository if it's
private" — which is what a missing org-level app installation looks like, not a typo.

Fixing it: install/configure the Vercel GitHub App on the org
(`github.com/apps/vercel` → Configure → the org → grant repository access), then reconnect
the project's Git repository. **Reconnecting loses nothing** — environment variables,
domains and deployment history live on the project, including the sensitive
`MGCJ_STRIPE_SECRET` records that cannot be read back. Re-check the production branch
afterwards.
