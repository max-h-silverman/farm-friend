import type { Db } from "./index";
import type { Sql } from "./sql";

// The issue report waiting on the sender's YES (B-091).
//
// Farm Friend can RECOGNISE that a message reports a problem with our own information. That
// recognition is a model judgement, so it commits nothing: this is where the report waits
// while the confirmation is outstanding, and code files the flag only once the sender says
// yes (Golden Rule #3). A false positive costs one question, never a false report in VIGA's
// queue.
//
// Three operations, deliberately the same three `pending-stock-out-report.ts` has:
//
//   - `savePendingIssueReport` — a confirmation was just asked for. REPLACES whatever the
//     sender had; the unique index on `sender_hash` is the arbiter, not a read-then-write, so
//     two messages racing cannot leave two rows for one YES to choose between.
//   - `readPendingIssueReport` — a YES arrives and needs to know what it confirms.
//   - `clearPendingIssueReport` — confirmed, declined, or abandoned.
//
// **Expiry is evaluated against the MESSAGE's time, never `now()`.** A pass replaying a
// delayed inbound event must decide with the clock of the message it is answering.
//
// This module stores text and interprets none of it. What the report MEANS is VIGA's to read.

function driver(db: Db): Sql {
  return db.sql;
}

export interface PendingIssueReport {
  reportText: string;
  inboxEventId: string;
}

export interface SavePendingIssueReportInput {
  /** The sender's phone hash. The raw number never reaches this layer (Golden Rule #5). */
  senderHash: string;
  /** The reporter's own message — the sentence that says what is wrong. */
  reportText: string;
  /** The inbound event it arrived on, so a filed flag can point at the thread. */
  inboxEventId: string;
  /** The inbound message's own time. */
  occurredAt: Date;
  /** How long a confirmation may still land, from `occurredAt`. */
  ttlMinutes: number;
}

/** Save the report a confirmation question leaves behind, replacing any the sender had. */
export async function savePendingIssueReport(
  db: Db,
  input: SavePendingIssueReportInput,
): Promise<void> {
  const expiresAt = new Date(input.occurredAt.getTime() + input.ttlMinutes * 60_000);
  await driver(db)`
    insert into pending_issue_reports (
      sender_hash, report_text, inbox_event_id, created_at, expires_at
    )
    values (
      ${input.senderHash}, ${input.reportText}, ${input.inboxEventId},
      ${input.occurredAt}, ${expiresAt}
    )
    on conflict (sender_hash) do update set
      report_text = excluded.report_text,
      inbox_event_id = excluded.inbox_event_id,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at
  `;
}

/** What the sender's YES would confirm, or null when nothing is open or it has expired. */
export async function readPendingIssueReport(
  db: Db,
  input: { senderHash: string; occurredAt: Date },
): Promise<PendingIssueReport | null> {
  const rows = await driver(db)`
    select report_text, inbox_event_id
    from pending_issue_reports
    where sender_hash = ${input.senderHash}
      and expires_at > ${input.occurredAt}
  `;
  const row = rows[0];
  if (row === undefined) return null;
  return {
    reportText: row.report_text as string,
    inboxEventId: row.inbox_event_id as string,
  };
}

/** Drop the sender's pending report — confirmed, declined, or abandoned. */
export async function clearPendingIssueReport(
  db: Db,
  input: { senderHash: string },
): Promise<void> {
  await driver(db)`
    delete from pending_issue_reports where sender_hash = ${input.senderHash}
  `;
}
