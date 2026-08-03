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
