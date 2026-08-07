// F-078 — the email roster, read out of VIGA's farm-stand form.
//
// The two email columns were already validated by `EXPECTED_COLUMNS` in `form-responses.ts` and
// discarded. They are what lets a farmer prove, without a volunteer vouching for them, that they
// control an address VIGA has on file for their farm.
//
// ## Everything here was measured against the real corpus, not designed in the abstract
//
// Both facts below cost real addresses if handled the obvious way:
//
//   1. **The two columns disagree for 5 of 32 farms**, so they are UNIONED rather than chosen
//      between. Lavender Hill's three addresses are `cathy@` in one and `info@` + `shop@` in the
//      other — either column alone loses real addresses and locks that farmer out of verifying
//      with one VIGA genuinely holds.
//   2. **Separators are mixed.** One farm writes `"a@x.com and b@x.com"`, another
//      `"a@x.com, b@x.com"`. Splitting on commas alone turns the first into ONE malformed
//      address instead of two good ones — and it would be stored, because nothing rejects
//      "and" on sight.
//
// ## Normalization, and why it matches the database exactly
//
// Addresses are lowercased and trimmed here because `farm_emails_one_per_farm_address` indexes
// `lower(btrim(email, E' \t\r\n'))`. If the two disagreed, the ingest would insert `Info@…`, the
// index would collapse it against `info@…`, and the failure would name a constraint rather than
// anything an operator could see in their data.
//
// **This is NOT case-folding the local part as a claim about email semantics.** Addresses are
// technically case-sensitive before the `@`; in practice no provider VIGA's farmers use treats
// them that way, and one spelling per address is what makes verification work at all.

/** One farm's row, reduced to the two columns this module reads. */
export interface FarmEmailRow {
  farmName: string;
  /** The `Email Address` column — who submitted the form. */
  primaryEmail: string | null;
  /** The `Email Address(es)` column — who to contact, sometimes several. */
  listedEmails: string | null;
}

export interface FarmRoster {
  farmName: string;
  /**
   * Every distinct address for this farm, primary first, normalized.
   *
   * **Empty is a real answer and is reported, never dropped.** Roughly three of the 35 seeded
   * farms have no email on file; they are told to contact VIGA, which is only possible if the
   * ingest says which farms they are.
   */
  emails: string[];
}

/**
 * The separators farmers actually use, and the one that needs care.
 *
 * `and` is matched as a STANDALONE WORD with `\b`. Matching the bare substring would shred
 * `alexander@…` and `sandy@…` — both real-looking island addresses — into fragments.
 */
const SEPARATORS = /\s*(?:[,;/]|\band\b)\s*/i;

/**
 * A minimal address shape: something, an `@`, a dotted domain, no whitespace.
 *
 * Deliberately NOT a full RFC 5322 validator. The job here is to tell an address from a human
 * answering a different question ("call me", "none", "n/a") — a stricter pattern would reject
 * real addresses and a looser one would store prose nobody can verify against.
 */
const ADDRESS = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Split one form cell into normalized addresses, dropping blanks and non-addresses. */
export function splitEmailCell(cell: string | null | undefined): string[] {
  if (cell === null || cell === undefined) return [];
  const found: string[] = [];
  for (const part of cell.split(SEPARATORS)) {
    const normalized = part.trim().toLowerCase();
    if (normalized === "") continue;
    if (!ADDRESS.test(normalized)) continue;
    found.push(normalized);
  }
  return found;
}

/**
 * Read each farm's roster from both columns.
 *
 * Order is primary-first then listed, de-duplicated, so a farm's roster is stable across runs —
 * which matters because re-running the ingest must be idempotent against the unique index.
 */
export function parseFarmEmails(rows: readonly FarmEmailRow[]): FarmRoster[] {
  return rows.map((row) => {
    const emails: string[] = [];
    const seen = new Set<string>();
    for (const email of [
      ...splitEmailCell(row.primaryEmail),
      ...splitEmailCell(row.listedEmails),
    ]) {
      if (seen.has(email)) continue;
      seen.add(email);
      emails.push(email);
    }
    return { farmName: row.farmName, emails };
  });
}
