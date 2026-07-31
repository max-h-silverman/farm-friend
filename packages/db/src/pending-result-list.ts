import type { Db } from "./index";
import type { Sql } from "./sql";

// The pending result list `MORE` pages through (F-046).
//
// Two operations, and the split is the whole design:
//
//   - `savePendingResultList` — a question just answered with more than one page's worth.
//     The list REPLACES whatever the sender had; the unique index on `sender_hash` is what
//     enforces that, not a read followed by a write, so two questions racing cannot leave two
//     lists behind for `MORE` to choose between.
//   - `takeNextResultPage` — a `MORE` claims the next slice. Read and advance happen in ONE
//     locked transaction, because a read followed by a separate update would let two
//     simultaneous claimants both see the same offset and both be served the same stands,
//     which reads to a customer as `MORE` doing nothing.
//
// **Expiry is evaluated against the MESSAGE's time, never `now()`.** A pass replaying a
// delayed inbound event must decide with the clock of the message it is answering — using the
// database's clock would refuse a page the customer asked for well inside the window, and
// would silently extend the window on the write side.
//
// This module stores and returns OPAQUE identifiers. What a fact id means, and how it
// dereferences to a stand, belongs to the inquiry path; nothing here interprets one.

function driver(db: Db): Sql {
  return db.sql;
}

export interface SavePendingResultListInput {
  /** The sender's phone hash. The raw number never reaches this layer (Golden Rule #5). */
  senderHash: string;
  /** The ordered fact identifiers the answer selected, in the order they will be paged. */
  factIds: string[];
  /** The product words the answer was about — not the sender's message. */
  itemsRequested: string[];
  /** How many of `factIds` the answering message already showed. */
  shown: number;
  /** The inbound message's own time. */
  occurredAt: Date;
  /** How long the list stays pageable, from `occurredAt`. */
  ttlMinutes: number;
}

/**
 * Save the list a paged answer leaves behind, replacing any list the sender already had.
 *
 * Called only when there is something left to page. A result set that fits in one message
 * stores nothing: there is nothing for `MORE` to return, and a row nobody can page would be
 * retained personal-adjacent data bought with no benefit.
 */
export async function savePendingResultList(
  db: Db,
  input: SavePendingResultListInput,
): Promise<void> {
  const expiresAt = new Date(input.occurredAt.getTime() + input.ttlMinutes * 60_000);
  await driver(db)`
    insert into pending_result_lists (
      sender_hash, fact_ids, items_requested, "offset", created_at, expires_at
    )
    values (
      ${input.senderHash}, ${input.factIds}, ${input.itemsRequested}, ${input.shown},
      ${input.occurredAt}, ${expiresAt}
    )
    on conflict (sender_hash) do update set
      fact_ids = excluded.fact_ids,
      items_requested = excluded.items_requested,
      "offset" = excluded."offset",
      created_at = excluded.created_at,
      expires_at = excluded.expires_at
  `;
}

export interface NextResultPage {
  /** The identifiers this page covers, in their saved order. */
  factIds: string[];
  /** Where this page starts in the saved list — what the renderer reports as "4-6 of 9". */
  offset: number;
  /** How long the whole list is. */
  total: number;
  itemsRequested: string[];
}

/**
 * Claim the next page of a sender's pending list, or `null` when there is none.
 *
 * `null` covers three situations deliberately made indistinguishable to the caller: no list
 * was ever saved, the list expired, and the list is exhausted. All three mean the same thing
 * to the customer — there is nothing to page — and one honest reply is better than three
 * shades of "no".
 *
 * An expired or exhausted row is DELETED as it is discovered. Nothing else sweeps this table,
 * and a terminal row left behind would be retained data with no reader.
 */
export async function takeNextResultPage(
  db: Db,
  input: { senderHash: string; occurredAt: Date; pageSize: number },
): Promise<NextResultPage | null> {
  return driver(db).begin(async (tx) => {
    // `for update` serializes concurrent MOREs from the same sender on the row itself. The
    // row always exists before any claimant reads it (a question wrote it), so the lock is a
    // sufficient arbiter here — unlike a first-insert race, which needs a unique index.
    const rows = await tx`
      select id, fact_ids, items_requested, "offset", expires_at
      from pending_result_lists
      where sender_hash = ${input.senderHash}
      for update
    `;
    const row = rows[0];
    if (!row) return null;

    const listId = row.id as string;
    const expiresAt = row.expires_at as Date;
    if (expiresAt.getTime() <= input.occurredAt.getTime()) {
      await tx`delete from pending_result_lists where id = ${listId}`;
      return null;
    }

    const factIds = row.fact_ids as string[];
    const offset = row.offset as number;
    const slice = factIds.slice(offset, offset + input.pageSize);

    if (slice.length === 0) {
      // Exhausted. Delete rather than leave a terminal row, so the next MORE is answered as
      // "nothing pending" by the same branch that answers a sender who never asked anything.
      await tx`delete from pending_result_lists where id = ${listId}`;
      return null;
    }

    const advanced = offset + slice.length;
    if (advanced >= factIds.length) {
      // The last page. The list is spent the moment it is served, so an exhausted list and a
      // list that never existed stay the same thing to the layer above.
      await tx`delete from pending_result_lists where id = ${listId}`;
    } else {
      await tx`
        update pending_result_lists set "offset" = ${advanced} where id = ${listId}
      `;
    }

    return {
      factIds: slice,
      offset,
      total: factIds.length,
      itemsRequested: row.items_requested as string[],
    };
  });
}
