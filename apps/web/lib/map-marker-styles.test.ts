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
