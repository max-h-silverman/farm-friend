import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");

describe("map marker category colors", () => {
  it("keeps flower glyphs red even when the listing has an unknown or stale open state", () => {
    expect(css).toMatch(/\.pin-flower-glyph\s*\{[^}]*stroke:\s*#b02d3b/);
    expect(css).toMatch(/\.pin-flower-petal\s*\{[^}]*fill:\s*#b02d3b/);
    expect(css).not.toMatch(
      /\.pin-(?:unknown|by_appointment|stale)\s+\.pin-flower-petal\s*\{/,
    );
  });

  it("never lets open-state styling replace the category fill of a farm marker", () => {
    expect(css).not.toMatch(
      /\.pin-(?:unknown|by_appointment|stale)\s+\.(?:pin-shape|pin-market-shape)\s*\{/,
    );
    expect(css).not.toMatch(/\.pin-(?:unknown|by_appointment|stale)\s+\.pin-number\s*\{/);
  });
});

describe("mobile map and sheet layout", () => {
  it("does not resize the map when the bottom sheet opens", () => {
    expect(css).not.toMatch(/\.sheet-open\s+\.island-svg\s*\{/);
  });
});

describe("desktop map layout", () => {
  it("does not add plus or minus signs to expandable stand names", () => {
    expect(css).not.toMatch(/\.stand-summary-toggle::after\s*\{/);
    expect(css).not.toMatch(/\.stand-summary-toggle\[aria-expanded="true"\]::after\s*\{/);
  });

  it("centers the complete map experience within a 1200px frame", () => {
    expect(css).toMatch(
      /@media \(min-width: 56rem\)[\s\S]*?\.page\s*\{[^}]*max-width:\s*75rem[^}]*margin:\s*0 auto/s,
    );
  });

  it("stacks the availability note beneath the enlarged VIGA logo", () => {
    expect(css).toMatch(/\.map-note\s*\{[^}]*font-size:\s*1\.5rem/s);
    const desktopDensity = css.slice(css.indexOf("desktop directory density"));
    expect(desktopDensity).toMatch(
      /\.map-intro\s*\{[^}]*display:\s*block/s,
    );
    expect(desktopDensity).toMatch(
      /\.farm-map-masthead\s*\{[^}]*width:\s*min\(42vw, 34rem\)/s,
    );
    expect(desktopDensity).toMatch(/\.map-note\s*\{[^}]*font-size:\s*1\.125rem/s);
  });

  it("gives the PDF-like directory more room than the geographic map", () => {
    const desktopDensity = css.slice(css.indexOf("desktop directory density"));
    expect(desktopDensity).toMatch(
      /\.layout\s*\{[^}]*grid-template-columns:\s*minmax\(0, 4fr\) minmax\(0, 3fr\)/s,
    );
  });

  it("uses one water color through the map frame and anchors the island left", () => {
    expect(css).not.toMatch(/\.island\s*\{\s*background:\s*var\(--panel\)/);
    expect(css).toMatch(/\.island-svg\s*\{[^}]*object-position:\s*left top/s);
  });

  it("keeps the on-map logo subordinate to the readable legend", () => {
    expect(css).toMatch(/\.island-viga-logo\s*\{[^}]*width:\s*clamp\(7\.6rem, 25\.6%, 12rem\)/s);
    const desktopDensity = css.slice(css.indexOf("desktop directory density"));
    expect(desktopDensity).toMatch(/\.marker-legend-item\s*\{[^}]*font-size:\s*0\.88rem/s);
  });

  it("keeps the PDF-like directory to two readable columns", () => {
    const desktopDensity = css.slice(css.indexOf("desktop directory density"));
    expect(desktopDensity).toMatch(/\.stands\s*\{[^}]*grid-template-columns:\s*repeat\(2,/s);
    expect(desktopDensity).not.toMatch(/\.stands\s*\{[^}]*(?:\n\s*columns:|repeat\([3-9],)/s);
    expect(desktopDensity).toMatch(/\.stand-head h2\s*\{[^}]*font-size:\s*1rem/s);
    expect(desktopDensity).toMatch(/\.stand-summary-address\s*\{[^}]*font-size:\s*0\.875rem/s);
  });

  it("uses one quiet directory surface instead of individual collapsed cards", () => {
    const desktopDensity = css.slice(css.indexOf("desktop directory density"));
    expect(desktopDensity).toMatch(
      /\.stand\s*\{[^}]*background:\s*transparent[^}]*border-color:\s*transparent[^}]*box-shadow:\s*none/s,
    );
  });
});

// COLOR IS MEANING ON THIS PAGE, across two palettes a customer reads on one screen: the map's
// pins say what KIND of place a stand is, the list's dots say facts ABOUT it. A color spent on
// two different meanings makes both unreadable — which is exactly what happened when
// "open until late November" was set to the same red the map already uses for "farm, no stand".
describe("indicator and pin colors do not collide", () => {
  /** Pull `.selector { color|background|fill: #hex }` out of the stylesheet. */
  const colorOf = (selector: string): string => {
    const pattern = new RegExp(
      `\\${selector}\\s*\\{[^}]*?(?:color|background|fill)\\s*:\\s*(#[0-9a-f]{6})`,
      "i",
    );
    const found = css.match(pattern);
    if (found === null) throw new Error(`no color found for ${selector}`);
    return found[1]!.toLowerCase();
  };

  it("gives every distinct meaning its own color", () => {
    // EVERY color-bearing selector on both surfaces, keyed by the fact it states. Two selectors
    // may share a color only when they state the SAME fact — those pairs are collapsed to one
    // entry here, so anything left sharing a color is a genuine collision.
    //
    // An earlier version of this test listed only a subset and stayed green while
    // "open until late November" wore the same red as "no farm stand to visit" — the exact
    // defect it was written to catch. Leaving any selector out makes the check meaningless.
    const meanings = {
      "no-viga-bucks": colorOf(".poster-indicator-no-viga-bucks"),
      "late-november": colorOf(".poster-indicator-late-november"),
      // Stated on both surfaces; the cross-surface test below pins them equal.
      "year-round": colorOf(".poster-indicator-year-round"),
      "no-stand-to-visit": colorOf(".poster-indicator-contact-only"),
      seasonal: colorOf(".marker-legend-seasonal"),
      "flowers-only": colorOf(".marker-legend-flower-only"),
      market: colorOf(".marker-legend-farmers-market"),
    };

    const byColor = new Map<string, string[]>();
    for (const [meaning, color] of Object.entries(meanings)) {
      byColor.set(color, [...(byColor.get(color) ?? []), meaning]);
    }
    const shared = [...byColor.entries()]
      .filter(([, names]) => names.length > 1)
      .map(([color, names]) => `${color} is used for ${names.join(" and ")}`);

    expect(shared).toEqual([]);
  });

  it("uses ONE color per fact across the list and the map", () => {
    // Year-round and no-stand-to-visit are each stated on both surfaces. Same fact, same color —
    // a customer matching a dot in the directory to a pin on the island depends on it.
    expect(colorOf(".poster-indicator-year-round")).toBe(colorOf(".marker-legend-year-round"));
    expect(colorOf(".poster-indicator-contact-only")).toBe(
      colorOf(".marker-legend-contact-only"),
    );
  });

  it("keeps the selection color out of the meaning palette", () => {
    // The selected ring marks WHICH stand you tapped — it is not a fact about the stand, so it
    // must not be mistakable for one.
    const selected = css.match(/--selected:\s*(#[0-9a-f]{6})/i)![1]!.toLowerCase();
    const meaningColors = [
      ".poster-indicator-no-viga-bucks",
      ".poster-indicator-year-round",
      ".poster-indicator-late-november",
      ".poster-indicator-contact-only",
      ".marker-legend-seasonal",
      ".marker-legend-year-round",
      ".marker-legend-flower-only",
      ".marker-legend-farmers-market",
    ].map(colorOf);

    expect(meaningColors).not.toContain(selected);
  });
});
