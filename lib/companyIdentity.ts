// A company's two derived identifiers: its slug and its card statement
// descriptor suffix. Both are DERIVED IN POSTGRES, not here.
//
// mgcj-app migrations `20261001010000_derive_company_slug.sql` and
// `20261001000000_derive_statement_descriptor.sql` own the derivation, via
// BEFORE INSERT triggers that fill only a NULL. That placement is deliberate:
// companies are created from this console AND by hand in the SQL editor, and a
// default in one of them is a default in one of them.
//
// WHAT IS DELIBERATELY ABSENT HERE: a TypeScript copy of the suffix ladder
// (strip legal-form words, then trade words, then fall back to the first word,
// then truncate). It is the kind of logic that drifts silently once it exists
// twice — the same failure as `fare.ts` having the vehicle surcharge on the
// client and not the server, which produced a quoted-high/held-low fare nobody
// complained about. So this file validates and PREVIEWS; it never predicts.
// Leave the suffix blank at creation and the database fills it.

/**
 * Slug preview only — the database is authoritative.
 *
 * Mirrors `derive_company_slug()`, which is a single regex and has been stable
 * since 20260929050000 backfilled every row with it. Kept because a slug field
 * with no preview is a field nobody fills in correctly, and the cost of drift
 * here is a wrong placeholder rather than a wrong stored value: leave the field
 * empty and the trigger computes the real one.
 */
export function slugPreview(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Slugs are compared case-insensitively by a unique index on lower(slug). */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function validateSlug(slug: string): string | null {
  if (!slug) return null; // empty is fine — the trigger derives it
  if (slug.length > 63) return "Slug must be 63 characters or fewer.";
  if (!SLUG_PATTERN.test(slug))
    return "Slug must be lowercase letters, digits and single hyphens — no spaces, and no leading or trailing hyphen.";
  return null;
}

// ── Statement descriptor ────────────────────────────────────────────────────

/**
 * The platform account's descriptor, for PREVIEW ONLY. Measured against a real
 * Stripe charge 2026-10-01, not read off a settings page:
 *
 *   'M&G CAB'             -> 'VELLON INC.* M&G CAB'    (period kept)
 *   'WAY TOO LONG A NAME' -> 'VELLON INC* WAY TOO LO'  (period DROPPED, cut)
 *
 * Stripe composes the real line; if the account descriptor is ever changed in
 * the Stripe Dashboard this constant goes stale and the preview lies, which is
 * why nothing is computed from it.
 */
export const STATEMENT_PREFIX = "VELLON INC.";
export const SUFFIX_MAX = 10;

/**
 * What the cardholder will see. Reproduces Stripe's observed behaviour: it fits
 * prefix + "* " + suffix into 22 characters, dropping the prefix's trailing
 * period first and only then truncating the suffix.
 */
export function statementLinePreview(suffix: string): string {
  const s = suffix.trim();
  if (!s) return STATEMENT_PREFIX; // no suffix -> the bare account descriptor
  const CAP = 22;
  let prefix = STATEMENT_PREFIX;
  if (prefix.length + 2 + s.length > CAP) prefix = prefix.replace(/\.$/, "");
  return `${prefix}* ${s}`.slice(0, CAP);
}

/**
 * Mirrors the CHECK constraint `companies_statement_descriptor_suffix_check`.
 *
 * Worth duplicating where the ladder is not: it is four stable conditions, and
 * the constraint is the backstop if it ever disagrees. Validating here turns a
 * 23514 into a sentence someone can act on.
 *
 * The 10-character cap is load-bearing, not cosmetic: Stripe does NOT reject an
 * over-long suffix, it silently truncates and returns a healthy
 * `requires_capture`. Nothing downstream will ever flag a mangled statement
 * line, so this is the only place it can be caught.
 */
export function validateSuffix(suffix: string): string | null {
  const s = suffix.trim();
  if (!s) return null; // empty is fine — NULL means the bare account descriptor
  if (s.length < 2 || s.length > SUFFIX_MAX)
    return `Suffix must be 2–${SUFFIX_MAX} characters (Stripe silently truncates anything longer).`;
  if (!/[A-Za-z]/.test(s)) return "Suffix must contain at least one letter.";
  if (/[<>\\'"*]/.test(s))
    return `Stripe rejects < > \\ ' " and * — "&" is fine.`;
  return null;
}

// ── Tax ─────────────────────────────────────────────────────────────────────

/**
 * Nova Scotia since 2025-04-01, verified at CRA. The column default; shown here
 * so the form can say what "normal" is rather than leaving a bare number box.
 */
export const DEFAULT_TAX_RATE = 14;

export function validateTaxRate(rate: number): string | null {
  if (!Number.isFinite(rate)) return "Tax rate must be a number.";
  if (rate < 0 || rate > 100) return "Tax rate must be between 0 and 100.";
  return null;
}
