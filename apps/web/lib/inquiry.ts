import {
  factsPerPage,
  groupFactsByStand,
  openNow,
  rankCandidates,
  renderClarificationRequest,
  renderInterpreterUnavailable,
  renderNoCurrentListing,
  renderResultPage,
  renderStandFactPage,
  renderStockAge,
  ORIGIN_LIMITATION_STATEMENT,
  PAGE_SIZE,
  MAP_INVITATION_LINE,
  RECIPE_SCOPE_STATEMENT,
  resolveStandName,
  timeZoneOffsetMinutes,
  VASHON_TIME_ZONE,
  type Clock,
  type FactBasis,
  type PageableFact,
  type RetrievedFact,
} from "@farm-friend/core";
import type {
  CatalogMatcher,
  SearchStandRequest,
  StandLookupRequest,
} from "@farm-friend/ai";
import {
  currentEntriesJoin,
  publicProviders,
  savePendingResultList,
  visibleFarms,
  type Db,
} from "@farm-friend/db";
import { readPublicClosure } from "./closure-projection";
import { listPublicStands, type PublicStand } from "./public-listing";

// Customer inquiry: question → code-rendered grounded answer.
//
// The sequence is fixed and code-owned (docs/AI_ARCHITECTURE.md §"Retrieval and ranking"):
//
//   1. deterministic routing has already run (compliance/confirmation never reach here)
//   2. the top-level MODEL call has already fixed route and operation without catalog access
//   3. CODE resolves a named stand and builds unique public item/payment catalogs
//   4. for inventory/payment only, MODEL selects catalog values in one bounded call
//   5. CODE validates membership, expands names to stands, orders, pages, and renders
//
// ## Paging (F-046)
//
// Step 4 renders at most `PAGE_SIZE` stands. When the selection is longer than that, the
// ORDERED IDENTIFIERS are saved as the sender's pending list and `MORE` walks it — see
// `paging.ts`. Nothing about steps 2-4 changes: paging is a property of how the answer is
// delivered, not of how it is decided, and a `MORE` re-enters at step 4 alone.

export interface InquiryDeps {
  db: Db;
  matcher: CatalogMatcher;
  clock: Clock;
}

export type ClassifiedInquiry =
  | { mode: "search_stands"; request: SearchStandRequest }
  | { mode: "stand_lookup"; request: StandLookupRequest };

type InquiryRequestContext = ClassifiedInquiry & {
  topic?: "viga_bucks";
  taskText: string;
  senderHash: string;
  occurredAt: Date;
  scope: SmsViewerScope;
};

/**
 * Whether this SENDER may see test sellers (F-074).
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
 * Derive the code-owned paging identifier for a location's standing offering.
 *
 * One location can contribute both a confirmed-stock row and a standing-offering row, so the
 * saved identifiers must not collide. The model never receives either identifier.
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

/**
 * The key two identifiers share when they describe the SAME stand (B-062).
 *
 * A stand can be retrieved on both bases, and `offeringFactId` derives the offering's id from
 * the confirmed one — so the relation is already encoded in the identifier and needs no
 * database round trip to recover. Normalizing to the confirmed form is that derivation read
 * backwards.
 *
 * Used to size a page in STANDS while the saved list stores facts. A page that took a flat
 * count of identifiers split a stand's two rows across two messages and printed it twice.
 */
const CONFIRMED_VARIANT_NIBBLE: Record<string, string> = { c: "8", d: "9", e: "a", f: "b" };

/**
 * The separator between a stand's fact id and the PROVIDER it belongs to (F-114 C.5).
 *
 * `@` cannot occur in a uuid, which is what makes the split unambiguous.
 */
const PROVIDER_FACT_SEPARATOR = "@";

/**
 * The paging identifier for ONE SELLER's row at a stand.
 *
 * **A suffix rather than another nibble, and that is forced.** The offering variant rewrites
 * one hex nibble inside the uuid — four values, exactly enough for "confirmed or offering". A
 * stand now has an unbounded number of sellers, so there is no nibble left and no fixed-size
 * encoding could carry a uuid anyway.
 *
 * It COMPOSES with the offering variant rather than replacing it: a seller's standing
 * offerings at a stand carry both markers, and `standKeyOfFactId` strips this suffix first and
 * then applies the nibble rule to what remains. One mechanism gained a case; nothing already
 * encoded had to be re-encoded, and every id already saved in a pending list still resolves.
 */
export function providerFactId(standFactId: string, providerId: string): string {
  return `${standFactId}${PROVIDER_FACT_SEPARATOR}${providerId}`;
}

export function standKeyOfFactId(factId: string): string {
  // The provider suffix comes off FIRST, so what remains is exactly the id the nibble rule was
  // written for. Reversing the order would leave the rule reading position 19 of a string that
  // may not be a bare uuid at all.
  const separatorAt = factId.indexOf(PROVIDER_FACT_SEPARATOR);
  const withoutProvider = separatorAt === -1 ? factId : factId.slice(0, separatorAt);
  if (withoutProvider.endsWith("z")) return withoutProvider.slice(0, -1);
  const nibble = CONFIRMED_VARIANT_NIBBLE[withoutProvider[19] ?? ""];
  if (nibble === undefined) return withoutProvider;
  return `${withoutProvider.slice(0, 19)}${nibble}${withoutProvider.slice(20)}`;
}

export type PagedStandFactKind = "payment" | "farm_bucks" | "open_now";
const PAGED_STAND_FACT_PREFIX = "stand-fact:";

/** Keep a non-inventory page typed while the pending-list table treats every id as opaque. */
export function pagedStandFactId(kind: PagedStandFactKind, standId: string): string {
  return `${PAGED_STAND_FACT_PREFIX}${kind}:${standId}`;
}

export function parsePagedStandFactId(
  value: string,
): { kind: PagedStandFactKind; standId: string } | undefined {
  if (!value.startsWith(PAGED_STAND_FACT_PREFIX)) return undefined;
  const rest = value.slice(PAGED_STAND_FACT_PREFIX.length);
  const split = rest.indexOf(":");
  if (split < 1) return undefined;
  const kind = rest.slice(0, split);
  if (kind !== "payment" && kind !== "farm_bucks" && kind !== "open_now") return undefined;
  const standId = rest.slice(split + 1);
  return standId === "" ? undefined : { kind, standId };
}

interface SelectableStand {
  /** The real location id used for deterministic ordering and paging. */
  fact: RetrievedFact;
  /** Separate authoritative voices retained for code-owned rendering. */
  evidence: RetrievedFact[];
}

/**
 * Collapse confirmed inventory and standing offerings into one result entry per stand.
 *
 * Relevance is a question about the stand and item, not about which evidence type code should
 * disclose. B-068 proved the distinction: the old model selected Forest Garden's usual
 * cucumber offering but omitted its confirmed cucumber. Code now retains both evidence voices
 * whenever their shared catalog name was selected.
 */
function groupSelectableStands(facts: RetrievedFact[]): SelectableStand[] {
  const groups: SelectableStand[] = [];
  const byStandId = new Map<string, SelectableStand>();

  for (const evidence of facts) {
    const standId = standKeyOfFactId(evidence.factId);
    let group = byStandId.get(standId);
    if (group === undefined) {
      group = {
        fact: { ...evidence, factId: standId, matchedItems: [] },
        evidence: [],
      };
      byStandId.set(standId, group);
      groups.push(group);
    }
    group.evidence.push(evidence);

    const existing = new Set(
      group.fact.matchedItems.map((item) => item.itemName.trim().toLowerCase()),
    );
    for (const item of evidence.matchedItems) {
      const key = item.itemName.trim().toLowerCase();
      if (!existing.has(key)) {
        group.fact.matchedItems.push(item);
        existing.add(key);
      }
    }
  }

  return groups;
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
export async function retrieveSmsListings(
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
      -- THE PROVIDER'S SELLER, not the stand's (F-115). This row IS one seller's claim, so the
      -- name on it has to be that seller's — reading the stand's own_seller_id credited a
      -- hosted seller's confirmed goods to the host, and at a VENUE, where the self-pointer is
      -- NULL, the inner join it required dropped the entire stand out of SMS answers.
      provider_seller.name as farm_name,
      provider.id as provider_id,
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
    -- LEFT, and that is the F-115 fix rather than a loosening. A VENUE has no own_seller_id —
    -- Morgan Hill is a place several farmers sell at and nobody's farm — so an INNER join here
    -- deleted every venue from SMS answers entirely. The alias survives only to carry the
    -- stand-owner visibility rule in the where clause; nothing is projected from it.
    left join sellers f on f.id = l.own_seller_id
    /*
      PER PROVIDER (F-114 C.5), not per stand.

      This used to join the current revision on the STAND, which after Phase B returns every
      seller's entries interleaved under whichever published_at the loop saw first — one
      farmer's goods dated by another's update, on the answer path, with nothing erroring.

      The join is INNER on both the provider and the revision, deliberately: a seller with no
      confirmed revision reaches a customer through the offerings half below, never as an empty
      confirmed listing. Pending and ended relationships are excluded here exactly as they are
      from the map, so the two channels cannot disagree about who is selling.
    */
    join stand_providers provider
      on provider.sales_location_id = l.id
     and ${publicProviders("provider")}
    -- The SELLER's own visibility, applied in the where clause below. A hosted seller VIGA
    -- retired leaves every stand they sold at, not only their own.
    join sellers provider_seller on provider_seller.id = provider.seller_id
    -- B-074 — the currency rule still comes from the shared predicate; what changed is the KEY
    -- it is applied on.
    inner join inventory_revisions r
      on r.provider_id = provider.id and r.is_current
    ${currentEntriesJoin({ revisionAlias: "r", entryAlias: "e", kind: "inner" })}
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
      -- The PROVIDER's seller, checked independently of the stand's own. A hosted seller VIGA
      -- retired, or a test seller, must leave every stand they sell at — filtering only the
      -- stand's own seller would leave a hosted one answering texts from a host that is fine.
      and ${visibleFarms("provider_seller", scope.includeTestFarms)}
    order by l.id asc, provider.id asc, e.sort_order asc
  `);

  // Keyed on the PROVIDER (F-114 C.5). Keyed on the stand, two sellers' entries land in one
  // row under whichever published_at arrived first — the misattribution this phase ends.
  const byLocation = new Map<string, LocationRow>();
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    if (readPublicClosure(row, at)?.state === "active") continue;
    const locationId = row.location_id as string;

    const providerId = row.provider_id as string;
    let entry = byLocation.get(providerId);
    if (!entry) {
      entry = {
        // The provider's own identifier, so two sellers at one stand cannot collide in the
        // pending list. `standKeyOfFactId` recovers the stand, which is what lets
        // `groupSelectableStands` collapse them back into ONE answer per stand — the
        // deduplication half of the criterion.
        factId: providerFactId(locationId, providerId),
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
      byLocation.set(providerId, entry);
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
      -- The STAND's own name here, not a seller's, because this half groups per STAND: one
      -- standing-offerings row carries every seller's usual items. Coalesced to the location
      -- name for a VENUE, which has no owning farm — picking one of its sellers would credit
      -- the whole stand's standing claims to whichever one the planner surfaced first.
      coalesce(f.name, l.name) as farm_name,
      l.created_at as created_at,
      o.display_name as item,
      o.sort_order as sort_order,
      c.result as closure_result,
      c.closure_kind as closure_kind,
      c.starts_on::text as closure_starts_on,
      c.closed_through::text as closure_closed_through
    from sales_locations l
    -- LEFT, for the reason stated on the confirmed half above: a venue has no owning farm, and
    -- an inner join dropped every venue out of standing-offerings answers too.
    left join sellers f on f.id = l.own_seller_id
    -- F-066 — usually_carried in the JOIN, not a WHERE: an item that exists only because a
    -- past revision named it must not enter the offerings half of retrieval, or a customer
    -- would be told a stand usually sells something nobody ever said that about.
    join stand_items o on o.sales_location_id = l.id and o.usually_carried
    /*
      THE ITEM'S OWN PROVIDER (F-114 C.5), and its seller's visibility.

      stand_items gained a provider in Phase B, and this query still joined it on the STAND
      alone — so a hosted seller's usual items reached SMS answers from a relationship that had
      ended, from an invitation nobody accepted, and from a seller VIGA had retired. The map
      closed all three when it moved to the shared reader; this is the same three on the answer
      path, which runs its own SQL and was proved by none of the map's tests.
    */
    join stand_providers offering_provider
      on offering_provider.id = o.provider_id
     and ${publicProviders("offering_provider")}
    join sellers offering_seller on offering_seller.id = offering_provider.seller_id
    left join closure_revisions c
      on c.sales_location_id = l.id and c.is_current
    -- The SECOND query in this function, and it needs the F-074 filter independently. A stand
    -- with no confirmed revision reaches a customer only through this half, so filtering the
    -- confirmed query alone would hide a test farm's fresh items and publish its standing ones.
    where l.is_public and l.retired_at is null
      and ${visibleFarms("f", scope.includeTestFarms)}
      and ${visibleFarms("offering_seller", scope.includeTestFarms)}
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
     * the question and their `MORE` stops seeing test sellers mid-conversation, and a saved id
     * cannot be replayed by anyone else into an answer they were never entitled to.
     */
    scope: SmsViewerScope;
  },
): Promise<PageableFact[]> {
  const byId = new Map(
    (await retrieveSmsListings(db, input.at, input.scope)).map((row) => [
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
 * catalog-matching seam, or "leafy greens" could never find "butter lettuce" (F-045). What a
 * customer READS about a stand should stay on topic: an answer about kale should not recite
 * the eggs.
 *
 * The selected catalog names are saved with the pending list, so page 1 and every MORE page
 * apply the same exact narrowing without another model call.
 */
function toPageableFact(
  row: LocationRow,
  itemsRequested: string[],
): PageableFact {
  const wanted = new Set(itemsRequested.map((item) => item.trim().toLowerCase()));
  const named = row.items.filter((item) =>
    wanted.has(item.itemName.trim().toLowerCase()),
  );
  return {
    factId: row.factId,
    farmName: row.farmName,
    locationName: row.locationName,
    publicAddress: row.publicAddress,
    matchedItems: named,
    asOf: row.asOf,
    basis: row.basis,
  };
}

/**
 * Answer a customer inquiry. Every factual word returned is rendered by code from typed
 * authoritative values; the operation is already fixed and the matcher selects catalog values only.
 */
export async function answerInquiry(
  deps: InquiryDeps,
  input: InquiryRequestContext,
): Promise<InquiryOutcome> {
  return answerResolvedInquiry(deps, input);
}

const WEEKDAYS = [
  "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday",
] as const;

function formatClockMinutes(minutes: number): string {
  const hour = Math.floor(minutes / 60) % 24;
  const minute = minutes % 60;
  const suffix = hour < 12 ? "am" : "pm";
  const clockHour = hour % 12 || 12;
  return `${clockHour}${minute === 0 ? "" : `:${String(minute).padStart(2, "0")}`}${suffix}`;
}

function formatDays(days: readonly number[]): string | undefined {
  const valid = [...new Set(days)].filter((day) => day >= 0 && day <= 6).sort((a, b) => a - b);
  if (valid.length === 0) return undefined;
  const consecutive = valid.every((day, index) => index === 0 || day === valid[index - 1]! + 1);
  if (consecutive && valid.length >= 3) {
    return `${WEEKDAYS[valid[0]!]!}-${WEEKDAYS[valid[valid.length - 1]!]!}`;
  }
  return valid.map((day) => WEEKDAYS[day]).join(", ");
}

function scheduleLines(stand: PublicStand): string[] {
  const lines: string[] = [];
  const hours = stand.availability.hours;
  if (hours !== undefined) {
    const value =
      hours.kind === "clock_range"
        ? `${formatClockMinutes(hours.fromMinutes)}-${formatClockMinutes(hours.untilMinutes)}`
        : hours.kind === "until_dusk"
          ? `${formatClockMinutes(hours.fromMinutes)} until dusk`
          : hours.kind === "dawn_to_dusk"
            ? "dawn to dusk"
            : hours.kind === "daylight_hours"
              ? "daylight hours"
              : hours.kind === "all_day"
                ? "all day"
                : "by appointment";
    lines.push(`Hours: ${value}`);
  }
  const days = formatDays(stand.availability.days ?? []);
  if (days !== undefined) lines.push(`Days: ${days}`);
  const season = stand.availability.season;
  if (season !== undefined) {
    const value =
      season.kind === "year_round"
        ? "year-round"
        : season.kind === "named_season"
          ? season.names.join(", ")
          : season.kind === "date_range"
            ? `${season.startMonth}/${season.startDay}-${season.endMonth}/${season.endDay}`
            : `from ${season.startMonth}/${season.startDay}`;
    lines.push(`Season: ${value}`);
  }
  if (stand.availability.hoursText !== undefined) {
    lines.push(`Note: ${stand.availability.hoursText}`);
  }
  return lines.length === 0 ? ["Hours not listed"] : lines;
}

/**
 * One stand's whole listing, rendered by code from its own published facts (B-071).
 *
 * Shared by `overview` and by a stand-scoped `inventory` answer, so the two cannot drift into
 * describing the same stand differently. Every line is a value the farmer published; no model
 * output reaches this function.
 */
function renderStandListing(stand: PublicStand, now: Date): string {
  const produce: string[] = [];
  const confirmed = new Set(stand.items.map((item) => item.itemName.trim().toLowerCase()));
  if (stand.items.length > 0) {
    /*
      THE STOCK CLAIM CARRIES ITS OWN AGE. This line asserted a bare "In stock:" at any age up
      to the 28-day expiry, so a nine-day-old confirmation read as current stock on the reply a
      customer is most likely to act on, while `paging.ts` dated the SAME rows. One
      confirmation must not read two ways over two routes, so both now call `renderStockAge`.

      An EXPIRED confirmation never arrives here at all: `listPublicStands` drops it upstream,
      so the stand reaches this function shaped like one that was never confirmed.
    */
    const when = stand.asOf === undefined ? "" : ` (${renderStockAge(stand.asOf, now)})`;
    produce.push(`In stock${when}: ${stand.items.map((item) => item.itemName).join(", ")}`);
  }
  /*
    A confirmation outranks a standing description of the SAME item — the rule the paged answer
    already applies, and it belongs here for the same reason: several corpus stands publish the
    thing they also list as usually carried, and printing it under both labels tells the
    customer we are unsure which is true. It is in stock; that is the stronger claim.

    Provo Farms showed the cost — all six confirmed items repeated verbatim under "Usually
    sells", so the useful part of that line (the two items they carry but had not confirmed) was
    buried in a list the customer had just read (max, 2026-08-14).
  */
  const alsoSells = stand.usualOfferings.filter(
    (item) => !confirmed.has(item.itemName.trim().toLowerCase()),
  );
  /*
    AVAILABILITY LEADS, exactly as it does on the map card, and it is stated even when there is
    nothing to state it about.

    With no confirmation above it, "Usually sells: Garlic" is the first thing a customer reads
    and lands as a hedged stock claim rather than as the absence of one — `standListingLines`
    already says "Nothing confirmed recently." before the standing offerings for that case.

    And a stand with NEITHER fact used to collapse this block entirely, so a customer who asked
    what a stand has got a reply that jumped to its hours without mentioning stock at all —
    indistinguishable from a bug. Silence is the one thing this surface must not do with a
    missing fact, so the status line is unconditional whenever no confirmation is being shown.
  */
  if (stand.items.length === 0) produce.push("Nothing confirmed recently.");
  if (alsoSells.length > 0) {
    // "also" only when a confirmed line sits above it to be additional TO — the same wording
    // rule `paging.ts` follows.
    const label = stand.items.length > 0 ? "Usually also sells" : "Usually sells";
    produce.push(`${label}: ${alsoSells.map((item) => item.itemName).join(", ")}`);
  }
  /*
    NO MAP LINK (max, 2026-08-14). The link exists to help a customer pick among several stands;
    this answer is already about the one stand they named, and its address is the line below.

    BLANK LINES BETWEEN GROUPS (max, 2026-08-14). A live listing arrived as eight unbroken
    lines, and a customer scanning for one fact had to read all of them. The four groups are
    the four questions being answered — who, what they have, how to pay, when and where —
    which is the same separation `paging.ts` already gives each stand in a multi-stand page.

    An empty group contributes nothing rather than a gap, so a stand with no payment methods
    reads as three tidy blocks instead of one with a hole in it. Measured against the live
    Provo Farms reply the three added characters do not change its segment count.
  */
  const groups: string[][] = [
    [stand.locationName],
    produce,
    stand.paymentMethods.length > 0 ? [`Payments: ${stand.paymentMethods.join(", ")}`] : [],
    scheduleLines(stand),
    [stand.publicAddress ?? "address not listed"],
  ];
  return groups
    .filter((group) => group.length > 0)
    .map((group) => group.join("\n"))
    .join("\n\n");
}

/**
 * A stand-scoped product question: the yes/no the customer asked, then the whole listing.
 *
 * **The verdict is computed by CODE from the stand's own rows**, never taken from the model.
 * The matcher's only contribution is `asked` — which catalog value the customer meant — and
 * even that is re-validated against the stand's catalog before it arrives here. So the worst a
 * matcher miss can do is answer about the wrong item; it can no longer delete items from the
 * listing beneath, which is the failure this rule exists to prevent.
 *
 * Confirmed stock and a standing offering are answered DIFFERENTLY on purpose. "Yes" is
 * reserved for a confirmation the farmer actually published, stamped with its age so the
 * customer can judge it; a usual offering says only that the stand usually carries it, because
 * nobody confirmed it today and claiming otherwise would invent availability (Golden Rule #3).
 */
function renderStandItemAnswer(
  stand: PublicStand,
  asked: readonly string[],
  now: Date,
): string {
  const confirmed = new Map(
    stand.items.map((item) => [item.itemName.trim().toLowerCase(), item.itemName]),
  );
  const usual = new Map(
    stand.usualOfferings.map((item) => [item.itemName.trim().toLowerCase(), item.itemName]),
  );

  const verdicts: string[] = [];
  for (const name of asked) {
    const key = name.trim().toLowerCase();
    const confirmedName = confirmed.get(key);
    if (confirmedName !== undefined) {
      // The age rides on the claim, exactly as the paged answer does it. The customer asked a
      // yes/no question, so the answer is "Yes" at every age and the parenthesis says how old
      // the confirmation is — the same one-vocabulary rule the stock line follows.
      const when = stand.asOf === undefined ? "" : ` (${renderStockAge(stand.asOf, now)})`;
      verdicts.push(`Yes: ${confirmedName}${when}`);
      continue;
    }
    const usualName = usual.get(key);
    verdicts.push(
      usualName === undefined
        ? `Not listed: ${name}`
        : `Usually, but not confirmed today: ${usualName}`,
    );
  }

  // No verdict means the matcher selected nothing the stand carries — the customer asked about
  // something this stand does not list. The listing still follows, which is the useful answer.
  const head = verdicts.length === 0 ? ["Not listed at this stand"] : verdicts;
  return [...head, "", renderStandListing(stand, now)].join("\n");
}

async function deliverStandFactPage(
  deps: InquiryDeps,
  input: {
    stands: PublicStand[];
    kind: PagedStandFactKind;
    selectedValues: string[];
    detailLines: (stand: PublicStand) => string[];
    senderHash: string;
    occurredAt: Date;
  },
): Promise<InquiryOutcome> {
  const first = input.stands.slice(0, PAGE_SIZE);
  const page = renderStandFactPage({
    entries: first.map((stand) => ({
      locationName: stand.locationName,
      ...(stand.publicAddress !== undefined ? { publicAddress: stand.publicAddress } : {}),
      detailLines: input.detailLines(stand),
    })),
    offset: 0,
    total: input.stands.length,
  });
  if (page.hasMore) {
    await savePendingResultList(deps.db, {
      senderHash: input.senderHash,
      factIds: input.stands.map((stand) => pagedStandFactId(input.kind, stand.factId)),
      itemsRequested: input.selectedValues,
      broad: false,
      shown: first.length,
      standTotal: input.stands.length,
      standsShown: first.length,
      occurredAt: input.occurredAt,
      ttlMinutes: PENDING_LIST_TTL_MINUTES,
    });
  }
  return {
    outcome: "answered",
    body: page.body,
    selectedFactIds: input.stands.map((stand) => stand.factId),
  };
}

/** B-069's operation-specific workflow after top-level classification. */
async function answerResolvedInquiry(
  deps: InquiryDeps,
  input: InquiryRequestContext,
): Promise<InquiryOutcome> {
  if (input.request.operation === "clarification") {
    return { outcome: "clarification", question: renderClarificationRequest() };
  }

  const publicStands = await listPublicStands(
    { db: deps.db, clock: deps.clock },
    input.scope,
  );
  const listings = await retrieveSmsListings(deps.db, deps.clock.now(), input.scope);
  let resolvedStand: PublicStand | undefined;
  const candidateStands =
    input.mode === "stand_lookup"
      ? (() => {
          const resolution = resolveStandName(
            input.taskText,
            publicStands.map((stand) => ({ id: stand.factId, name: stand.locationName })),
          );
          if (resolution.kind !== "match") return [];
          resolvedStand = publicStands.find((stand) => stand.factId === resolution.id);
          return resolvedStand === undefined ? [] : [resolvedStand];
        })()
      : publicStands;

  if (input.mode === "stand_lookup" && resolvedStand === undefined) {
    return { outcome: "clarification", question: renderClarificationRequest() };
  }

  if (input.topic === "viga_bucks") {
    if (resolvedStand !== undefined) {
      const status =
        resolvedStand.farmBucksAccepted === true
          ? "Accepts VIGA Farm Bucks"
          : resolvedStand.farmBucksAccepted === false
            ? "Does not accept VIGA Farm Bucks"
            : "VIGA Farm Bucks acceptance not listed";
      return {
        outcome: "answered",
        // No map link on a single-stand answer — see `renderStandListing`.
        body: [resolvedStand.locationName, status].join("\n"),
        selectedFactIds: [resolvedStand.factId],
      };
    }
    const matching = publicStands.filter((stand) => stand.farmBucksAccepted === true);
    if (matching.length === 0) {
      return {
        outcome: "answered",
        body: `No public stand currently lists VIGA Farm Bucks acceptance.\n\n${MAP_INVITATION_LINE}`,
        selectedFactIds: [],
      };
    }
    return deliverStandFactPage(deps, {
      stands: matching,
      kind: "farm_bucks",
      selectedValues: [],
      detailLines: () => ["Accepts VIGA Farm Bucks"],
      senderHash: input.senderHash,
      occurredAt: input.occurredAt,
    });
  }

  /*
    THE CATALOG MUST OFFER EVERY VALUE THE ANSWER COULD RETURN (B-087).

    It used to be built from `candidateStands` (`listPublicStands`) while the answer is filtered
    from `listings` (`retrieveSmsListings`), and the two do not hold the same rows.
    `listPublicStands` drops the items of any confirmation past `isConfirmationExpired` — 28 days
    — because an expired confirmation contributes no dated claim to the map. `retrieveSmsListings`
    applies no such filter.

    So a stand whose last confirmation was 29 days ago contributed NO catalog value. The model
    cannot select a value it was never shown, nothing downstream can tell that from "the customer
    never asked", and the stand became unreachable by name. Not ranked last — INVISIBLE.

    Measured on production 2026-08-18: "who has eggs?" returned one stand while ten were listing
    eggs. Four were past 28 days (41d, 108d, 109d, 124d) and could never be selected.

    Building the catalog from the SAME rows the answer is filtered from makes the two incapable
    of disagreeing. Age still governs everything it should — `renderStockAge` words it, `isStale`
    ranks it, and a four-month-old line reads as four months old — but it no longer decides
    whether a farmer's stand can be found at all.

    `usualOfferings` still comes from `candidateStands`: standing claims never expire, they are
    not on `listings`, and a stand that lists eggs as usually carried must stay findable.
  */
  const catalog = new Map<string, string>();
  const paymentCatalog = new Map<string, string>();
  for (const listing of listings) {
    for (const item of listing.items) {
      const key = item.itemName.trim().toLowerCase();
      if (key !== "" && !catalog.has(key)) catalog.set(key, item.itemName.trim());
    }
  }
  for (const stand of candidateStands) {
    for (const item of [...stand.items, ...stand.usualOfferings]) {
      const key = item.itemName.trim().toLowerCase();
      if (key !== "" && !catalog.has(key)) catalog.set(key, item.itemName.trim());
    }
    for (const method of stand.paymentMethods) {
      const key = method.trim().toLowerCase();
      if (key !== "" && !paymentCatalog.has(key)) paymentCatalog.set(key, method.trim());
    }
  }

  if (input.request.operation === "location" && resolvedStand !== undefined) {
    return {
      outcome: "answered",
      // No map link — see `renderStandListing`. The address IS the answer here.
      body: [
        resolvedStand.locationName,
        resolvedStand.publicAddress ?? "address not listed",
      ].join("\n"),
      selectedFactIds: [resolvedStand.factId],
    };
  }

  if (input.request.operation === "hours" && resolvedStand !== undefined) {
    return {
      outcome: "answered",
      // No map link — see `renderStandListing`. The schedule is one block under the name,
      // matching the listing's grouping so both single-stand replies read the same way.
      body: [resolvedStand.locationName, scheduleLines(resolvedStand).join("\n")].join("\n\n"),
      selectedFactIds: [resolvedStand.factId],
    };
  }

  if (input.request.operation === "hours") {
    const now = deps.clock.now();
    const utcOffsetMinutes = timeZoneOffsetMinutes(now, VASHON_TIME_ZONE);
    const matching = publicStands.filter(
      (stand) =>
        openNow({
          availability: stand.availability,
          ...(stand.closure !== undefined ? { closure: stand.closure } : {}),
          at: now,
          utcOffsetMinutes,
          ...(stand.latitude !== undefined ? { latitude: stand.latitude } : {}),
          ...(stand.longitude !== undefined ? { longitude: stand.longitude } : {}),
        }).state === "open",
    );
    if (matching.length === 0) {
      return {
        outcome: "answered",
        body: `No public stand is confirmed open right now.\n\n${MAP_INVITATION_LINE}`,
        selectedFactIds: [],
      };
    }
    return deliverStandFactPage(deps, {
      stands: matching,
      kind: "open_now",
      selectedValues: [],
      detailLines: () => ["Open now"],
      senderHash: input.senderHash,
      occurredAt: input.occurredAt,
    });
  }

  if (input.request.operation === "overview" && resolvedStand !== undefined) {
    return {
      outcome: "answered",
      body: renderStandListing(resolvedStand, deps.clock.now()),
      selectedFactIds: [resolvedStand.factId],
    };
  }

  /*
    B-071 — A QUESTION ABOUT ONE STAND ALWAYS RETURNS THAT STAND'S WHOLE LISTING.

    The customer asked about one product, so the answer LEADS with yes or no — that is what
    they asked. Then it shows the same full listing `overview` renders, because a customer who
    is standing in front of one farm wants to know what is there (max, 2026-08-14).

    That shape is also what takes the matcher out of the answer's content. Previously a
    stand-scoped inventory question narrowed the reply to the values the matcher returned, and
    a value it silently failed to return was deleted from what the farmer had published: on
    Provo Farms' real eleven values, `what's in stock at provo?` dropped a confirmed item in 3
    of 8 live runs, so the customer saw four items where the farmer had published six while the
    map, which calls no model, showed all six. Nothing downstream could catch it, because a
    dropped value is indistinguishable from one the customer never asked about.

    Now the model only decides WHICH ITEM the yes/no is about. The listing beneath it is
    rendered by code from the stand's own published facts, so a matcher miss can no longer
    shorten a farmer's listing — Golden Rule #4's line, placed where it can be enforced.
  */
  if (input.request.operation === "inventory" && resolvedStand !== undefined) {
    const catalogNames = [...resolvedStand.items, ...resolvedStand.usualOfferings]
      .map((item) => item.itemName.trim())
      .filter((name) => name !== "");
    const match = await deps.matcher.match({
      taskText: input.taskText,
      catalogType: "inventory",
      values: catalogNames,
    });
    if (!match.ok) {
      return match.reason === "provider_error"
        ? { outcome: "clarification", question: renderInterpreterUnavailable() }
        : { outcome: "rejected", reason: "catalog matcher carries only public catalog values" };
    }
    // Membership is re-validated exactly as the island-wide path validates it: the model may
    // only ever name a value code placed in front of it.
    const byKey = new Map(catalogNames.map((name) => [name.toLowerCase(), name]));
    const asked: string[] = [];
    for (const name of match.matches) {
      const ours = byKey.get(name.trim().toLowerCase());
      if (ours === undefined) {
        return { outcome: "rejected", reason: `item ${name} is not part of the public catalog` };
      }
      if (!asked.includes(ours)) asked.push(ours);
    }
    return {
      outcome: "answered",
      body: renderStandItemAnswer(resolvedStand, asked, deps.clock.now()),
      selectedFactIds: [resolvedStand.factId],
    };
  }

  if (input.request.operation === "payment") {
    const match = await deps.matcher.match({
      taskText: input.taskText,
      catalogType: "payment",
      values: [...paymentCatalog.values()],
    });
    if (!match.ok) {
      return match.reason === "provider_error"
        ? { outcome: "clarification", question: renderInterpreterUnavailable() }
        : { outcome: "rejected", reason: "catalog matcher carries only public catalog values" };
    }
    const selectedMethods: string[] = [];
    for (const method of match.matches) {
      const ours = paymentCatalog.get(method.trim().toLowerCase());
      if (ours === undefined) {
        return { outcome: "rejected", reason: `payment method ${method} is not part of the public catalog` };
      }
      if (!selectedMethods.includes(ours)) selectedMethods.push(ours);
    }
    const selectedKeys = new Set(selectedMethods.map((method) => method.toLowerCase()));
    const matching = candidateStands.filter((stand) =>
      stand.paymentMethods.some((method) => selectedKeys.has(method.trim().toLowerCase())),
    );
    if (matching.length === 0) {
      return {
        outcome: "answered",
        body: `No public stand lists ${selectedMethods.join(" or ") || "that"} as a payment method.\n\n${MAP_INVITATION_LINE}`,
        selectedFactIds: [],
      };
    }
    return deliverStandFactPage(deps, {
      stands: matching,
      kind: "payment",
      selectedValues: selectedMethods,
      detailLines: (stand) => [
        `Payment listed: ${stand.paymentMethods.filter((method) => selectedKeys.has(method.trim().toLowerCase())).join(", ")}`,
      ],
      senderHash: input.senderHash,
      occurredAt: input.occurredAt,
    });
  }

  const notes = [
    "outOfScopeRequest" in input.request && input.request.outOfScopeRequest === true
      ? RECIPE_SCOPE_STATEMENT
      : undefined,
    "originDependent" in input.request && input.request.originDependent === true
      ? ORIGIN_LIMITATION_STATEMENT
      : undefined,
  ].filter((note): note is string => note !== undefined);
  const withScope = (body: string): string =>
    notes.length === 0 ? body : [body, ...notes].join("\n\n");

  let selectedNames: string[];
  if (input.request.operation === "inventory") {
    const match = await deps.matcher.match({
      taskText: input.taskText,
      catalogType: "inventory",
      values: [...catalog.values()],
    });
    if (!match.ok) {
      return match.reason === "provider_error"
        ? { outcome: "clarification", question: renderInterpreterUnavailable() }
        : { outcome: "rejected", reason: "catalog matcher carries only public catalog values" };
    }
    selectedNames = [];
    for (const name of match.matches) {
      const ours = catalog.get(name.trim().toLowerCase());
      if (ours === undefined) {
        return { outcome: "rejected", reason: `item ${name} is not part of the public catalog` };
      }
      if (!selectedNames.includes(ours)) selectedNames.push(ours);
    }
    if (selectedNames.length === 0) {
      return {
        outcome: "answered",
        body: withScope(renderNoCurrentListing([])),
        selectedFactIds: [],
      };
    }
  } else if (input.request.operation === "broad") {
    selectedNames = [...catalog.values()];
  } else {
    return { outcome: "rejected", reason: `unsupported ${input.request.operation} inquiry operation` };
  }

  const selectedKeys = new Set(selectedNames.map((name) => name.trim().toLowerCase()));
  const matching = listings
    .filter((row) => resolvedStand === undefined || standKeyOfFactId(row.factId) === resolvedStand.factId)
    .filter((row) => row.items.some((item) => selectedKeys.has(item.itemName.trim().toLowerCase())))
    .map((row) => toPageableFact(row, selectedNames));

  if (matching.length === 0) {
    return {
      outcome: "answered",
      body: withScope(renderNoCurrentListing(selectedNames)),
      selectedFactIds: [],
    };
  }

  const grouped = groupSelectableStands(matching);
  /*
    F-120 — A STAND ANSWERING THE WHOLE REQUEST OUTRANKS ONE ANSWERING PART OF IT.

    `groupSelectableStands` already deduplicates a stand's `matchedItems` by name across both
    evidence voices, so its length IS the count of distinct requested names that stand supports.
    No new query and no second grouping pass.

    BROAD IS DELIBERATELY EXEMPT. `operation: "broad"` sets `selectedNames` to the entire catalog,
    so a real count there would rank stands by how many items they list — a "biggest listing"
    leaderboard, in answer to a question that named no item. Passing a constant collapses the key
    and leaves a broad answer ordered by freshness exactly as it is today.
  */
  const isBroad = input.request.operation === "broad";
  const ranked = rankCandidates(
    grouped.map(({ fact }) => ({
      factId: fact.factId,
      locationName: fact.locationName,
      asOf: fact.asOf,
      matchCount: isBroad ? 1 : fact.matchedItems.length,
    })),
  );
  const byStand = new Map(grouped.map((stand) => [stand.fact.factId, stand]));
  const facts = ranked.flatMap((candidate) => byStand.get(candidate.factId)!.evidence);

  return deliverPage(deps, {
    facts,
    itemsRequested: selectedNames,
    broad: isBroad,
    senderHash: input.senderHash,
    occurredAt: input.occurredAt,
    withScope,
    taskText: input.taskText,
  });
}

/**
 * Render the first page of an answer and remember the rest, counting in STANDS.
 *
 * One function for both exits — the ordinary answer and B-061's duplicate-id recovery — so the
 * two cannot come to page differently. Both previously sliced `PAGE_SIZE` FACTS and reported
 * `facts.length` as the total, which is the arithmetic B-062 found live: "1-3 of 45" over an
 * island of 35 stands, and a stand whose two rows straddled a page boundary printed twice.
 *
 * `groupFactsByStand` puts a stand's rows next to each other and counts entries rather than
 * rows; `factsPerPage` then takes whole stands. The saved list holds the SAME fact ids in that
 * grouped order, so the MORE replay inherits the property without knowing about it.
 */
async function deliverPage(
  deps: InquiryDeps,
  input: {
    facts: PageableFact[];
    itemsRequested: string[];
    broad: boolean;
    senderHash: string;
    occurredAt: Date;
    withScope: (body: string) => string;
    /**
     * The customer's own words, so the renderer can tell an exact answer from a related one
     * (B-086). Only the FIRST page carries it: a `MORE` page renders from the stored list,
     * where every entry has already earned its place in the order it was ranked.
     */
    taskText: string;
  },
): Promise<InquiryOutcome> {
  const { factIds, standCount } = groupFactsByStand(input.facts, deps.clock.now());
  const byId = new Map(input.facts.map((fact) => [fact.factId, fact]));
  const grouped = factIds.map((factId) => byId.get(factId)!);
  const firstPage = grouped.slice(0, factsPerPage(grouped, PAGE_SIZE));

  const page = renderResultPage({
    itemsRequested: input.itemsRequested,
    facts: firstPage,
    offset: 0,
    total: standCount,
    clock: deps.clock,
    taskText: input.taskText,
  });

  if (page.hasMore) {
    // Only a set that does not fit leaves anything behind. A list nobody can page would be
    // retained data with no reader, and case 2 says the machinery must not intrude on the
    // common small answer at all.
    await savePendingResultList(deps.db, {
      senderHash: input.senderHash,
      factIds,
      itemsRequested: input.itemsRequested,
      broad: input.broad,
      shown: firstPage.length,
      standTotal: standCount,
      standsShown: PAGE_SIZE,
      occurredAt: input.occurredAt,
      ttlMinutes: PENDING_LIST_TTL_MINUTES,
    });
  }

  return {
    outcome: "answered",
    body: input.withScope(page.body),
    selectedFactIds: factIds,
  };
}
