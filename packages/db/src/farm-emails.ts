import { hashEmail, type FarmRoster } from "@farm-friend/core";

import type { Db } from "./index";

// F-078 — the ingest that writes VIGA's email roster.
//
// Insert-only and IDEMPOTENT against `seller_emails_one_per_farm_address`, so a re-run writes
// zero rows rather than duplicating or updating. That matters because the roster is loaded from
// a CSV a human re-exports: running it twice must be a safe thing to do.

export interface FarmEmailIngestResult {
  /** Rows genuinely inserted by this run. A second run reports 0. */
  inserted: number;
  /** Addresses already present, so a re-run is visibly a no-op rather than silently one. */
  skipped: number;
  /**
   * Farms in the roster that matched no seeded farm, BY NAME.
   *
   * Reported, never dropped. Roughly three of the 35 seeded sellers have no email on file and
   * some roster names may not match; an operator can only act on that if the ingest says so.
   */
  unmatchedFarmNames: string[];
  /** Farms in the roster carrying no address at all — the "contact VIGA" set. */
  farmsWithoutEmail: string[];
}

/**
 * Write the roster.
 *
 * Matching is by EXACT farm name, the same rule `resolveStandKey` uses — never a similarity
 * score. A wrong match here would attach one farmer's address to another farm and hand them
 * control of the wrong listing, which is worse than reporting the farm as unmatched.
 */
export async function ingestFarmEmails(
  db: Db,
  rosters: readonly FarmRoster[],
  salt: string,
  now: Date,
): Promise<FarmEmailIngestResult> {
  const result: FarmEmailIngestResult = {
    inserted: 0,
    skipped: 0,
    unmatchedFarmNames: [],
    farmsWithoutEmail: [],
  };

  for (const roster of rosters) {
    if (roster.emails.length === 0) {
      result.farmsWithoutEmail.push(roster.farmName);
      continue;
    }

    const sellers = (await db.sql`
      select id from sellers where name = ${roster.farmName} limit 1
    `) as unknown as Array<{ id: string }>;
    const farmId = sellers[0]?.id;
    if (farmId === undefined) {
      result.unmatchedFarmNames.push(roster.farmName);
      continue;
    }

    for (const email of roster.emails) {
      // `on conflict do nothing` against the normalized unique index is the whole idempotency
      // story. `select`-then-`insert` cannot serialize a row that does not exist yet, so the
      // INDEX is the arbiter — an empty `returning` means the address was already there.
      const written = (await db.sql`
        insert into seller_emails (seller_id, email, email_hash, added_at)
        values (${farmId}, ${email}, ${hashEmail(email, salt)}, ${now.toISOString()})
        on conflict do nothing
        returning id
      `) as unknown as Array<{ id: string }>;

      if (written.length > 0) result.inserted += 1;
      else result.skipped += 1;
    }
  }

  return result;
}
