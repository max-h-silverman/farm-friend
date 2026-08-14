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
  ORIGIN_LIMITATION_STATEMENT,
  PAGE_SIZE,
  PUBLIC_MAP_URL,
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
import { savePendingResultList, visibleFarms, type Db } from "@farm-friend/db";
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

export function standKeyOfFactId(factId: string): string {
  if (factId.endsWith("z")) return factId.slice(0, -1);
  const nibble = CONFIRMED_VARIANT_NIBBLE[factId[19] ?? ""];
  if (nibble === undefined) return factId;
  return `${factId.slice(0, 19)}${nibble}${factId.slice(20)}`;
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
  const listings = await retrieveCurrentListings(deps.db, deps.clock.now(), input.scope);
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
        body: [resolvedStand.locationName, status, "", `Map: ${PUBLIC_MAP_URL}`].join("\n"),
        selectedFactIds: [resolvedStand.factId],
      };
    }
    const matching = publicStands.filter((stand) => stand.farmBucksAccepted === true);
    if (matching.length === 0) {
      return {
        outcome: "answered",
        body: `No public stand currently lists VIGA Farm Bucks acceptance.\n\nMap: ${PUBLIC_MAP_URL}`,
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

  const catalog = new Map<string, string>();
  const paymentCatalog = new Map<string, string>();
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
      body: [
        resolvedStand.locationName,
        resolvedStand.publicAddress ?? "address not listed",
        "",
        `Map: ${PUBLIC_MAP_URL}`,
      ].join("\n"),
      selectedFactIds: [resolvedStand.factId],
    };
  }

  if (input.request.operation === "hours" && resolvedStand !== undefined) {
    return {
      outcome: "answered",
      body: [resolvedStand.locationName, ...scheduleLines(resolvedStand), "", `Map: ${PUBLIC_MAP_URL}`].join("\n"),
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
        body: `No public stand is confirmed open right now.\n\nMap: ${PUBLIC_MAP_URL}`,
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
    const lines = [resolvedStand.locationName];
    if (resolvedStand.items.length > 0) {
      lines.push(`In stock: ${resolvedStand.items.map((item) => item.itemName).join(", ")}`);
    }
    if (resolvedStand.usualOfferings.length > 0) {
      lines.push(`Usually sells: ${resolvedStand.usualOfferings.map((item) => item.itemName).join(", ")}`);
    }
    if (resolvedStand.paymentMethods.length > 0) {
      lines.push(`Payments: ${resolvedStand.paymentMethods.join(", ")}`);
    }
    lines.push(...scheduleLines(resolvedStand));
    lines.push(resolvedStand.publicAddress ?? "address not listed", "", `Map: ${PUBLIC_MAP_URL}`);
    return {
      outcome: "answered",
      body: lines.join("\n"),
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
        body: `No public stand lists ${selectedMethods.join(" or ") || "that"} as a payment method.\n\nMap: ${PUBLIC_MAP_URL}`,
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
  const ranked = rankCandidates(
    grouped.map(({ fact }) => ({
      factId: fact.factId,
      locationName: fact.locationName,
      asOf: fact.asOf,
    })),
  );
  const byStand = new Map(grouped.map((stand) => [stand.fact.factId, stand]));
  const facts = ranked.flatMap((candidate) => byStand.get(candidate.factId)!.evidence);

  return deliverPage(deps, {
    facts,
    itemsRequested: selectedNames,
    broad: input.request.operation === "broad",
    senderHash: input.senderHash,
    occurredAt: input.occurredAt,
    withScope,
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
