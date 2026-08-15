import { describe, expect, it, vi } from "vitest";
import { FixedClock, createPublicActionThrottle } from "@farm-friend/core";
import type { Db } from "@farm-friend/db";
import {
  handleAddressLookupPost,
  type FarmerAddressLookupDeps,
} from "./farmer-address-lookup";

// F-069 — the HTTP boundary for the DRAFT pin lookup.
//
// The properties this endpoint has to hold, and why each one:
//
//   * THE INVITATION TOKEN IS THE CREDENTIAL. Geocoding costs money per call, so an
//     unauthenticated lookup endpoint is a way to spend VIGA's money in a loop. The same token
//     that gates writing the listing gates the lookup.
//   * THE KEY NEVER REACHES THE BROWSER. The lookup happens here, server-side; the response
//     carries a coordinate and nothing else. A key in client JavaScript is a published key.
//   * THE THROTTLE FRONTS IT. This is the third consumer of the abuse/cost throttle, and it is
//     the same shape as the first two: a public handler performing an EXPENSIVE action. What is
//     rationed is the billed provider call (docs/ARCHITECTURE.md §abuse / cost throttle).
//   * A DRAFT IS NOT A COMMIT. This endpoint writes nothing. The coordinate it returns has to be
//     confirmed by the farmer and re-submitted through `/api/farmer/listing` to reach the map.

const T0 = new Date("2026-08-05T17:00:00Z");
const TOKEN = "a".repeat(64);
const FARM_ID = "11111111-1111-4111-8111-111111111111";

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://farmfriend.example/api/farmer/address-lookup", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

type Loader = FarmerAddressLookupDeps["loadInvitation"];
type Lookup = FarmerAddressLookupDeps["lookupAddress"];

function loader(
  result: Awaited<ReturnType<Loader>> = {
    status: "active",
    invitationId: "invitation-1",
    farmId: FARM_ID,
    farmName: "Test Farm",
    channel: "sms",
  },
) {
  return vi.fn<Parameters<Loader>, ReturnType<Loader>>(async () => result);
}

function lookup(
  result: Awaited<ReturnType<Lookup>> = {
    status: "found",
    latitude: 47.4471,
    longitude: -122.4594,
  },
) {
  return vi.fn<Parameters<Lookup>, ReturnType<Lookup>>(async () => result);
}

type Claimer = FarmerAddressLookupDeps["claimFarm"];

function claimer(
  result: Awaited<ReturnType<Claimer>> = {
    status: "claimable",
    farmId: FARM_ID,
    farmName: "Test Farm",
    description: null,
  },
) {
  return vi.fn<Parameters<Claimer>, ReturnType<Claimer>>(async () => result);
}

type LinkResolver = FarmerAddressLookupDeps["resolveLink"];

function linkResolver(result: Awaited<ReturnType<LinkResolver>> = null) {
  return vi.fn<Parameters<LinkResolver>, ReturnType<LinkResolver>>(async () => result);
}

function deps(
  loadInvitation = loader(),
  lookupAddress = lookup(),
  throttle = createPublicActionThrottle({
    clock: new FixedClock(T0),
    limit: 10,
    windowMs: 60_000,
  }),
  claimFarm = claimer(),
  resolveLink = linkResolver(),
): FarmerAddressLookupDeps {
  return {
    db: {} as Db,
    clock: new FixedClock(T0),
    loadInvitation,
    lookupAddress,
    throttle,
    claimFarm,
    resolveLink,
    clientSignalSalt: "test-salt",
  };
}

describe("farmer address lookup endpoint", () => {
  it("returns a draft coordinate for a valid token and address", async () => {
    const response = await handleAddressLookupPost(
      deps(),
      post({ token: TOKEN, address: "12345 Vashon Highway SW" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "found",
      latitude: 47.4471,
      longitude: -122.4594,
    });
  });

  it("REFUSES a malformed token before spending a provider call", async () => {
    // The token check is what stops the endpoint being a free geocoding proxy.
    const spend = lookup();
    const response = await handleAddressLookupPost(
      deps(loader(), spend),
      post({ token: "not-a-token", address: "12345 Vashon Highway SW" }),
    );

    expect(response.status).toBe(400);
    expect(spend).not.toHaveBeenCalled();
  });

  it("REFUSES an unknown or spent invitation without spending a provider call", async () => {
    // Expired, redeemed, and unknown all collapse to `invalid` in the lookup, which is what
    // stops this endpoint being used to learn whether a guessed token names anything.
    const spend = lookup();
    const response = await handleAddressLookupPost(
      deps(loader({ status: "invalid" }), spend),
      post({ token: TOKEN, address: "12345 Vashon Highway SW" }),
    );

    expect(response.status).toBe(410);
    expect(spend).not.toHaveBeenCalled();
  });

  it("reports an off-island result as such rather than as a coordinate", async () => {
    // The farmer must be told their address did not resolve to somewhere on the island, so they
    // can place the pin themselves. Returning a coordinate here would be the fabricated-pin
    // defect the boundary exists to prevent.
    const response = await handleAddressLookupPost(
      deps(loader(), lookup({ status: "off_island" })),
      post({ token: TOKEN, address: "1234 Pike Street, Seattle" }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "off_island" });
  });

  it("reports no result and not_configured WITHOUT a coordinate", async () => {
    for (const status of ["no_result", "not_configured"] as const) {
      const response = await handleAddressLookupPost(
        deps(loader(), lookup({ status })),
        post({ token: TOKEN, address: "somewhere" }),
      );
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toEqual({ status });
      expect(body.latitude).toBeUndefined();
      expect(body.longitude).toBeUndefined();
    }
  });

  it("THROTTLES repeated lookups from one client", async () => {
    // The billed call is the thing being rationed. A farmer typing an address needs a handful of
    // lookups; a loop wants thousands.
    const throttle = createPublicActionThrottle({
      clock: new FixedClock(T0),
      limit: 2,
      windowMs: 60_000,
    });
    const spend = lookup();
    const shared = deps(loader(), spend, throttle);
    const headers = { "x-forwarded-for": "203.0.113.7" };

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const allowed = await handleAddressLookupPost(
        shared,
        post({ token: TOKEN, address: "12345 Vashon Highway SW" }, headers),
      );
      expect(allowed.status).toBe(200);
    }

    const refused = await handleAddressLookupPost(
      shared,
      post({ token: TOKEN, address: "12345 Vashon Highway SW" }, headers),
    );
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).not.toBeNull();
    // The refused attempt did NOT reach the provider — that is the whole point of the order.
    expect(spend).toHaveBeenCalledTimes(2);
  });

  it("consults the throttle BEFORE the invitation and the provider", async () => {
    // Ordering asserted by exhausting a real budget and then counting BOTH downstream calls.
    // If the throttle ran last, the refused attempt would still have cost a database read and a
    // billed provider call — which is the cost the throttle exists to prevent.
    const throttle = createPublicActionThrottle({
      clock: new FixedClock(T0),
      limit: 1,
      windowMs: 60_000,
    });
    const spend = lookup();
    const load = loader();
    const shared = deps(load, spend, throttle);
    const headers = { "x-forwarded-for": "203.0.113.9" };

    const allowed = await handleAddressLookupPost(
      shared,
      post({ token: TOKEN, address: "12345 Vashon Highway SW" }, headers),
    );
    expect(allowed.status).toBe(200);

    const refused = await handleAddressLookupPost(
      shared,
      post({ token: TOKEN, address: "12345 Vashon Highway SW" }, headers),
    );
    expect(refused.status).toBe(429);
    expect(spend).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("refuses a blank or oversized address", async () => {
    for (const address of ["", "   ", "x".repeat(5_000)]) {
      const spend = lookup();
      const response = await handleAddressLookupPost(
        deps(loader(), spend),
        post({ token: TOKEN, address }),
      );
      expect(response.status).toBe(400);
      expect(spend).not.toHaveBeenCalled();
    }
  });

  it("refuses a non-string address and a body that is not JSON", async () => {
    const spend = lookup();
    expect(
      (await handleAddressLookupPost(deps(loader(), spend), post({ token: TOKEN, address: 7 })))
        .status,
    ).toBe(400);
    expect((await handleAddressLookupPost(deps(loader(), spend), post("{"))).status).toBe(400);
    expect(spend).not.toHaveBeenCalled();
  });

  it("NEVER returns the provider key or any field beyond the coordinate", async () => {
    // The response shape is the containment: a key echoed into a response body is a published
    // key, and the browser has no use for anything but the coordinate.
    const response = await handleAddressLookupPost(
      deps(),
      post({ token: TOKEN, address: "12345 Vashon Highway SW" }),
    );

    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["latitude", "longitude", "status"]);
    expect(JSON.stringify(body)).not.toContain("key");
  });

  // ── F-072: the second credential ───────────────────────────────────────────────────────
  //
  // A grandfathered farmer holds no invitation, so a claimable farm stands in the token's
  // place on this BILLED endpoint. It is a weaker gate — farm ids are not secret — and these
  // tests pin down exactly what it does and does not buy, so the weakening is deliberate and
  // visible rather than discovered later.

  describe("the grandfathered credential", () => {
    it("returns a draft coordinate for a claimable farm", async () => {
      const response = await handleAddressLookupPost(
        deps(),
        post({ farmId: FARM_ID, address: "12345 Vashon Highway SW" }),
      );

      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({
        status: "found",
        latitude: 47.4471,
        longitude: -122.4594,
      });
    });

    it("REFUSES a farm that already has a farmer, before spending a provider call", async () => {
      // The lookup closes for a farm as soon as it has a farmer, so the billed surface shrinks
      // as sellers onboard rather than staying open to every farm forever.
      const spend = lookup();
      const response = await handleAddressLookupPost(
        deps(loader(), spend, undefined, claimer({ status: "already_onboarded" })),
        post({ farmId: FARM_ID, address: "12345 Vashon Highway SW" }),
      );

      expect(response.status).toBe(410);
      expect(spend).not.toHaveBeenCalled();
    });

    it("refuses an unknown farm before spending a provider call", async () => {
      const spend = lookup();
      const response = await handleAddressLookupPost(
        deps(loader(), spend, undefined, claimer({ status: "unknown_farm" })),
        post({ farmId: FARM_ID, address: "12345 Vashon Highway SW" }),
      );

      expect(response.status).toBe(410);
      expect(spend).not.toHaveBeenCalled();
    });

    it("REFUSES a malformed farm id before spending a provider call", async () => {
      const spend = lookup();
      const claim = claimer();
      const response = await handleAddressLookupPost(
        deps(loader(), spend, undefined, claim),
        post({ farmId: "not-a-uuid", address: "12345 Vashon Highway SW" }),
      );

      expect(response.status).toBe(400);
      expect(claim).not.toHaveBeenCalled();
      expect(spend).not.toHaveBeenCalled();
    });

    it("refuses a request carrying BOTH credentials rather than picking one", async () => {
      // Ambiguous, not clever: honouring the weaker one would let a farm id downgrade a
      // request that also carried a token, and honouring the stronger would let a token
      // launder a lookup for a farm it does not name.
      const spend = lookup();
      const response = await handleAddressLookupPost(
        deps(loader(), spend),
        post({ token: TOKEN, farmId: FARM_ID, address: "12345 Vashon Highway SW" }),
      );

      expect(response.status).toBe(400);
      expect(spend).not.toHaveBeenCalled();
    });

    it("refuses a request carrying NO credential", async () => {
      const spend = lookup();
      const response = await handleAddressLookupPost(
        deps(loader(), spend),
        post({ address: "12345 Vashon Highway SW" }),
      );

      expect(response.status).toBe(400);
      expect(spend).not.toHaveBeenCalled();
    });

    it("accepts an already-onboarded farmer's STAND LINK token (F-073)", async () => {
      // An invitation token and a stand link are both 64 hex, so the shape check cannot tell
      // them apart. An editing farmer holds the second kind and is placing a pin on a stand
      // they already control, which is the same act.
      const invalidInvitation = loader({ status: "invalid" });
      const response = await handleAddressLookupPost(
        deps(invalidInvitation, lookup(), undefined, claimer(), linkResolver({
          authorizationId: "auth-1",
          farmId: FARM_ID,
          salesLocationId: "loc-1",
          senderHash: "hash-1",
        })),
        post({ token: TOKEN, address: "12345 Vashon Highway SW" }),
      );

      expect(response.status).toBe(200);
    });

    it("refuses a token that is NEITHER an invitation nor a live stand link", async () => {
      const spend = lookup();
      const response = await handleAddressLookupPost(
        deps(loader({ status: "invalid" }), spend, undefined, claimer(), linkResolver(null)),
        post({ token: TOKEN, address: "12345 Vashon Highway SW" }),
      );

      expect(response.status).toBe(410);
      expect(spend).not.toHaveBeenCalled();
    });

    it("is still fronted by the throttle, which is the real cost defense here", async () => {
      // The credential is weak on this path, so the rationing is what actually bounds spend.
      const spend = lookup();
      const throttle = createPublicActionThrottle({
        clock: new FixedClock(T0),
        limit: 1,
        windowMs: 60_000,
      });
      const first = await handleAddressLookupPost(
        deps(loader(), spend, throttle),
        post({ farmId: FARM_ID, address: "12345 Vashon Highway SW" }),
      );
      const second = await handleAddressLookupPost(
        deps(loader(), spend, throttle),
        post({ farmId: FARM_ID, address: "12345 Vashon Highway SW" }),
      );

      expect(first.status).toBe(200);
      expect(second.status).toBe(429);
      expect(spend).toHaveBeenCalledTimes(1);
    });
  });
});
