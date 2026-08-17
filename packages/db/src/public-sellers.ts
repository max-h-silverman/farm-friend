import type { Db } from "./index";
import { visibleFarms } from "./test-farms";
import { publicProviders } from "./provider-liveness";

/*
  F-114 Phase C.5 — THE SELLER LIST.

  ## Why it is not optional

  §customer behavior: a hosted-only seller — a bakery that sells exclusively at other people's
  stands — owns no `sales_locations` row, so it has no pin and no card of its own. This list is
  that seller's ONLY discovery path. Without it, C.5's own labelling rule credits hosted sellers
  by name on other people's cards and makes them findable nowhere, which is worse than not
  naming them at all.

  ## The second grouping of one reader

  The stand card groups by ITEM with sellers nested. This groups by SELLER with stands nested,
  and each stand carries that seller's items. Same provider rows, same liveness rules, opposite
  nesting — which is what makes "the same facts in two views" a property rather than a promise.

  ## What it deliberately does NOT carry

  No confirmed inventory and no freshness. A seller's page answers *where can I buy from them*,
  and the answer to *what is out right now* is the STAND's card, which is the one place that
  states it with its own recency. Duplicating a dated claim here would be a second place for it
  to go stale.
*/

/** One stand a seller is currently selling at. */
export interface PublicSellerStand {
  salesLocationId: string;
  locationName: string;
  /** True when this seller IS that stand — by self-pointer, never a name match. */
  describesOwnStand: boolean;
  /** What they usually carry THERE. Per stand, never pooled across a seller's stands. */
  usualItems: { itemName: string }[];
}

/** One seller as the public list carries them. */
export interface PublicSeller {
  sellerId: string;
  sellerName: string;
  description?: string;
  /**
   * True when this seller runs a stand of their own somewhere.
   *
   * The list's own reason for existing is the sellers for which this is FALSE — they have no
   * pin and no card, so this list is where they are found. Carried so the page can say so
   * rather than leaving a hosted-only seller looking like an incomplete record.
   */
  ownsAStand: boolean;
  /** Where they are selling now, by stand name. Never empty — see the liveness rule below. */
  sellingAt: PublicSellerStand[];
}

/**
 * Every seller currently selling anywhere on the island.
 *
 * **A seller with no live relationship is absent entirely.** `pending` and ended relationships
 * are excluded, exactly as they are from the stand cards, so an invitation nobody accepted
 * lists nobody and a seller who has stopped selling everywhere leaves the list rather than
 * appearing with an empty `sellingAt`. `paused` is included: a paused seller still sells there,
 * they are simply not being prompted.
 *
 * **Visibility is checked on BOTH ends.** `visibleFarms` over the seller (a test seller appears
 * only for a deliberate viewer; a farm VIGA retired appears for nobody), AND the stand's own
 * `is_public` and `retired_at`. Those are different facts with different owners — the farmer's
 * switch and VIGA's — and a reader filtering one passes the other's test while leaking.
 */
export async function listPublicSellers(
  db: Db,
  input: { includeTestSellers: boolean },
): Promise<PublicSeller[]> {
  /*
    ONE ROW PER (SELLER, STAND), then one pass for the items.

    Two statements rather than one: fanning `stand_items` out beside the stands is a cross
    product, and a seller at three stands with four items each would arrive as twelve rows that
    a naive loop reads as twelve items.
  */
  const standRows = await db.sql.unsafe(
    `
      select
        seller.id as seller_id,
        seller.name as seller_name,
        seller.description as description,
        provider.id as provider_id,
        location.id as sales_location_id,
        location.name as location_name,
        (provider.seller_id is not distinct from location.own_seller_id) as describes_own_stand
      from stand_providers as provider
      join sellers as seller on seller.id = provider.seller_id
      join sales_locations as location on location.id = provider.sales_location_id
      where ${publicProviders("provider")}
        -- The STAND's own two gates. is_public is the farmer's switch and retired_at is VIGA's
        -- decision; they are deliberately separate columns (F-071) because the farmer's
        -- onboarding form rewrites the first on every save.
        and location.is_public
        and location.retired_at is null
        and ${visibleFarms("seller", input.includeTestSellers)}
      order by lower(seller.name) asc, seller.id asc, lower(location.name) asc, location.id asc
    `,
    [],
  );

  const bySeller = new Map<string, PublicSeller>();
  const standByProvider = new Map<string, PublicSellerStand>();

  for (const raw of standRows) {
    const row = raw as Record<string, unknown>;
    const sellerId = row.seller_id as string;
    const description = row.description as string | null;

    let seller = bySeller.get(sellerId);
    if (seller === undefined) {
      seller = {
        sellerId,
        sellerName: row.seller_name as string,
        ...(description === null ? {} : { description }),
        ownsAStand: false,
        sellingAt: [],
      };
      bySeller.set(sellerId, seller);
    }

    const describesOwnStand = row.describes_own_stand === true;
    // Accumulated across the seller's stands rather than read off one: a seller may own one
    // stand and be a guest at another, and `ownsAStand` is the question "do they have a pin
    // anywhere", not "is this row their own".
    if (describesOwnStand) seller.ownsAStand = true;

    const stand: PublicSellerStand = {
      salesLocationId: row.sales_location_id as string,
      locationName: row.location_name as string,
      describesOwnStand,
      usualItems: [],
    };
    seller.sellingAt.push(stand);
    standByProvider.set(row.provider_id as string, stand);
  }

  if (standByProvider.size > 0) {
    const itemRows = await db.sql.unsafe(
      `
        select item.provider_id as provider_id, item.display_name as item_name
        from stand_items as item
        -- usually_carried, for the reason F-066 states: an item that exists only because a past
        -- revision named it is vocabulary, not something the seller says they usually have.
        where item.provider_id = any($1::uuid[]) and item.usually_carried
        order by item.provider_id asc, item.sort_order asc, item.display_name asc
      `,
      [[...standByProvider.keys()]],
    );

    for (const raw of itemRows) {
      const row = raw as Record<string, unknown>;
      const stand = standByProvider.get(row.provider_id as string);
      if (stand === undefined) continue;
      stand.usualItems.push({ itemName: row.item_name as string });
    }
  }

  return [...bySeller.values()];
}
