import type { Db } from "./index";
import type { Tx } from "./sql";

// F-074 — test farms, and the ONE rule that decides whether anyone sees one.
//
// A test farm is a farm VIGA marked as fake so it can be walked end to end against real
// production — onboard, publish, text, appear on the map — without an islander ever seeing it.
// It is not a listing with a warning on it. It is absent.
//
// ## Why the predicate lives here and is stated once
//
// Four surfaces decide what a viewer may see, and each runs its own SQL:
//
//   * the public map and `GET /api/public/stands`   (`public-listing.ts`)
//   * customer SMS retrieval, confirmed half         (`inquiry.ts`)
//   * customer SMS retrieval, offerings half         (`inquiry.ts` — a SECOND query)
//   * the grandfathered farm picker                  (`farmer.ts`)
//
// Four copies of "and it isn't a test farm" is four chances to miss one, and the one that gets
// missed is a leak nobody notices until a customer texts about a fake farm. So the rule is
// written here as a fragment both halves of the system compose into their own queries, exactly
// as F-072 did with `NO_LIVE_FARMER` after the same problem — and an integration test asserts
// the copies agree rather than trusting that they do.
//
// ## Two ways to be a deliberate viewer, and they are not the same kind of thing
//
// **`?hidden=true` is a URL parameter, not a credential.** Anyone who guesses it sees test
// farms. That is acceptable *because a test farm holds no real data*, and it is why this flag
// must never be used to hide a REAL farm that wants privacy — a farmer who does not want her
// address published is `contact_only` (B-024), which is a fact about the listing rather than a
// query string anyone can type.
//
// **A listed sender hash is a real credential**, and it is the riskier of the two: it is a
// second way to be privileged, reachable from untrusted inbound SMS. Three properties contain
// it, and all three are structural rather than promised:
//
//   1. It grants VISIBILITY and nothing else. No path but retrieval reads
//      `administrator_phones`, so being listed cannot publish, approve, or read a farmer's data.
//   2. It is decided by CODE from the sender hash, before any model call, and never travels in
//      or out of model context. The model selects from what retrieval already returned, so a
//      test farm the filter excluded cannot be named however directly it is asked for.
//   3. Removal is immediate, because every read filters on `revoked_at is null`.

/**
 * The visibility rule, written ONCE, as a SQL fragment over a `farms` alias.
 *
 * `includeTestFarms` is the deliberate-viewer decision already made by the caller — resolved
 * from `?hidden=true` on the web or from the sender's hash over SMS. It is a boolean by the
 * time it arrives here on purpose: this module decides what a test farm IS, and never how
 * someone earned the right to see one.
 *
 * Returns `true` rather than an empty string in the permitted case, so it is always a legal
 * boolean expression and a caller can drop it into a `where` or a `select` without knowing
 * which branch it took.
 */
export function visibleFarms(alias: string, includeTestFarms: boolean): string {
  if (includeTestFarms) return "true";
  return `${alias}.test_farm_at is null`;
}

/**
 * Is this sender allowed to see test farms?
 *
 * Code's decision, from the sender hash and the database — never the model's, and never
 * inferred from the message. Deliberately returns a bare boolean: the caller learns whether
 * this sender may SEE more, and nothing about who they are. Nothing downstream can escalate a
 * fact it was never given.
 *
 * A revoked listing stops granting visibility on the very next message, because that is the
 * only place this is read.
 */
export async function isPrivilegedSender(
  db: Db,
  input: { senderHash: string },
): Promise<boolean> {
  const rows = await db.sql`
    select 1 from administrator_phones
    where phone_hash = ${input.senderHash} and revoked_at is null
    limit 1
  `;
  return rows.length > 0;
}

export interface AdministratorPhoneRow {
  id: string;
  /** The last four digits, so an operator can tell one row from another. Never more. */
  lastFour: string;
  addedAt: Date;
}

/**
 * The live administrator phone list, for the admin surface.
 *
 * Carries no hash and no number — an operator needs to identify a row and remove it, and the
 * hash is a lookup key rather than something to put on a screen (Golden Rule #5). Revoked rows
 * stay in the table for the audit trail and are deliberately not listed: the page shows who can
 * see test farms NOW, which is the question it exists to answer.
 */
export async function listAdministratorPhones(
  db: Db,
): Promise<AdministratorPhoneRow[]> {
  const rows = await db.sql`
    select id, phone_last_four, added_at
    from administrator_phones
    where revoked_at is null
    order by added_at desc, id asc
  `;
  return rows.map((row) => ({
    id: row.id as string,
    lastFour: row.phone_last_four as string,
    addedAt: row.added_at as Date,
  }));
}

export type AddAdministratorPhoneResult =
  | { status: "added"; id: string }
  | { status: "already_listed" }
  | { status: "not_an_administrator" };

/**
 * List a phone number as allowed to see test farms.
 *
 * Takes the HASH and the last four digits, never a raw number: normalization and hashing happen
 * at the request boundary, so a raw E.164 never reaches this layer and cannot be logged by it.
 *
 * The administrator's authority is re-read inside the transaction. A principal resolved at the
 * start of a request proves they were an administrator then; the row proves they are one now,
 * and a revocation that committed in between must win.
 */
export async function addAdministratorPhone(
  db: Db,
  input: {
    phoneHash: string;
    phoneLastFour: string;
    administratorId: string;
    occurredAt: Date;
  },
): Promise<AddAdministratorPhoneResult> {
  return db.sql.begin(async (tx: Tx) => {
    const administrator = await tx`
      select id from administrators
      where id = ${input.administratorId} and revoked_at is null
      for update
    `;
    if (administrator.length === 0) {
      return { status: "not_an_administrator" as const };
    }

    // The partial unique index is the arbiter, not a preceding SELECT: `for update` cannot
    // serialize a row that does not exist yet, so two administrators listing the same number
    // at once are resolved by the index. An empty result means the other one won.
    const inserted = await tx`
      insert into administrator_phones (
        phone_hash, phone_last_four, added_by_administrator_id, added_at
      )
      values (
        ${input.phoneHash}, ${input.phoneLastFour}, ${input.administratorId},
        ${input.occurredAt.toISOString()}
      )
      on conflict do nothing
      returning id
    `;
    if (inserted.length === 0) return { status: "already_listed" as const };

    // The audit event commits with the listing or not at all: a number granted visibility with
    // no record of who granted it is exactly what the audit trail exists to prevent.
    await tx`
      insert into audit_events (action, actor_administrator_id, subject_type, subject_id,
        occurred_at)
      values ('administrator_phone_added', ${input.administratorId}, 'administrator_phone',
        ${inserted[0]?.id as string}, ${input.occurredAt.toISOString()})
    `;

    return { status: "added" as const, id: inserted[0]?.id as string };
  });
}

export type RemoveAdministratorPhoneResult =
  | { status: "removed" }
  | { status: "not_listed" }
  | { status: "not_an_administrator" };

/**
 * Stop a number seeing test farms.
 *
 * A revocation rather than a delete, matching `administrators` and `farmer_authorizations`: the
 * row stays so the audit trail can still answer who was listed and when. It takes effect on the
 * sender's very next message, because `isPrivilegedSender` filters on `revoked_at is null`.
 */
export async function removeAdministratorPhone(
  db: Db,
  input: { id: string; administratorId: string; occurredAt: Date },
): Promise<RemoveAdministratorPhoneResult> {
  return db.sql.begin(async (tx: Tx) => {
    const administrator = await tx`
      select id from administrators
      where id = ${input.administratorId} and revoked_at is null
      for update
    `;
    if (administrator.length === 0) {
      return { status: "not_an_administrator" as const };
    }

    // Locked, so two concurrent removals cannot both see "live" and write two audit events for
    // one decision. Idempotent on the second: a row already revoked is `not_listed`, which
    // keeps the FIRST revocation's timestamp rather than falsifying when it took effect.
    const listing = await tx`
      select id, revoked_at from administrator_phones
      where id = ${input.id}
      for update
    `;
    if (listing.length === 0) return { status: "not_listed" as const };
    if (listing[0]?.revoked_at !== null) return { status: "not_listed" as const };

    await tx`
      update administrator_phones
      set revoked_at = ${input.occurredAt.toISOString()},
          revoked_by_administrator_id = ${input.administratorId}
      where id = ${input.id}
    `;

    await tx`
      insert into audit_events (action, actor_administrator_id, subject_type, subject_id,
        occurred_at)
      values ('administrator_phone_removed', ${input.administratorId}, 'administrator_phone',
        ${input.id}, ${input.occurredAt.toISOString()})
    `;

    return { status: "removed" as const };
  });
}

export type MarkTestFarmResult =
  | { status: "marked" }
  | { status: "unmarked" }
  | { status: "unchanged" }
  | { status: "not_an_administrator" }
  | { status: "unknown_farm" };

/**
 * Mark a farm as a test farm, or unmark it.
 *
 * One function for both directions rather than two near-duplicates: it is one decision with two
 * values, and the authority check, the lock, and the audit record are identical either way.
 *
 * Clears the actor alongside the timestamp when unmarking — `farms_coherent_test_farm` requires
 * the two to move together, and a farm that is not a test farm was marked by nobody.
 */
export async function setTestFarm(
  db: Db,
  input: {
    farmId: string;
    isTestFarm: boolean;
    administratorId: string;
    occurredAt: Date;
  },
): Promise<MarkTestFarmResult> {
  return db.sql.begin(async (tx: Tx) => {
    const administrator = await tx`
      select id from administrators
      where id = ${input.administratorId} and revoked_at is null
      for update
    `;
    if (administrator.length === 0) {
      return { status: "not_an_administrator" as const };
    }

    const farm = await tx`
      select id, test_farm_at from farms
      where id = ${input.farmId}
      for update
    `;
    if (farm.length === 0) return { status: "unknown_farm" as const };

    const alreadyTest = farm[0]?.test_farm_at !== null;
    // Idempotent, and it keeps the FIRST marking's timestamp. Moving it would falsify when the
    // farm actually became a test farm, and would write a second audit event for one decision.
    if (alreadyTest === input.isTestFarm) return { status: "unchanged" as const };

    await tx`
      update farms
      set test_farm_at = ${input.isTestFarm ? input.occurredAt.toISOString() : null},
          test_farm_by_administrator_id = ${input.isTestFarm ? input.administratorId : null},
          updated_at = ${input.occurredAt.toISOString()}
      where id = ${input.farmId}
    `;

    await tx`
      insert into audit_events (action, actor_administrator_id, subject_type, subject_id,
        occurred_at)
      values (
        ${input.isTestFarm ? "farm_marked_test" : "farm_unmarked_test"},
        ${input.administratorId}, 'farm', ${input.farmId},
        ${input.occurredAt.toISOString()}
      )
    `;

    return { status: input.isTestFarm ? ("marked" as const) : ("unmarked" as const) };
  });
}
