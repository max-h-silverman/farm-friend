import { publicReadContext } from "../lib/public-context";
import { listPublicStands, serializePublicStand } from "../lib/public-listing";
import { StandMap } from "./stand-map";

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

// F-074 — `?hidden=true` reaches a server component as `searchParams`, not as a URL, so the
// page reads the parameter itself rather than sharing `viewerScopeFromUrl` with the API route.
// The RULE both surfaces obey — which farms a scope may see — is shared where it matters, in
// `visibleFarms`; what differs here is only how Next hands over the query string.
//
// A repeated parameter arrives as an array. That is not `"true"`, so it does not open the door
// — a near-miss failing CLOSED is the only safe direction for a visibility filter.
export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const stands = await listPublicStands(publicReadContext(), {
    includeTestFarms: params.hidden === "true",
  });

  // The SAME serializer `GET /api/public/stands` uses (F-042). This mapping used to be
  // written out again here, and the two copies had already diverged — the page sent
  // `updated: undefined` and `stale: undefined` as present keys where the API omitted them,
  // so "nobody has confirmed this" reached the browser differently depending on which reader
  // produced it. One statement of the wire format, both readers.
  const payload = stands.map(serializePublicStand);

  return <StandMap stands={payload} />;
}
