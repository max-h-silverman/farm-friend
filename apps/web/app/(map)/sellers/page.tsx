import { listPublicSellers } from "@farm-friend/db";
import { publicReadContext } from "../../../lib/public-context";
import { SellerDirectory } from "./seller-directory";

// The public SELLER list (F-114 C.5) — the island's second discovery view.
//
// §customer behavior: *"Two public list views: stands and sellers. Stands is the default. The
// map remains a map of stands; sellers get a browse list and a detail page, not pins."*
//
// WHY IT IS NOT OPTIONAL. A hosted-only seller — a bakery that sells exclusively at other
// people's stands — owns no `sales_locations` row, so it has no pin and no card of its own.
// This page is that seller's ONLY discovery path. Without it, the labelling rule C.5 added
// credits hosted sellers by name on other people's cards and leaves them findable nowhere,
// which is a worse outcome than not naming them at all.
//
// MODEL-FREE, structurally, exactly like the map: it takes `publicReadContext` — `db` and
// `clock`, no seam — so there is no path from this page to a model. Natural-language inquiry
// stays SMS-only (F-019), which is why the search box below is a client-side filter over data
// already served rather than a question anyone answers.
//
// Rendered per request. A cached list would keep showing a seller at a stand they left.

export const dynamic = "force-dynamic";

// A repeated parameter arrives as an array, which is not `"true"` — a near-miss fails CLOSED,
// the only safe direction for a visibility filter. Same rule the map page states.
export default async function SellersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const sellers = await listPublicSellers(publicReadContext().db, {
    includeTestSellers: params.hidden === "true",
  });

  return <SellerDirectory sellers={sellers} />;
}
