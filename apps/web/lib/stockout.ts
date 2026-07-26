import type { StockOutModel } from "@farm-friend/ai";
import type { Clock } from "@farm-friend/core";
import type { Db } from "@farm-friend/db";

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
 */
async function resolveAuthorizedRecipient(
  db: Db,
  salesLocationId: string,
): Promise<string | null> {
  const rows = await db.sql`
    select c.phone_hash
    from sales_locations l
    join farmer_authorizations a on a.farm_id = l.farm_id
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
 * Record a stock-out report from the code-bound reporting surface and resolve the farmer to
 * prompt. Returns the recipient hash for the caller to queue; it never sends, and it never
 * touches published inventory.
 */
export async function recordStockOutReport(
  deps: StockOutDeps,
  input: StockOutInput,
): Promise<StockOutOutcome> {
  // The location must exist and be a real sales location before anything else happens.
  const locations = await deps.db.sql`
    select id from sales_locations where id = ${input.salesLocationId}
  `;
  if (locations.length === 0) {
    return { outcome: "rejected", reason: "unknown sales location" };
  }

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

  if (parsed.kind === "listed") {
    // Membership check: the entry must belong to the CODE-BOUND location. A model naming an
    // entry from another farm's stand is refused rather than recorded against this one.
    if (!items.some((item) => item.entryId === parsed.entryId)) {
      return {
        outcome: "rejected",
        reason: `entry ${parsed.entryId} is not listed at the bound location`,
      };
    }
    referencedEntryId = parsed.entryId;
  } else {
    unlistedText = parsed.itemText.trim();
    if (unlistedText === "") {
      return { outcome: "unclear" };
    }
  }

  const inserted = await deps.db.sql`
    insert into stock_out_reports (
      sales_location_id, referenced_inventory_entry_id, unlisted_item_text,
      status, reported_at
    )
    values (
      ${input.salesLocationId}, ${referencedEntryId}, ${unlistedText},
      'open', ${deps.clock.now()}
    )
    returning id
  `;

  const recipientHash = await resolveAuthorizedRecipient(
    deps.db,
    input.salesLocationId,
  );

  return {
    outcome: "recorded",
    reportId: inserted[0]?.id as string,
    ...(recipientHash !== null ? { alertedRecipientHash: recipientHash } : {}),
  };
}
