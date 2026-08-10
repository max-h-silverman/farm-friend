import type { StockOutModel } from "@farm-friend/ai";
import { renderStockOutAlert, type Clock } from "@farm-friend/core";
import { queueOutbox, type Db, type Tx } from "@farm-friend/db";

// Customer stock-out report → private farmer alert.
//
// Golden Rule #1: the farmer owns published state. A customer report NEVER mutates inventory,
// ranking, or the map — it creates a private signal that PROMPTS the farmer. The farmer's own
// confirmed action is the only thing that changes what a stand shows.
//
// Two identifiers decide who is affected, and NEITHER may come from a model:
//   - the sales location — bound in code from the QR/web surface the reporter scanned
//   - the farmer recipient — resolved in code from that location's current authorization
//
// The model's only job is reading free text into "which item" — and even then it returns an
// opaque entry ID that must belong to the bound location, or normalized text for an unlisted
// item. It never names a location, a person, or a phone.

export interface StockOutDeps {
  db: Db;
  model: StockOutModel;
  clock: Clock;
}

export interface StockOutInput {
  /** Bound by the surface in code from the scanned QR/web route — never model output. */
  salesLocationId: string;
  /** The reporter's free text describing what was missing. */
  taskText: string;
  /**
   * A stable key for the REPORTING EVENT, when the surface has one — an inbound SMS provider
   * event id. It makes the whole workflow idempotent: a redelivered message records one
   * report and texts the farmer once, rather than once per delivery attempt.
   *
   * Optional because not every surface has one. Absent, each call is a distinct report, which
   * is correct for a web form where two submissions are two people saying the same thing.
   */
  reportKey?: string;
}

export type StockOutOutcome =
  | {
      outcome: "recorded";
      reportId: string;
      /** Present when an authorized farmer could be resolved for the bound location. */
      alertedRecipientHash?: string;
    }
  /** The text did not identify an item; nothing is recorded and no one is alerted. */
  | { outcome: "unclear" }
  | { outcome: "rejected"; reason: string };

/** The bound location's currently published entries, for matching only. */
async function listedItems(
  db: Db,
  salesLocationId: string,
): Promise<{ entryId: string; itemName: string }[]> {
  const rows = await db.sql`
    select e.id, e.item_name
    from inventory_entries e
    join inventory_revisions r on r.id = e.inventory_revision_id
    where r.sales_location_id = ${salesLocationId} and r.is_current
    order by e.sort_order asc
  `;
  return rows.map((raw) => {
    const row = raw as Record<string, unknown>;
    return { entryId: row.id as string, itemName: row.item_name as string };
  });
}

/**
 * Resolve the farmer to alert, in code, from the bound location. A location with no current
 * authorized farmer yields no recipient — the report is still recorded for VIGA review rather
 * than being routed to whoever happens to be nearby.
 *
 * Takes the caller's transaction handle so the recipient is resolved under the same snapshot
 * that writes the report and queues the alert: an authorization revoked mid-workflow must not
 * be able to land a message on a farmer who no longer owns the stand.
 */
async function resolveAuthorizedRecipient(
  tx: Tx,
  salesLocationId: string,
): Promise<string | null> {
  const rows = await tx`
    select c.phone_hash
    from sales_locations l
    join farmer_authorizations a on a.farm_id = l.owner_farm_id
    join contacts c on c.id = a.contact_id
    where l.id = ${salesLocationId}
      and a.revoked_at is null
      and a.phone_verified_at is not null
    order by a.authorized_at asc
    limit 1
  `;
  return (rows[0]?.phone_hash as string | undefined) ?? null;
}

/**
 * Record a stock-out report from the code-bound reporting surface and queue the farmer's
 * private alert. It never sends, and it never touches published inventory.
 *
 * **The report and its alert commit together** (F-104). A report with no alert is a private
 * note nobody reads — the exact gap GL-007 named, where the handler resolved a recipient and
 * dropped it. Queuing inside the same transaction as the insert makes "recorded" and "the
 * farmer was prompted" one fact rather than two that can diverge.
 *
 * Queuing is not sending: `authorizeDispatch` re-reads consent at the claim, so an alert to a
 * farmer who never opted in is SUPPRESSED there. That is deliberate and needs no special case
 * here — the report is still recorded for VIGA either way.
 */
export async function recordStockOutReport(
  deps: StockOutDeps,
  input: StockOutInput,
): Promise<StockOutOutcome> {
  // The location must exist and be a real sales location before anything else happens. Its
  // name is read here because the farmer's alert names the stand, and that name must come
  // from the bound row rather than from anything the reporter or the model supplied.
  const locations = await deps.db.sql`
    select id, name from sales_locations where id = ${input.salesLocationId}
  `;
  if (locations.length === 0) {
    return { outcome: "rejected", reason: "unknown sales location" };
  }
  const locationName = locations[0]?.name as string;

  const items = await listedItems(deps.db, input.salesLocationId);

  // The model reads free text into an item reference — and nothing else.
  const parsed = await deps.model.parseItem({
    taskText: input.taskText,
    listedItems: items,
  });

  if (parsed.kind === "unclear") {
    return { outcome: "unclear" };
  }

  let referencedEntryId: string | null = null;
  let unlistedText: string | null = null;
  /**
   * What the farmer's alert calls the missing item. For a LISTED entry this is the stand's
   * own `item_name` from the bound row — never the model's echo of it — so the alert names
   * the item as the farmer wrote it. For an unlisted one there is no row to read, and the
   * normalized text is the only description that exists.
   */
  let alertItemName: string;

  if (parsed.kind === "listed") {
    // Membership check: the entry must belong to the CODE-BOUND location. A model naming an
    // entry from another farm's stand is refused rather than recorded against this one.
    const listed = items.find((item) => item.entryId === parsed.entryId);
    if (listed === undefined) {
      return {
        outcome: "rejected",
        reason: `entry ${parsed.entryId} is not listed at the bound location`,
      };
    }
    referencedEntryId = parsed.entryId;
    alertItemName = listed.itemName;
  } else {
    unlistedText = parsed.itemText.trim();
    if (unlistedText === "") {
      return { outcome: "unclear" };
    }
    alertItemName = unlistedText;
  }

  const now = deps.clock.now();

  return deps.db.sql.begin(async (tx) => {
    /*
      Idempotency, when the surface gave us a key for the reporting event.

      `on conflict do nothing returning id` is the arbiter rather than a preceding read:
      `select … for update` cannot serialize a row that does not exist yet, so two concurrent
      redeliveries of the same inbound message would both see nothing and both insert. An
      empty result means another delivery won the race; the existing report is then read back
      and its alert is already queued (or was itself deduplicated by `logical_key`).
    */
    const inserted = await tx`
      insert into stock_out_reports (
        sales_location_id, referenced_inventory_entry_id, unlisted_item_text,
        status, reported_at, report_key
      )
      values (
        ${input.salesLocationId}, ${referencedEntryId}, ${unlistedText},
        'open', ${now}, ${input.reportKey ?? null}
      )
      on conflict (report_key) do nothing
      returning id
    `;

    if (inserted.length === 0) {
      // A redelivery. The first delivery recorded the report and queued the alert; saying
      // "recorded" is honest, and queuing again is what `logical_key` would refuse anyway.
      const existing = await tx`
        select id from stock_out_reports where report_key = ${input.reportKey ?? null}
      `;
      return {
        outcome: "recorded" as const,
        reportId: existing[0]?.id as string,
      };
    }

    const reportId = inserted[0]?.id as string;
    const recipientHash = await resolveAuthorizedRecipient(
      tx,
      input.salesLocationId,
    );

    if (recipientHash === null) {
      // No authorized farmer to prompt. The report still stands for VIGA's queue — a stand
      // between farmers is exactly when a stale listing needs a human to notice.
      return { outcome: "recorded" as const, reportId };
    }

    await queueOutbox(tx, {
      // One alert per report, enforced by `outbox_work`'s unique `logical_key`.
      logicalKey: `stock-out-alert-${reportId}`,
      recipientHash,
      // Proactive: Farm Friend speaks first, so consent is re-read at the dispatch claim.
      messageCategory: "stock_out_alert",
      // Code-rendered from two typed facts. No customer sentence, no model prose.
      body: renderStockOutAlert({ locationName, itemName: alertItemName }),
      now,
    });

    return {
      outcome: "recorded" as const,
      reportId,
      alertedRecipientHash: recipientHash,
    };
  }) as Promise<StockOutOutcome>;
}
