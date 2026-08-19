import type { Db } from "./index";
import type { Sql } from "./sql";

/**
 * The trash: VIGA takes a stand or seller out of the console's list, and can put it back
 * (F-122, max 2026-08-19 — revising "off the map, plus a real delete" the same day).
 *
 * **Trash and off-the-map are two decisions, not two names for one.** Off the map is the
 * everyday reversible hide: the record is still VIGA's, still in the roster, just not shown to
 * customers. Trash means "this should not be in my list at all", so a trashed record leaves the
 * roster entirely and is reachable only from the trash view.
 *
 * **Trashing DESTROYS NOTHING.** Every revision, report, authorization and stand survives it
 * untouched, which is exactly what lets a restore put back the record that was trashed rather
 * than an approximation of it. Emptying the trash is deliberately NOT built here: a permanent
 * delete has to answer a large `on delete restrict` closure — `inventory_revisions`,
 * `closure_revisions`, `stock_out_reports`, `farmer_authorizations`,
 * `sales_location_participants` and, through `stand_providers`, six more — and that is its own
 * piece of work, not a corner of this one.
 *
 * **Trashing retires in the same transaction**, and `*_trashed_implies_retired` enforces it.
 * That is what lets public invisibility stay ONE rule — every public read already filters on
 * `retired_at`, and none of them has to learn a second column. Restoring undoes only the
 * retirement that trashing itself caused: a record retired on its own beforehand stays retired,
 * because two independent decisions must not silently undo each other.
 *
 * **One mechanism, parameterized by subject**, rather than four near-duplicate writers. Trash
 * behaves identically for a stand and a seller — the table, the id column and the audit noun
 * are the only differences, and they are data here rather than duplicated control flow.
 */

function driver(db: Db): Sql {
  return db.sql;
}

/** Which roster a record belongs to. The tables differ; the act does not. */
export type TrashSubject = "stand" | "farm";

interface SubjectShape {
  table: string;
  /** What the audit trail calls this kind of record, matching the existing retirement events. */
  noun: string;
}

/**
 * The only place a subject becomes a table name. Both values are literals from this file and
 * never caller input, so they are safe to interpolate where a parameter cannot go.
 */
const SUBJECTS: Record<TrashSubject, SubjectShape> = {
  stand: { table: "sales_locations", noun: "stand" },
  farm: { table: "sellers", noun: "farm" },
};

export interface TrashInput {
  subject: TrashSubject;
  id: string;
  administratorId: string;
  occurredAt: Date;
}

export type TrashResult =
  | { status: "trashed" }
  | { status: "already_trashed" }
  | { status: "not_an_administrator" }
  | { status: "unknown_subject" };

export type RestoreFromTrashResult =
  | { status: "restored" }
  | { status: "not_trashed" }
  | { status: "not_an_administrator" }
  | { status: "unknown_subject" };

/**
 * Put a stand or seller in the trash, retiring it in the same transaction.
 *
 * **`retired_by_trash` is the whole reason restore can be honest.** Writing `retired_at` alone
 * would make a restore guess whether the retirement was its own to undo; this column records
 * that trashing caused it, so restore clears exactly what it created and leaves a separate
 * take-down standing.
 *
 * Refuses a second trash rather than treating it as a no-op: moving the timestamp would falsify
 * WHEN the record was trashed, which is the one fact the column is for, and the operator's
 * screen can report a conflict.
 *
 * The administrator's authority is re-read inside the transaction. A principal resolved at the
 * start of a request proves they were an administrator then; the row proves they are one now,
 * and a revocation that committed in between must win.
 */
export async function putInTrash(db: Db, input: TrashInput): Promise<TrashResult> {
  const subject = SUBJECTS[input.subject];
  return driver(db).begin(async (tx) => {
    const administrator = await tx`
      select id from administrators
      where id = ${input.administratorId} and revoked_at is null
      for update
    `;
    if (administrator.length === 0) {
      return { status: "not_an_administrator" as const };
    }

    // Locked so two concurrent trashings cannot both see "live" and write two audit events for
    // one act — the same reasoning `retireFarm` uses.
    const record = await tx.unsafe(
      `select id, trashed_at, retired_at from ${subject.table} where id = $1 for update`,
      [input.id],
    );
    if (record.length === 0) return { status: "unknown_subject" as const };
    if (record[0]?.trashed_at !== null) return { status: "already_trashed" as const };

    /*
      RETIRE ONLY IF IT IS NOT ALREADY RETIRED. A record VIGA had separately taken off the map
      keeps its own retirement — its timestamp, its actor, and its independence from this act.
      Overwriting it would credit the trashing for a decision it did not make, and the restore
      below would then put back a stand VIGA had deliberately taken down.
    */
    const alreadyRetired = record[0]?.retired_at !== null;
    await tx.unsafe(
      `update ${subject.table}
         set trashed_at = $1, trashed_by_administrator_id = $2,
             retired_by_trash = $3,
             retired_at = coalesce(retired_at, $1),
             retired_by_administrator_id = coalesce(retired_by_administrator_id, $2),
             updated_at = $1
       where id = $4`,
      [input.occurredAt.toISOString(), input.administratorId, !alreadyRetired, input.id],
    );

    // The audit event commits with the trashing or not at all: a record removed from the roster
    // with no record of who did it is exactly what the audit trail exists to prevent.
    await tx`
      insert into audit_events (action, actor_administrator_id, subject_type, subject_id,
        occurred_at)
      values (${`${subject.noun}_trashed`}, ${input.administratorId}, ${subject.noun},
        ${input.id}, ${input.occurredAt.toISOString()})
    `;

    return { status: "trashed" as const };
  });
}

/**
 * Take a stand or seller back out of the trash.
 *
 * This is what makes trashing safe to reach for: an operator who trashes the wrong record fixes
 * it themselves rather than asking for a database repair.
 *
 * **Undoes the retirement only when trashing caused it** (`retired_by_trash`). A record that was
 * already off the map before it was trashed comes back to the roster still off the map, which is
 * the honest answer — VIGA made that decision separately and only VIGA's own restore reverses it.
 * Without this the restore would silently republish a stand somebody had deliberately taken down.
 *
 * Clears each actor alongside its timestamp: the `coherent_trash` and `coherent_retirement`
 * CHECKs require the pairs to move together, and a record that is not trashed was trashed by
 * nobody.
 */
export async function restoreFromTrash(
  db: Db,
  input: TrashInput,
): Promise<RestoreFromTrashResult> {
  const subject = SUBJECTS[input.subject];
  return driver(db).begin(async (tx) => {
    const administrator = await tx`
      select id from administrators
      where id = ${input.administratorId} and revoked_at is null
      for update
    `;
    if (administrator.length === 0) {
      return { status: "not_an_administrator" as const };
    }

    const record = await tx.unsafe(
      `select id, trashed_at, retired_by_trash from ${subject.table} where id = $1 for update`,
      [input.id],
    );
    if (record.length === 0) return { status: "unknown_subject" as const };
    if (record[0]?.trashed_at === null) return { status: "not_trashed" as const };

    const undoRetirement = record[0]?.retired_by_trash === true;
    await tx.unsafe(
      `update ${subject.table}
         set trashed_at = null, trashed_by_administrator_id = null,
             retired_by_trash = false,
             retired_at = case when $1 then null else retired_at end,
             retired_by_administrator_id =
               case when $1 then null else retired_by_administrator_id end,
             updated_at = $2
       where id = $3`,
      [undoRetirement, input.occurredAt.toISOString(), input.id],
    );

    await tx`
      insert into audit_events (action, actor_administrator_id, subject_type, subject_id,
        occurred_at)
      values (${`${subject.noun}_restored_from_trash`}, ${input.administratorId},
        ${subject.noun}, ${input.id}, ${input.occurredAt.toISOString()})
    `;

    return { status: "restored" as const };
  });
}

/**
 * Named doors for the two subjects, so a caller states which roster it means rather than
 * passing a string the type system would let it get wrong at a distance.
 */
export function trashStand(
  db: Db,
  input: { salesLocationId: string; administratorId: string; occurredAt: Date },
): Promise<TrashResult> {
  return putInTrash(db, {
    subject: "stand",
    id: input.salesLocationId,
    administratorId: input.administratorId,
    occurredAt: input.occurredAt,
  });
}

export function trashFarm(
  db: Db,
  input: { farmId: string; administratorId: string; occurredAt: Date },
): Promise<TrashResult> {
  return putInTrash(db, {
    subject: "farm",
    id: input.farmId,
    administratorId: input.administratorId,
    occurredAt: input.occurredAt,
  });
}
