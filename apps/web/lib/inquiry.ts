import {
  isBroadAvailabilityRequest,
  rankCandidates,
  renderClarificationRequest,
  renderInterpreterUnavailable,
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
  type InterpretedIntent,
  type PageableFact,
  type RetrievedFact,
} from "@farm-friend/core";
import type { InquiryModel } from "@farm-friend/ai";
import { savePendingResultList, visibleFarms, type Db } from "@farm-friend/db";
import { readPublicClosure } from "./closure-projection";

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
 * Whether this SENDER may see test farms (F-074).
 *
 * A resolved boolean by the time it reaches retrieval, and that is the containment. Whether a
 * sender is privileged is CODE's decision from the sender hash, made before any model call; the
 * model never learns it, never sees the hash, and cannot influence it. Nothing downstream can
 * escalate a fact it was never given.
 *
 * Required rather than optional, unlike the web's scope. A caller that forgets it on the map
 * shows a fake farm to a browser; a caller that forgets it here answers a stranger's text about
 * one — and the compiler is the only thing that reliably notices a new call site.
 */
export interface SmsViewerScope {
  includeTestFarms: boolean;
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
 * Derive the offering candidate's identifier for a location.
 *
 * One location can be a candidate on BOTH bases — confirmed stock and a standing offering —
 * and the model hands back identifiers, so the two must not collide. The confirmed fact keeps
 * the bare location id; this derives the offering's.
 *
 * **It must carry no structure the model could try to reconstruct (B-049).** The previous
 * scheme was `offering-<locationId>`, and measured against the live model and the production
 * corpus the model dropped the prefix and returned the bare uuid — 11 of 11 invalid
 * identifiers in that run were this single mistake. Code refused each one correctly, so
 * nothing false was ever rendered, but the customer lost a real answer every time, and 33 of
 * 48 candidates are offering-only stands, so most questions were exposed to it.
 *
 * A fact identifier is an OPAQUE TOKEN to copy back verbatim, and an opaque token with a
 * meaningful prefix invites exactly the editing that broke this. Flipping the uuid's variant
 * nibble keeps every property that matters — deterministic, so a `MORE` replay dereferences
 * to the same row; collision-free against the bare id; and `assertOpaqueId`-shaped — while
 * leaving nothing a model would think to normalize away.
 *
 * `basis` is unaffected: it already travels to the model as its own typed field, which is
 * what made the prefix redundant as well as fragile.
 */
const OFFERING_VARIANT_NIBBLE: Record<string, string> = {
  "8": "c",
  "9": "d",
  a: "e",
  b: "f",
};

export function offeringFactId(locationId: string): string {
  const nibble = OFFERING_VARIANT_NIBBLE[locationId[19] ?? ""];
  if (nibble === undefined) {
    // Not a v4 uuid — the seeded short ids some suites use. Fall back to a suffix, which is
    // still a single token and still collision-free, and is never seen in production.
    return `${locationId}z`;
  }
  return `${locationId.slice(0, 19)}${nibble}${locationId.slice(20)}`;
}

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
async function retrieveCurrentListings(
  db: Db,
  at: Date,
  scope: SmsViewerScope,
): Promise<LocationRow[]> {
  const rows = await db.sql.unsafe(`
    select
      l.id as location_id,
      l.name as location_name,
      -- F-088 — a hidden address never leaves the database on an answer path. Suppressed
      -- HERE rather than at the renderer so no downstream reader can print it by
      -- accident; the paging renderer already shows a null address as "address not listed".
      case when l.address_public then l.public_address else null end as public_address,
      f.name as farm_name,
      r.published_at as published_at,
      e.item_name as item_name,
      e.quantity as quantity,
      e.unit as unit,
      e.price_text as price_text,
      e.approximation as approximation,
      e.sort_order as sort_order,
      c.result as closure_result,
      c.closure_kind as closure_kind,
      c.starts_on::text as closure_starts_on,
      c.closed_through::text as closure_closed_through
    from sales_locations l
    join farms f on f.id = l.owner_farm_id
    join inventory_revisions r
      on r.sales_location_id = l.id and r.is_current
    join inventory_entries e on e.inventory_revision_id = r.id
    left join closure_revisions c
      on c.sales_location_id = l.id and c.is_current
    -- F-071 — a stand VIGA retired leaves SMS retrieval too, not just the map. Both surfaces
    -- run their own SQL, so the map's filter proves nothing about this one; the failure it
    -- guards against is a text reply sending someone to a stand that has been taken down.
    --
    -- F-074 — and a test farm leaves it unless this SENDER is privileged. The filter is in
    -- RETRIEVAL, which is what makes "the model cannot name a test farm however directly it is
    -- asked" true rather than promised: the model only ever selects from what came back here.
    where l.is_public and l.retired_at is null
      and ${visibleFarms("f", scope.includeTestFarms)}
    order by l.id asc, e.sort_order asc
  `);

  const byLocation = new Map<string, LocationRow>();
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    if (readPublicClosure(row, at)?.state === "active") continue;
    const locationId = row.location_id as string;

    let entry = byLocation.get(locationId);
    if (!entry) {
      entry = {
        factId: locationId,
        farmName: row.farm_name as string,
        locationName: row.location_name as string,
        // `as string` was a lie even before F-088 — the column has been nullable since
        // F-038, and the cast is what let the literal "null" reach customers once
        // (F-046). A hidden address now arrives null on this path too.
        publicAddress: row.public_address as string | null,
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
  const offeringRows = await db.sql.unsafe(`
    select
      l.id as location_id,
      l.name as location_name,
      -- F-088 — a hidden address never leaves the database on an answer path. Suppressed
      -- HERE rather than at the renderer so no downstream reader can print it by
      -- accident; the paging renderer already shows a null address as "address not listed".
      case when l.address_public then l.public_address else null end as public_address,
      f.name as farm_name,
      l.created_at as created_at,
      o.display_name as item,
      o.sort_order as sort_order,
      c.result as closure_result,
      c.closure_kind as closure_kind,
      c.starts_on::text as closure_starts_on,
      c.closed_through::text as closure_closed_through
    from sales_locations l
    join farms f on f.id = l.owner_farm_id
    -- F-066 — usually_carried in the JOIN, not a WHERE: an item that exists only because a
    -- past revision named it must not enter the offerings half of retrieval, or a customer
    -- would be told a stand usually sells something nobody ever said that about.
    join stand_items o on o.sales_location_id = l.id and o.usually_carried
    left join closure_revisions c
      on c.sales_location_id = l.id and c.is_current
    -- The SECOND query in this function, and it needs the F-074 filter independently. A stand
    -- with no confirmed revision reaches a customer only through this half, so filtering the
    -- confirmed query alone would hide a test farm's fresh items and publish its standing ones.
    where l.is_public and l.retired_at is null
      and ${visibleFarms("f", scope.includeTestFarms)}
    order by l.id asc, o.sort_order asc
  `);

  const offeringsByLocation = new Map<string, LocationRow>();
  for (const raw of offeringRows) {
    const row = raw as Record<string, unknown>;
    if (readPublicClosure(row, at)?.state === "active") continue;
    const locationId = row.location_id as string;

    let entry = offeringsByLocation.get(locationId);
    if (!entry) {
      entry = {
        factId: offeringFactId(locationId),
        farmName: row.farm_name as string,
        locationName: row.location_name as string,
        // `as string` was a lie even before F-088 — the column has been nullable since
        // F-038, and the cast is what let the literal "null" reach customers once
        // (F-046). A hidden address now arrives null on this path too.
        publicAddress: row.public_address as string | null,
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
  input: {
    factIds: string[];
    itemsRequested: string[];
    at: Date;
    /**
     * F-074 — re-applied on the paging path too. A saved list holds identifiers, and this
     * dereferences them through the SAME retrieval: a sender whose listing was removed between
     * the question and their `MORE` stops seeing test farms mid-conversation, and a saved id
     * cannot be replayed by anyone else into an answer they were never entitled to.
     */
    scope: SmsViewerScope;
  },
): Promise<PageableFact[]> {
  const byId = new Map(
    (await retrieveCurrentListings(db, input.at, input.scope)).map((row) => [
      row.factId,
      row,
    ]),
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
 * Three sources, in descending order of precision (F-107):
 *
 *   1. `modelMatched` — the items the MODEL says answered the request for this fact. The only
 *      source that can resolve a category question, because "butter lettuce" answers "leafy
 *      greens" by a relationship code cannot see. Already validated against this row's real
 *      item names by `validateFactSelection`, so nothing invented reaches here.
 *   2. exact name match against the requested words — what code can prove on its own.
 *   3. every item the stand publishes.
 *
 * Source 3 is the honest floor rather than a good answer: listing nothing under a stand the
 * model chose would render an empty claim. It is reached when the model said nothing and no
 * name matched — the category case on a MORE page, where the model's matches were never
 * saved. Keeping the rule in ONE function is what stops page 1 and page 2 of the same answer
 * from narrowing differently.
 */
function toPageableFact(
  row: LocationRow,
  itemsRequested: string[],
  modelMatched?: readonly string[],
): PageableFact {
  const wanted = new Set(itemsRequested.map((item) => item.trim().toLowerCase()));
  const named = row.items.filter((item) =>
    wanted.has(item.itemName.trim().toLowerCase()),
  );
  const claimed =
    modelMatched === undefined
      ? []
      : row.items.filter((item) =>
          modelMatched.some(
            (name) => name.trim().toLowerCase() === item.itemName.trim().toLowerCase(),
          ),
        );
  return {
    factId: row.factId,
    farmName: row.farmName,
    locationName: row.locationName,
    publicAddress: row.publicAddress,
    matchedItems:
      claimed.length > 0 ? claimed : named.length > 0 ? named : row.items,
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
    /** F-074 — whether this sender may see test farms. Code's decision, never the model's. */
    scope: SmsViewerScope;
  },
): Promise<InquiryOutcome> {
  // Step 2 — interpret. This call sees the question and no facts.
  const rawIntent = await deps.model.interpret({ taskText: input.taskText });

  // B-049 — no model saw the question, so the reply must not blame the customer's wording.
  // Checked before validation because "unavailable" is code's own observation about the
  // transport, never a shape a model returned, and so has no interpretation to validate.
  if (rawIntent.kind === "unavailable") {
    return { outcome: "clarification", question: renderInterpreterUnavailable() };
  }

  const intent = validateInterpretedIntent(rawIntent);
  if (!intent.ok) {
    return { outcome: "rejected", reason: intent.reason };
  }
  // B-061 defect 4 — a customer asking what there is to buy must be answered, whichever model
  // is installed. Measured live: "what do you have" came back `ambiguous` 10 runs out of 10
  // while that exact phrase sat in the instruction as never-ambiguous, and three earlier
  // instruction edits each moved which phrasings passed while regressing others. The model
  // matches the instruction's vocabulary rather than its concept, so this is a code guarantee
  // (`isBroadAvailabilityRequest`, grammar only, no food or farm words) rather than prose.
  //
  // It overrides ONLY toward answering, and only over `ambiguous`: a model that produced a
  // lookup keeps its own interpretation. The substituted intent is the same one the model
  // returns for a broad request, so the whole downstream path is unchanged — and `broad` means
  // code pages its own ranked set rather than asking the model to reproduce identifiers.
  const broadOverride =
    intent.value.kind === "ambiguous" && isBroadAvailabilityRequest(input.taskText);

  const interpreted: InterpretedIntent = broadOverride
    ? {
        kind: "lookup",
        items: ["produce"],
        ranking: "any",
        broad: true,
        outOfScopeRequest: false,
        originDependent: false,
      }
    : intent.value;

  if (interpreted.kind === "ambiguous") {
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
    interpreted.outOfScopeRequest ? RECIPE_SCOPE_STATEMENT : undefined,
    interpreted.originDependent ? ORIGIN_LIMITATION_STATEMENT : undefined,
  ].filter((note): note is string => note !== undefined);

  const withScope = (body: string): string =>
    notes.length === 0 ? body : [body, ...notes].join("\n\n");

  // Step 3 — CODE retrieves, then ranks by the validated interpretation.
  const now = deps.clock.now();
  const listings = await retrieveCurrentListings(deps.db, now, input.scope);
  const candidates: InquiryCandidate[] = listings.map((row) => ({
    factId: row.factId,
    farmName: row.farmName,
    locationName: row.locationName,
    matchedItemNames: row.items.map((item) => item.itemName),
    asOf: row.asOf,
  }));

  const ranked = rankCandidates(candidates, {
    ranking: interpreted.ranking,
    items: interpreted.items,
    ...(interpreted.farmScope !== undefined
      ? { farmScope: interpreted.farmScope }
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
      body: withScope(renderNoCurrentListing(interpreted.items)),
      selectedFactIds: [],
    };
  }

  // Every published item reaches the selection seam, not just exact string matches
  // (F-045). Narrowing the RETRIEVED SET by name equality is what made "leafy greens"
  // invisible to a stand publishing "butter lettuce": the model cannot select what it was
  // never shown. Rendering narrows separately — that rule lives in `toPageableFact`, once,
  // because a later MORE page of this same answer must obey it too.
  const itemsRequested = interpreted.items;
  const byId = new Map(listings.map((row) => [row.factId, row]));
  const retrieved: RetrievedFact[] = ranked.map((candidate) =>
    toPageableFact(byId.get(candidate.factId)!, itemsRequested),
  );

  // A general "what is available" request includes every retrieved fact by definition.
  // The deterministic ranking and display grouping already order that complete answer, so
  // the model only needs to reproduce the first page. Named-item and category questions stay
  // on the full selection path: only the model can judge their semantic matches (B-050).
  const displayOrdered = [
    ...retrieved.filter((fact) => fact.basis === "confirmed"),
    ...retrieved.filter((fact) => fact.basis === "offering"),
  ];
  const selectionCandidates = interpreted.broad
    ? displayOrdered.slice(0, PAGE_SIZE)
    : retrieved;

  // Step 4 — select. This call sees the retrieved facts and NOT the raw question.
  const rawSelection = await deps.model.select({
    items: interpreted.items,
    ranking: interpreted.ranking,
    facts: selectionCandidates.map((fact) => ({
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
    //
    // B-049 — and the two failures say DIFFERENT things, exactly as on the interpretation
    // seam above. Measured live, "who has eggs" interpreted correctly and then timed out
    // here at 20.0s; telling that customer we did not catch which item they meant is both
    // false and useless, since retrieval had already found the eggs.
    return rawSelection.reason === "invalid_output"
      ? { outcome: "rejected", reason: "selection carries only ordered fact identifiers" }
      : {
          outcome: "clarification",
          question: renderInterpreterUnavailable(),
        };
  }

  const selection = validateFactSelection(rawSelection, selectionCandidates);
  if (!selection.ok) {
    // B-061 — a MALFORMED selection must not throw away a retrieval that already succeeded.
    //
    // Found live: "got any peppers" and "eggz" both had their selection refused, and both
    // customers were told "Sorry, I did not catch which item or farm you meant" — false, since
    // code had already retrieved the peppers and the eggs. The wording blames the customer for
    // the model's bad reply.
    //
    // The distinction is what the failure REVEALS, and it is narrow on purpose. A duplicate id
    // is a model that repeated itself: it names nothing it was not shown, so there is nothing
    // to report and code's own ranking already holds a correct answer. Every other failure —
    // an invented identifier, a smuggled `answerText`, a malformed shape — is a claim about
    // facts the model was never given, and stays `rejected` so an attack remains observable.
    //
    // Not a retry: a second model call would spend the customer's latency on a path where code
    // already knows the answer. Grounding is untouched, because the model's selection is
    // discarded ENTIRELY rather than repaired — every fact below comes from `displayOrdered`,
    // which code built and ranked.
    if (selection.failure !== "duplicate_id") {
      return { outcome: "rejected", reason: selection.reason };
    }

    const fallback = displayOrdered.slice(0, PAGE_SIZE);
    const fallbackPage = renderResultPage({
      itemsRequested,
      facts: fallback,
      offset: 0,
      total: displayOrdered.length,
      clock: deps.clock,
    });

    if (fallbackPage.hasMore) {
      await savePendingResultList(deps.db, {
        senderHash: input.senderHash,
        factIds: displayOrdered.map((fact) => fact.factId),
        itemsRequested,
        shown: PAGE_SIZE,
        occurredAt: input.occurredAt,
        ttlMinutes: PENDING_LIST_TTL_MINUTES,
      });
    }

    return {
      outcome: "answered",
      body: withScope(fallbackPage.body),
      selectedFactIds: displayOrdered.map((fact) => fact.factId),
    };
  }
  if (selection.value.kind === "clarification") {
    return { outcome: "clarification", question: renderClarificationRequest() };
  }
  if (selection.value.factIds.length === 0) {
    return {
      outcome: "answered",
      body: withScope(renderNoCurrentListing(interpreted.items)),
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
  const answerFactIds = interpreted.broad
    ? [...selectedFactIds, ...displayOrdered.slice(PAGE_SIZE).map((fact) => fact.factId)]
    : selectedFactIds;
  // F-107 — re-narrow each fact to the items the MODEL said answered the request, where it
  // said. Built from `listings` rather than `retrieved` so the full published list is in hand:
  // `toPageableFact` already narrowed once on string match, and narrowing a narrowed list
  // would silently drop a category answer the model correctly identified.
  const modelMatched = selection.value.matchedItems ?? {};
  const rowByFactId = new Map(listings.map((row) => [row.factId, row]));
  const byFactId = new Map(
    retrieved.map((fact) => {
      const row = rowByFactId.get(fact.factId);
      const claimed = modelMatched[fact.factId];
      return [
        fact.factId,
        row !== undefined && claimed !== undefined
          ? toPageableFact(row, itemsRequested, claimed)
          : fact,
      ];
    }),
  );
  const selected = answerFactIds.map((factId) => byFactId.get(factId)!);
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
    selectedFactIds: answerFactIds,
  };
}
