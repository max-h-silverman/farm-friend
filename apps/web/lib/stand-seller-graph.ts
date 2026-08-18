// F-118 — THE ONE BIPARTITE GRAPH BOTH PUBLIC LISTS READ.
//
// ## Why this module exists
//
// A stand has sellers; a seller has stands. The map's list shows the two as separate tabs, and
// before this the RELATIONSHIP between them was rendered three times in three shapes — a
// sentence on the seller card, a name list on the stand card, and a `Set` of ids built inline
// for the pin highlight. Three renderings of one fact is three places for it to drift, and the
// fact is not decorative: it is what a customer follows to get from "who bakes the sourdough"
// to "which pin do I drive to".
//
// So the relationship is stated ONCE, here, as a link. Both directions, one shape:
//
//   seller → `SellerStandLink[]`   where she sells, each a destination
//   stand  → `StandSellerLink[]`   who sells here, each a person to look up
//
// The component prints links and decides nothing about them.
//
// ## What is decided here rather than in the component
//
// - **Whether a stand is reachable.** A seller may sell at a stand the map is not currently
//   showing — a filter is on, or it has no coordinate. The link SURVIVES, marked `onMap: false`
//   with no number: dropping it would quietly shorten "sells at 2 stands" to one and make the
//   count on her card a lie.
// - **Own versus guest**, from the self-pointer the reader resolved. Never a name match.
// - **The pin number**, looked up from the numbered stand set. A component computing one would
//   be a second numbering, and two numberings send a customer to the wrong pin.
//
// It reads no data of its own and calls nothing. Both inputs are payloads the two lists already
// receive, so nothing here needs a server round trip.

import { isDefinitelyShut } from "./map-view";

/** A seller as a stand's payload carries them — the fields the graph needs, and no more. */
export interface GraphStandSeller {
  providerId: string;
  sellerId: string;
  sellerName: string;
  /** By SELF-POINTER, resolved server-side. Never a name match. */
  describesOwnStand: boolean;
}

/** A stand as the numbered map view carries it. */
export interface GraphStand {
  id: string;
  /**
   * The stand's pin number, when the caller has one.
   *
   * OPTIONAL, because the three readers below need different parts of a stand and only
   * `sellerStandLinks` needs this. A caller counting open stands or reading a season should not
   * have to number its input first, and a required field here forced exactly that — or worse, a
   * placeholder number invented at the call site, which is a second numbering waiting to
   * disagree with the pins.
   */
  standNumber?: number;
  locationName: string;
  /** Absent for a stand nobody has been invited to — a different fact from an empty list. */
  sellers?: readonly GraphStandSeller[];
  /**
   * Whether this stand is open right now, as the map already resolved it.
   *
   * Optional because the graph's other answers do not need it — a stand set built for the pin
   * numbers alone is a complete input for `sellerStandLinks`. A stand that did not state it is
   * counted as not-open, never as open; see `sellerStandsOpen`.
   */
  openState?: string;
  /**
   * What this stand stated about its season, in the shape the public payload nests it —
   * `availability.season`, absent when the stand stated nothing.
   *
   * Read from `availability` rather than hoisted to a `season` field of its own so a caller can
   * pass a stand payload straight in. A second spelling of the same fact here would be one more
   * place for the card's badge and the stand's own dot to drift apart.
   */
  availability?: { season?: GraphSeason };
}

/**
 * A stand's stated season, as narrowly as the badge needs to read it.
 *
 * NOT a restatement of the payload's own season union — `map-view.ts` owns that, and a second
 * copy here would be a type that could drift out of agreement with the data it describes.
 * This is the SHAPE this module reads: a `kind`, and the end date a `date_range` carries. Any
 * season the payload adds arrives here as a `kind` neither badge matches, which returns no
 * badge — the correct answer for a season these two words do not describe.
 */
export interface GraphSeason {
  kind: string;
  endMonth?: number;
  endDay?: number;
}

/** One stand a seller sells at, as the seller list carries it. */
export interface GraphSellerStand {
  salesLocationId: string;
  locationName: string;
  describesOwnStand: boolean;
  usualItems: readonly { itemName: string }[];
}

/** A seller as the seller list carries them. */
export interface GraphSeller {
  sellerId: string;
  sellerName: string;
  ownsAStand: boolean;
  sellingAt: readonly GraphSellerStand[];
}

/**
 * How a seller stands to a stand.
 *
 * Two words rather than a boolean, because the card prints them and "own"/"guest" is what the
 * customer reads. `describesOwnStand` is the fact; this is its name.
 */
export type SellerRelation = "own" | "guest";

/** Where a seller sells, as one destination the customer can act on. */
export interface SellerStandLink {
  standId: string;
  locationName: string;
  relation: SellerRelation;
  /** What she brings TO THIS STAND. Never pooled across her stands. */
  usualItems: string[];
  /**
   * The pin number, ABSENT when the stand is not among the ones shown.
   *
   * Absent rather than zero or a placeholder: there is no pin to send anyone to, and a number
   * printed beside a stand with no pin is an instruction that cannot be followed.
   */
  standNumber?: number;
  /** Whether this stand has a pin the customer can be sent to right now. */
  onMap: boolean;
}

/** Who sells at a stand, as one person the customer can look up. */
export interface StandSellerLink {
  sellerId: string;
  sellerName: string;
  relation: SellerRelation;
}

function relationOf(describesOwnStand: boolean): SellerRelation {
  return describesOwnStand ? "own" : "guest";
}

/**
 * Where this seller sells, each stand a destination.
 *
 * **Her own stand leads.** It is the strongest answer to "where do I find her" — a stand she
 * runs is open on her own schedule and carries her whole range — so it is first regardless of
 * the order the reader returned. Within each group the reader's order is preserved, which is
 * the stand's own name.
 */
export function sellerStandLinks(
  seller: GraphSeller,
  stands: readonly GraphStand[],
): SellerStandLink[] {
  const byId = new Map(stands.map((stand) => [stand.id, stand]));

  const links = seller.sellingAt.map((stand): SellerStandLink => {
    const onMap = byId.get(stand.salesLocationId);
    return {
      standId: stand.salesLocationId,
      locationName: stand.locationName,
      relation: relationOf(stand.describesOwnStand),
      usualItems: stand.usualItems.map((item) => item.itemName),
      ...(onMap?.standNumber === undefined ? {} : { standNumber: onMap.standNumber }),
      onMap: onMap !== undefined,
    };
  });

  // A STABLE partition rather than a sort on a boolean: `Array.prototype.sort` is stable in
  // every engine we target, but partitioning states the intent — two groups, each in the order
  // it arrived — where a comparator would leave a reader working out what happens on a tie.
  return [
    ...links.filter((link) => link.relation === "own"),
    ...links.filter((link) => link.relation === "guest"),
  ];
}

/**
 * The stands to light on the map for a chosen seller.
 *
 * A `Set` because the pin layer asks it once per pin per render. `undefined` yields an empty
 * set, which is what makes "no highlight" the resting state rather than a branch every caller
 * has to remember to write.
 */
export function standsForSeller(seller: GraphSeller | undefined): Set<string> {
  if (seller === undefined) return new Set();
  return new Set(seller.sellingAt.map((stand) => stand.salesLocationId));
}

/**
 * Who sells at this stand, each a person the customer can look up in the seller list.
 *
 * **Deduplicated by seller, not by provider.** A stand's `sellers` is a list of PROVIDER rows
 * and one seller can hold more than one at a stand; this answers "who sells here", a question
 * about people, so a name must never appear twice. The first row for a seller wins, which
 * preserves the reader's own ordering.
 *
 * **The stand's own seller leads**, matching the card's own hierarchy: the stand is theirs, and
 * everyone else is there by their invitation.
 */
export function standSellerLinks(stand: GraphStand): StandSellerLink[] {
  const seen = new Set<string>();
  const links: StandSellerLink[] = [];

  for (const seller of stand.sellers ?? []) {
    if (seen.has(seller.sellerId)) continue;
    seen.add(seller.sellerId);
    links.push({
      sellerId: seller.sellerId,
      sellerName: seller.sellerName,
      relation: relationOf(seller.describesOwnStand),
    });
  }

  return [
    ...links.filter((link) => link.relation === "own"),
    ...links.filter((link) => link.relation === "guest"),
  ];
}

/** A rectangle in island viewBox units. */
export interface TipSize {
  width: number;
  height: number;
}

/** Where the marker tooltip's box goes, and which side of the pin it ended up on. */
export interface TipBox {
  x: number;
  y: number;
  /** True when there was no room above the pin and the box flipped underneath it. */
  below: boolean;
}

/**
 * Place the marker tooltip so it stays ON the island.
 *
 * **The figure CLIPS.** `.island` is `overflow: hidden` and the artwork fills a fixed viewBox,
 * so a box centred on its pin loses whatever hangs past an edge. Vashon is long and narrow and
 * most stands sit near a shore, so "centred on the pin" is broken for the majority of pins
 * rather than for an unlucky few — measured in a browser, a west-shore tooltip lost its entire
 * left half, seller names included.
 *
 * Two different corrections, because the axes fail differently:
 *
 * - **Horizontally, CLAMP.** Sliding the box sideways keeps it beside its pin and costs nothing;
 *   nothing about the tooltip's meaning depends on being exactly centred.
 * - **Vertically, FLIP.** The box sits above the pin so it does not cover the marker it is
 *   explaining. Near the north shore there is no room above, and clamping alone would lay the
 *   box on top of the pin — so it goes underneath instead, which keeps both facts true.
 *
 * The clamp is written `max(0, min(…))` rather than the other order so a box WIDER than the
 * island is pinned to the left edge instead of landing at a negative coordinate: it still
 * overflows, but it overflows the end nobody reads first.
 */
export function markerTipBox(
  pin: { x: number; y: number },
  size: TipSize,
  viewBox: { width: number; height: number },
): TipBox {
  const x = Math.max(0, Math.min(pin.x - size.width / 2, viewBox.width - size.width));

  // The pin's own glyph reaches about this far above its anchor point, so the box clears the
  // marker rather than resting on its head.
  const above = pin.y - MARKER_TIP_GAP - size.height;
  if (above >= 0) return { x, y: above, below: false };

  return {
    x,
    y: Math.min(pin.y + MARKER_TIP_GAP, viewBox.height - size.height),
    below: true,
  };
}

/**
 * How far the tooltip stands off its pin, in island units.
 *
 * Big enough to clear the pin glyph, which is drawn upward from its anchor — a smaller gap put
 * the box's lower edge through the top of the marker it was explaining.
 */
const MARKER_TIP_GAP = 76;

/**
 * How many island units a tooltip must span to render at a given size in REAL pixels (B-088).
 *
 * ## The bug this exists to end
 *
 * The tooltip is a `foreignObject` inside the island SVG, so every length inside it — including
 * its font sizes — is in viewBox units, scaled by however the drawing is fitted to the screen.
 * The island is 1000 units wide, so a 22-unit heading is 22 real pixels only when the map happens
 * to render 1000px wide. Measured against the real page:
 *
 *     map 1200px wide -> "Runs this stand" renders at 20px
 *     map  700px wide ->                              12px
 *     map  390px wide ->                             6.6px
 *
 * The text got SMALLER exactly as the screen did, which is backwards — and raising the CSS
 * numbers cannot fix it, because that inflates the desktop case by the same factor it rescues
 * the phone.
 *
 * ## The fix
 *
 * Scale the tooltip's own geometry by the inverse of the map's rendered scale, so its contents
 * land at a fixed real size at every viewport. `scale` is the measured ratio of rendered pixels
 * to viewBox units; a scale of 0.39 (a 390px phone) makes the box 1/0.39 as many units wide, and
 * the text inside it comes out the size the CSS asks for.
 *
 * Clamped at 1: on a map rendered WIDER than its viewBox the tooltip would otherwise shrink below
 * its designed size, and the design is already the floor.
 */
export function markerTipUnitScale(scale: number): number {
  if (!Number.isFinite(scale) || scale <= 0) return 1;
  return Math.max(1, 1 / scale);
}


/**
 * What a seller's card may say about buying from her right now.
 *
 * THREE answers, because the underlying fact has three states — and B-083 is what the missing
 * third one cost. `unknown` is not a hedge; it is the only honest answer for a stand that stated
 * no hours, and printing "Closed" there asserted a closure no farmer had made on 9 of 34 live
 * seller cards.
 */
export type SellerOpenState = "open" | "closed" | "unknown";

/**
 * Can a customer buy from this seller right now?
 *
 * **`open` if ANY stand she sells at is open**, because she is buyable wherever any one of them
 * is. The card states that rather than a fraction: "1 of 1 stand open" makes the reader do
 * arithmetic to reach a yes.
 *
 * **`closed` only when every stand she sells at is one a farmer positively shut** — out of
 * season, or outside the hours they stated (max, 2026-08-18). Closed is a claim about the
 * farmer's intent, so it is said only where the farmer said it.
 *
 * **`unknown` otherwise**, and that is the case the boolean this replaced could not express: a
 * stand that stated no hours, a by-appointment arrangement, or a stand the map is not currently
 * showing. None of those is evidence of a closure, and the card marks them unconfirmed rather
 * than shut — the same way the stand list already marks a stand with nothing stated.
 *
 * The precedence is `open` > `unknown` > `closed`, which matters for a seller at several stands:
 * one shut stand and one silent one is NOT a closure, because the silent one never told us.
 */
export function sellerOpenState(
  seller: GraphSeller,
  stands: readonly GraphStand[],
): SellerOpenState {
  const byId = new Map(stands.map((stand) => [stand.id, stand]));
  /*
    A stand absent from `stands` contributes `undefined`, which is neither open nor closed —
    it lands in `unknown` below rather than counting as evidence of a shut door.
  */
  const states = seller.sellingAt.map(
    (stand) => byId.get(stand.salesLocationId)?.openState,
  );

  if (states.some((state) => state === "open")) return "open";
  /*
    Closed requires EVERY stand to be positively shut, and at least one stand to exist. An empty
    list falls through to `unknown`: a seller with nowhere to sell has not been closed, she has
    simply told us nothing.
  */
  if (
    states.length > 0 &&
    states.every((state) => isDefinitelyShut(state))
  ) {
    return "closed";
  }
  return "unknown";
}

/** The two season badges the poster's key already defines. */
export type SellerSeasonBadge = "year-round" | "late-november";

/**
 * The season badge for a seller, from the stands she sells at.
 *
 * A seller has no season of her own — she has PLACES, and each place has one. So the badge is
 * derived, and **the longest season wins**: the badge answers "how long can I buy from her",
 * and she is buyable wherever any of her stands is open. Taking the first stand's season would
 * make the same seller read differently depending on how her stands happened to be ordered.
 *
 * **Absent rather than guessed.** A stand with a summer range has stated something true that
 * neither badge describes; inventing a third badge here would put a season on the card that no
 * farmer chose. The two values are exactly the poster's own key, which is where they came from.
 */
export function sellerSeasonBadge(
  seller: GraphSeller,
  stands: readonly GraphStand[],
): SellerSeasonBadge | undefined {
  const byId = new Map(stands.map((stand) => [stand.id, stand]));
  const seasons = seller.sellingAt
    .map((stand) => byId.get(stand.salesLocationId)?.availability?.season)
    .filter((season): season is GraphSeason => season !== undefined);

  if (seasons.some((season) => season.kind === "year_round")) return "year-round";
  // The SAME test `posterIndicators` applies to a stand — a range ending in the last third of
  // November. Stated once here so a seller's badge and her stand's dot can never disagree.
  if (
    seasons.some(
      (season) =>
        season.kind === "date_range" &&
        season.endMonth === 11 &&
        // `>= 20` on an absent day would be `undefined >= 20`, which is false — correct, but by
        // accident. Stated explicitly so a season that names a month and no day cannot ever
        // reach the comparison at all.
        season.endDay !== undefined &&
        season.endDay >= 20,
    )
  ) {
    return "late-november";
  }
  return undefined;
}
