import {
  rankCandidates,
  renderClarificationRequest,
  renderNoCurrentListing,
  renderResultPage,
  validateFactSelection,
  validateInterpretedIntent,
  ORIGIN_LIMITATION_STATEMENT,
  PAGE_SIZE,
  RECIPE_SCOPE_STATEMENT,
  type Clock,
  type FactBasis,
  type InquiryCandidate,
  type PageableFact,
  type RetrievedFact,
} from "@farm-friend/core";
import type { InquiryModel } from "@farm-friend/ai";
import { savePendingResultList, type Db } from "@farm-friend/db";

// Customer inquiry: question → code-rendered grounded answer.
//
// The sequence is fixed and code-owned (docs/AI_ARCHITECTURE.md §"Retrieval and ranking"):
//
//   1. deterministic routing has already run (compliance/confirmation never reach here)
//   2. MODEL interprets the question — what to look up, and how to order it
//   3. CODE validates that interpretation and retrieves authoritative facts
//   4. MODEL selects and orders identifiers from exactly those facts
//   5. CODE validates membership, dereferences values, and renders the answer
//
// Empty retrieval short-circuits at step 3: with nothing to select from, a model call could
// only invent, so the honest "no current listing" is rendered without one.
//
// ## Paging (F-046)
//
// Step 5 renders at most `PAGE_SIZE` stands. When the selection is longer than that, the
// ORDERED IDENTIFIERS are saved as the sender's pending list and `MORE` walks it — see
// `paging.ts`. Nothing about steps 2-4 changes: paging is a property of how the answer is
// delivered, not of how it is decided, and a `MORE` re-enters at step 5 alone.

export interface InquiryDeps {
  db: Db;
  model: InquiryModel;
  clock: Clock;
}

/**
 * How long a saved list stays pageable.
 *
 * An hour, from the PM item. The bound exists because `MORE` REPLAYS the saved list rather
 * than re-running retrieval: a stand that confirmed stock in the meantime is not on the
 * replayed page, and the older the list the more likely that is. Stale paging is worse than
 * none, because a customer cannot tell a fresh page from an hour-old replay.
 */
export const PENDING_LIST_TTL_MINUTES = 60;

export type InquiryOutcome =
  /** A code-rendered authoritative answer, ready for the outbox. */
  | { outcome: "answered"; body: string; selectedFactIds: string[] }
  /** A code-controlled question back to the customer. */
  | { outcome: "clarification"; question: string }
  /** Model output code refused; nothing is delivered as fact. */
  | { outcome: "rejected"; reason: string };

/**
 * Distinguishes an offering candidate's identifier from a confirmed one for the same
 * location. Hyphenated rather than colon-separated so it satisfies `assertOpaqueId`, the
 * projection's guard that an identifier field carries an identifier and not free text.
 */
const OFFERING_FACT_PREFIX = "offering-";

export interface LocationRow {
  factId: string;
  farmName: string;
  locationName: string;
  /**
   * Nullable, because the column is. F-045 typed this `string` and two real stands carry no
   * address, so customers were shown the literal word "null" (fixed in F-046's renderer).
   */
  publicAddress: string | null;
  asOf: Date;
  basis: FactBasis;
  items: {
    itemName: string;
    quantity?: number;
    unit?: string;
    priceText?: string;
    approximation?: "some" | "limited" | "plentiful";
  }[];
}

/**
 * Retrieve what every public location publishes — farmer-confirmed inventory AND the
 * standing offering tags.
 *
 * Offerings were invisible here until F-045, which is why every SMS question answered "no
 * stand has a current listing" while the public map showed 212 tags for the same stands:
 * production holds zero inventory revisions, so a query reading only `inventory_revisions`
 * retrieved nothing, every time, and short-circuited before any model call. The map and SMS
 * now read the same two sources.
 *
 * A location contributes at most one row per basis. Confirmed inventory and offerings are
 * kept as SEPARATE candidates rather than merged, because they support different claims and
 * the renderer must never blur them: one carries recency, the other carries none.
 *
 * Retrieval stays deliberately general — it selects rows, and the layers above order and
 * select. There is no food vocabulary or farm name in this query.
 */
async function retrieveCurrentListings(db: Db): Promise<LocationRow[]> {
  const rows = await db.sql`
    select
      l.id as location_id,
      l.name as location_name,
      l.public_address as public_address,
      f.name as farm_name,
      r.published_at as published_at,
      e.item_name as item_name,
      e.quantity as quantity,
      e.unit as unit,
      e.price_text as price_text,
      e.approximation as approximation,
      e.sort_order as sort_order
    from sales_locations l
    join farms f on f.id = l.farm_id
    join inventory_revisions r
      on r.sales_location_id = l.id and r.is_current
    join inventory_entries e on e.inventory_revision_id = r.id
    where l.is_public
    order by l.id asc, e.sort_order asc
  `;

  const byLocation = new Map<string, LocationRow>();
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    const locationId = row.location_id as string;

    let entry = byLocation.get(locationId);
    if (!entry) {
      entry = {
        factId: locationId,
        farmName: row.farm_name as string,
        locationName: row.location_name as string,
        publicAddress: row.public_address as string,
        asOf: row.published_at as Date,
        basis: "confirmed",
        items: [],
      };
      byLocation.set(locationId, entry);
    }

    entry.items.push({
      itemName: row.item_name as string,
      ...(row.quantity !== null ? { quantity: Number(row.quantity) } : {}),
      ...(row.unit !== null ? { unit: row.unit as string } : {}),
      ...(row.price_text !== null ? { priceText: row.price_text as string } : {}),
      ...(row.approximation !== null
        ? { approximation: row.approximation as "some" | "limited" | "plentiful" }
        : {}),
    });
  }

  // The offerings half. `created_at` orders these among themselves; it is never rendered,
  // because an offering is a standing description that nobody confirmed.
  const offeringRows = await db.sql`
    select
      l.id as location_id,
      l.name as location_name,
      l.public_address as public_address,
      f.name as farm_name,
      l.created_at as created_at,
      o.item as item,
      o.sort_order as sort_order
    from sales_locations l
    join farms f on f.id = l.farm_id
    join sales_location_offerings o on o.sales_location_id = l.id
    where l.is_public
    order by l.id asc, o.sort_order asc
  `;

  const offeringsByLocation = new Map<string, LocationRow>();
  for (const raw of offeringRows) {
    const row = raw as Record<string, unknown>;
    const locationId = row.location_id as string;

    let entry = offeringsByLocation.get(locationId);
    if (!entry) {
      entry = {
        // A distinct fact identifier: one location can be a candidate on both bases, and
        // the model selects identifiers, so they must not collide. The separator is a
        // hyphen because `assertOpaqueId` requires an identifier to LOOK like one — a
        // colon would be refused, correctly, as free text wearing an id's name.
        factId: `${OFFERING_FACT_PREFIX}${locationId}`,
        farmName: row.farm_name as string,
        locationName: row.location_name as string,
        publicAddress: row.public_address as string,
        asOf: row.created_at as Date,
        basis: "offering",
        items: [],
      };
      offeringsByLocation.set(locationId, entry);
    }

    entry.items.push({ itemName: row.item as string });
  }

  return [...byLocation.values(), ...offeringsByLocation.values()];
}

/**
 * Dereference saved fact identifiers to the rows they name, in the SAVED order (F-046).
 *
 * This is what makes `MORE` a replay rather than a second question. Identity and order are
 * frozen at question time — so no stand appears twice and none is skipped as ranking shifts —
 * while the VALUES are read fresh here, because the pending list deliberately stores no copy
 * of them.
 *
 * An identifier that no longer resolves is DROPPED rather than rendered from anything: a
 * stand withdrawn between two pages must not appear, and there is no stale copy it could be
 * rendered from. The caller decides what an empty page means; this only reports what still
 * exists.
 *
 * The filter is applied in code over one general retrieval rather than as an id predicate in
 * SQL, so there is exactly ONE query defining what a published fact is. A second query
 * shaped "the same but by id" is the kind of near-duplicate that drifts.
 */
export async function dereferenceFacts(
  db: Db,
  input: { factIds: string[]; itemsRequested: string[] },
): Promise<PageableFact[]> {
  const byId = new Map(
    (await retrieveCurrentListings(db)).map((row) => [row.factId, row]),
  );
  return input.factIds
    .map((factId) => byId.get(factId))
    .filter((row): row is LocationRow => row !== undefined)
    .map((row) => toPageableFact(row, input.itemsRequested));
}

/**
 * One retrieved row as the renderer needs to see it, narrowed to the items the customer
 * actually asked about.
 *
 * **The narrowing rule lives here, once, because both pages of one answer must obey it.**
 * What the model may CONSIDER is deliberately broad — every published item reaches the
 * selection seam, or "leafy greens" could never find "butter lettuce" (F-045). What a
 * customer READS about a stand should stay on topic: an answer about kale should not recite
 * the eggs.
 *
 * When no published name matches the requested words — the category case, where the
 * relationship is exactly what code cannot see — every item is shown rather than none,
 * because listing nothing under a stand the model chose would render an empty claim.
 */
function toPageableFact(row: LocationRow, itemsRequested: string[]): PageableFact {
  const wanted = new Set(itemsRequested.map((item) => item.trim().toLowerCase()));
  const named = row.items.filter((item) =>
    wanted.has(item.itemName.trim().toLowerCase()),
  );
  return {
    factId: row.factId,
    farmName: row.farmName,
    locationName: row.locationName,
    publicAddress: row.publicAddress,
    matchedItems: named.length > 0 ? named : row.items,
    asOf: row.asOf,
    basis: row.basis,
  };
}

/**
 * Answer a customer inquiry. Every factual word returned is rendered by code from typed
 * authoritative values; the model contributes interpretation and ordering only.
 */
export async function answerInquiry(
  deps: InquiryDeps,
  input: {
    taskText: string;
    /**
     * Who asked. A result set longer than one page is saved against this hash so `MORE` can
     * continue it (F-046); a set that fits saves nothing.
     */
    senderHash: string;
    /** The inbound message's own time — what the saved list's expiry is measured from. */
    occurredAt: Date;
  },
): Promise<InquiryOutcome> {
  // Step 2 — interpret. This call sees the question and no facts.
  const rawIntent = await deps.model.interpret({ taskText: input.taskText });

  const intent = validateInterpretedIntent(rawIntent);
  if (!intent.ok) {
    return { outcome: "rejected", reason: intent.reason };
  }
  if (intent.value.kind === "ambiguous") {
    // The model signalled; the words are code's.
    return { outcome: "clarification", question: renderClarificationRequest() };
  }

  // The two launch boundaries a request can cross, handled by one mechanism.
  //
  // F-018 — the request also asked for a recipe, cooking/preservation instructions, or
  // food-safety guidance.
  // F-017 — the request needs the customer's own position ("which stand is closest?"), which
  // launch does not resolve over SMS.
  //
  // In both cases the model contributes a BOOLEAN and code contributes every word. Farm
  // Friend still answers the grounded availability half from typed facts and then states the
  // boundary; it never fabricates the part it cannot support, and never returns an unranked
  // list as though it had answered "which is closest?".
  const notes = [
    intent.value.outOfScopeRequest ? RECIPE_SCOPE_STATEMENT : undefined,
    intent.value.originDependent ? ORIGIN_LIMITATION_STATEMENT : undefined,
  ].filter((note): note is string => note !== undefined);

  const withScope = (body: string): string =>
    notes.length === 0 ? body : [body, ...notes].join("\n\n");

  // Step 3 — CODE retrieves, then ranks by the validated interpretation.
  const listings = await retrieveCurrentListings(deps.db);
  const candidates: InquiryCandidate[] = listings.map((row) => ({
    factId: row.factId,
    farmName: row.farmName,
    locationName: row.locationName,
    matchedItemNames: row.items.map((item) => item.itemName),
    asOf: row.asOf,
  }));

  const ranked = rankCandidates(candidates, {
    ranking: intent.value.ranking,
    items: intent.value.items,
    ...(intent.value.farmScope !== undefined
      ? { farmScope: intent.value.farmScope }
      : {}),
  });

  if (ranked.length === 0) {
    // No grounded-selection call: there is nothing to select from, so asking a model could
    // only produce invention. The honest answer is code's.
    //
    // A recipe request with nothing available still lands here, and still gets only the
    // code-rendered "no current listing" plus the scope statement — never a model-authored
    // substitute offered in place of the facts we do not have.
    return {
      outcome: "answered",
      body: withScope(renderNoCurrentListing(intent.value.items)),
      selectedFactIds: [],
    };
  }

  // Every published item reaches the selection seam, not just exact string matches
  // (F-045). Narrowing the RETRIEVED SET by name equality is what made "leafy greens"
  // invisible to a stand publishing "butter lettuce": the model cannot select what it was
  // never shown. Rendering narrows separately — that rule lives in `toPageableFact`, once,
  // because a later MORE page of this same answer must obey it too.
  const itemsRequested = intent.value.items;
  const byId = new Map(listings.map((row) => [row.factId, row]));
  const retrieved: RetrievedFact[] = ranked.map((candidate) =>
    toPageableFact(byId.get(candidate.factId)!, itemsRequested),
  );

  // Step 4 — select. This call sees the retrieved facts and NOT the raw question.
  const now = deps.clock.now();
  const rawSelection = await deps.model.select({
    items: intent.value.items,
    ranking: intent.value.ranking,
    facts: retrieved.map((fact) => ({
      factId: fact.factId,
      farmName: fact.farmName,
      locationName: fact.locationName,
      matchedItemNames: fact.matchedItems.map((item) => item.itemName),
      // An offering has no age to report: nobody confirmed it. Sending one would let the
      // model treat a standing description as a fresh confirmation.
      ...(fact.basis === "confirmed"
        ? {
            ageHours: Math.max(
              0,
              Math.floor((now.getTime() - fact.asOf.getTime()) / 3_600_000),
            ),
          }
        : {}),
      basis: fact.basis,
    })),
  });

  // Step 5 — CODE validates membership and renders.
  if ("kind" in rawSelection && rawSelection.kind === "refused") {
    // The seam refused the model's shape. A rejected shape (typically a smuggled factual
    // string) is reported as such so an attack is observable; a transient provider error
    // asks the customer, because "no current listing" would be a factual claim we cannot
    // support from a failed call.
    return rawSelection.reason === "invalid_output"
      ? { outcome: "rejected", reason: "selection carries only ordered fact identifiers" }
      : {
          outcome: "clarification",
          question: renderClarificationRequest(),
        };
  }

  const selection = validateFactSelection(rawSelection, retrieved);
  if (!selection.ok) {
    return { outcome: "rejected", reason: selection.reason };
  }
  if (selection.value.kind === "clarification") {
    return { outcome: "clarification", question: renderClarificationRequest() };
  }
  if (selection.value.factIds.length === 0) {
    return {
      outcome: "answered",
      body: withScope(renderNoCurrentListing(intent.value.items)),
      selectedFactIds: [],
    };
  }

  // Step 5, paged (F-046). The model chose and ordered; code decides how much of that fits in
  // one message and remembers the rest.
  //
  // Ordering here is the RENDERER's rule, not a second ranking: confirmed stock leads and is
  // never paged away, because it is what the customer actually asked for. The model's order
  // is preserved within each group.
  const selectedFactIds = selection.value.factIds;
  const byFactId = new Map(retrieved.map((fact) => [fact.factId, fact]));
  const selected = selectedFactIds.map((factId) => byFactId.get(factId)!);
  const ordered = [
    ...selected.filter((fact) => fact.basis === "confirmed"),
    ...selected.filter((fact) => fact.basis === "offering"),
  ];

  const page = renderResultPage({
    itemsRequested,
    facts: ordered.slice(0, PAGE_SIZE),
    offset: 0,
    total: ordered.length,
    clock: deps.clock,
  });

  if (page.hasMore) {
    // Only a set that does not fit leaves anything behind. A list nobody can page would be
    // retained data with no reader, and case 2 says the machinery must not intrude on the
    // common small answer at all.
    await savePendingResultList(deps.db, {
      senderHash: input.senderHash,
      factIds: ordered.map((fact) => fact.factId),
      itemsRequested,
      shown: PAGE_SIZE,
      occurredAt: input.occurredAt,
      ttlMinutes: PENDING_LIST_TTL_MINUTES,
    });
  }

  return {
    outcome: "answered",
    body: withScope(page.body),
    selectedFactIds,
  };
}
