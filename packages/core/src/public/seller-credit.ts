// F-114 Phase C.5 — WHO GETS CREDITED, and HOW ITEMS ARE GROUPED. Both stated once.
//
// After Phase B a stand has several sellers, and two questions follow every one of them to
// every surface: whose listing is this, and how do several sellers' claims about one item read
// as one card. Both live here, in core, with no database and no framework, where the map, the
// SMS answer, the seller list and the farmer surfaces all reach them.
//
// **C.5 wrote the rule and converted only the cards it was building** (F-115 Tranche C). Four
// other surfaces went on deciding it for themselves — the SMS target menu, the settings loader,
// and two character-identical `listingLabel` copies in React whose comments each claimed the
// ownership this module actually holds. They agreed by habit; nothing compared them. All four
// now compose `creditSeller`, and `listing-label-agreement.test.tsx` compares the surfaces
// rather than the helper, because a second unit test of this function would prove nothing about
// whether anybody calls it.

/**
 * A listing that may or may not need its seller named.
 *
 * `describesOwnStand` is the SELF-POINTER (`sales_locations.own_seller_id`), resolved by
 * whichever reader produced this row. It is the ONLY thing that decides, and that is the whole
 * point of the type: a caller cannot supply a name comparison here even by accident, because
 * the decision is already made by the time the value arrives.
 */
export interface CreditableListing {
  locationName: string;
  sellerName: string;
  /** True when this seller IS the stand — by pointer, never by a name match. */
  describesOwnStand: boolean;
}

/**
 * How one listing is named to a person.
 *
 * **The stand's own seller renders unlabelled; every other seller is credited.** §suppression
 * follows a pointer: a stand owner who sells under a separate brand deliberately created that
 * brand, so it is named on the card and findable in the seller list — and a stand whose own
 * seller is called something else entirely still renders bare, because the pointer says so and
 * the strings are not consulted.
 *
 * **Name matching was rejected as a defect.** Seller names are free text. "Morgan Hill Farm" at
 * "Morgan Hill Stand" would not match, so the stand's own goods would be credited by name on
 * its own card; any looser rule would erase a genuine hosted seller called "Hill Farm" at "Hill
 * Farm Stand". Both failures are in the real corpus's reach, and neither is possible here.
 *
 * `separator` is the caller's, because the two channels are bound differently: SMS is GSM-7 and
 * one em-dash re-encodes the whole body to UCS-2, halving its capacity, so the SMS readers pass
 * `" - "` and the web passes `" — "`. What must not differ between channels is WHICH listings
 * get a name, and that is the part this function owns.
 */
/**
 * What separates a stand's name from its seller's on a SCREEN.
 *
 * An em-dash, because nothing on the web is bound by encoding. Named rather than typed at each
 * caller so the two channels' choices sit side by side and neither can drift into the other's.
 */
export const LISTING_SEPARATOR = " — ";

/**
 * The same separator in SMS.
 *
 * A plain hyphen, and this is NOT a style choice. One em-dash re-encodes the whole message body
 * from GSM-7 to UCS-2, dropping per-segment capacity from 153 characters to 67 — an encoding
 * effect, not a length effect, and invisible by inspection (`reply-encoding.test.ts` sweeps
 * every code-owned reply for it).
 */
export const SMS_LISTING_SEPARATOR = " - ";

export function creditSeller(listing: CreditableListing, separator: string): string {
  const credit = sellerCredit(listing);
  return credit === undefined
    ? listing.locationName
    : `${listing.locationName}${separator}${credit}`;
}

/**
 * The seller's name where it is owed, and NOTHING where it is not.
 *
 * The same decision `creditSeller` makes, without a location name attached — for the surfaces
 * that already print the stand's name in a heading and need only the credit that goes beside an
 * item. The stand detail card is the first: its heading says "Morgan Hill Stand", so a nested
 * line wants "Tian Tian" alone, and for the stand's own seller wants nothing at all.
 *
 * **Returns `undefined`, never the empty string**, so a renderer has no value to print in the
 * credit slot for a line that must render bare — the absence is the instruction.
 *
 * One predicate, two renderings. Composing this into a location name is what `creditSeller`
 * does, which is what keeps the SMS menu, the settings screen and the public cards incapable of
 * disagreeing about which sellers are named.
 */
export function sellerCredit(
  listing: Pick<CreditableListing, "sellerName" | "describesOwnStand">,
): string | undefined {
  return listing.describesOwnStand ? undefined : listing.sellerName;
}

/**
 * Which kind of claim an item line is.
 *
 * `confirmed` — a farmer dated this: it was on the table when they said so.
 * `usual` — a standing claim, true in March and September, dated by nothing.
 *
 * They are never collapsed (§customer behavior: unknown, usual and current stay distinct), and
 * keeping the distinction in the DATA rather than in each renderer is what stops a usual line
 * inheriting someone else's timestamp.
 */
export type ItemRegister = "confirmed" | "usual";

/** One item as one provider states it. */
export interface ProviderItem {
  itemName: string;
  register: ItemRegister;
  priceText?: string;
  quantity?: number;
  unit?: string;
  approximation?: "some" | "limited" | "plentiful";
}

/** Everything one seller-at-a-stand contributes to the card. */
export interface ProviderItemFacts {
  providerId: string;
  sellerId: string;
  sellerName: string;
  /** By SELF-POINTER. See `CreditableListing`. */
  describesOwnStand: boolean;
  /**
   * This provider's own card-recency sentence, absent when they have confirmed nothing.
   *
   * Per PROVIDER, because each publishes independently: at one stand Tian Tian's eggs may be
   * two hours old and Cascade Bakery's three weeks. A stand-wide timestamp would date one
   * seller's goods by another's update, which is the silently-wrong output Phase A's
   * consolidation exists to make impossible.
   */
  cardRecency?: string;
  /** True when this provider's confirmation is old enough to warn about. */
  stale?: boolean;
  items: ProviderItem[];
}

/** One provider's contribution to a single item's line. */
export interface ItemProviderLine {
  providerId: string;
  sellerId: string;
  sellerName: string;
  describesOwnStand: boolean;
  priceText?: string;
  quantity?: number;
  unit?: string;
  approximation?: "some" | "limited" | "plentiful";
  /**
   * Absent on every `usual` line, always.
   *
   * A hosted seller is public on approval on standing claims alone, so this is often the FIRST
   * thing a customer reads about them — and a date beside it would read as a confirmation
   * nobody made. Dropped HERE rather than left to each renderer to omit, so there is no slot a
   * timestamp could be put back into.
   */
  cardRecency?: string;
  stale?: boolean;
}

/** One item, once, with every seller who supports it nested beneath. */
export interface GroupedItem {
  itemName: string;
  register: ItemRegister;
  providers: ItemProviderLine[];
}

/**
 * Turn several providers' item lists into the card's item-first shape.
 *
 * **Each item appears once; its supporting providers nest beneath it with their own price and
 * their own freshness.** Before this, a stand card printed one flat list, which after Phase B
 * became three duplicate `Tomatoes` rows the moment three sellers carried tomatoes.
 *
 * THE KEY IS `(itemName, register)`, EXACTLY. Two decisions in that:
 *
 * - **No case-folding, no trimming.** The vocabulary is already reconciled upstream by the
 *   `stand_items` join every reader shares, so a difference that survives to here is a real
 *   difference between two sellers' own words. `standListingLines` refuses the same safety net
 *   for the same reason: a fallback would make a broken join invisible for as long as it lasted.
 * - **The register is part of the key.** One seller confirming eggs today and another merely
 *   usually carrying them are two claims, not one — and merging them would date the standing
 *   claim by someone else's confirmation.
 *
 * Confirmed groups come first, then usual ones. Within each, items keep the order they were
 * first seen, and providers keep the order they were given — so the caller's ordering (the
 * stand's own seller first, then hosted sellers) survives into the card.
 */
export function groupProviderItems(
  providers: readonly ProviderItemFacts[],
): GroupedItem[] {
  const groups = new Map<string, GroupedItem>();

  for (const provider of providers) {
    for (const item of provider.items) {
      const key = `${item.register} ${item.itemName}`;
      let group = groups.get(key);
      if (group === undefined) {
        group = { itemName: item.itemName, register: item.register, providers: [] };
        groups.set(key, group);
      }
      group.providers.push({
        providerId: provider.providerId,
        sellerId: provider.sellerId,
        sellerName: provider.sellerName,
        describesOwnStand: provider.describesOwnStand,
        ...(item.priceText === undefined ? {} : { priceText: item.priceText }),
        ...(item.quantity === undefined ? {} : { quantity: item.quantity }),
        ...(item.unit === undefined ? {} : { unit: item.unit }),
        ...(item.approximation === undefined ? {} : { approximation: item.approximation }),
        // The no-timestamp rule, enforced by the shape rather than by the renderer. A `usual`
        // line has no recency field at all, so nothing downstream has one to print.
        ...(item.register === "usual" || provider.cardRecency === undefined
          ? {}
          : { cardRecency: provider.cardRecency }),
        ...(item.register === "usual" || provider.stale === undefined
          ? {}
          : { stale: provider.stale }),
      });
    }
  }

  const ordered = [...groups.values()];
  // A stable partition rather than a sort: `Array.prototype.sort` is stable in every runtime
  // this ships to, but stating the partition directly says what is meant and cannot be undone
  // by someone adding a second sort key later.
  return [
    ...ordered.filter((group) => group.register === "confirmed"),
    ...ordered.filter((group) => group.register === "usual"),
  ];
}
