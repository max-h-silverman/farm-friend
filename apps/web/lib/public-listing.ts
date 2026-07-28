import { isStale, renderRecency, type Clock } from "@farm-friend/core";
import type { Db } from "@farm-friend/db";

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
  publicAddress: string;
  latitude: number;
  longitude: number;
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
   * True when the listing must be shown WITH a prominent staleness warning.
   *
   * Absent — not `false` — when there is nothing to be stale about. "Never confirmed" and
   * "confirmed recently" are different facts, and collapsing them to `false` would claim the
   * second.
   */
  isStale?: boolean;
  items: PublicStandItem[];
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
      l.public_address as public_address,
      l.public_latitude as public_latitude,
      l.public_longitude as public_longitude,
      f.name as farm_name,
      r.published_at as published_at,
      e.item_name as item_name,
      e.quantity as quantity,
      e.unit as unit,
      e.price_text as price_text,
      e.approximation as approximation
    from sales_locations l
    join farms f on f.id = l.farm_id
    left join inventory_revisions r
      on r.sales_location_id = l.id and r.is_current
    left join inventory_entries e on e.inventory_revision_id = r.id
    where l.is_public
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
      stand = {
        factId: locationId,
        farmName: row.farm_name as string,
        locationName: row.location_name as string,
        publicAddress: row.public_address as string,
        latitude: Number(row.public_latitude),
        longitude: Number(row.public_longitude),
        ...(asOf
          ? {
              asOf,
              recencyLabel: renderRecency(asOf, now),
              isStale: isStale(asOf, now),
            }
          : {}),
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

  return Response.json({
    stands: stands.map((stand) => ({
      id: stand.factId,
      farmName: stand.farmName,
      locationName: stand.locationName,
      address: stand.publicAddress,
      latitude: stand.latitude,
      longitude: stand.longitude,
      // Recency is rendered by code, and is present exactly when a farmer has confirmed
      // something. A stale stand stays listed WITH its warning rather than disappearing; a
      // never-confirmed stand is listed with these fields ABSENT (B-013) rather than with a
      // fabricated "updated" string. Omitting the keys — instead of sending null — is what
      // lets the map view distinguish "no confirmation yet" from "confirmed long ago".
      ...(stand.recencyLabel !== undefined
        ? { updated: stand.recencyLabel, stale: stand.isStale }
        : {}),
      items: stand.items,
    })),
  });
}
