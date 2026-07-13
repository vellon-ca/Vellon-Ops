# Vellon Ops — Spec (v1)

Private founder/super-admin console for **Vellon** (the software vendor behind the M&G C&J
dispatch platform). Lets Victor run vendor operations — onboard taxi companies, track revenue,
check backend health — without touching the database by hand, and without any of these powers
living inside tenant-facing apps.

**This is not a second dispatch dashboard.** Tenant taxi-company admins have no account here and
no way to reach it. It is a standalone deployment with its own auth realm, its own secrets, and
its own small database.

---

## 1. Core principles (locked)

1. **Standalone, not embedded.** Separate repo, separate Vercel deployment. Owner-only code and
   powers never ship inside `mgcj-dashboard` (the tenant bundle).
2. **No privileged secret ever reaches the browser.** `service_role` keys, Stripe secret keys,
   Twilio creds — all live server-side only (Next.js route handlers / server actions, env vars).
   The browser only ever calls Vellon Ops' own server.
3. **Server-enforced access, not UI-gated.** Hiding buttons in React is not security. Every
   privileged action re-verifies the caller is an allowlisted platform owner on the server before
   doing anything.
4. **Separate auth realm.** Vellon Ops authenticates against its **own** Supabase project, wholly
   separate from `hhsqwmftrrmtodvvuyxq` (mgcj) and any future tenant project. Tenants cannot
   escalate into it because there is no shared auth or RLS surface.
5. **Hub-and-spoke, built for one spoke.** mgcj is the only project today. The architecture
   supports future projects (each with its own independent backend) via a connector layer, but v1
   ships no multi-project UI complexity — just don't hardcode mgcj assumptions into the core.
6. **Audit everything that mutates.** Every platform-owner write (onboard, fee change, device-lock
   reset, invoice generation) appends an immutable audit record: who, what, when, before → after.
7. **Read-only by default; destructive actions behind explicit confirm.**

---

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js (App Router)** | Gives the required server tier for free — route handlers / server actions hold secrets; UI stays client-side. One deployable. |
| Hosting | **Vercel** | Matches existing muscle memory (mgcj-dashboard is on Vercel). Env-var secret management per project. |
| Auth + hub DB | **New dedicated Supabase project** ("vellon-ops") | Own auth realm + small Postgres for registry/audit/metrics. Familiar tooling, zero shared surface with tenants. |
| Auth method | Email allowlist + **TOTP 2FA** | Only allowlisted user IDs get in; 2FA enforced. |
| Theme | Dark / near-black | Visually distinct "owner mode." |

---

## 3. Auth & access control

- **Allowlist table** `platform_owners (user_id, email, added_at)` in the vellon-ops Supabase
  project — *not* a role enum value. Keeps Victor's identity out of any tenant role system entirely.
- **TOTP 2FA** required (Supabase MFA, or app-level TOTP).
- **Server-side guard** — a single `requirePlatformOwner()` helper wraps every server action /
  route handler: validates the vellon-ops session, confirms `user_id ∈ platform_owners`, else 403.
  No privileged code path skips it.
- Optional later: IP allowlist, passkey.

---

## 4. Connector layer (future-proofing, minimal in v1)

Each spoke project is described by a **connector**: what kind of backend it has and which
server-side env vars hold its secrets. The hub reads secrets *by reference* — raw keys live in
Vercel env vars, never in the hub DB.

```
Connector {
  projectId: string
  kind: 'supabase' | 'postgres' | 'rest' | ...   // extensible
  // secrets resolved server-side from env by convention, e.g.
  //   MGCJ_SUPABASE_URL, MGCJ_SUPABASE_SERVICE_ROLE, MGCJ_STRIPE_SECRET, ...
}
```

v1 registers exactly one connector (mgcj → Supabase `hhsqwmftrrmtodvvuyxq` + Stripe + Twilio).
Project-specific modules (revenue tracker, onboarding wizard) live *behind* a connector so
project #2 later just brings its own modules — the core hub stays project-agnostic.

---

## 5. Hub database (vellon-ops Supabase project)

Small. Holds only hub metadata — never tenant data (that's read live/cached through connectors).

- `platform_owners (user_id, email, added_at)` — access allowlist.
- `projects (id, name, slug, icon, color, status, links, created_at)` — spoke registry; seeded
  with mgcj.
- `audit_log (id, actor_user_id, project_id, action, target, before, after, created_at)` —
  immutable; append-only.
- `metric_snapshots (id, project_id, key, value, captured_at)` — cached revenue/health numbers so
  the UI isn't hammering each backend live on every load.

---

## 6. v1 modules (mgcj)

**In v1:**

1. **Company onboarding wizard** — the biggest manual-process killer. Flow:
   create `company_id` → create Stripe Connect Express account + generate onboarding link →
   set `platform_fee_percent` → seed the first dispatcher `admin` profile → mint driver invite
   codes. Each step audited.
2. **Revenue tracker** — gross fares, platform fees split by **card** (auto-collected via Connect
   application fees) vs **cash** (invoiced), by company, over time; reconciled against Stripe
   balance/transfers.
   - **Monthly cash-invoice generator** — compute each company's cash-fare platform fee at the
     same rate as card and produce the monthly invoice. Recurring operational need baked into the
     revenue model; nothing does this today.
3. **DB / ops health** — table row counts, `pg_cron` last-run/success per job, Edge Function
   invocation stats, and stuck-state detectors (rides pending too long, scheduled rides unclaimed
   near departure, orphaned records). Read-only.

**Fast-follow (v1.1):**

4. **Stripe Connect status board** — `charges_enabled` / `payouts_enabled` / requirements-due per
   company, live from Stripe.
5. **Driver / user ops** — deactivate a driver; **reset the single-device `device_token` lock**
   for legitimately locked-out drivers; push-token debug tool.
6. **Twilio balance / usage widget**; push-notification test harness.

**Explicitly deferred:** company impersonation / "view as company" — highest-risk feature; wait
until audit log + 2FA are proven.

---

## 7. Open questions / to confirm before build

- Repo name confirmed: **vellon-ops**.
- Confirm the vellon-ops Supabase project gets created fresh (new project ref) vs. reusing an
  existing personal project.
- Revenue reconciliation source of truth: Stripe API live vs. nightly snapshot into
  `metric_snapshots` (leaning snapshot + on-demand refresh, to bound Stripe API calls).
