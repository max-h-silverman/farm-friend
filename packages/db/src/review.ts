import { maskPhoneSuffix } from "@farm-friend/core";
import type postgres from "postgres";
import type { Db } from "./index";

// The operator review queues (F-030): the flag rail's human half, and the reader customer
// stock-out reports never had.
//
// This module is the sibling of `admin.ts` and deliberately repeats its two disciplines rather
// than inventing new ones:
//
//   - **Authority is re-read inside the transaction that writes.** A principal proves who the
//     caller was when the request started; only the locked row proves who they are now.
//   - **The audit event commits with the act or not at all.** A disposition whose actor was
//     not recorded is exactly what the audit trail exists to prevent.
//
// Two properties are specific to this file:
//
// **Disposing a flag is what lets retention terminate.** F-026's purge exempts a body whose
// inbox event carries an OPEN flag, and the exemption fails safe. Before this module nothing
// moved a flag out of `open`, so a flagged body retained indefinitely. `disposeFlag` is the
// path that ends the exemption — and because the predicate is `status = 'open'`, DISMISSAL
// ends it as surely as resolution does.
//
// **Nothing here can change what a stand shows (Golden Rule #1).** Every statement below
// touches `flags`, `stock_out_reports`, and `audit_events` and nothing else. A customer's
// report is a private signal that prompts the farmer; an operator triaging it records that a
// human looked, never that the listing changed. There is no write path from this file to
// `inventory_revisions` or `inventory_entries`, and the integration suite proves it by
// snapshotting every published record across every action here.
//
// **Phones are masked at the QUERY, not in the renderer.** Each projection selects
// `right(phone_e164, 4)`, so the full number is never materialized in application memory and
// the admin surface never becomes a second reader of the send path's column.

type Sql = ReturnType<typeof postgres>;

function driver(db: Db): Sql {
  return db.sql;
}

/** Which slice of a queue to read. `all` includes already-disposed/triaged rows. */
export type ReviewQueueFilter = "open" | "all";

export interface FlagReviewRow {
  flagId: string;
  /** The last four digits of the sender's number, already masked. Never the number. */
  senderMask: string;
  reasonCode: string;
  status: "open" | "resolved" | "dismissed";
  dispositionCode: string | null;
  disposedByEmail: string | null;
  disposedAt: Date | null;
  createdAt: Date;
  /** Whether the flagged thread still has readable context to review. */
  hasReadableThread: boolean;
}

/**
 * The flag queue. Oldest first: the flag that has waited longest is the one a safety rail is
 * failing, so it belongs at the top rather than the bottom.
 */
export async function listFlagsForReview(
  db: Db,
  input: { status: ReviewQueueFilter },
): Promise<FlagReviewRow[]> {
  const openOnly = input.status === "open";
  const rows = await driver(db)`
    select
      flag.id,
      -- Masked in SQL: the full number never leaves the database.
      right(contact.phone_e164, 4) as sender_last_four,
      flag.reason_code,
      flag.status,
      flag.disposition_code,
      administrator.email as disposed_by_email,
      flag.disposed_at,
      flag.created_at,
      exists (
        select 1 from provider_inbox_events event
        join sms_messages message on message.id = event.message_id
        where event.id = flag.inbox_event_id and message.body is not null
      ) as has_readable_thread
    from flags as flag
    left join contacts as contact on contact.phone_hash = flag.contact_hash
    left join administrators as administrator
      on administrator.id = flag.disposed_by_administrator_id
    where ${openOnly ? driver(db)`flag.status = 'open'` : driver(db)`true`}
    order by flag.created_at asc, flag.id asc
  `;

  return rows.map((row) => ({
    flagId: row.id as string,
    senderMask: maskPhoneSuffix((row.sender_last_four as string | null) ?? null),
    reasonCode: row.reason_code as string,
    status: row.status as FlagReviewRow["status"],
    dispositionCode: (row.disposition_code as string | null) ?? null,
    disposedByEmail: (row.disposed_by_email as string | null) ?? null,
    disposedAt:
      row.disposed_at === null ? null : new Date(row.disposed_at as string),
    createdAt: new Date(row.created_at as string),
    hasReadableThread: row.has_readable_thread as boolean,
  }));
}

export interface DisposeFlagInput {
  flagId: string;
  administratorId: string;
  /** What the operator decided. Both END the retention exemption; neither is a soft state. */
  disposition: "resolved" | "dismissed";
  /** Why, in the operator's words-as-code. Free text is the caller's; it is never a phone. */
  dispositionCode: string;
  occurredAt: Date;
}

export type DisposeFlagResult =
  | { status: "disposed" }
  | { status: "already_disposed" }
  | { status: "unknown_flag" }
  | { status: "not_an_administrator" };

/**
 * Close a flag, recording who decided and when.
 *
 * This is the write that makes the FLAG safety rail real: a registered 10DLC commitment whose
 * human half did not exist, so an arriving flag was durable and unreviewable.
 *
 * It is also the write that lets F-026's retention purge terminate. The exemption is keyed on
 * `status = 'open'`, so the instant this commits the thread's expired bodies become eligible —
 * there is no grace period, because no consumer needs one and an unowned window would be
 * speculative state (DATA_ARCHITECTURE.md §privacy).
 *
 * Disposal happens EXACTLY ONCE. The flag row is locked and its status re-read under that
 * lock, so concurrent operators cannot both record a disposition, and a second attempt is
 * refused rather than silently overwriting the first operator's recorded decision.
 */
export async function disposeFlag(
  db: Db,
  input: DisposeFlagInput,
): Promise<DisposeFlagResult> {
  return driver(db).begin(async (tx) => {
    const administrator = await tx`
      select id from administrators
      where id = ${input.administratorId} and revoked_at is null
      for update
    `;
    if (administrator.length === 0) {
      return { status: "not_an_administrator" as const };
    }

    // The lock is what makes "exactly once" true under contention: the losing transaction
    // waits here and then reads the winner's committed status below.
    const existing = await tx`
      select status from flags where id = ${input.flagId} for update
    `;
    const flag = existing[0];
    if (flag === undefined) return { status: "unknown_flag" as const };
    if (flag.status !== "open") return { status: "already_disposed" as const };

    await tx`
      update flags
      set status = ${input.disposition},
          disposition_code = ${input.dispositionCode},
          disposed_by_administrator_id = ${input.administratorId},
          disposed_at = ${input.occurredAt.toISOString()}
      where id = ${input.flagId}
    `;

    await tx`
      insert into audit_events (action, actor_administrator_id, subject_type, subject_id,
        occurred_at)
      values (
        ${input.disposition === "resolved" ? "flag_resolved" : "flag_dismissed"},
        ${input.administratorId}, 'flag', ${input.flagId},
        ${input.occurredAt.toISOString()}
      )
    `;

    return { status: "disposed" as const };
  });
}

export interface ThreadMessage {
  messageId: string;
  receivedAt: Date;
  /** The retained body, or null once retention has cleared it. */
  body: string | null;
  /** True when the message existed but its body has been purged — not "the message was blank." */
  bodyPurged: boolean;
  /** True for the message this flag was raised on. */
  isFlagged: boolean;
}

export interface FlaggedThread {
  flagId: string;
  senderMask: string;
  status: "open" | "resolved" | "dismissed";
  reasonCode: string;
  createdAt: Date;
  messages: ThreadMessage[];
}

/**
 * Read the flagged thread an operator is reviewing.
 *
 * A "thread" here is exactly the flagged sender's own inbound messages — the scope the
 * documented retention exemption keeps readable. It is deliberately not a cross-sender
 * conversation view: no other person's messages are reachable from a flag, which is why the
 * suite asserts an unrelated sender's message never appears.
 *
 * The sender is masked at the query. A body that retention has already cleared is reported as
 * `bodyPurged` rather than as an empty message, because an operator must be able to tell
 * "deleted on schedule" from "they sent nothing."
 *
 * What is NOT redacted: whatever the sender voluntarily typed. That text is the thing under
 * review, and redacting it would defeat the rail. Farm Friend claims no general detector for
 * content a sender chose to send (Golden Rule #6); the guarantee is over OUR identifiers.
 */
export async function readFlaggedThread(
  db: Db,
  input: { flagId: string },
): Promise<FlaggedThread | null> {
  const sql = driver(db);

  const flags = await sql`
    select
      flag.id, flag.contact_hash, flag.inbox_event_id, flag.reason_code,
      flag.status, flag.created_at,
      right(contact.phone_e164, 4) as sender_last_four
    from flags as flag
    left join contacts as contact on contact.phone_hash = flag.contact_hash
    where flag.id = ${input.flagId}
  `;
  const flag = flags[0];
  if (flag === undefined) return null;

  const senderHash = flag.contact_hash as string | null;

  // A flag with no sender has no thread to show. It is still a legal row (the column is
  // nullable), so the honest answer is a flag with an empty thread rather than an error.
  const messages =
    senderHash === null
      ? []
      : await sql`
          select
            message.id, message.received_at, message.body,
            event.id as inbox_event_id
          from sms_messages as message
          left join provider_inbox_events as event on event.message_id = message.id
          where message.sender_hash = ${senderHash}
          order by message.received_at asc, message.id asc
        `;

  return {
    flagId: flag.id as string,
    senderMask: maskPhoneSuffix((flag.sender_last_four as string | null) ?? null),
    status: flag.status as FlaggedThread["status"],
    reasonCode: flag.reason_code as string,
    createdAt: new Date(flag.created_at as string),
    messages: messages.map((row) => ({
      messageId: row.id as string,
      receivedAt: new Date(row.received_at as string),
      body: (row.body as string | null) ?? null,
      bodyPurged: row.body === null,
      isFlagged: row.inbox_event_id === flag.inbox_event_id,
    })),
  };
}

export interface StandDataFlagRow {
  flagId: string;
  salesLocationId: string;
  standName: string;
  reason: string;
  /** The export text that needs a human decision, verbatim. */
  sourceText: string;
  resolutionNote: string | null;
  resolvedByEmail: string | null;
  resolvedAt: Date | null;
  createdAt: Date;
}

/**
 * The stand-data flag queue (F-037): the seeder's unresolved questions about VIGA's export —
 * contradictory hours, an unresolvable season, a possible closure. Until this reader the
 * seeded flags were visible only by SQL. Oldest first, like every queue here.
 *
 * Nothing in these rows is private: the source text is VIGA's own published description,
 * already contact-stripped at seed time, and the resolver is named by email like every other
 * disposition.
 */
export async function listStandDataFlags(
  db: Db,
  input: { status: ReviewQueueFilter },
): Promise<StandDataFlagRow[]> {
  const openOnly = input.status === "open";
  const rows = await driver(db)`
    select
      flag.id, flag.sales_location_id, flag.reason, flag.source_text,
      flag.resolution_note, flag.resolved_at, flag.created_at,
      location.name as stand_name,
      administrator.email as resolved_by_email
    from stand_data_flags as flag
    join sales_locations as location on location.id = flag.sales_location_id
    left join administrators as administrator
      on administrator.id = flag.resolved_by_administrator_id
    where ${openOnly ? driver(db)`flag.resolved_at is null` : driver(db)`true`}
    order by flag.created_at asc, flag.id asc
  `;

  return rows.map((row) => ({
    flagId: row.id as string,
    salesLocationId: row.sales_location_id as string,
    standName: row.stand_name as string,
    reason: row.reason as string,
    sourceText: row.source_text as string,
    resolutionNote: (row.resolution_note as string | null) ?? null,
    resolvedByEmail: (row.resolved_by_email as string | null) ?? null,
    resolvedAt:
      row.resolved_at === null ? null : new Date(row.resolved_at as string),
    createdAt: new Date(row.created_at as string),
  }));
}

export interface ResolveStandDataFlagInput {
  flagId: string;
  administratorId: string;
  /** What the operator decided, in their own words. Required: a bare "resolved" with no
   *  record of the decision would make the queue a dismiss button. */
  resolutionNote: string;
  occurredAt: Date;
}

export type ResolveStandDataFlagResult =
  | { status: "resolved" }
  | { status: "already_resolved" }
  | { status: "unknown_flag" }
  | { status: "not_an_administrator" };

/**
 * Resolve a stand-data flag, recording who decided what and when.
 *
 * Resolution records a DECISION about the data question; it deliberately cannot act on it.
 * There is no write path from here to `sales_locations`, `sales_location_offerings`, or
 * inventory — the temptation is "fix the hours while I'm here", and an operator edit to a
 * listing is a different, not-yet-built capability with its own authority story. The
 * integration suite pins this with a byte-equality snapshot of the whole listing.
 *
 * Resolution happens EXACTLY ONCE, under the same lock discipline as `disposeFlag`: the row
 * is locked, `resolved_at` re-read under that lock, and a second operator is refused rather
 * than silently overwriting the first operator's recorded decision.
 */
export async function resolveStandDataFlag(
  db: Db,
  input: ResolveStandDataFlagInput,
): Promise<ResolveStandDataFlagResult> {
  return driver(db).begin(async (tx) => {
    const administrator = await tx`
      select id from administrators
      where id = ${input.administratorId} and revoked_at is null
      for update
    `;
    if (administrator.length === 0) {
      return { status: "not_an_administrator" as const };
    }

    const existing = await tx`
      select resolved_at from stand_data_flags where id = ${input.flagId} for update
    `;
    const flag = existing[0];
    if (flag === undefined) return { status: "unknown_flag" as const };
    if (flag.resolved_at !== null) return { status: "already_resolved" as const };

    await tx`
      update stand_data_flags
      set resolution_note = ${input.resolutionNote},
          resolved_by_administrator_id = ${input.administratorId},
          resolved_at = ${input.occurredAt.toISOString()}
      where id = ${input.flagId}
    `;

    await tx`
      insert into audit_events (action, actor_administrator_id, subject_type, subject_id,
        occurred_at)
      values (
        'stand_data_flag_resolved', ${input.administratorId}, 'stand_data_flag',
        ${input.flagId}, ${input.occurredAt.toISOString()}
      )
    `;

    return { status: "resolved" as const };
  });
}

export interface StockOutReportRow {
  reportId: string;
  farmId: string;
  farmName: string;
  salesLocationId: string;
  salesLocationName: string;
  /** The item, whether the report referenced a published entry or named an unlisted one. */
  itemText: string;
  status: "open" | "reviewed" | "dismissed";
  reviewedByEmail: string | null;
  reviewedAt: Date | null;
  reportedAt: Date;
}

/**
 * The stock-out report queue: what customers privately reported, per farm.
 *
 * These rows accumulated with no reader at all, which meant a farmer's prompt could go
 * unanswered with nobody able to notice. This is the reader.
 *
 * A report stores no reporter — there is no column for one, and this query deliberately joins
 * nowhere that could acquire a phone. What an operator needs is which farm, which stand, and
 * what item; who said so is not part of the job (Golden Rule #5).
 *
 * `itemText` resolves the referenced entry's name when the report pointed at published
 * inventory, because an operator reading a bare entry UUID learns nothing actionable.
 */
export async function listStockOutReports(
  db: Db,
  input: { status: ReviewQueueFilter },
): Promise<StockOutReportRow[]> {
  const openOnly = input.status === "open";
  const rows = await driver(db)`
    select
      report.id, report.status, report.reported_at, report.reviewed_at,
      coalesce(entry.item_name, report.unlisted_item_text) as item_text,
      location.id as sales_location_id, location.name as sales_location_name,
      farm.id as farm_id, farm.name as farm_name,
      administrator.email as reviewed_by_email
    from stock_out_reports as report
    join sales_locations as location on location.id = report.sales_location_id
    join farms as farm on farm.id = location.farm_id
    left join inventory_entries as entry
      on entry.id = report.referenced_inventory_entry_id
    left join administrators as administrator
      on administrator.id = report.reviewed_by_administrator_id
    where ${openOnly ? driver(db)`report.status = 'open'` : driver(db)`true`}
    order by report.reported_at asc, report.id asc
  `;

  return rows.map((row) => ({
    reportId: row.id as string,
    farmId: row.farm_id as string,
    farmName: row.farm_name as string,
    salesLocationId: row.sales_location_id as string,
    salesLocationName: row.sales_location_name as string,
    itemText: row.item_text as string,
    status: row.status as StockOutReportRow["status"],
    reviewedByEmail: (row.reviewed_by_email as string | null) ?? null,
    reviewedAt:
      row.reviewed_at === null ? null : new Date(row.reviewed_at as string),
    reportedAt: new Date(row.reported_at as string),
  }));
}

export interface TriageStockOutReportInput {
  reportId: string;
  administratorId: string;
  status: "reviewed" | "dismissed";
  occurredAt: Date;
}

export type TriageStockOutReportResult =
  | { status: "triaged" }
  | { status: "already_triaged" }
  | { status: "unknown_report" }
  | { status: "not_an_administrator" };

/**
 * Mark a stock-out report reviewed or dismissed, recording who acted.
 *
 * Triage records that a human looked. It does NOT change the listing — not the entry the
 * report referenced, not the revision, not ranking (Golden Rule #1). The temptation this
 * forecloses is real and specific: "the customer said it is out, so remove the item." Only
 * the farmer's confirmed revision through the ordinary proposal flow changes publication;
 * the report's job is to prompt them.
 */
export async function triageStockOutReport(
  db: Db,
  input: TriageStockOutReportInput,
): Promise<TriageStockOutReportResult> {
  return driver(db).begin(async (tx) => {
    const administrator = await tx`
      select id from administrators
      where id = ${input.administratorId} and revoked_at is null
      for update
    `;
    if (administrator.length === 0) {
      return { status: "not_an_administrator" as const };
    }

    const existing = await tx`
      select status from stock_out_reports where id = ${input.reportId} for update
    `;
    const report = existing[0];
    if (report === undefined) return { status: "unknown_report" as const };
    if (report.status !== "open") return { status: "already_triaged" as const };

    await tx`
      update stock_out_reports
      set status = ${input.status},
          reviewed_by_administrator_id = ${input.administratorId},
          reviewed_at = ${input.occurredAt.toISOString()}
      where id = ${input.reportId}
    `;

    await tx`
      insert into audit_events (action, actor_administrator_id, subject_type, subject_id,
        occurred_at)
      values (
        ${
          input.status === "reviewed"
            ? "stock_out_report_reviewed"
            : "stock_out_report_dismissed"
        },
        ${input.administratorId}, 'stock_out_report', ${input.reportId},
        ${input.occurredAt.toISOString()}
      )
    `;

    return { status: "triaged" as const };
  });
}
