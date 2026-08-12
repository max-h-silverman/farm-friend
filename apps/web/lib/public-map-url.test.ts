import { PUBLIC_MAP_URL } from "@farm-friend/core";
import { describe, expect, it } from "vitest";
import { resolvePublicMapUrl } from "./composition";

/*
  The public map's address is stated TWICE — as deployed configuration (`PUBLIC_MAP_URL` in the
  environment, which the `MAP` keyword replies with) and as a constant in core that customer copy
  embeds directly ("The map at … is always up to date", the paged answer's `Map:` line).

  Nothing compared them until F-110. Changing the deployed value alone updated some messages and
  not others, and no test failed — the link still resolved, so the only symptom was two different
  links reaching the same customer. These tests make that disagreement loud at startup.
*/
describe("the public map URL is one destination, stated in two places", () => {
  it("accepts a configured value that matches the URL in customer copy", () => {
    expect(resolvePublicMapUrl({ PUBLIC_MAP_URL } as never)).toBe(PUBLIC_MAP_URL);
  });

  it("refuses a deployed value that disagrees with customer copy", () => {
    // The exact regression this guards: the config keeps the bare page URL while core's copy
    // carries the `#map` anchor, so `MAP` and the paged answer send different links.
    expect(() =>
      resolvePublicMapUrl({
        PUBLIC_MAP_URL: "https://www.vigavashon.org/farm-stand-map",
      } as never),
    ).toThrow(/must match the map URL stated in customer copy/);
  });

  it("refuses a different host entirely", () => {
    expect(() =>
      resolvePublicMapUrl({ PUBLIC_MAP_URL: "https://example.com/map#map" } as never),
    ).toThrow(/must match the map URL stated in customer copy/);
  });

  it("still allows a localhost override, which is how the map is developed", () => {
    // Local dev serves its own map and cannot be held to VIGA's production address.
    const local = "http://localhost:3000/map";
    expect(resolvePublicMapUrl({ PUBLIC_MAP_URL: local } as never)).toBe(local);
  });

  it("lands the reader on the map rather than the top of VIGA's page", () => {
    expect(new URL(PUBLIC_MAP_URL).hash).toBe("#map");
  });
});
