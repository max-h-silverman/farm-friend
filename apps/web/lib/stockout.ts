import type { StockOutModel } from "@farm-friend/ai";
import { renderStockOutAlert, type Clock } from "@farm-friend/core";
import {
  queueOutbox,
  readCurrentInventoryByProvider,
  type Db,
  type ProviderCurrentEntries,
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
      /**
       * The farmers prompted — one per CONTRADICTED provider (F-114 Phase C.3), and empty when
       * the report contradicts nobody. Plural because one report at a stand with two sellers
       * may honestly contradict both.
       */
      alertedRecipientHashes?: string[];
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
  /**
   * Which listing this candidate came from (F-114 Phase C.3). Never reaches the model — the
   * model sees one flat list and does not learn that a stand has several sellers, exactly as it
   * does not learn that published and usual items are two kinds.
   */
  providerId: string;
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
): Promise<{ candidates: MatchCandidate[]; byProvider: ProviderCurrentEntries[] }> {
  /*
    F-114 Phase C.3 — the candidates span EVERY live provider at the stand.

    Before C.3 this read the stand's own listing alone, so a hosted seller's bread could not be
    reported at all: the customer's word matched nothing and the report was filed as unlisted
    text with nobody told. A customer at an unattended stand names an item, never a seller, and
    this list is what makes that possible.

    Deduplication still folds case and surrounding whitespace ONLY, and it now folds ACROSS
    providers: two sellers both listing eggs offer the model one "Eggs", because the model is
    picking an item and not a seller. Which providers that item belongs to is resolved after the
    match, in code, from the same rows this list was built from — so the model never learns a
    stand has several sellers, exactly as it never learns published and usual are two kinds.
  */
  const byProvider = await readCurrentInventoryByProvider(db, { salesLocationId });
  const offerings = await db.sql`
    select id, display_name, provider_id
    from stand_items
    where sales_location_id = ${salesLocationId}
    order by sort_order asc, display_name asc
  `;

  const candidates: MatchCandidate[] = [];
  const normalize = (name: string) => name.trim().toLowerCase();
  const seen = new Set<string>();

  // Published entries first — the precedence rule is unchanged, and an entry is the better
  // reference because it carries a farmer's confirmation time for VIGA's queue.
  for (const provider of byProvider) {
    for (const entry of provider.entries) {
      if (seen.has(normalize(entry.itemName))) continue;
      seen.add(normalize(entry.itemName));
      candidates.push({
        entryId: entry.entryId,
        itemName: entry.itemName,
        kind: "inventory-entry",
        providerId: provider.providerId,
      });
    }
  }

  for (const raw of offerings) {
    const row = raw as Record<string, unknown>;
    const itemName = row.display_name as string;
    if (seen.has(normalize(itemName))) continue;
    seen.add(normalize(itemName));
    candidates.push({
      entryId: row.id as string,
      itemName,
      kind: "stand-item",
      providerId: row.provider_id as string,
    });
  }

  // The provider rows travel back with the candidates rather than being re-read at routing
  // time: the contradiction test must run against the SAME snapshot the match was made from,
  // or a revision published in between could make the matched item belong to a different set
  // of sellers than the one the customer's word was resolved against.
  return { candidates, byProvider };
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
  providerIds: readonly string[],
): Promise<string[]> {
  if (providerIds.length === 0) return [];
  /*
    ONE recipient per contradicted provider — the SELLER'S own phone, never the host's.

    §the Venison Valley case: Zoe is told about Gracie's Greens' eggs and Kelsey is not, because
    they are different sellers with different phones. The host's `host_may_update_stock` grant is
    deliberately NOT consulted: it says the host MAY state the seller's stock, not that the host
    should be woken up about it. Prompting is the seller's business.

    The earliest authorization wins per seller, as before — a stable choice rather than an
    arbitrary one when a seller has several phones.
  */
  const rows = await tx`
    select distinct on (provider.id) contact.phone_hash
    from stand_providers as provider
    join farmer_authorizations as auth on auth.seller_id = provider.seller_id
    join contacts as contact on contact.id = auth.contact_id
    where provider.id in ${tx(providerIds as string[])}
      and auth.revoked_at is null
      and auth.phone_verified_at is not null
    order by provider.id, auth.authorized_at asc
  `;
  // Sorted, and deduplicated first: one phone may be authorized for two of the contradicted
  // sellers (one phone already acts for two sellers in production), and that person must be
  // texted once. The sort makes the result independent of `provider.id`, which is random.
  return [
    ...new Set(rows.map((row) => (row as Record<string, unknown>).phone_hash as string)),
  ].sort();
}

/**
 * Which providers a report about this item CONTRADICTS.
 *
 * §customer behavior, and the whole of C.3's routing rule. Being listed in a provider's current
 * revision IS the claim "we have this out"; there is no sold-out flag, so absence from a
 * published listing is that provider already saying they are out.
 *
 *   * **listed** — contradicted. Told, whether they confirmed five minutes or three weeks ago.
 *   * **published a listing without it** — agrees. Skipped, because telling a farmer what their
 *     own listing already says is noise, and noise is what makes a farmer stop reading.
 *   * **published nothing, or carries it only as a usual item** — no dated claim exists to
 *     contradict. Never told; the report is filed for VIGA.
 *
 * The match is the same case-and-whitespace fold `stand_items_one_per_location_name` uses, and
 * it must never fold singulars into plurals or synonyms into each other — that would be a
 * produce taxonomy, which no business code here may encode.
 */
function contradictedProviders(
  byProvider: readonly ProviderCurrentEntries[],
  itemName: string,
): string[] {
  const wanted = itemName.trim().toLowerCase();
  return byProvider
    .filter((provider) =>
      provider.entries.some((entry) => entry.itemName.trim().toLowerCase() === wanted),
    )
    .map((provider) => provider.providerId);
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

  const { candidates: items, byProvider } = await listedItems(
    deps.db,
    input.salesLocationId,
  );

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
    /*
      F-114 Phase C.3 — routed by CONTRADICTION, in code, from rows code retrieved.

      An UNLISTED report contradicts nobody: no provider ever claimed the thing the customer
      named, so there is no dated claim to argue with. It is filed for VIGA and nothing is sent
      — the same silence a usual-only match gets, and for the same reason.
    */
    const recipientHashes =
      alertItem.kind === "listed"
        ? await resolveAuthorizedRecipient(
            tx,
            contradictedProviders(byProvider, alertItem.itemName),
          )
        : [];

    if (recipientHashes.length === 0) {
      // Nobody to prompt — no live claim, or no authorized farmer behind the ones there are.
      // The report still stands for VIGA's queue: a stand between farmers is exactly when a
      // stale listing needs a human to notice.
      return { outcome: "recorded" as const, reportId };
    }

    for (const recipientHash of recipientHashes) {
      await queueOutbox(tx, {
        // One alert per report PER RECIPIENT, enforced by `outbox_work`'s unique `logical_key`.
        // The hash is in the key because two sellers may both be contradicted by one report and
        // each must hear about their own goods; a report-only key would silently drop the
        // second.
        logicalKey: `stock-out-alert-${reportId}-${recipientHash}`,
        recipientHash,
        // Proactive: Farm Friend speaks first, so consent is re-read at the dispatch claim.
        messageCategory: "stock_out_alert",
        // Code-rendered from two typed facts. No customer sentence, no model prose.
        //
        // Identical for every recipient, and deliberately: §public output never attributes an
        // observation to its observer, and naming the OTHER seller contradicted by the same
        // report would tell each farmer what their neighbour has out.
        body: renderStockOutAlert({ locationName, item: alertItem }),
        now,
      });
    }

    return {
      outcome: "recorded" as const,
      reportId,
      alertedRecipientHashes: recipientHashes,
    };
  }) as Promise<StockOutOutcome>;
}
