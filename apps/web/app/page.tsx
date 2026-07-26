import { publicReadContext } from "../lib/public-context";
import { listPublicStands } from "../lib/public-listing";
import { StandMap } from "./stand-map";
import type { PublicStandPayload } from "../lib/map-view";

// The public stand map (F-017) — the ungated, embeddable surface islanders actually see.
//
// It is MODEL-FREE, and that is structural rather than promised: `listPublicStands` takes
// `db` and `clock`, there is no model seam in its dependency set, and this page passes it
// nothing else. Natural-language inquiry is SMS-only at launch (F-019), so there is no query
// field here for a customer to ask a question into and no path from this page to a model.
//
// Rendering happens per request so recency is honest. A cached page would show "updated 2
// hours ago" long after it stopped being true, which is precisely the staleness the product
// exists to eliminate.

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const stands = await listPublicStands(publicReadContext());

  // Serialize to the same shape the public API serves, so the browser view model has one
  // input type whether it came from this render or from a later fetch.
  const payload: PublicStandPayload[] = stands.map((stand) => ({
    id: stand.factId,
    farmName: stand.farmName,
    locationName: stand.locationName,
    address: stand.publicAddress,
    latitude: stand.latitude,
    longitude: stand.longitude,
    updated: stand.recencyLabel,
    stale: stand.isStale,
    items: stand.items,
  }));

  return <StandMap stands={payload} />;
}
