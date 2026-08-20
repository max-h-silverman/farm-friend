// F-114 Phase C.5 — the seller list's view model.
//
// The page renders this and decides nothing, exactly as the stand map renders `map-view.ts`.
// What could be WRONG about a seller list — a search that answers every question with
// "everyone", a hosted seller described as running a stand they are a guest at — is decided
// here, in pure functions, where a test can hold it to account.

/** One stand a seller sells at, as the page receives it. */
export interface SellerListStand {
  salesLocationId: string;
  locationName: string;
  /** By SELF-POINTER, resolved server-side. Never a name match. */
  describesOwnStand: boolean;
  usualItems: { itemName: string }[];
}

/** One seller as the page receives them. */
export interface SellerListEntry {
  sellerId: string;
  sellerName: string;
  description?: string;
  ownsAStand: boolean;
  /** B-095, F-125 — her own VIGA Bucks answer, applying at every stand she sells at. */
  farmBucksAccepted: boolean;
  sellingAt: SellerListStand[];
}

/**
 * Narrow the list to what the customer typed.
 *
 * **THE CORPUS IS BOUNDED to facts about the SELLER**: their own name, and the items they
 * carry. A stand's name is deliberately excluded — matching it would answer "who is at Morgan
 * Hill" with every baker who happens to have a table there, whose own identity has nothing to
 * do with the query. The MAP answers that question, by stand, which is where it belongs. This
 * is the same rule `sellsMatch` holds for the map, where `alsoSellingHere` stays out of the
 * haystack for the mirror-image reason.
 *
 * Substring and case-folded: a customer types "dough" and the item says "sourdough". An empty
 * query returns everyone; a query nothing matches returns nothing, which is the direction that
 * matters — a filter failing open would look like working search and answer every question with
 * the whole island.
 */
export function filterSellers(
  sellers: readonly SellerListEntry[],
  query: string,
): SellerListEntry[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...sellers];

  return sellers.filter((seller) => {
    const haystack = [
      seller.sellerName,
      ...seller.sellingAt.flatMap((stand) =>
        stand.usualItems.map((item) => item.itemName),
      ),
    ];
    return haystack.some((entry) => entry.toLowerCase().includes(needle));
  });
}
