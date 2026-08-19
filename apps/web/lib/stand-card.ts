// The SUBPATH, not the barrel. This module is reached from `stand-map.tsx`, which is a client
// component, so anything it imports is bundled for the BROWSER — and core's barrel re-exports
// `privacy/phone`, which imports `node:crypto`. The build fails outright on it, which is the
// good outcome; the failure mode worth naming is that no unit test can see this, because vitest
// runs in Node where `node:crypto` resolves perfectly well. `map-view.ts` imports by subpath for
// exactly this reason, and every browser-reachable core module needs one.
import {
  groupProviderItems,
  sellerCredit,
  type ItemRegister,
  type ProviderItemFacts,
} from "@farm-friend/core/seller-credit";
import type { OpenState } from "@farm-friend/core/open-now";
import type { PublicStandPayload } from "./map-view";

// F-114 Phase C.5 — THE STAND DETAIL CARD, ITEM-FIRST.
//
// §customer behavior: *"Stand details stay centered on one In stock card, item-first: each item
// appears once and its supporting providers nest beneath it with their own price and freshness.
// No three duplicate Tomatoes rows."*
//
// ## Why this is a second function beside `standListingLines`, and not a replacement
//
// `standListingLines` decides a stand's body as SENTENCES — "Confirmed 4 hours ago: eggs, kale"
// — which is the shape the compact card and every SMS-parity surface need, and the shape that
// has carried the no-timestamp rule since F-042. It is stand-level by construction: one
// confirmed heading, one usual heading, one recency phrase for the whole stand.
//
// After Phase B a stand has several sellers, each publishing independently with its own
// freshness. That is a second axis, and a flat list of sentences cannot hold it — the honest
// rendering needs an item to say "these three sellers have it, at these three prices, each
// confirmed at a different time". This function owns exactly that axis.
//
// It decides nothing else. Recency wording is core's; who gets credited is `creditSeller`'s;
// which register an item is in was decided by the reader. What is stated HERE, once, is which
// sections a card has and what nests under each item.

/** One item as one seller states it, already rendered. */
export interface StandCardItem {
  itemName: string;
  priceText?: string;
  quantity?: number;
  unit?: string;
  approximation?: "some" | "limited" | "plentiful";
}

/**
 * One seller at this stand, as the payload carries them.
 *
 * `describesOwnStand` arrives resolved by the reader — the SELF-POINTER, never a name match.
 * The card is the third reader of that rule and consults the boolean rather than the strings.
 */
export interface StandCardSeller {
  providerId: string;
  sellerId: string;
  sellerName: string;
  describesOwnStand: boolean;
  /**
   * This seller's own card-recency sentence, absent when they have confirmed nothing.
   *
   * Per SELLER. A stand-wide timestamp would date one farmer's goods by another's update.
   */
  cardRecency?: string;
  stale?: boolean;
  /**
   * Whether this seller is open right now — the intersection with the stand's schedule,
   * resolved server-side (F-114 C.5).
   *
   * Carried through the card's types because a later renderer will want to mark a seller who is
   * shut inside an open stand. `standCardSections` does not READ it today: which items a card
   * shows is a question about what was published, not about whether the till is staffed, and
   * hiding a closed seller's listing would remove information a customer planning tomorrow
   * needs. What it must never do is claim they are open, and the field is what lets the
   * renderer say so.
   */
  openState: OpenState;
  confirmedItems: StandCardItem[];
  usualItems: StandCardItem[];
}

/** One seller's contribution to a single item's row. */
export interface StandCardItemProvider {
  providerId: string;
  sellerId: string;
  /**
   * What to print beside this line, or ABSENT for the stand's own seller.
   *
   * Absent rather than the stand's own name, so there is no string a renderer could put in the
   * credit slot for a line that must render bare. §suppression follows a pointer.
   */
  credit?: string;
  priceText?: string;
  quantity?: number;
  unit?: string;
  approximation?: "some" | "limited" | "plentiful";
  /** Absent on every usual line, always — see `groupProviderItems`. */
  recency?: string;
  stale?: boolean;
}

/** One item, once, with the sellers who support it. */
export interface StandCardItemRow {
  itemName: string;
  providers: StandCardItemProvider[];
}

/** One register's worth of the card. */
export interface StandCardSection {
  register: ItemRegister;
  items: StandCardItemRow[];
}

/**
 * Decide a stand detail card's sections.
 *
 * **A STAND SHUTDOWN OVERRIDES EVERY SELLER AND RENDERS NOTHING ITEMIZED.** A closed stand is a
 * locked box: whatever any seller published, and however fresh it is, none of it is buyable
 * there. So an active closure returns no sections at all — confirmed and usual alike, because
 * a shutdown is a fact about the PLACE and a standing claim is as unbuyable as a dated one.
 * Enforced here rather than in the component so the map card, the seller detail page and every
 * later reader inherit it from one place. An UPCOMING closure changes nothing: it is
 * information about next week, and the stand is open now.
 *
 * Returns an empty list when there is nothing to itemize — no sellers, or sellers claiming
 * nothing. The card falls back to `standListingLines`' sentences there, which already own the
 * "no listing yet" and contact-only wording; inventing a second empty-state vocabulary here
 * would be two ways to say one thing.
 */
export function standCardSections(
  stand: PublicStandPayload,
): readonly StandCardSection[] {
  if (stand.closure?.state === "active") return [];

  const sellers = stand.sellers ?? [];
  if (sellers.length === 0) return [];

  const facts: ProviderItemFacts[] = sellers.map((seller) => ({
    providerId: seller.providerId,
    sellerId: seller.sellerId,
    sellerName: seller.sellerName,
    describesOwnStand: seller.describesOwnStand,
    ...(seller.cardRecency === undefined ? {} : { cardRecency: seller.cardRecency }),
    ...(seller.stale === undefined ? {} : { stale: seller.stale }),
    items: [
      ...seller.confirmedItems.map((item) => ({ ...item, register: "confirmed" as const })),
      ...seller.usualItems.map((item) => ({ ...item, register: "usual" as const })),
    ],
  }));

  const grouped = groupProviderItems(facts);
  const sections: StandCardSection[] = [];

  for (const group of grouped) {
    let section = sections.find((candidate) => candidate.register === group.register);
    if (section === undefined) {
      section = { register: group.register, items: [] };
      sections.push(section);
    }
    /*
      B-088 — A RECENCY ON AN ITEM LINE ONLY WHEN IT DISTINGUISHES.

      The per-seller axis is real — sellers publish independently — but printing each seller's
      phrase unconditionally repeated the section heading verbatim on every row. Measured against
      production: 33 of 37 public stands have exactly one seller, and three of the remaining four
      have two sellers who published on the SAME day. Only Plum Forest actually differs.

      So the test is agreement, not seller count: when every seller supporting this item states
      the same phrase, the heading has already said it and the line stays quiet. A rule keyed on
      `providers.length > 1` would still print duplicates for Pacific Crest, Tian Tian and
      Venison Valley.

      `undefined` counts as a value here, deliberately: one seller with a recency and one without
      DISAGREE, and the one who has it should say so.
    */
    const distinctRecencies = new Set(group.providers.map((provider) => provider.cardRecency));
    const recencyDistinguishes = distinctRecencies.size > 1;

    section.items.push({
      itemName: group.itemName,
      providers: group.providers.map((provider) => ({
        providerId: provider.providerId,
        sellerId: provider.sellerId,
        // The SHARED decision, asked in the form this surface needs: the card's heading already
        // prints the stand's name, so a nested line wants the seller alone — and nothing at all
        // for the stand's own seller. `sellerCredit` and `creditSeller` are one predicate in two
        // renderings, so this card and the SMS menu cannot disagree about who is named.
        ...(() => {
          const credit = sellerCredit(provider);
          return credit === undefined ? {} : { credit };
        })(),
        ...(provider.priceText === undefined ? {} : { priceText: provider.priceText }),
        ...(provider.quantity === undefined ? {} : { quantity: provider.quantity }),
        ...(provider.unit === undefined ? {} : { unit: provider.unit }),
        ...(provider.approximation === undefined
          ? {}
          : { approximation: provider.approximation }),
        ...(provider.cardRecency === undefined || !recencyDistinguishes
          ? {}
          : { recency: provider.cardRecency }),
        ...(provider.stale === undefined ? {} : { stale: provider.stale }),
      })),
    });
  }

  // `groupProviderItems` already orders confirmed groups before usual ones, so the sections
  // come out in that order without a second sort here.
  return sections;
}
