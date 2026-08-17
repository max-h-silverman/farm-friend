import {
  readAvailabilityFacts,
  renderStandItemPrice,
  type StandAvailabilityFacts,
  type StandItemPrice,
} from "@farm-friend/core";
import type { Db } from "./index";
import { visibleFarms } from "./test-farms";
import { publicProviders } from "./provider-liveness";

/*
  F-114 Phase C.5 — WHAT EACH SELLER CLAIMS AT A STAND. The one public reader.

  ## Why this exists

  The public map, SMS retrieval and the seller list all have to answer the same question after
  Phase B: at this stand, what does each seller currently claim, and how fresh is each claim?
  Phase A consolidated the *currency predicate* so that question would have one place to change
  when providers arrived. This is that change — and it is a NEW reader rather than a widening
  of `currentInventoryJoin`, because the shape of the answer changed, not just the predicate:
  the corpus-wide surfaces select one row per stand and this returns a nested structure per
  stand. Keeping them separate lets the three surfaces above adopt it one at a time without the
  admin roster, which genuinely does want stand-wide aggregates, being dragged along.

  ## What a provider-blind reader gets wrong, silently

  Before C.5 the map joined `is_current` on `sales_location_id` alone. With two sellers at one
  stand that returns both revisions' entries interleaved under whichever `published_at` the
  planner surfaced, so one seller's goods are dated by the other's update. Nothing errors, the
  items are all present, and the card is wrong. That is the class of defect this module ends.

  ## The two registers stay apart, all the way down

  `confirmedItems` is what a farmer dated. `usualItems` is a standing claim dated by nothing. A
  hosted seller is public on approval on standing claims alone (§customer behavior), so a
  provider carrying only `usualItems` is an ordinary, expected result — and it comes back with
  `publishedAt: null`, because there is nothing to date it by and no field a renderer could
  read a date out of.
*/

/** One item a provider currently claims, in the farmer's own words. */
export interface ProviderConfirmedItem {
  entryId: string;
  itemName: string;
  quantity?: number;
  unit?: string;
  priceText?: string;
  approximation?: "some" | "limited" | "plentiful";
}

/**
 * Something a provider USUALLY sells, with its rendered price.
 *
 * The RENDERED SENTENCE, not the four parts — turned into words once, here, by the single
 * renderer every surface shares. A caller holding `amount` and `basis` would be a second place
 * that decides how a price reads.
 */
export interface ProviderUsualItem {
  itemId: string;
  itemName: string;
  priceText?: string;
}

/** Everything one seller-at-one-stand publishes. */
export interface StandProviderFacts {
  providerId: string;
  salesLocationId: string;
  sellerId: string;
  sellerName: string;
  /**
   * True when this provider IS the stand — `provider.seller_id` equals
   * `sales_locations.own_seller_id`.
   *
   * **By self-pointer, never a name match** (§suppression follows a pointer). Compared with
   * `is not distinct from`, which is what makes a VENUE's null pointer answer `false` rather
   * than NULL: at Morgan Hill no provider is the stand, and a plain `=` would give every one of
   * them a NULL that a careless coalesce turns into "this is the stand's own".
   */
  describesOwnStand: boolean;
  /** This provider's own stated schedule, UNCLAMPED. See the note on clamping below. */
  availability: StandAvailabilityFacts;
  /** One stand-specific note in the seller's own words, when they wrote one. */
  publicNote?: string;
  /**
   * When THIS provider last published — null when they never have.
   *
   * Per provider, always. A stand-wide timestamp is the defect this module exists to prevent.
   */
  publishedAt: Date | null;
  confirmedItems: ProviderConfirmedItem[];
  usualItems: ProviderUsualItem[];
}

/**
 * Every live seller at each of the named stands, with what each one claims.
 *
 * Returned as a Map keyed on `sales_location_id` because every caller has a set of stands in
 * hand and wants each one's sellers beside it; a flat list would make all three surfaces write
 * the same grouping loop.
 *
 * **Which providers are live**: `pending` and ended relationships are excluded — an invitation
 * nobody accepted lists nobody, and an ended relationship is not a listing. `paused` IS
 * included, because a paused seller's last published claim is still what a customer saw; the
 * pause stopped the prompting, not the publication. This matches
 * `readCurrentInventoryByProvider` exactly, so the stock-out router and the public card cannot
 * disagree about what a pause means.
 *
 * **Which sellers are visible**: `visibleFarms` over the SELLER, so a farm VIGA retired leaves
 * every stand it sold at rather than only its own (B-066), and a test seller appears only for a
 * viewer who deliberately asked. Composed rather than hand-written for the reason that fragment
 * exists — four surfaces state this rule and four copies is four chances to miss one.
 *
 * **The availability is NOT clamped here.** A provider's schedule is clamped to its stand's at
 * the rendering seam (`intersectAvailability`), which needs both answers to do it. A reader
 * that resolved the intersection would have to know the stand's schedule too, and would hand
 * every caller one answer where the honest card needs to distinguish "this seller is shut" from
 * "the whole stand is shut".
 *
 * **Ordering**: the stand's own seller first, then hosted sellers by name. Decided here so the
 * map, the SMS answer and the seller list present the same facts in the same order.
 */
export async function readStandProviderFacts(
  db: Db,
  input: { salesLocationIds: readonly string[]; includeTestFarms: boolean },
): Promise<Map<string, StandProviderFacts[]>> {
  const byStand = new Map<string, StandProviderFacts[]>();

  /*
    THE ID SET IS PASSED AS AN ARRAY PARAMETER (`= any($1::uuid[])`), NEVER INTERPOLATED INTO
    AN `in (…)` LIST. That is what makes an empty request safe with no guard in front of it:
    `= any('{}')` matches nothing, so asking for no stands returns no stands. An interpolated
    `in ()` is a syntax error, and the length check people reach for to avoid it is the thing
    that silently becomes "every stand on the island" when it is written the wrong way round.
    An empty-request case is asserted, and it proves the behavior rather than a branch.
  */

  /*
    ONE ROUND TRIP FOR THE PROVIDERS AND THEIR CURRENT REVISION, then one for each register's
    items. Three statements rather than one, deliberately: a single query fanning out both
    `inventory_entries` and `stand_items` is a CROSS PRODUCT — 3 confirmed items and 4 usual
    ones is 12 rows, each read as a real item by any loop that does not de-duplicate. The
    public map already learned this the expensive way (F-042's aggregate-in-a-subquery note),
    and three small statements are legible where one with two aggregated subqueries is not.
  */
  const providerRows = await db.sql.unsafe(
    `
      select
        provider.id as provider_id,
        provider.sales_location_id as sales_location_id,
        provider.seller_id as seller_id,
        seller.name as seller_name,
        (provider.seller_id is not distinct from location.own_seller_id) as describes_own_stand,
        provider.public_note as public_note,
        provider.season_kind as season_kind,
        provider.season_start_month as season_start_month,
        provider.season_start_day as season_start_day,
        provider.season_end_month as season_end_month,
        provider.season_end_day as season_end_day,
        provider.season_names as season_names,
        provider.open_hours_kind as open_hours_kind,
        provider.open_from_minutes as open_from_minutes,
        provider.open_until_minutes as open_until_minutes,
        provider.open_days as open_days,
        revision.id as revision_id,
        revision.published_at as published_at
      from stand_providers as provider
      join sales_locations as location on location.id = provider.sales_location_id
      join sellers as seller on seller.id = provider.seller_id
      -- LEFT, and load-bearing: a hosted seller who is public on standing claims alone has no
      -- revision at all, and dropping them here would delete the very case §customer behavior
      -- says must be visible on approval.
      left join inventory_revisions as revision
        on revision.provider_id = provider.id and revision.is_current
      where provider.sales_location_id = any($1::uuid[])
        and ${publicProviders("provider")}
        and ${visibleFarms("seller", input.includeTestFarms)}
      order by
        provider.sales_location_id asc,
        (provider.seller_id is not distinct from location.own_seller_id) desc,
        lower(seller.name) asc,
        provider.id asc
    `,
    [[...input.salesLocationIds]],
  );

  const byProvider = new Map<string, StandProviderFacts>();
  /** Revision id → the provider it belongs to, so the entries pass attaches without re-joining. */
  const providerByRevision = new Map<string, StandProviderFacts>();

  for (const raw of providerRows) {
    const row = raw as Record<string, unknown>;
    const providerId = row.provider_id as string;
    const salesLocationId = row.sales_location_id as string;
    const publicNote = row.public_note as string | null;

    const facts: StandProviderFacts = {
      providerId,
      salesLocationId,
      sellerId: row.seller_id as string,
      sellerName: row.seller_name as string,
      describesOwnStand: row.describes_own_stand === true,
      availability: readAvailabilityFacts(row),
      ...(publicNote === null ? {} : { publicNote }),
      publishedAt: (row.published_at as Date | null) ?? null,
      confirmedItems: [],
      usualItems: [],
    };

    byProvider.set(providerId, facts);
    const revisionId = row.revision_id as string | null;
    if (revisionId !== null) providerByRevision.set(revisionId, facts);

    const existing = byStand.get(salesLocationId);
    if (existing === undefined) byStand.set(salesLocationId, [facts]);
    else existing.push(facts);
  }

  // A saved pair of round trips, NOT a correctness guard — the two statements below are
  // already correct against an empty set for the reason stated above. Named as an optimization
  // so nobody later mistakes it for a rule and writes a test that cannot fail.
  if (byProvider.size === 0) return byStand;

  const revisionIds = [...providerByRevision.keys()];
  if (revisionIds.length > 0) {
    const entryRows = await db.sql.unsafe(
      `
        select
          entry.id as entry_id,
          entry.inventory_revision_id as revision_id,
          -- F-066 — a confirmed item is rendered in its STAND ITEM's words, so the confirmed
          -- and usual lists are one vocabulary by the time anything groups them. The item is
          -- resolved per PROVIDER now: two sellers at one stand may both carry "eggs", and
          -- joining on the stand alone would resolve one seller's entry to the other's
          -- spelling — and, worse, could match two item rows and duplicate the entry.
          coalesce(item.display_name, entry.item_name) as item_name,
          entry.quantity as quantity,
          entry.unit as unit,
          entry.price_text as price_text,
          entry.approximation as approximation
        from inventory_entries as entry
        join inventory_revisions as revision on revision.id = entry.inventory_revision_id
        left join stand_items as item
          on item.provider_id = revision.provider_id
         and lower(btrim(item.display_name, E' \\t\\r\\n'))
           = lower(btrim(entry.item_name, E' \\t\\r\\n'))
        where entry.inventory_revision_id = any($1::uuid[])
        order by entry.inventory_revision_id asc, entry.sort_order asc, entry.id asc
      `,
      [revisionIds],
    );

    for (const raw of entryRows) {
      const row = raw as Record<string, unknown>;
      const facts = providerByRevision.get(row.revision_id as string);
      if (facts === undefined) continue;
      facts.confirmedItems.push({
        entryId: row.entry_id as string,
        itemName: row.item_name as string,
        ...(row.quantity === null ? {} : { quantity: Number(row.quantity) }),
        ...(row.unit === null ? {} : { unit: row.unit as string }),
        ...(row.price_text === null ? {} : { priceText: row.price_text as string }),
        ...(row.approximation === null
          ? {}
          : { approximation: row.approximation as ProviderConfirmedItem["approximation"] }),
      });
    }
  }

  const usualRows = await db.sql.unsafe(
    `
      select
        item.id as item_id,
        item.provider_id as provider_id,
        item.display_name as item_name,
        -- F-092 — THE PRICE IS GATED HERE, IN THE QUERY. A farmer who turns prices off must not
        -- find them on the map, and gating in SQL means the value never leaves the database, so
        -- no later reader can leak what was withheld. The ITEM is never gated: "this seller
        -- sells eggs" is the listing; only what it costs is theirs to hide.
        case when not location.prices_public then null else item.price_amount::text end as price_amount,
        case when not location.prices_public then null else item.price_quantity::text end as price_quantity,
        case when not location.prices_public then null else item.price_unit end as price_unit,
        case when not location.prices_public then null else item.price_basis end as price_basis
      from stand_items as item
      join sales_locations as location on location.id = item.sales_location_id
      -- F-066 — usually_carried in the predicate: an item that exists only because a past
      -- revision named it is vocabulary, not something the seller says they usually have.
      where item.provider_id = any($1::uuid[]) and item.usually_carried
      order by item.provider_id asc, item.sort_order asc, item.display_name asc
    `,
    [[...byProvider.keys()]],
  );

  for (const raw of usualRows) {
    const row = raw as Record<string, unknown>;
    const facts = byProvider.get(row.provider_id as string);
    if (facts === undefined) continue;
    const price: StandItemPrice | null =
      row.price_amount === null
        ? null
        : {
            amount: row.price_amount as string,
            quantity: row.price_quantity as string,
            unit: row.price_unit as string | null,
            basis: row.price_basis as StandItemPrice["basis"],
          };
    const priceText = renderStandItemPrice(price);
    facts.usualItems.push({
      itemId: row.item_id as string,
      itemName: row.item_name as string,
      ...(priceText === null ? {} : { priceText }),
    });
  }

  return byStand;
}
