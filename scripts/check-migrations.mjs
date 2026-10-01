#!/usr/bin/env node
// Migration drift check — the vellon-ops HUB project.
//
// Answers one question: does every migration file in supabase/migrations/ have
// a matching row in the hub's remote migration history, and vice versa?
//
// Ported from mgcj-app's identical check 2026-10-01, deliberately as a near-copy
// rather than a shared package — the two repos have no build relationship, and
// the CLI-flag traps below are the whole value of the file.
//
// WHY THIS EXISTS, and this repo had it worse than mgcj-app. Hub SQL was applied
// by hand through this project's SQL editor and **never stamped**, so as of
// 2026-10-01 the ledger was EMPTY while all eight migrations were live. Two
// consequences, both discovered by running a dry-run rather than by reading
// anything: `supabase db push` proposed replaying 0001-0008 over the live hub —
// the database holding the invoicing records — and nothing anywhere could tell
// you a hub migration was outstanding. 0001-0008 were each verified live and
// then stamped, which is what made this check possible at all.
//
// mgcj-app's version exists for the mirror failure: 20260627_fix_remaining_leaks
// was written, committed and never run, and a later session built a diagnosis on
// the belief that it had been. Same family — the repo records INTENT.
//
// It applies NO DDL. It reads the ledger and compares. Safe to run on every push.
//
// WHAT IT DOES NOT CATCH — important, do not oversell this gate:
//   * SQL applied by hand with no migration file at all. Hand-application does
//     not stamp the ledger, so there is nothing for this to compare. Only a
//     schema diff finds that, and that needs Docker.
//   * A migration whose file has been EDITED since it was applied. The ledger
//     records versions, not content.
// So this proves the two lists agree. It does not prove the database matches
// the files. The 2026-10-01 stamping pass is a concrete example of the gap: each
// migration was verified by probing for the TABLES and COLUMNS it creates, which
// PostgREST can see — but RLS policies, grants, revokes and comments it cannot,
// and those statements remain unverified by construction.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const run = promisify(execFile);

// The hub ref is not a secret — it is the public half of NEXT_PUBLIC_SUPABASE_URL.
// Kept here so the check has one definition; override with
// SUPABASE_PROJECT_REFS="ref:label,...".
//
// ONE project on purpose. The hub is a single Supabase project shared by local,
// Preview and Production (there is no dev hub), and the two mgcj SPOKE projects
// are covered by mgcj-app's own copy of this check against ITS migrations —
// `supabase/migrations/` here contains hub schema only. Pointing this at a spoke
// would compare the wrong file list and report drift that does not exist.
const DEFAULT_REFS = [
  { ref: 'cbzycoxiifapcypohdlr', label: 'hub' },
];

const refs = process.env.SUPABASE_PROJECT_REFS
  ? process.env.SUPABASE_PROJECT_REFS.split(',').map((s) => {
      const [ref, label] = s.trim().split(':');
      return { ref, label: label || ref };
    })
  : DEFAULT_REFS;

// Two flags here are load-bearing, both learned by getting them wrong:
//
//   --output-format json  is NOT the same flag as `--output json`. The latter is
//                         the status-variable formatter (env|pretty|json|...)
//                         and is IGNORED by this command, which then prints a
//                         markdown table. Parsing that would be silent garbage.
//   --agent no            the CLI auto-detects an agent session and switches to
//                         JSON on its own. CI is not an agent session, so the
//                         format must be forced rather than inherited — pinning
//                         it means local and CI parse the same bytes.
const listArgs = (ref) => [
  'migration', 'list', '--project-ref', ref, '--output-format', 'json', '--agent', 'no',
];

// The CLI prints progress lines ("Initialising login role...", "Connecting to
// remote database...") before the JSON, so take the last line that parses.
function lastJson(stdout) {
  const lines = stdout.split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try { return JSON.parse(lines[i]); } catch { /* keep looking */ }
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Supabase's management API returns transient Cloudflare 502s (observed
// 2026-09-21, retryable with a 60s backoff). Without a retry this gate would be
// flaky, and a flaky gate gets ignored — which defeats the point of having it.
async function listMigrations(ref) {
  let lastErr = 'no attempt made';
  for (let attempt = 1; attempt <= 4; attempt++) {
    let stdout = '';
    try {
      ({ stdout } = await run('supabase', listArgs(ref), { maxBuffer: 16 * 1024 * 1024 }));
    } catch (e) {
      stdout = (e.stdout || '') + (e.stderr || '');
    }
    const parsed = lastJson(stdout);
    if (parsed && Array.isArray(parsed.migrations)) return parsed.migrations;
    lastErr = parsed?.error?.message || stdout.trim() || 'unparseable CLI output';
    if (attempt < 4) await sleep(20_000 * attempt);
  }
  throw new Error(`could not read migration history for ${ref}: ${lastErr}`);
}

let failed = false;

for (const { ref, label } of refs) {
  const migrations = await listMigrations(ref);

  // `local` empty  => stamped remotely, no file in the repo.
  // `remote` empty => file in the repo, never applied to this project.
  const unapplied = migrations.filter((m) => m.local && !m.remote).map((m) => m.local);
  const untracked = migrations.filter((m) => !m.local && m.remote).map((m) => m.remote);

  if (!unapplied.length && !untracked.length) {
    console.log(`  ok   ${label} (${ref}) — ${migrations.length} migrations, ledger agrees with repo`);
    continue;
  }

  failed = true;
  console.log(`  FAIL ${label} (${ref})`);
  for (const v of unapplied) {
    console.log(`         in repo, NOT applied : ${v}`);
  }
  for (const v of untracked) {
    console.log(`         applied, NO file     : ${v}`);
  }
}

if (failed) {
  console.log('');
  console.log('Migration history has drifted from the repo.');
  console.log('');
  console.log('  "in repo, NOT applied" — either apply it (supabase db push, or the SQL');
  console.log('  editor), or, if it is already live and merely unstamped, verify that');
  console.log('  live FIRST and then record it:');
  console.log('');
  console.log('    supabase migration repair --project-ref <ref> --status applied <version>');
  console.log('');
  console.log('  Verify live before repairing. Stamping a migration that never ran makes');
  console.log('  this gate lie permanently, which is worse than the drift it reports.');
  console.log('');
  console.log('  "applied, NO file" — the ledger knows a version the repo does not. Either');
  console.log('  someone stamped it by hand, or a db push half-landed. Recover the SQL into');
  console.log('  supabase/migrations/ if it is real; un-record it if it is not:');
  console.log('');
  console.log('    supabase migration repair --project-ref <ref> --status reverted <version>');
  process.exit(1);
}

console.log('');
console.log('No migration drift.');
