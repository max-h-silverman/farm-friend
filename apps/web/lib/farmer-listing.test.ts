import { describe, expect, it, vi } from "vitest";
import { FixedClock } from "@farm-friend/core";
import type { Db } from "@farm-friend/db";
import {
  handleFarmerListingPost,
  type FarmerListingDeps,
} from "./farmer-listing";

// F-067 — the HTTP boundary for the listing details an onboarding farmer types.
//
// This is the FIRST farmer-facing write path for public listing data, so the contract it holds
// matters more than most:
//
//   * THE INVITATION TOKEN IS THE ONLY CREDENTIAL, and it names the farm. A farm id from the
//     request body would let anyone with any link write onto any farm's listing — the token
//     must resolve the farm server-side, and this boundary must never accept one.
//   * The token travels in the BODY, never a query string: a credential in a URL lands in
//     server logs and browser history by default. Same rule the agreement endpoint follows.
//   * An expired, redeemed, or unknown invitation gets ONE uniform refusal, so this cannot be
//     used to learn whether a guessed token names anything.
//   * The visitability branch is the form's real structure, and its refusals must reach the
//     farmer as something they can act on rather than as a 500.
//
// The durable half is proven against real Postgres in
// `packages/db/src/onboarding-listing.integration.test.ts`. These tests own the request
// contract: what is refused, what is disclosed, and what reaches the writer.

const T0 = new Date("2026-08-05T17:00:00Z");
const TOKEN = "a".repeat(64);
const FARM_ID = "11111111-1111-4111-8111-111111111111";

const LISTING = {
  visitability: "visitable",
  offeringType: "produce",
  standName: "Test Stand",
  publicAddress: "12345 Vashon Highway SW",
  latitude: 47.4471,
  longitude: -122.4594,
  hoursText: "Daylight hours",
  paymentMethods: ["cash"],
  items: ["Eggs"],
};

function post(body: unknown): Request {
  return new Request("https://farmfriend.example/api/farmer/listing", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

type Loader = FarmerListingDeps["loadInvitation"];
type Saver = FarmerListingDeps["saveListing"];

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

function saver(
  result: Awaited<ReturnType<Saver>> = { status: "saved", salesLocationId: "loc-1" },
) {
  return vi.fn<Parameters<Saver>, ReturnType<Saver>>(async () => result);
}

function deps(
  loadInvitation = loader(),
  saveListing = saver(),
): FarmerListingDeps {
  return {
    db: {} as Db,
    clock: new FixedClock(T0),
    loadInvitation,
    saveListing,
  };
}

describe("farmer onboarding listing endpoint", () => {
  it("saves the listing against the farm the TOKEN names", async () => {
    const save = saver();
    const response = await handleFarmerListingPost(
      deps(loader(), save),
      post({ token: TOKEN, ...LISTING }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "saved" });
    expect(save).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        farmId: FARM_ID,
        standName: "Test Stand",
        occurredAt: T0,
      }),
    );
  });

  it("IGNORES a farm id in the request body", async () => {
    // The attack this boundary exists to refuse. If a caller-supplied farm reached the
    // writer, anyone holding any onboarding link could overwrite any farm's public listing
    // — address, hours, and all — on VIGA's map.
    const save = saver();
    await handleFarmerListingPost(
      deps(loader(), save),
      post({
        token: TOKEN,
        ...LISTING,
        farmId: "22222222-2222-4222-8222-222222222222",
      }),
    );

    expect(save).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ farmId: FARM_ID }),
    );
  });

  it("stamps the SERVER's time, never a time from the request", async () => {
    const save = saver();
    await handleFarmerListingPost(
      deps(loader(), save),
      post({ token: TOKEN, ...LISTING, occurredAt: new Date(0).toISOString() }),
    );

    expect(save).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ occurredAt: T0 }),
    );
  });

  it("refuses a malformed token BEFORE touching the database", async () => {
    const load = loader();
    const save = saver();
    const response = await handleFarmerListingPost(
      deps(load, save),
      post({ token: "not-a-token", ...LISTING }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(load).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("answers an unknown or spent invitation with the UNIFORM refusal", async () => {
    // Same 410 the agreement endpoint gives, so neither is an oracle for whether a guessed
    // token names anything real.
    const save = saver();
    const response = await handleFarmerListingPost(
      deps(loader({ status: "invalid" }), save),
      post({ token: TOKEN, ...LISTING }),
    );

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({
      error: "invitation_unavailable",
    });
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses an invitation that names NO FARM", async () => {
    // An invitation with no farm is the path that still needs a human (a bare SIGNUP, or a
    // link minted before farms were named at invite time). There is nothing to write a
    // listing against, and inventing a farm here would grant exactly what the invited path
    // is careful never to grant.
    const save = saver();
    const response = await handleFarmerListingPost(
      deps(
        loader({
          status: "active",
          invitationId: "invitation-1",
          farmId: null,
          farmName: null,
          channel: "sms",
        }),
        save,
      ),
      post({ token: TOKEN, ...LISTING }),
    );

    expect(response.status).toBe(410);
    expect(save).not.toHaveBeenCalled();
  });

  it("passes a contact-only listing through with no address or pin", async () => {
    const save = saver();
    const response = await handleFarmerListingPost(
      deps(loader(), save),
      post({
        token: TOKEN,
        standName: "Delivery Farm",
        visitability: "contact_only",
        offeringType: "by_order",
        hoursText: "By arrangement",
        paymentMethods: ["cash"],
        items: ["lamb"],
      }),
    );

    expect(response.status).toBe(200);
    expect(save).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        listing: expect.objectContaining({
          visitability: "contact_only",
          publicAddress: null,
          latitude: null,
          longitude: null,
        }),
      }),
    );
  });

  it("DROPS an address and pin sent alongside contact_only", async () => {
    // A farmer who fills in the address, then changes their answer to "no stand to visit",
    // must not publish a pin. The form hides those fields, but the boundary cannot rely on
    // the form — it is reachable by anything that can POST, and `coherentVisitability` would
    // refuse the write with an error the farmer cannot act on.
    const save = saver();
    await handleFarmerListingPost(
      deps(loader(), save),
      post({
        token: TOKEN,
        standName: "Delivery Farm",
        visitability: "contact_only",
        offeringType: "by_order",
        publicAddress: "12345 Vashon Highway SW",
        latitude: 47.4471,
        longitude: -122.4594,
        paymentMethods: [],
        items: [],
      }),
    );

    expect(save).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        listing: expect.objectContaining({
          publicAddress: null,
          latitude: null,
          longitude: null,
        }),
      }),
    );
  });

  it("refuses a listing with no visitability answer", async () => {
    // The form's central question. Defaulting it would decide on the farmer's behalf whether
    // there is a place to drive to, which is precisely the fact nobody may invent.
    const save = saver();
    const response = await handleFarmerListingPost(
      deps(loader(), save),
      post({ token: TOKEN, standName: "Test Stand", offeringType: "produce" }),
    );

    expect(response.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses a non-numeric coordinate rather than coercing it", async () => {
    // `Number(null)` is 0, which is a real coordinate in the Atlantic. Every coordinate here
    // is validated as a number rather than coerced into one.
    const save = saver();
    const response = await handleFarmerListingPost(
      deps(loader(), save),
      post({ token: TOKEN, ...LISTING, latitude: "47.4471" }),
    );

    expect(response.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it("reports an incomplete location as something the farmer can fix", async () => {
    const response = await handleFarmerListingPost(
      deps(loader(), saver({ status: "incomplete_location" })),
      post({ token: TOKEN, ...LISTING }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "incomplete_location",
    });
  });

  it("reports a pin that is not on the island", async () => {
    const response = await handleFarmerListingPost(
      deps(loader(), saver({ status: "off_island" })),
      post({ token: TOKEN, ...LISTING }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "off_island" });
  });

  it("refuses a body that is not JSON", async () => {
    const response = await handleFarmerListingPost(deps(), post("{"));
    expect(response.status).toBe(400);
  });

  it("refuses non-string items and payment methods rather than storing junk", async () => {
    const save = saver();
    const response = await handleFarmerListingPost(
      deps(loader(), save),
      post({ token: TOKEN, ...LISTING, items: ["Eggs", 7] }),
    );

    expect(response.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it("caps how much text one submission can write", async () => {
    // The endpoint is reachable by anyone holding a link, and everything it writes is
    // published on VIGA's public map. An unbounded field is a defacement vector and a
    // storage one; the limits are generous enough that no real farmer meets them.
    const save = saver();
    const response = await handleFarmerListingPost(
      deps(loader(), save),
      post({ token: TOKEN, ...LISTING, hoursText: "x".repeat(5_000) }),
    );

    expect(response.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it("caps how MANY items one submission can write", async () => {
    const save = saver();
    const response = await handleFarmerListingPost(
      deps(loader(), save),
      post({
        token: TOKEN,
        ...LISTING,
        items: Array.from({ length: 300 }, (_, index) => `item ${index}`),
      }),
    );

    expect(response.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });
});
