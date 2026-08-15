import type { StockOutModel } from "@farm-friend/ai";
import { renderStockOutAlert, type Clock } from "@farm-friend/core";
import {
  queueOutbox,
  readCurrentInventory,
  readNativeProviderId,
  type Db,
} from "@farm-friend/db";

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
//
// B-057: "which item" spans both of the stand's farmer-authored item lists — what it currently
// publishes and what it usually carries. The model sees ONE flat list of opaque ids and does
// not learn that two kinds exist; code built the list, so code alone knows which is which.

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

/**
 * An item the reporter's text may be matched against, and WHICH FARM-AUTHORED ROW it names.
 *
 * The kind never reaches the model — `entryId` is opaque to it either way. It exists because
 * code, which built this list, is the only thing that knows which table an id came from, and
 * must know in order to store the right reference and dereference the right name.
 */
type MatchCandidate = {
  entryId: string;
  itemName: string;
  kind: "inventory-entry" | "stand-item";
};

/**
 * The bound location's matchable items: what it currently publishes, then what it usually
 * carries (B-057).
 *
 * **Both are farmer-authored names Farm Friend already holds and publishes**, which is what
 * makes naming either one back to the farmer safe under Golden Rule #6. Neither is model
 * prose. The model's job is unchanged — pick an identifier out of a list code built.
 *
 * Measured against the production corpus 2026-08-11: 33 of 37 stands carry at least one usual
 * offering absent from their current published inventory, and 18 of 37 publish no inventory at
 * all. Matching only the current revision made "sold out of something" the ordinary outcome.
 *
 * ORDER IS THE PRECEDENCE RULE. Published entries come first, and a name already published is
 * not offered a second time under its stand-item id: a model shown "Kale" twice is being asked
 * to flip a coin between two references to one fact, and the entry is the better reference
 * because it carries a farmer's confirmation time for VIGA's queue.
 *
 * Deduplication folds case and surrounding whitespace ONLY — the same normalization
 * `stand_items_one_per_location_name` uses. It must never fold singulars into plurals or
 * synonyms into each other; that would be a produce taxonomy, which no business code here may
 * encode.
 */
async function listedItems(
  db: Db,
  salesLocationId: string,
): Promise<MatchCandidate[]> {
  // F-114 Phase B — the stock-out matcher's candidates. Phase C.3 widens this to EVERY
  // provider whose confirmed inventory contradicts the report; Phase B keeps the native slot
  // so today's output is byte-identical.
  const providerId = await readNativeProviderId(db, { salesLocationId });
  const current = await readCurrentInventory(db, { salesLocationId, providerId });
  const offerings = await db.sql`
    select id, display_name
    from stand_items
    where sales_location_id = ${salesLocationId}
    order by sort_order asc, display_name asc
  `;

  const candidates: MatchCandidate[] = (current?.entries ?? []).map((entry) => ({
    entryId: entry.entryId,
    itemName: entry.itemName,
    kind: "inventory-entry" as const,
  }));

  const normalize = (name: string) => name.trim().toLowerCase();
  const published = new Set(candidates.map((item) => normalize(item.itemName)));

  for (const raw of offerings) {
    const row = raw as Record<string, unknown>;
    const itemName = row.display_name as string;
    if (published.has(normalize(itemName))) continue;
    candidates.push({
      entryId: row.id as string,
      itemName,
      kind: "stand-item" as const,
    });
  }

  return candidates;
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
  // The transaction handle as `queueOutbox` takes it. `Tx` is deliberately not exported from
  // the db package — transactions are owned there — so this names the shape it uses rather
  // than widening that boundary for one caller.
  tx: Parameters<typeof queueOutbox>[0],
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
  let referencedStandItemId: string | null = null;
  let unlistedText: string | null = null;
  /**
   * What the farmer's alert may say about the missing item. A LISTED match contributes the
   * stand's own name from the bound row — never the model's echo of it — whether that row is
   * a published entry or one of the stand's usual offerings. An UNLISTED one contributes no
   * text: its only description is model output derived from an anonymous stranger's message,
   * which the renderer refuses to speak in Farm Friend's voice. The stored report keeps the
   * detail for VIGA's queue.
   */
  let alertItem: { kind: "listed"; itemName: string } | { kind: "unlisted" };

  if (parsed.kind === "listed") {
    // Membership check: the id must belong to the CODE-BOUND location, because it is looked
    // up in the list code built for THIS location. A model naming an item from another farm's
    // stand finds no match here and is refused rather than recorded against this one. The
    // composite foreign keys make the same guarantee at the database, for both kinds.
    const listed = items.find((item) => item.entryId === parsed.entryId);
    if (listed === undefined) {
      return {
        outcome: "rejected",
        reason: `entry ${parsed.entryId} is not listed at the bound location`,
      };
    }
    // Which column stores it is decided HERE, from the candidate code built — never from
    // anything the model returned. The model cannot choose to be recorded as an inventory
    // entry, because it never learns that the distinction exists.
    if (listed.kind === "inventory-entry") {
      referencedEntryId = parsed.entryId;
    } else {
      referencedStandItemId = parsed.entryId;
    }
    alertItem = { kind: "listed", itemName: listed.itemName };
  } else {
    unlistedText = parsed.itemText.trim();
    if (unlistedText === "") {
      return { outcome: "unclear" };
    }
    alertItem = { kind: "unlisted" };
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
        sales_location_id, referenced_inventory_entry_id, referenced_stand_item_id,
        unlisted_item_text, status, reported_at, report_key
      )
      values (
        ${input.salesLocationId}, ${referencedEntryId}, ${referencedStandItemId},
        ${unlistedText}, 'open', ${now}, ${input.reportKey ?? null}
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
      body: renderStockOutAlert({ locationName, item: alertItem }),
      now,
    });

    return {
      outcome: "recorded" as const,
      reportId,
      alertedRecipientHash: recipientHash,
    };
  }) as Promise<StockOutOutcome>;
}
