import type { Db } from "./index";
import type { Sql } from "./sql";

// The stock-out report waiting on one answer (B-065).
//
// Farm Friend asks "Which stand are you at?" or "What was sold out?" and, before this, stored
// nothing — so the customer's answer arrived as an unrelated message with half the report
// missing and dead-ended. This is the half that remembers.
//
// Three operations, deliberately plain:
//
//   - `savePendingStockOutReport` — a question was just asked. REPLACES whatever the sender
//     had; the unique index on `sender_hash` is what enforces one open clarification, not a
//     read followed by a write, so two messages racing cannot leave two rows behind.
//   - `readPendingStockOutReport` — the next message looks for an unfinished report.
//   - `clearPendingStockOutReport` — resolved, released, or abandoned.
//
// **Expiry is evaluated against the MESSAGE's time, never `now()`** — the same rule
// `takeNextResultPage` follows. A pass replaying a delayed inbound event must decide with the
// clock of the message it is answering.
//
// This module stores text and an opaque location id. It interprets neither: what the report
// text means, and which stand an id names, belong to the free-text path.

function driver(db: Db): Sql {
  return db.sql;
}

/** Which half of the report is still missing, and therefore what the next message supplies. */
export type PendingStockOutAwaiting = "stand" | "item";

export interface SavePendingStockOutReportInput {
  /** The sender's phone hash. The raw number never reaches this layer (Golden Rule #5). */
  senderHash: string;
  /** The reporter's ORIGINAL message — the half that would otherwise be lost. */
  reportText: string;
  awaiting: PendingStockOutAwaiting;
  /**
   * The bound stand, required when `awaiting` is `item` and forbidden otherwise.
   * `pending_stock_out_reports_awaiting_shape` refuses any other combination.
   */
  salesLocationId?: string;
  /** The inbound message's own time. */
  occurredAt: Date;
  /** How long an answer may still land, from `occurredAt`. */
  ttlMinutes: number;
}

/**
 * Save the report a clarifying question leaves behind, replacing any the sender already had.
 *
 * Both state columns move together on conflict. Writing `awaiting` without clearing
 * `sales_location_id` would leave a stale stand under `awaiting = 'stand'` — a shape the
 * CHECK refuses, so a partial update fails loudly rather than storing something incoherent.
 */
export async function savePendingStockOutReport(
  db: Db,
  input: SavePendingStockOutReportInput,
): Promise<void> {
  const expiresAt = new Date(input.occurredAt.getTime() + input.ttlMinutes * 60_000);
  await driver(db)`
    insert into pending_stock_out_reports (
      sender_hash, report_text, awaiting, sales_location_id, created_at, expires_at
    )
    values (
      ${input.senderHash}, ${input.reportText}, ${input.awaiting},
      ${input.salesLocationId ?? null}, ${input.occurredAt}, ${expiresAt}
    )
    on conflict (sender_hash) do update set
      report_text = excluded.report_text,
      awaiting = excluded.awaiting,
      sales_location_id = excluded.sales_location_id,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at
  `;
}

export interface PendingStockOutReport {
  /** The reporter's original message. Supplies the ITEM when the follow-up supplies the stand. */
  reportText: string;
  awaiting: PendingStockOutAwaiting;
  /** Present exactly when `awaiting` is `item`. */
  salesLocationId: string | null;
}

/**
 * Read the sender's unfinished report, if one is still open at the message's time.
 *
 * An expired row is indistinguishable from no row: the caller answers the message as an
 * ordinary new one, which is exactly the behavior that predates this table.
 */
export async function readPendingStockOutReport(
  db: Db,
  input: { senderHash: string; occurredAt: Date },
): Promise<PendingStockOutReport | null> {
  const rows = await driver(db)`
    select report_text, awaiting, sales_location_id
    from pending_stock_out_reports
    where sender_hash = ${input.senderHash}
      and expires_at > ${input.occurredAt}
  `;
  const row = rows[0];
  if (row === undefined) return null;
  return {
    reportText: row.report_text as string,
    awaiting: row.awaiting as PendingStockOutAwaiting,
    salesLocationId: (row.sales_location_id as string | null) ?? null,
  };
}

/** Drop the sender's pending report — resolved, released, or deliberately abandoned. */
export async function clearPendingStockOutReport(
  db: Db,
  input: { senderHash: string },
): Promise<void> {
  await driver(db)`
    delete from pending_stock_out_reports where sender_hash = ${input.senderHash}
  `;
}
