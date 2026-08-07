import { describe, expect, it, vi } from "vitest";
import { lookupIslandAddress, type AddressLookupDeps } from "./address-lookup";

// F-069 / F-077 — turning a typed address into the coordinate a stand publishes at.
//
// ## The boundary this narrows, and why it is still narrow
//
// "No runtime geocoder" was a decided boundary (PRODUCT_BRIEF §launch decisions,
// DEVELOPMENT §non-goals) with a tripwire in `packages/core/src/architecture.test.ts`. max
// reopened it on 2026-08-05, for FARM STAND ONBOARDING ONLY, after being shown the risk.
//
// The reason it was closed is still true and still governs this module: a `StubMapProvider` once
// invented deterministic pseudo-coordinates near Vashon for ANY address string, and a stand
// placed at a fabricated point is worse than a stand with no point — it sends a customer
// somewhere real and wrong. Rural Vashon is where geocoders are weakest (long driveways,
// unnumbered roads, a stand at the road rather than at the mailing address), and a geocoder
// always returns SOMETHING that looks right.
//
// **F-069 answered that with a draft the farmer confirmed by tapping the island map. F-077
// (max, 2026-08-06) removed the tap.** The lookup is now the only source of a coordinate, and an
// address that will not resolve is REFUSED — the farmer corrects the address rather than
// placing a point by hand. The trade was made deliberately: no nudging a stand to the road, in
// exchange for a published point that always corresponds to the published address.
//
// **What did NOT change is everything this module guarantees**, and it carries more weight now
// that nothing sits downstream of it:
//
//   1. A result outside `ISLAND_BOUNDS` is REFUSED, never shown. Farm Friend is one island; a
//      coordinate off it is a wrong answer regardless of the provider's confidence.
//   2. This module NEVER invents a coordinate. No result, an unusable result, a provider error,
//      or a missing key all produce the SAME "nothing found" answer. There is no code path that
//      constructs a coordinate from anything but a provider number that passed the bounds check.
//
// What the FORM does with a failure is `listing-step.tsx`'s decision, asserted in its own
// suite: it used to offer a tap, and since F-077 it refuses to publish.

const KEY = "test-geocoding-key";

/** A Google Geocoding response body, trimmed to the fields this module reads. */
function googleResponse(
  results: { lat: number; lng: number }[],
  status = "OK",
): unknown {
  return {
    status,
    results: results.map((result) => ({
      geometry: { location: { lat: result.lat, lng: result.lng } },
    })),
  };
}

function deps(response: unknown, ok = true): AddressLookupDeps {
  return {
    apiKey: KEY,
    fetch: vi.fn(async () => ({
      ok,
      status: ok ? 200 : 500,
      json: async () => response,
    })) as unknown as typeof fetch,
  };
}

describe("lookupIslandAddress", () => {
  it("returns a draft coordinate for an address that resolves ON the island", async () => {
    // Vashon town centre.
    const result = await lookupIslandAddress(
      deps(googleResponse([{ lat: 47.4471, lng: -122.4594 }])),
      "12345 Vashon Highway SW",
    );

    expect(result).toEqual({
      status: "found",
      latitude: 47.4471,
      longitude: -122.4594,
    });
  });

  it("REFUSES a result off the island rather than offering a pin in the wrong place", async () => {
    // Downtown Seattle. A geocoder handed a partial or misspelled Vashon address will happily
    // resolve it to the mainland, and that is exactly the "somewhere real and wrong" case.
    const result = await lookupIslandAddress(
      deps(googleResponse([{ lat: 47.6062, lng: -122.3321 }])),
      "1234 Pike Street",
    );

    expect(result).toEqual({ status: "off_island" });
  });

  it("refuses a result just outside the bounds, not merely one far away", async () => {
    // Anchored to the boundary itself: a check that only caught Seattle would pass a pin in
    // Puget Sound a few hundred metres off the shore.
    const result = await lookupIslandAddress(
      deps(googleResponse([{ lat: 47.6, lng: -122.4594 }])),
      "somewhere north",
    );
    expect(result).toEqual({ status: "off_island" });
  });

  it("takes the FIRST result, which is the provider's best match", async () => {
    const result = await lookupIslandAddress(
      deps(
        googleResponse([
          { lat: 47.4471, lng: -122.4594 },
          { lat: 47.4, lng: -122.45 },
        ]),
      ),
      "Vashon Highway SW",
    );

    expect(result).toEqual({
      status: "found",
      latitude: 47.4471,
      longitude: -122.4594,
    });
  });

  it("asks for no draft when the address resolves to nothing", async () => {
    const result = await lookupIslandAddress(
      deps(googleResponse([], "ZERO_RESULTS")),
      "nowhere at all",
    );
    expect(result).toEqual({ status: "no_result" });
  });

  it("asks for no draft on a provider error, inventing nothing", async () => {
    // The failure mode that matters: a broken or throttled provider must yield NO coordinate,
    // never a guessed one. Since F-077 that means the stand cannot be published until the
    // lookup succeeds, which is a refusal the farmer can see — not a silent approximation.
    const errored = await lookupIslandAddress(
      deps(googleResponse([], "OVER_QUERY_LIMIT")),
      "12345 Vashon Highway SW",
    );
    expect(errored).toEqual({ status: "no_result" });

    const failed = await lookupIslandAddress(
      deps(googleResponse([{ lat: 47.4471, lng: -122.4594 }]), false),
      "12345 Vashon Highway SW",
    );
    expect(failed).toEqual({ status: "no_result" });
  });

  it("asks for no draft when the provider throws", async () => {
    const result = await lookupIslandAddress(
      {
        apiKey: KEY,
        fetch: vi.fn(async () => {
          throw new Error("network down");
        }) as unknown as typeof fetch,
      },
      "12345 Vashon Highway SW",
    );
    expect(result).toEqual({ status: "no_result" });
  });

  it("asks for no draft when a coordinate is missing or not a number", async () => {
    // A malformed body must not become `Number(undefined)` — NaN — or worse, 0, which is a real
    // coordinate in the Atlantic.
    for (const body of [
      { status: "OK", results: [{ geometry: { location: { lat: "47.4", lng: -122.4 } } }] },
      { status: "OK", results: [{ geometry: {} }] },
      { status: "OK", results: [{}] },
      { status: "OK" },
      {},
      null,
    ]) {
      const result = await lookupIslandAddress(deps(body), "12345 Vashon Highway SW");
      expect(result).toEqual({ status: "no_result" });
    }
  });

  it("does NOT call the provider when the key is absent", async () => {
    // An unconfigured deployment must fall back to pin-dropping silently rather than erroring:
    // the pin is the authority, so a missing geocoder is a missing convenience, not an outage.
    const fetchMock = vi.fn();
    const result = await lookupIslandAddress(
      { apiKey: undefined, fetch: fetchMock as unknown as typeof fetch },
      "12345 Vashon Highway SW",
    );

    expect(result).toEqual({ status: "not_configured" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does NOT call the provider for a blank address", async () => {
    const fetchMock = vi.fn();
    const result = await lookupIslandAddress(
      { apiKey: KEY, fetch: fetchMock as unknown as typeof fetch },
      "   ",
    );

    expect(result).toEqual({ status: "no_result" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the key and the address, and BIASES the query to the island", async () => {
    const fetchDep = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => googleResponse([{ lat: 47.4471, lng: -122.4594 }]),
    })) as unknown as typeof fetch;

    await lookupIslandAddress({ apiKey: KEY, fetch: fetchDep }, "12345 Vashon Hwy SW");

    const url = String((fetchDep as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![0]);
    expect(url).toContain("maps.googleapis.com/maps/api/geocode/json");
    expect(url).toContain(`key=${KEY}`);
    // `URLSearchParams` form-encodes spaces as `+`, which is correct for a query string. The
    // assertion names that rather than `%20`, so it is anchored to real encoding behaviour.
    expect(url).toContain("address=12345+Vashon+Hwy+SW");
    // A bare "12345 Vashon Hwy" resolves in a dozen states. The bounds parameter keeps the
    // provider's best match on the island the farm is actually on.
    expect(url).toContain("bounds=");
    expect(url).toContain("region=us");
  });
});
