import { isStale, renderElapsed, renderRecency, type Clock } from "@farm-friend/core";
import type { Db } from "@farm-friend/db";
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

export interface PublicStandItem {
  itemName: string;
  quantity?: number;
  unit?: string;
  priceText?: string;
  approximation?: "some" | "limited" | "plentiful";
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
   */
  usualOfferings: string[];
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
   * `farm_links` held a correct schema and had NO writer and NO reader — verified in both
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
  items: PublicStandItem[];
}

export interface PublicStandLink {
  /** What a person reads — "Website", "Instagram", "Facebook". */
  label: string;
  /** Always absolute; `farm_links_absolute_http_url` refuses anything else. */
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
): Promise<PublicStand[]> {
  const rows = await deps.db.sql`
    select
      l.id as location_id,
      l.name as location_name,
      l.kind as location_kind,
      l.public_address as public_address,
      l.public_latitude as public_latitude,
      l.public_longitude as public_longitude,
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
      f.name as farm_name,
      f.description as farm_description,
      r.published_at as published_at,
      c.result as closure_result,
      c.closure_kind as closure_kind,
      c.starts_on::text as closure_starts_on,
      c.closed_through::text as closure_closed_through,
      -- F-042 — aggregated in a subquery rather than joined alongside inventory_entries.
      -- A second LEFT JOIN would make this query a CROSS PRODUCT: 3 tags x 2 confirmed items
      -- is 6 rows, and the loop below would push each item three times and each tag twice.
      -- Every duplicate reads as a real second item on the card. Aggregating keeps the row
      -- grain at one-per-inventory-entry, which is what the loop already assumes.
      --
      -- coalesce, because an aggregate over no rows is NULL rather than an empty array. The
      -- untagged stands are the majority, so that is the common path, not the edge.
      -- F-066 — the standing state of a stand item, not a table of its own. usually_carried
      -- is what makes it a standing claim; an item that exists only because a past revision
      -- named it is vocabulary, not something the stand says it usually has.
      coalesce(
        (
          select array_agg(o.display_name order by o.sort_order asc, o.display_name asc)
          from stand_items o
          where o.sales_location_id = l.id and o.usually_carried
        ),
        array[]::text[]
      ) as usual_offerings,
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
          from farm_links link
          where link.farm_id = f.id
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
      ) as payment_methods,
      -- F-066 — a confirmed item is rendered in its STAND ITEM's words, so the confirmed list
      -- and the usual list are one vocabulary by the time anything reads them.
      --
      -- Both columns hold the farmer's own words, but from different moments: the entry keeps
      -- what was published (immutably — its table refuses every update), while the item is the
      -- stand's current spelling. They legitimately differ in case — the weekly form states
      -- "Eggs", the profile form seeded "eggs" — and standListingLines must subtract one list
      -- from the other so nothing prints under two headings. Resolving here means that
      -- subtraction is a plain set difference over one vocabulary instead of a case-fold in the
      -- view standing in for a join.
      --
      -- coalesce, because an entry naming something with no item row must still render rather
      -- than vanish. The backfill leaves none, and every writer creates the item, but a
      -- confirmed item silently disappearing from a card is not a failure mode worth risking.
      coalesce(item.display_name, e.item_name) as item_name,
      e.quantity as quantity,
      e.unit as unit,
      e.price_text as price_text,
      e.approximation as approximation
    from sales_locations l
    join farms f on f.id = l.owner_farm_id
    left join inventory_revisions r
      on r.sales_location_id = l.id and r.is_current
    left join closure_revisions c
      on c.sales_location_id = l.id and c.is_current
    left join inventory_entries e on e.inventory_revision_id = r.id
    -- The entry's stand item, by the same normalized key the unique index enforces. This is
    -- the link, and it is a join rather than a foreign key because inventory_entries refuses
    -- every update — a reference column could never have been backfilled onto published rows
    -- without disabling the immutability guard (see 0020_stand_items.sql). The index makes this
    -- at most one row, so it cannot multiply the result.
    left join stand_items item
      on item.sales_location_id = e.sales_location_id
     and lower(btrim(item.display_name, E' \t\r\n'))
       = lower(btrim(e.item_name, E' \t\r\n'))
    -- F-071 — retired_at is a SECOND, operator-owned reason a stand leaves the public
    -- surface, and it is deliberately not folded into is_public: that column is a listing
    -- attribute the farmer's own onboarding form sets to true on every save, so VIGA's
    -- decision expressed through it would be reverted the next time the farmer edited.
    where l.is_public and l.retired_at is null
    order by r.published_at desc nulls last, l.id asc, e.sort_order asc
  `;

  const now = deps.clock.now();
  const byLocation = new Map<string, PublicStand>();

  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    const locationId = row.location_id as string;

    let stand = byLocation.get(locationId);
    if (!stand) {
      // `published_at` is null exactly when the left join found no current revision. The
      // three recency fields are then omitted TOGETHER — spreading them conditionally rather
      // than assigning `undefined` keeps them absent from the object, so a downstream
      // `"asOf" in stand` check and JSON serialization both agree that nothing was confirmed.
      const publishedAt = row.published_at as Date | null;
      const asOf = publishedAt ?? undefined;

      // F-038 — the place fields are spread conditionally, exactly like the recency fields
      // below, so a contact-only farm carries no address key at all rather than a null one.
      // Read from the database's own answer (`visitability`) rather than by testing whether
      // the address happens to be null, so the constraint and the reader cannot disagree.
      const address = row.public_address as string | null;
      const latitude = row.public_latitude as number | null;
      const longitude = row.public_longitude as number | null;
      const isVisitable = row.visitability === "visitable";
      const closure = readPublicClosure(row, now);

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
        ...(isVisitable && address !== null && latitude !== null && longitude !== null
          ? {
              publicAddress: address,
              latitude: Number(latitude),
              longitude: Number(longitude),
            }
          : {}),
        ...(asOf
          ? {
              asOf,
              recencyLabel: renderRecency(asOf, now),
              confirmedElapsed: renderElapsed(asOf, now),
              isStale: isStale(asOf, now),
            }
          : {}),
        // F-042 — spread flat rather than conditionally: an empty list is the honest answer
        // for an untagged stand, and there is no second fact for absence to distinguish.
        usualOfferings: (row.usual_offerings as string[] | null) ?? [],
        // F-043 — always present, `{}` when the stand stated nothing. The inner fields carry
        // the stated/unstated distinction; see `readAvailability`.
        availability: readAvailability(row),
        ...(closure !== undefined ? { closure } : {}),
        participantNames: (row.participant_names as string[] | null) ?? [],
        // Empty, never absent — the same rule as `usualOfferings` above.
        links: (row.links as PublicStandLink[] | null) ?? [],
        paymentMethods: (row.payment_methods as string[] | null) ?? [],
        items: [],
      };
      byLocation.set(locationId, stand);
    }

    // A revision with no entries still appears — the farmer confirmed an empty stand, and
    // that is a fact worth showing with its date.
    if (row.item_name === null || row.item_name === undefined) continue;

    stand.items.push({
      itemName: row.item_name as string,
      ...(row.quantity !== null ? { quantity: Number(row.quantity) } : {}),
      ...(row.unit !== null ? { unit: row.unit as string } : {}),
      ...(row.price_text !== null ? { priceText: row.price_text as string } : {}),
      ...(row.approximation !== null
        ? { approximation: row.approximation as "some" | "limited" | "plentiful" }
        : {}),
    });
  }

  return [...byLocation.values()];
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
): Promise<Response> {
  const stands = await listPublicStands(deps);

  return Response.json({ stands: stands.map(serializePublicStand) });
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
    // F-038 — omitted TOGETHER for a contact-only farm, never serialized as null. A client
    // reading `address: null` would print an empty address line; `latitude: 0` would drop a
    // pin in the Atlantic. Absence is the only honest encoding of "there is nowhere to go".
    ...(stand.publicAddress !== undefined &&
    stand.latitude !== undefined &&
    stand.longitude !== undefined
      ? {
          address: stand.publicAddress,
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
  };
}
