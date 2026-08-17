import {
  isConfirmationExpired,
  isStale,
  openNow,
  renderCardRecency,
  renderElapsed,
  renderRecency,
  timeZoneOffsetMinutes,
  VASHON_TIME_ZONE,
  type Clock,
  type OpenState,
  type StandAvailabilityFacts,
} from "@farm-friend/core";
import {
  intersectAvailability,
  readStandProviderFacts,
  visibleFarms,
  type Db,
} from "@farm-friend/db";
// A TYPE-ONLY import of the browser view model's input shape. It adds no runtime edge (and
// `map-view.ts` is already inside the public read graph, model-free and asserted so), and it
// makes the wire format a compiler-checked contract between the server that writes it and the
// view model that reads it — rather than two hand-kept object literals that agree by habit.
import type {
  PublicStandPayload,
  StandAvailability,
  StandHours,
  StandSeason,
} from "./map-view";
import { readPublicClosure, type PublicClosure } from "./closure-projection";

// Public web discovery — the MODEL-FREE half of F-019's channel boundary.
//
// This module deliberately imports no model seam and takes no `model` dependency. That is
// the enforcement, not a convention: a public map that could reach a model would be the
// anonymous inquiry surface F-019 exists to keep out of launch. Natural-language inquiry is
// SMS-only and lives in `inquiry.ts`, reached only from the verified Telnyx webhook.
//
// Fact parity with SMS is structural rather than promised. This reads the same
// `is_current` revision rows `inquiry.ts` retrieves, and labels recency with the same
// `renderRecency` / `isStale` helpers that render the SMS answer — so the web cannot drift
// into a friendlier account of how fresh a listing is.
//
// Nothing here is rate-capped. Ordinary browsing costs a query, not a model call, and
// capping a customer for reading the map would be a product failure wearing a safety label.

export interface PublicListingDeps {
  db: Db;
  clock: Clock;
}

/**
 * What a viewer deliberately asked to see (F-074).
 *
 * `includeTestFarms` is false everywhere except a request that carried `?hidden=true`. It is
 * separated from `PublicListingDeps` on purpose: dependencies are how the surface is wired,
 * this is a property of the REQUEST, and folding a per-request fact into the composition root
 * is how one visitor's query string ends up deciding what every other visitor sees.
 */
export interface PublicViewerScope {
  includeTestFarms: boolean;
}

/** The ordinary visitor. Named so the common case is a value rather than a repeated literal. */
export const PUBLIC_VIEWER: PublicViewerScope = { includeTestFarms: false };

export interface PublicStandItem {
  itemName: string;
  quantity?: number;
  unit?: string;
  priceText?: string;
  approximation?: "some" | "limited" | "plentiful";
}

/**
 * Something a stand USUALLY sells, with the price the farmer states for it (F-090).
 *
 * Deliberately its own type rather than a reuse of `PublicStandItem`: that one describes a
 * DATED confirmation and carries quantity and approximation, none of which a standing claim
 * has. One type serving both would invite a renderer to read "12 dozen" off a fact that never
 * counted anything.
 *
 * `priceText` absent means NO PRICE IS SHOWN — either the farmer stated none, or they have
 * prices switched off for this stand. Never "free", which is a stated amount of zero and
 * renders as the word.
 *
 * It is the RENDERED SENTENCE, not the four parts, and that is deliberate for a public type:
 * the parts are turned into words once, at this boundary, by the single renderer every surface
 * shares. A component holding `amount` and `basis` would be a second place that decides how a
 * price reads, and the two would drift.
 */
export interface UsualOffering {
  itemName: string;
  priceText?: string;
}

export interface PublicStand {
  /** The sales location id — the same stable identifier SMS retrieval carries. */
  factId: string;
  farmName: string;
  locationName: string;
  locationKind: "farm_stand" | "farmers_market";
  /**
   * Where to go — present only for a `visitable` location (F-038).
   *
   * **Absent, all three together, for a `contact_only` farm.** Open Gate Lamb sells by order
   * and has no stand to visit, so there is no address and no pin. The optionality is not
   * cosmetic: the reader previously cast these (`as string`, `Number(...)`), and against a NULL
   * that produced the address `null` with coordinates `0, 0` — a pin in the Atlantic Ocean off
   * the coast of Africa, with no type error anywhere. Migration 0007 makes the state
   * unrepresentable in the database; these optional fields keep the reader from reinventing it.
   */
  publicAddress?: string;
  latitude?: number;
  longitude?: number;
  /** Whether there is a place to go at all (F-038). */
  visitability: "visitable" | "contact_only";
  /** What the farm provides (F-038) — produce, services, or goods by order. */
  offeringType: "produce" | "services" | "by_order";
  /** Sanitized public source text; direct contact details never enter this field. */
  description?: string;
  /** Present only once VIGA has confirmed the stand's Farm Bucks eligibility. */
  farmBucksAccepted?: boolean;
  /**
   * When the farmer last confirmed this inventory.
   *
   * **Absent when no farmer has confirmed anything yet** (B-013). A seeded stand starts in
   * exactly that state, and the three recency fields are optional TOGETHER so it is not
   * possible to render "updated just now" for a confirmation that never happened. A default
   * date here would be indistinguishable from a real one downstream.
   */
  asOf?: Date;
  /** Code-rendered recency, identical in wording to the SMS answer. Absent with `asOf`. */
  recencyLabel?: string;
  /**
   * The bare elapsed phrase behind `recencyLabel` — "3 hours ago" (F-042).
   *
   * Absent with the other two, for the same reason. The public map's confirmed heading reads
   * "Confirmed 3 hours ago" while the SMS answer reads "updated 3 hours ago"; both come from
   * core's one `renderElapsed`, so the two channels cannot come to disagree about how fresh
   * the same row is. Carried as its own field rather than reconstructed downstream by
   * stripping a verb off `recencyLabel`.
   */
  confirmedElapsed?: string;
  /**
   * The public card's recency sentence — "Last updated 3 weeks ago", or "No recent update"
   * once a confirmation is four weeks old (F-097).
   *
   * A THIRD phrasing rather than a reformatting of `confirmedElapsed`, because the card and
   * the SMS answer are asked different questions: an answer is about right now and counts in
   * hours; a card is browsed and its listings run to months. Both still come from core, and
   * everything under a week is the same shared arithmetic.
   */
  cardRecency?: string;
  /**
   * True when the listing must be shown WITH a prominent staleness warning.
   *
   * Absent — not `false` — when there is nothing to be stale about. "Never confirmed" and
   * "confirmed recently" are different facts, and collapsing them to `false` would claim the
   * second.
   */
  isStale?: boolean;
  /**
   * What this stand USUALLY sells (F-042) — its seeded specialties, never current stock.
   *
   * A SEPARATE FIELD FROM `items`, and that separation is the product rule rather than a
   * schema convenience. `items` is a statement about what is out on the table RIGHT NOW —
   * dated, and attributed by `inventory_revisions.source` to either a farmer's handset or
   * VIGA's own records (F-063). A specialty is a standing property of the farm, true in March
   * and in September, dated by nothing. Merging them would let a year-old form line render as
   * something confirmed today.
   *
   * **Empty, never absent** — unlike the recency fields. An empty list is a complete, honest
   * answer ("we know of no specialties"), whereas "no confirmation" and "confirmed nothing"
   * are genuinely different facts that only absence can distinguish.
   *
   * Carries NO date, here or anywhere downstream. There is nothing to date: nobody confirmed
   * these.
   *
   * F-090 — each carries the farmer's OPTIONAL price, which is a standing claim in exactly the
   * same way the item is: "eggs are usually $6/dozen", true in March and in September, dated by
   * nothing. A price on today's confirmed stock is a different fact and lives on `items`.
   */
  usualOfferings: UsualOffering[];
  /**
   * What the stand has stated about when it is open (F-043).
   *
   * F-035 wrote these columns and, until this item, nothing read them. Always present, `{}`
   * when nothing was stated; the individual facts inside are independently optional, because
   * a season and a time of day are separate things a farmer may or may not have given.
   */
  availability: StandAvailability;
  /** Active or upcoming only; expired/reopened instructions disappear at read time. */
  closure?: PublicClosure;
  /** Active owner-confirmed display names, separate from aggregate inventory provenance. */
  participantNames: string[];
  /**
   * The farm's website and social links (F-061).
   *
   * `seller_links` held a correct schema and had NO writer and NO reader — verified in both
   * directions; its only non-schema appearances were integration-test cleanup lists. The seeder
   * is now the writer and this is the reader, because a populated table nothing reads is still
   * invisible to the customer it was for.
   *
   * **Empty, never absent**, like `usualOfferings`: "we know of no links" is a complete answer,
   * and there is no second fact for absence to distinguish.
   */
  links: PublicStandLink[];
  /**
   * How this stand can be paid (F-061) — canonically spelled, VIGA Bucks excluded.
   *
   * Farm Bucks has its own field (`farmBucksAccepted`) fed by its own column, so it is
   * deliberately not repeated here: one fact, one home, no way for the two to disagree.
   */
  paymentMethods: string[];
  /**
   * The stand-wide union of what every seller currently claims.
   *
   * **DERIVED from `sellers`** since F-114 C.5, not read separately. It is what the compact
   * card, the search haystack and every SMS-parity surface need — a customer scanning a map
   * asks "is there kale here", not "whose kale". Deriving it rather than reading it a second
   * way is what makes web and SMS incapable of disagreeing about what a stand holds.
   */
  items: PublicStandItem[];
  /**
   * Every live seller at this stand, each with its own items and its own freshness (C.5).
   *
   * The detail card's source. `items` above is the union of these; the two are one fact in two
   * shapes rather than two facts. Empty for a venue nobody has been invited to.
   */
  sellers: PublicStandSeller[];
}

/** One seller at one stand, as the public surface carries them (F-114 C.5). */
export interface PublicStandSeller {
  providerId: string;
  sellerId: string;
  sellerName: string;
  /** By SELF-POINTER, resolved in the reader. Never a name match. */
  describesOwnStand: boolean;
  /**
   * This seller's own card-recency sentence — absent when they have confirmed nothing, and
   * absent once their confirmation has aged out.
   *
   * Per SELLER, which is the whole point of C.5: at one stand Kelsey's venison may be three
   * hours old and Zoe's greens two days.
   */
  cardRecency?: string;
  stale?: boolean;
  /**
   * What can honestly be said about THIS seller being open right now (F-114 C.5).
   *
   * The INTERSECTION of the seller's own stated schedule with the stand's, computed once by
   * `intersectAvailability` — which is the seam Phase A created for exactly this and which had
   * no consumer until now.
   *
   * The rule is one-directional. A stand that is shut makes every seller at it unavailable,
   * whatever the seller says: the stand is locked, so nobody's goods are buyable there. A stand
   * that IS open does not make a seller open — the seller's own answer stands, which supports
   * the real case of a hosted seller who locks their box before the stand shuts.
   *
   * `unknown` is preserved rather than resolved. 5 of 34 production stands state no season and
   * 12 state no hours; a stand that stated nothing has not stated that it is shut, and must not
   * close a seller who DID state a schedule.
   */
  openState: OpenState;
  confirmedItems: PublicStandItem[];
  /** Standing claims. They carry a price and NEVER a date. */
  usualItems: UsualOffering[];
}

export interface PublicStandLink {
  /** What a person reads — "Website", "Instagram", "Facebook". */
  label: string;
  /** Always absolute; `seller_links_absolute_http_url` refuses anything else. */
  url: string;
}

/**
 * Read F-035's availability columns off a row into the shape the browser gets.
 *
 * A pure function over the raw row, so the "unstated stays unstated" rule is testable without
 * a database and is stated in exactly one place.
 *
 * THE RULE: every field is spread conditionally and NOTHING is defaulted. A stand that stated
 * no season must not acquire `year_round`, and a `dawn_to_dusk` stand must not acquire clock
 * times — both would be a claim no farmer made, and the second is precisely the invented
 * precision migration 0005 refuses. The database's CHECK constraints already guarantee the
 * kind and its operands agree, so this reads the kind and takes only the operands that kind
 * defines.
 */
function readAvailability(row: Record<string, unknown>): StandAvailability {
  const seasonKind = row.season_kind as StandSeason["kind"] | null;
  const hoursKind = row.open_hours_kind as StandHours["kind"] | null;
  const days = row.open_days as number[] | null;
  const hoursText = row.hours_text as string | null;
  const stockingCadence = row.stocking_cadence as
    | StandAvailability["stockingCadence"]
    | null;
  const stockingDays = row.stocking_days as number[] | null;

  let season: StandSeason | undefined;
  switch (seasonKind) {
    case "year_round":
      season = { kind: "year_round" };
      break;
    case "date_range":
      season = {
        kind: "date_range",
        startMonth: Number(row.season_start_month),
        startDay: Number(row.season_start_day),
        endMonth: Number(row.season_end_month),
        endDay: Number(row.season_end_day),
      };
      break;
    case "named_season":
      // The names, NOT months. Resolution happens against one documented constant at the
      // moment the question is asked (F-035), so VIGA correcting what "summer" means changes
      // that constant rather than requiring a re-seed.
      season = {
        kind: "named_season",
        names: (row.season_names as string[] | null) ?? [],
      };
      break;
    case "open_ended":
      season = {
        kind: "open_ended",
        startMonth: Number(row.season_start_month),
        startDay: Number(row.season_start_day),
      };
      break;
    default:
      season = undefined;
  }

  let hours: StandHours | undefined;
  switch (hoursKind) {
    case "dawn_to_dusk":
    case "daylight_hours":
    case "all_day":
    case "by_appointment":
      // No clock times, by CHECK constraint and by product rule. The sun is computed at read
      // time; a stored 6am–8pm would be a schedule the farmer never gave.
      hours = { kind: hoursKind };
      break;
    case "clock_range":
      hours = {
        kind: "clock_range",
        fromMinutes: Number(row.open_from_minutes),
        untilMinutes: Number(row.open_until_minutes),
      };
      break;
    case "until_dusk":
      hours = { kind: "until_dusk", fromMinutes: Number(row.open_from_minutes) };
      break;
    default:
      hours = undefined;
  }

  return {
    ...(season ? { season } : {}),
    ...(hours ? { hours } : {}),
    // Empty is treated as unstated rather than as "open on no day". The CHECK constraint
    // already forbids an empty array, so this is belt-and-braces against a future writer.
    ...(days && days.length > 0 ? { days } : {}),
    ...(hoursText ? { hoursText } : {}),
    ...(stockingCadence ? { stockingCadence } : {}),
    ...(stockingDays && stockingDays.length > 0 ? { stockingDays } : {}),
  };
}

/**
 * Every public sales location, ordered most-recently-confirmed first.
 *
 * A stale listing is returned flagged, never filtered out: the honor-system reality is that
 * old information plus an honest warning beats a blank map.
 *
 * **A stand with no current revision is returned too** (B-013), with no recency and no items.
 * The join to `inventory_revisions` is LEFT for that reason. It used to be an inner join,
 * which silently made every unconfirmed stand invisible — and since B-002 seeds VIGA's stands
 * with zero inventory by design, that would have left the map empty with a green seed test.
 * The product rule is the same one that keeps stale listings visible: "we don't know" is an
 * honest thing to show; disappearing is not.
 *
 * Ordering puts confirmed stands first, newest confirmation leading, and never-confirmed
 * stands last (`nulls last`) rather than sorting them as though they were infinitely old.
 */
export async function listPublicStands(
  deps: PublicListingDeps,
  scope: PublicViewerScope = PUBLIC_VIEWER,
): Promise<PublicStand[]> {
  const rows = await deps.db.sql.unsafe(`
    select
      l.id as location_id,
      l.name as location_name,
      l.kind as location_kind,
      l.public_address as public_address,
      l.public_latitude as public_latitude,
      l.public_longitude as public_longitude,
      -- F-088 — whether the address TEXT may be shown. The pin is unaffected: a stand with a
      -- hidden address is still placed on the map, it just prints no address line.
      l.address_public as address_public,
      l.visitability as visitability,
      l.offering_type as offering_type,
      l.farm_bucks_accepted as farm_bucks_accepted,
      l.farm_bucks_eligible as farm_bucks_eligible,
      -- F-043 — F-035's availability columns, read for the first time. Selected on the
      -- location row (grain: one per location), so they neither multiply nor are multiplied
      -- by the inventory join below.
      l.season_kind as season_kind,
      l.season_start_month as season_start_month,
      l.season_start_day as season_start_day,
      l.season_end_month as season_end_month,
      l.season_end_day as season_end_day,
      l.season_names as season_names,
      l.open_hours_kind as open_hours_kind,
      l.open_from_minutes as open_from_minutes,
      l.open_until_minutes as open_until_minutes,
      l.open_days as open_days,
      l.hours_text as hours_text,
      l.stocking_cadence as stocking_cadence,
      l.stocking_days as stocking_days,
      -- The STAND's own farm, coalesced to the location name for a VENUE (F-115). Morgan Hill
      -- is a place several farmers sell at and nobody's farm, so its own_seller_id is NULL and
      -- there is no owning farm name to show. Its sellers each carry their own name on the
      -- per-seller list below, which is where a venue's identities actually live.
      coalesce(f.name, l.name) as farm_name,
      -- NOT coalesced: a description is a farm's own words about itself, and a venue has no
      -- farm to have written any. Absent is the honest answer; the location name is a label,
      -- not a description of anything.
      f.description as farm_description,
      c.result as closure_result,
      c.closure_kind as closure_kind,
      c.starts_on::text as closure_starts_on,
      c.closed_through::text as closure_closed_through,
      coalesce(
        (
          select array_agg(
            participant.display_name
            order by lower(participant.display_name), participant.display_name, participant.id
          )
          from sales_location_participants participant
          where participant.sales_location_id = l.id
            and participant.retired_at is null
        ),
        array[]::text[]
      ) as participant_names,
      -- F-061 — links belong to the FARM (one website, however many stands it runs), payment
      -- methods to the LOCATION (what this stand takes at this table). Aggregated as JSON
      -- because a link is a pair; the text[] aggregates above carry single values.
      coalesce(
        (
          select json_agg(
            json_build_object('label', link.label, 'url', link.url)
            order by link.sort_order asc, link.label asc
          )
          from seller_links link
          where link.seller_id = f.id
        ),
        '[]'::json
      ) as links,
      coalesce(
        (
          select array_agg(payment.method order by payment.method asc)
          from sales_location_payment_methods payment
          where payment.sales_location_id = l.id
        ),
        array[]::text[]
      ) as payment_methods
    from sales_locations l
    -- LEFT (F-115). A VENUE has no own_seller_id, and an INNER join here deleted every venue
    -- from the public map — the same line, with the same effect, as the two in SMS retrieval.
    -- The alias survives to carry the stand-owner visibility rule in the where clause: a farm
    -- VIGA retires must still take its own stands down with it.
    left join sellers f on f.id = l.own_seller_id
    left join closure_revisions c
      on c.sales_location_id = l.id and c.is_current
    -- F-071 — retired_at is a SECOND, operator-owned reason a stand leaves the public
    -- surface, and it is deliberately not folded into is_public: that column is a listing
    -- attribute the farmer's own onboarding form sets to true on every save, so VIGA's
    -- decision expressed through it would be reverted the next time the farmer edited.
    --
    -- F-074 adds a THIRD, and it is the same shape of rule for the same reason: a test farm is
    -- absent unless this viewer deliberately asked for one. The predicate is composed from
    -- visibleFarms rather than written out, because SMS retrieval runs its own two queries
    -- and the map's filter proves nothing about those — three copies is three chances to leak.
    where l.is_public and l.retired_at is null
      and ${visibleFarms("f", scope.includeTestFarms)}
    -- ONE ROW PER STAND now (F-114 C.5). The inventory joins that used to fan this out per
    -- entry are gone: after Phase B they returned every seller's entries under one stand-wide
    -- published_at, which is the misattribution this phase exists to end. Inventory arrives
    -- from readStandProviderFacts below, per provider, and the confirmation ordering the
    -- product rule asks for is applied there — it needs the per-seller dates to be honest.
    order by l.id asc
  `);

  const now = deps.clock.now();
  const byLocation = new Map<string, PublicStand>();

  /*
    THE PER-SELLER FACTS, from the one reader the map, SMS and the seller list share.

    A second query rather than a join, deliberately: a stand has several sellers and each has
    several items in two registers, so joining it here would be the cross product F-042 already
    paid for once. The reader returns the nesting directly.
  */
  const providerFacts = await readStandProviderFacts(deps.db, {
    salesLocationIds: rows.map((raw) => (raw as Record<string, unknown>).location_id as string),
    includeTestFarms: scope.includeTestFarms,
  });

  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    const locationId = row.location_id as string;

    let stand = byLocation.get(locationId);
    if (!stand) {
      const closure = readPublicClosure(row, now);
      /*
        A STAND SHUTDOWN OVERRIDES EVERY SELLER AND PUBLISHES NOTHING ITEMIZED (F-114).

        A closed stand is a locked box. Whatever any seller published, and however fresh it is,
        none of it is buyable there — so an active closure withholds every item, in BOTH
        registers and in every shape the payload carries: the per-seller lists, the stand-wide
        union, the usual offerings, and the recency that would date them.

        Withheld HERE, beside the aged-out rule below and for the same reason: past this point
        a closed stand is shaped exactly like a stand that has published nothing, so the map
        card, the compact card, the search haystack and `standListingLines` all need no new
        case. Suppressing in the detail card alone would leave a closed stand's stock answering
        a produce search and printing on the compact card, with the card's own suite green.

        The stand stays LISTED, with its closure notice — that is the point of publishing one.
        Only the stock claim goes. An UPCOMING closure withholds nothing: it is information
        about next week, and the stand is open now.
      */
      const shutDown = closure?.state === "active";

      /*
        AN AGED-OUT CONFIRMATION IS TREATED AS NO CONFIRMATION (max, 2026-08-10).

        The card used to print "In stock" with an item list under it for a confirmation of any
        age, conceding only that the caption read "(No recent update)" — asserting stock in the
        same breath as admitting the claim could no longer be dated.

        Withheld HERE, where the dates are, rather than branched on in the component: past the
        threshold the recency fields simply never become fields, so an expired listing reaches
        the view shaped exactly like a never-confirmed one and every downstream reader — the map
        card, the payload, `standListingLines` — needs no new case.

        The stand itself stays listed. It keeps its specialties and reads "Nothing confirmed
        recently."; only the STOCK CLAIM goes. Losing the claim is not the same as disappearing,
        and the honor-system rule that stale listings stay visible is unaffected.

        **APPLIED PER SELLER SINCE C.5.** A stand's sellers age out independently: Kelsey may
        have confirmed this morning while Zoe's last update is five weeks old, and expiring the
        stand as a whole would delete a live claim over a neighbour's stale one.
      */
      /*
        THE INTERSECTION'S TWO INPUTS, computed once per stand.

        The stand's own open-now answer is what every seller's is clamped to, so it is resolved
        here rather than inside the per-seller map — recomputing it per seller would be the same
        arithmetic several times and, worse, a second place it could be resolved differently.
      */
      const availability = readAvailability(row);
      const utcOffsetMinutes = timeZoneOffsetMinutes(now, VASHON_TIME_ZONE);
      const standCoordinates =
        row.public_latitude !== null && row.public_longitude !== null
          ? {
              latitude: Number(row.public_latitude),
              longitude: Number(row.public_longitude),
            }
          : {};
      const standOpenNow = openNow({
        availability,
        ...(closure !== undefined ? { closure } : {}),
        at: now,
        utcOffsetMinutes,
        ...standCoordinates,
      });

      const sellers = (providerFacts.get(locationId) ?? []).map(
        (provider): PublicStandSeller => {
          const asOf =
            !shutDown &&
            provider.publishedAt !== null &&
            !isConfirmationExpired(provider.publishedAt, now)
              ? provider.publishedAt
              : undefined;
          return {
            providerId: provider.providerId,
            sellerId: provider.sellerId,
            sellerName: provider.sellerName,
            describesOwnStand: provider.describesOwnStand,
            ...(asOf === undefined
              ? {}
              : { cardRecency: renderCardRecency(asOf, now), stale: isStale(asOf, now) }),
            /*
              THE SEAM PHASE A BUILT FOR THIS. A seller who stated no schedule of their own
              passes `undefined`, and the stand's answer comes back untouched — which is what
              keeps every single-seller stand on the island answering exactly as it did before.
            */
            openState: intersectAvailability({
              stand: standOpenNow,
              ...(hasStatedAvailability(provider.availability)
                ? {
                    provider: openNow({
                      availability: provider.availability,
                      // The seller's answer is computed WITHOUT the closure: a stand closure is
                      // the stand's fact, and applying it on both sides would make the clamp
                      // meaningless — every seller would already read `farmer_closed` and the
                      // intersection would have nothing left to decide.
                      at: now,
                      utcOffsetMinutes,
                      ...standCoordinates,
                    }),
                  }
                : {}),
            }).state,
            // An expired confirmation contributes NO items, exactly as it contributes no date.
            // Keeping the items while dropping the date is the "In stock, undatable" claim the
            // rule above exists to refuse.
            confirmedItems: asOf === undefined ? [] : provider.confirmedItems.map(publicItem),
            // A shutdown takes the STANDING claims too. "Fernhorn usually has sourdough" is as
            // unbuyable as today's loaves when the stand is locked, and a usual line printing
            // under a closure notice is the same false invitation the confirmed one would be.
            usualItems: shutDown
              ? []
              : provider.usualItems.map((item) => ({
                  itemName: item.itemName,
                  ...(item.priceText === undefined ? {} : { priceText: item.priceText }),
                })),
          };
        },
      );

      /*
        THE STAND-WIDE FACTS, DERIVED FROM THE SELLERS RATHER THAN READ AGAIN.

        `asOf` is the FRESHEST live confirmation at this stand, because the card's one-line
        summary and the map's ordering both ask "how current is this stand" — and the honest
        answer to that is the most recent thing anyone here vouched for. The per-seller dates
        survive intact on `sellers`, so the detail card never has to fall back to this.

        Deriving rather than re-reading is what makes the two shapes incapable of disagreeing;
        a second query would be a second answer.
      */
      const liveConfirmations = (providerFacts.get(locationId) ?? [])
        .map((provider) => provider.publishedAt)
        .filter(
          (publishedAt): publishedAt is Date =>
            publishedAt !== null && !isConfirmationExpired(publishedAt, now),
        );
      const asOf =
        // A shutdown takes the stand-wide date with the items it dated. Read from the same
        // `shutDown` the sellers above were built from rather than re-testing the closure, so
        // there is exactly one place the rule is decided.
        shutDown || liveConfirmations.length === 0
          ? undefined
          : liveConfirmations.reduce((newest, candidate) =>
              candidate > newest ? candidate : newest,
            );

      // F-038 — the place fields are spread conditionally, exactly like the recency fields
      // below, so a contact-only farm carries no address key at all rather than a null one.
      // Read from the database's own answer (`visitability`) rather than by testing whether
      // the address happens to be null, so the constraint and the reader cannot disagree.
      const address = row.public_address as string | null;
      const latitude = row.public_latitude as number | null;
      const longitude = row.public_longitude as number | null;

      stand = {
        factId: locationId,
        farmName: row.farm_name as string,
        locationName: row.location_name as string,
        locationKind: row.location_kind as "farm_stand" | "farmers_market",
        visitability: row.visitability as "visitable" | "contact_only",
        offeringType: row.offering_type as "produce" | "services" | "by_order",
        ...(row.farm_description !== null && row.farm_description !== undefined
          ? { description: row.farm_description as string }
          : {}),
        // Older imported rows are `false/false`: that means no eligibility review, not a
        // customer-facing claim that the stand refuses VIGA Bucks. Only an eligible row has
        // a reviewed acceptance answer to publish.
        ...(row.farm_bucks_eligible === true
          ? { farmBucksAccepted: row.farm_bucks_accepted as boolean }
          : {}),
        /*
          F-088 — the pin and the address text are now separate decisions.

          The COORDINATE travels whenever the stand is visitable and placed. The ADDRESS travels
          only when the farmer also lets it be shown. `address_public` is `NOT NULL DEFAULT true`,
          so an explicit `=== false` is not needed — but it is written that way anyway, because a
          missing column on an older row would otherwise read as `undefined` and silently hide
          every address on the island.
        */
        /*
          F-088 — `isVisitable` is NO LONGER a gate on the location.

          It used to be, because the database guaranteed a contact-only farm had none. Now every
          farm may be placed, and a farm the map cannot draw is a farm nobody finds — the
          lead-gen case max named. What tells the two apart downstream is `visitability` itself,
          which the payload already carries: the marker kind, the "no stand to visit" card line,
          and the suppressed directions link all read it.

          The location still travels whole or not at all. That half is the database's rule and
          this mirrors it rather than restating a second, looser version.
        */
        ...(address !== null && latitude !== null && longitude !== null
          ? {
              ...(row.address_public === false ? {} : { publicAddress: address }),
              latitude: Number(latitude),
              longitude: Number(longitude),
            }
          : {}),
        ...(asOf
          ? {
              asOf,
              recencyLabel: renderRecency(asOf, now),
              confirmedElapsed: renderElapsed(asOf, now),
              // F-097 — the PUBLIC CARD's own phrasing, which counts in weeks and gives up at
              // four of them. Rendered here beside the other two rather than derived in the
              // component, so all three recency strings for a row are decided in one place.
              cardRecency: renderCardRecency(asOf, now),
              isStale: isStale(asOf, now),
            }
          : {}),
        // F-042 — spread flat rather than conditionally: an empty list is the honest answer
        // for an untagged stand, and there is no second fact for absence to distinguish.
        //
        // DERIVED FROM THE SELLERS (C.5), deduplicated by name across them: a customer reading
        // "usually sells" wants to know what is on offer here, and printing "eggs" twice
        // because two sellers both usually carry them reads as two facts about eggs. WHOSE they
        // are is the detail card's question, and `sellers` carries the answer intact.
        //
        // The price is already rendered by the reader, and already withheld there for a stand
        // with prices switched off — gated in SQL so the value never leaves the database.
        usualOfferings: dedupeByItemName(
          sellers.flatMap((seller) => seller.usualItems),
        ),
        // F-043 — always present, `{}` when the stand stated nothing. The inner fields carry
        // the stated/unstated distinction; see `readAvailability`.
        availability: readAvailability(row),
        ...(closure !== undefined ? { closure } : {}),
        participantNames: (row.participant_names as string[] | null) ?? [],
        // Empty, never absent — the same rule as `usualOfferings` above.
        links: (row.links as PublicStandLink[] | null) ?? [],
        paymentMethods: (row.payment_methods as string[] | null) ?? [],
        // The stand-wide union, deduplicated the same way and for the same reason. Derived
        // rather than read a second time, which is what keeps it from becoming a second fact.
        items: dedupeByItemName(sellers.flatMap((seller) => seller.confirmedItems)),
        sellers,
      };
      byLocation.set(locationId, stand);
    }
  }

  /*
    MOST-RECENTLY-CONFIRMED FIRST, never-confirmed last (B-013).

    Sorted here rather than in SQL since C.5: the ordering key is the stand's freshest LIVE
    confirmation, and that is now a per-seller fact the database cannot express in one
    `order by` without the stand-wide join this phase removed. `asOf` is absent exactly for a
    stand nothing live was confirmed at, and those go last rather than being sorted as though
    they were infinitely old.
  */
  return [...byLocation.values()].sort((a, b) => {
    if (a.asOf === undefined && b.asOf === undefined) return a.factId.localeCompare(b.factId);
    if (a.asOf === undefined) return 1;
    if (b.asOf === undefined) return -1;
    return b.asOf.getTime() - a.asOf.getTime() || a.factId.localeCompare(b.factId);
  });
}

/**
 * One published entry as the public surface carries it.
 *
 * The reader's `entryId` is deliberately dropped: it is a durable identifier the map has no use
 * for, and a public payload states what a customer needs rather than every column that was read.
 */
function publicItem(item: {
  itemName: string;
  quantity?: number;
  unit?: string;
  priceText?: string;
  approximation?: "some" | "limited" | "plentiful";
}): PublicStandItem {
  return {
    itemName: item.itemName,
    ...(item.quantity === undefined ? {} : { quantity: item.quantity }),
    ...(item.unit === undefined ? {} : { unit: item.unit }),
    ...(item.priceText === undefined ? {} : { priceText: item.priceText }),
    ...(item.approximation === undefined ? {} : { approximation: item.approximation }),
  };
}

/**
 * Collapse a stand-wide list to one entry per item name, keeping the first.
 *
 * **The first, not a merge.** Two sellers' eggs have two prices and two freshnesses, and there
 * is no honest way to state both on a single stand-wide line — §customer behavior rejects a
 * price range and a suppressed price alike. So the stand-wide list answers "is there kale
 * here" and the DETAIL CARD, reading `sellers`, answers "whose, at what price, confirmed when".
 *
 * Case-sensitive, matching `groupProviderItems` and for the same reason: the vocabulary is
 * already reconciled by the reader's `stand_items` join, so a surviving difference is a real
 * difference between two sellers' own words, and folding it would print one seller's spelling
 * over another's.
 */
function dedupeByItemName<Item extends { itemName: string }>(items: Item[]): Item[] {
  const seen = new Set<string>();
  const kept: Item[] = [];
  for (const item of items) {
    if (seen.has(item.itemName)) continue;
    seen.add(item.itemName);
    kept.push(item);
  }
  return kept;
}

/**
 * The public discovery HTTP handler, over injected dependencies. It lives here rather than
 * in the route file because Next.js permits only its own fields as route exports — and
 * keeping it injectable is what lets the tests invoke it without the process-wide singleton.
 *
 * Note the dependency set: `db` and `clock`. There is no model seam to pass, which is how
 * "public discovery is model-free" is enforced rather than merely intended.
 */
export async function handleStandsRequest(
  deps: PublicListingDeps,
  scope: PublicViewerScope = PUBLIC_VIEWER,
): Promise<Response> {
  const stands = await listPublicStands(deps, scope);

  return Response.json({ stands: stands.map(serializePublicStand) });
}

/**
 * Read the deliberate-viewer decision out of a request URL (F-074).
 *
 * Stated once and shared by the API route and the page, so the two surfaces cannot disagree
 * about what asking for test sellers looks like. Exactly `?hidden=true` counts — `hidden=1`,
 * `hidden`, and `hidden=TRUE` do not, because a filter that leaks on a near-miss is worse than
 * one that is strict and predictable.
 *
 * This is a query parameter, NOT a credential. Anyone who guesses it sees test sellers, which is
 * acceptable only because a test farm holds no real data.
 */
export function viewerScopeFromUrl(url: string): PublicViewerScope {
  const hidden = new URL(url).searchParams.get("hidden");
  return { includeTestFarms: hidden === "true" };
}

/**
 * One stand as the public wire format — the shape `map-view.ts` types as `PublicStandPayload`.
 *
 * Stated ONCE, and consumed by both readers: `GET /api/public/stands` and the server-rendered
 * page, which passes the same objects straight into the browser view model. It was written
 * twice before F-042, and the copies had already begun to matter — a field added to one is
 * invisible on the other, and the page render and the API would then disagree about what a
 * stand is. Exactly the drift the "one general mechanism" rule exists to prevent.
 *
 * Note which keys are CONDITIONAL and which are always present. The three place fields travel
 * together or not at all (F-038); the three recency fields travel together or not at all
 * (B-013, F-042); `usuallySells` is always sent, empty when the stand has no tags. Each of
 * those choices is what lets the renderer tell "we know nothing" from "we know it's empty".
 */
export function serializePublicStand(stand: PublicStand): PublicStandPayload {
  return {
    id: stand.factId,
    farmName: stand.farmName,
    locationName: stand.locationName,
    locationKind: stand.locationKind,
    visitability: stand.visitability,
    offeringType: stand.offeringType,
    ...(stand.description !== undefined ? { description: stand.description } : {}),
    ...(stand.farmBucksAccepted !== undefined
      ? { farmBucksAccepted: stand.farmBucksAccepted }
      : {}),
    // F-038 — the COORDINATE PAIR is omitted together for a contact-only farm, never serialized
    // as null. A client reading `latitude: 0` would drop a pin in the Atlantic. Absence is the
    // only honest encoding of "there is nowhere to go".
    //
    // F-088 SPLIT THE ADDRESS OUT OF THAT BUNDLE, deliberately. The three used to travel as one
    // group because they described one fact; they now describe two — where the stand is, and
    // whether its address may be printed. A stand whose farmer hid the address sends the
    // coordinates with NO `address` key, so the pin still places and the client has nothing to
    // print. `address` without coordinates remains impossible, which is the half that was
    // load-bearing: it is the direction that would put a pin in the ocean.
    ...(stand.latitude !== undefined && stand.longitude !== undefined
      ? {
          ...(stand.publicAddress !== undefined ? { address: stand.publicAddress } : {}),
          latitude: stand.latitude,
          longitude: stand.longitude,
        }
      : {}),
    // Recency is rendered by code, and is present exactly when a farmer has confirmed
    // something. A stale stand stays listed WITH its warning rather than disappearing; a
    // never-confirmed stand is listed with these fields ABSENT (B-013) rather than with a
    // fabricated "updated" string. Omitting the keys — instead of sending null — is what
    // lets the map view distinguish "no confirmation yet" from "confirmed long ago".
    // All THREE recency keys travel together (F-042 adds the third). `confirmedElapsed` is
    // the bare phrase the map's "Confirmed X ago" heading needs; it is present exactly when
    // a farmer confirmed something, so a client never has a date available to put beside
    // the usual-offerings line.
    ...(stand.recencyLabel !== undefined
      ? {
          updated: stand.recencyLabel,
          confirmedElapsed: stand.confirmedElapsed,
          cardRecency: stand.cardRecency,
          stale: stand.isStale,
        }
      : {}),
    // F-042 — always sent, `[]` when the stand has no tags. The map distinguishes "no tags
    // and no confirmation" (still "No listing yet") from "tags but nothing confirmed", and
    // it can only do that if an empty list is stated rather than omitted.
    usuallySells: stand.usualOfferings,
    // F-043 — always sent, `{}` when nothing was stated, exactly like `usuallySells`. The
    // fields INSIDE are what carry stated-vs-unstated, and they are already absent rather
    // than null, so this passes straight through.
    availability: stand.availability,
    alsoSellingHere: stand.participantNames,
    // F-061 — always sent, `[]` when the farm stated none. Structured, so the card renders a
    // labelled action per link instead of scraping one "Website:" line back out of the prose
    // and silently dropping every Instagram and Facebook the farm listed.
    links: stand.links,
    paymentMethods: stand.paymentMethods,
    ...(stand.closure !== undefined ? { closure: stand.closure } : {}),
    items: stand.items,
    // F-114 C.5 — always sent, `[]` for a venue nobody has been invited to. The detail card's
    // source; `items` above is the union of these, derived on the server so the two shapes
    // cannot come to disagree about what a stand holds.
    sellers: stand.sellers,
  };
}

/**
 * Did this seller state ANY schedule of their own?
 *
 * `intersectAvailability` takes `undefined` to mean "no schedule of their own", and gives back
 * the stand's answer untouched. An empty facts object is not the same thing to `openNow`, which
 * would resolve it to `unknown` and then clamp — arriving at the same answer today by a
 * different route, and at a different one the moment either rule changes. Asking the question
 * explicitly keeps the two spellings of "said nothing" from being two behaviours.
 */
function hasStatedAvailability(availability: StandAvailabilityFacts): boolean {
  return (
    availability.season !== undefined ||
    availability.hours !== undefined ||
    (availability.days !== undefined && availability.days.length > 0)
  );
}
