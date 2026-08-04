// Where the map panel sits when a stand is selected.
//
// THE BEHAVIOR. On wide screens the directory is a long column beside a much shorter map.
// Selecting a stand — from either surface — slides the map down so it sits beside the stand
// being read, instead of staying at the top while the customer's attention is 900px below it.
//
// WHY THIS IS ARITHMETIC AND NOT CSS. `position: sticky` pins an element to the VIEWPORT, which
// is the wrong reference twice over: the public map is embedded in an iframe sized to its own
// content (see `embed-height.tsx`), so the frame's viewport is the whole document and sticky
// never engages; and sticky can only hold a fixed offset, where this has to track a specific
// card. So the offset is computed and applied as a transform.
//
// This module is the whole decision. It takes measurements and returns a number — no DOM, no
// React — so the clamping can be tested at its boundaries rather than inferred from a browser.

/** Measurements the caller reads from the laid-out page, in pixels. */
export interface MapFollowGeometry {
  /** Distance from the top of the list column to the top of the selected card. */
  readonly cardOffset: number;
  /** Height of the map panel being moved. */
  readonly mapHeight: number;
  /** Height of the column the map may travel within. */
  readonly columnHeight: number;
  /**
   * The list column's top relative to the VISIBLE AREA — negative once the page has scrolled
   * past it. Optional: without it the offset is clamped to the column alone, which is the
   * right answer when there is no smaller viewport to fit within.
   */
  readonly columnTop?: number;
  /** Height of the visible area. Optional, and paired with `columnTop`. */
  readonly viewportHeight?: number;
}

/**
 * How far down the map panel should be translated, in pixels.
 *
 * Never negative and never past the bottom of the column: the map may follow the list, but it
 * may not leave the area the page reserved for it. A selection near the end of a long list
 * therefore stops the map at the column's bottom edge rather than tracking exactly — the
 * "or as far down as the render area allows" case.
 */
export function mapFollowOffset(geometry: MapFollowGeometry): number {
  const { cardOffset, mapHeight, columnHeight } = geometry;

  // TOP-ALIGNED, not centered. Centering read well in the abstract and was wrong on the page:
  // an expanded card runs several hundred pixels tall, so centering drove the map down by half
  // of that and pushed its own top off screen while the card sat far above the map's middle.
  // The card's top is what the customer's eye is on, so that is what the map's top matches.
  //
  // Card height is deliberately unused. It changes the moment a card expands, and the map must
  // not move in response to the selection growing.
  const aligned = cardOffset;

  // The map cannot travel past the end of its column. When the map is taller than the column
  // there is no room to move at all, and the clamp collapses to zero rather than going negative.
  const furthest = Math.max(0, columnHeight - mapHeight);

  if (!Number.isFinite(aligned) || !Number.isFinite(furthest)) return 0;

  const withinColumn = Math.min(Math.max(aligned, 0), furthest);

  // THE VIEWPORT CLAMP. The column clamp above is not enough on its own: a 30-stand directory
  // is thousands of pixels tall, so a card near the bottom of the screen yields an offset that
  // is legal by the column and still leaves the map below the fold. Fitting the map to the
  // VISIBLE AREA is what actually keeps it on screen.
  const { columnTop, viewportHeight } = geometry;
  if (
    columnTop === undefined ||
    viewportHeight === undefined ||
    !Number.isFinite(columnTop) ||
    !Number.isFinite(viewportHeight) ||
    viewportHeight <= 0
  ) {
    return Math.round(withinColumn);
  }

  // The offset that puts the map's top at the top of the VISIBLE AREA. Zero while the column
  // starts on screen; once the page has scrolled past it, this is how far down the map must
  // travel just to be seen at all.
  const highest = Math.max(0, -columnTop);

  // How far the map's bottom would fall past the bottom of the visible area, if any.
  const overflow = columnTop + withinColumn + mapHeight - viewportHeight;
  const pulledUp = overflow > 0 ? withinColumn - overflow : withinColumn;

  // Never above the top of the visible area — a map taller than the screen cannot rest against
  // both edges, and its TOP being cut off is the failure this exists to prevent. `max` with
  // `highest` also carries the map DOWN to the fold when the card it is following sits above
  // it: that is the marker-tap case, where the card is hoisted to the column's top while the
  // customer is reading far below, and a map left at offset 0 would be off screen with it.
  const onScreen = Math.max(pulledUp, highest);

  // Still bounded by the column: the map may not leave the area the page reserved for it.
  return Math.round(Math.min(Math.max(onScreen, 0), furthest));
}
