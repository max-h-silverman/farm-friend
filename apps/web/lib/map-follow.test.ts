import { describe, expect, it } from "vitest";
import { mapFollowOffset } from "./map-follow";

// The map follows the selected stand down the directory, and STOPS at the bottom of the area
// the page gave it. Every case below is one of the boundaries that rule creates — the clamps
// are the behavior, not a defensive afterthought, so they are asserted by value.

describe("mapFollowOffset", () => {
  it("aligns the top of the map with the top of the selected card", () => {
    // Card at 400: the map's top goes to 400 too, so the customer reads the stand's name and
    // the island at the same height.
    expect(
      mapFollowOffset({
        cardOffset: 400,
        mapHeight: 300,
        columnHeight: 2000,
      }),
    ).toBe(400);
  });

  it("does not push the map down when the selected card is tall", () => {
    // THE REGRESSION, stated as the property that prevents it. An expanded card runs several
    // hundred pixels tall; centering the map on it drove the map half a card-height below the
    // card's top, putting the map's own top off screen. The offset now depends ONLY on where
    // the card starts — the card's height is not an input, so growing it cannot move the map.
    //
    // Asserted as an exact value rather than a comparison: two calls with identical arguments
    // agree no matter what the function does, and would still pass under centering.
    expect(
      mapFollowOffset({ cardOffset: 600, mapHeight: 700, columnHeight: 4000 }),
    ).toBe(600);

    // A map twice as tall still aligns to the same card top; only the clamp may reduce it.
    expect(
      mapFollowOffset({ cardOffset: 600, mapHeight: 1400, columnHeight: 4000 }),
    ).toBe(600);
  });

  it("stays at the top for the first card in the list", () => {
    // The first card is already at the column's top, so there is nowhere above to go.
    expect(
      mapFollowOffset({
        cardOffset: 0,
        mapHeight: 400,
        columnHeight: 2000,
      }),
    ).toBe(0);
  });

  it("stops at the bottom of the column for a selection near the end", () => {
    // Aligning with the last card would carry the map past the column's end, so it stops where
    // the column does: 2000 - 400 = 1600. This is the "as far down as the area allows" case.
    expect(
      mapFollowOffset({
        cardOffset: 1900,
        mapHeight: 400,
        columnHeight: 2000,
      }),
    ).toBe(1600);
  });

  it("does not move at all when the map is taller than its column", () => {
    // A short filtered list beside a tall map: there is no room to travel, and the map must
    // not be dragged upward out of the page. Without the `max(0, …)` this returns -400.
    expect(
      mapFollowOffset({
        cardOffset: 100,
        mapHeight: 800,
        columnHeight: 400,
      }),
    ).toBe(0);
  });

  it("returns a whole number of pixels", () => {
    // A fractional transform blurs the map's text on some displays, and a laid-out card's
    // measured top is routinely fractional.
    expect(
      mapFollowOffset({
        cardOffset: 150.6,
        mapHeight: 301,
        columnHeight: 2000,
      }),
    ).toBe(151);
  });

  // THE VIEWPORT CLAMP. The column clamp above only knows how tall the DIRECTORY is, and on a
  // 30-stand list that is thousands of pixels — so a card near the bottom of the screen produced
  // an offset that was legal by the column and still pushed the map below the fold. These cases
  // are stated in viewport coordinates: `columnTop` is the list column's position relative to
  // the visible area (negative once the page has scrolled past it).
  describe("keeping the map on screen", () => {
    it("rests the map against the bottom edge when aligning would overflow", () => {
      // Column starts 200px above the fold. Card 900px down it, so the card's top is at 700 on
      // screen. A 600-tall map aligned there would end at 1300, past an 800-tall viewport — so
      // the map is pulled up until its bottom sits on the edge: offset 900 - (1300 - 800) = 400.
      expect(
        mapFollowOffset({
          cardOffset: 900,
          mapHeight: 600,
          columnHeight: 4000,
          columnTop: -200,
          viewportHeight: 800,
        }),
      ).toBe(400);
    });

    it("aligns with the card when the map already fits on screen", () => {
      // Same geometry, but the card is high enough that the whole map fits below it. The
      // viewport clamp must not fire and drag the map away from the card it is following.
      expect(
        mapFollowOffset({
          cardOffset: 300,
          mapHeight: 400,
          columnHeight: 4000,
          columnTop: -50,
          viewportHeight: 900,
        }),
      ).toBe(300);
    });

    it("never pushes the map above the top of the visible area", () => {
      // A map TALLER than the screen cannot rest against both edges. Resting it on the bottom
      // would put its top off screen above, which is the failure this whole change is about —
      // so the top wins and the overflow hangs off the bottom instead.
      expect(
        mapFollowOffset({
          cardOffset: 1200,
          mapHeight: 1000,
          columnHeight: 4000,
          columnTop: -400,
          viewportHeight: 700,
        }),
      ).toBe(400);
    });

    it("brings the map down to the visible area for a card hoisted to the column top", () => {
      // THE MARKER-TAP CASE. A pin tap hoists its card to the top of the DIRECTORY, which — when
      // the customer has scrolled far down a 30-stand list — is far above the visible area. The
      // map cannot simply go to offset 0 to meet it: that is the column's top, also off screen,
      // leaving neither the card nor the map in view. Instead the map comes down to the top of
      // what is actually visible: the column starts 1500px above the fold, so offset 1500.
      expect(
        mapFollowOffset({
          cardOffset: 0,
          mapHeight: 600,
          columnHeight: 4000,
          columnTop: -1500,
          viewportHeight: 900,
        }),
      ).toBe(1500);
    });

    it("ignores the viewport when it is not measurable", () => {
      // Inside VIGA's iframe the frame is sized to its own content, so there is no smaller
      // viewport to clamp against and the height reads as the whole document. Falling back to
      // the column-only answer keeps the embed behaving as it did rather than jumping.
      expect(
        mapFollowOffset({
          cardOffset: 900,
          mapHeight: 600,
          columnHeight: 4000,
          columnTop: -200,
          viewportHeight: 99999,
        }),
      ).toBe(900);
    });
  });

  it("stays put rather than guessing when the page has not been measured yet", () => {
    // Before layout, jsdom and a first paint can both report zeroes; a NaN from an unmeasured
    // element must not become a transform.
    expect(
      mapFollowOffset({
        cardOffset: Number.NaN,
        mapHeight: 0,
        columnHeight: 0,
      }),
    ).toBe(0);
  });
});
