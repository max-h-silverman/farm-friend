// The SUBPATH, not the barrel — this module is reached from `stand-map.tsx`, a client component.
// See the note at the top of `stand-card.ts`: core's barrel re-exports `privacy/phone`, which
// imports `node:crypto`, and no unit test can see the resulting break because vitest runs in Node.
import type { ItemRegister } from "@farm-friend/core/seller-credit";
import type { OpenState } from "@farm-friend/core/open-now";
import type { PublicStandPayload } from "./map-view";

// F-119 — THE STAND DETAIL CARD, SELLER-MAJOR.
//
// ## What changes, and what does not
//
// `standCardSections` renders a register ITEM-first: each item once, with its supporting sellers
// nested beneath (F-114 C.5, which exists to kill three duplicate `Tomatoes` rows). This renders
// the same register SELLER-first: each seller a sub-heading carrying its own recency, with that
// seller's items as cards beneath.
//
// **This is presentation over data the card already receives.** No new query, no new payload
// field — `PublicStandPayload.sellers` already carries per-seller items and per-seller recency,
// which is exactly the axis this reorients around.
//
// ## The tradeoff, stated rather than hidden
//
// Seller-major cannot keep F-114's "each item appears once": two sellers carrying tomatoes means
// tomatoes appears under each. That is the point of the mockup rather than a regression of it —
// each copy sits under a different seller, with that seller's own price and freshness, which is
// the comparison the customer is being asked to make. `standCardSections` still exists and still
// owns the item-first axis; neither is a replacement for the other.
//
// ## Where each rule already lives
//
// Recency wording is core's. The shutdown rule and the "nothing to itemize" rule are inherited
// from `standCardSections`' contract rather than re-decided. What is decided HERE, once, is which
// seller groups a register has and whether each shows a sub-heading.

/** One item as one seller states it, ready to render as a card. */
export interface StandCardSellerItem {
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
 * The card consults the boolean rather than comparing strings.
 */
export interface StandCardSeller {
  providerId: string;
  sellerId: string;
  sellerName: string;
  describesOwnStand: boolean;
  /** This seller's own card-recency sentence, absent when they have confirmed nothing. */
  cardRecency?: string;
  stale?: boolean;
  /**
   * Whether this seller is open right now — the intersection with the stand's schedule,
   * resolved server-side.
   *
   * Not READ here: which items a card shows is a question about what was published, not about
   * whether the till is staffed, and hiding a closed seller's listing would remove information
   * a customer planning tomorrow needs. Carried so a renderer can mark a seller who is shut
   * inside an open stand without ever claiming they are open.
   */
  openState: OpenState;
  confirmedItems: StandCardSellerItem[];
  usualItems: StandCardSellerItem[];
}

/** One seller's block within a register. */
export interface StandCardSellerGroup {
  providerId: string;
  sellerId: string;
  sellerName: string;
  /**
   * Whether to print the seller sub-heading at all.
   *
   * B-088's rule, carried forward: a stand with one seller in this register must not grow a
   * sub-heading that repeats what the section heading already said. Decided per SECTION, because
   * that is where the redundancy actually is — a stand whose own farm is alone under `In stock`
   * but shares `Usually carries` with a guest wants the heading in the second and not the first.
   *
   * Measured: 33 of 37 public stands have exactly one seller, so the suppressed case is the
   * common one.
   */
  showHeading: boolean;
  /**
   * This seller's own recency sentence — ABSENT on a usual section, always.
   *
   * Per seller, because each publishes independently: a stand-wide timestamp would date one
   * farmer's goods by another's update. A standing claim is dated by nothing, and a hosted
   * seller is often public on standing claims alone, so a date there would read as a
   * confirmation nobody made.
   */
  recency?: string;
  stale?: boolean;
  items: StandCardSellerItem[];
}

/** One register's worth of the card, grouped by seller. */
export interface StandCardSellerSection {
  register: ItemRegister;
  sellers: StandCardSellerGroup[];
}

const REGISTERS: readonly ItemRegister[] = ["confirmed", "usual"];

function itemsFor(seller: StandCardSeller, register: ItemRegister): StandCardSellerItem[] {
  return register === "confirmed" ? seller.confirmedItems : seller.usualItems;
}

/**
 * Decide a stand detail card's sections, grouped seller-major.
 *
 * Returns an empty list when there is nothing to itemize — a shutdown, no sellers, or sellers
 * claiming nothing — matching `standCardSections` exactly, so the caller's fallback to
 * `standListingLines`' sentences is reached in precisely the same cases. Inventing a second
 * empty-state vocabulary here would be two ways to say one thing.
 */
export function standCardSellerGroups(
  stand: PublicStandPayload,
): readonly StandCardSellerSection[] {
  // A closed stand is a locked box: whatever any seller published, none of it is buyable there.
  if (stand.closure?.state === "active") return [];

  const sellers = stand.sellers ?? [];
  const sections: StandCardSellerSection[] = [];

  for (const register of REGISTERS) {
    const groups: StandCardSellerGroup[] = [];

    for (const seller of sellers) {
      const items = itemsFor(seller, register);
      // A seller who claims nothing in this register is absent from it rather than present and
      // empty — an empty sub-heading states a seller has nothing, which is not what silence means.
      if (items.length === 0) continue;

      groups.push({
        providerId: seller.providerId,
        sellerId: seller.sellerId,
        sellerName: seller.sellerName,
        // Filled in below, once this register's seller count is known.
        showHeading: false,
        // The no-timestamp rule enforced by SHAPE: a usual group has no recency field at all, so
        // nothing downstream has one to print even if a renderer asked for it.
        ...(register === "usual" || seller.cardRecency === undefined
          ? {}
          : { recency: seller.cardRecency }),
        ...(register === "usual" || seller.stale === undefined ? {} : { stale: seller.stale }),
        items,
      });
    }

    if (groups.length === 0) continue;

    const showHeading = groups.length > 1;
    for (const group of groups) group.showHeading = showHeading;

    sections.push({ register, sellers: groups });
  }

  return sections;
}
