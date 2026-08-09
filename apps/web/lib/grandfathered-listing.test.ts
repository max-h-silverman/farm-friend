import { describe, expect, it, vi } from "vitest";
import { FixedClock } from "@farm-friend/core";
import type { Db } from "@farm-friend/db";
import {
  handleGrandfatheredListingPost,
  type GrandfatheredListingDeps,
} from "./grandfathered-listing";

// F-072 — the HTTP boundary for a grandfathered farmer's listing, claimed from the public
// dropdown with NO invitation and NO administrator.
//
// This is the widest door in Farm Friend, by max's decision (2026-08-06): there is no phone
// roster to verify a claimant against, so picking the farm from a list is the whole claim. That
// makes the boundary's remaining guarantees the only ones there are, and each has a test here:
//
//   * THE FARM IS RESOLVED SERVER-SIDE AND RE-CHECKED. The body names a farm — it must, there
//     is no token to name one — so `claimFarm` is what stands between a posted id and a write.
//     A farm with a live farmer is refused, which is what stops a stranger overwriting the
//     listing of a farm whose farmer already onboarded.
//   * The refusal is CHECKED AT SUBMIT, not merely at page load. The dropdown's omission is a
//     convenience; a farmer can onboard in the window between the page rendering and the form
//     being sent, and the submit must lose that race.
//   * Nothing here grants authority. Publishing inventory still needs an authorization, which
//     still needs a handset — this path writes listing facts only.
//
// The listing FIELD validation is not retested here: it is `farmer-listing.ts`'s, shared by
// both credentials, and duplicating it would create two statements of one rule.

const T0 = new Date("2026-08-06T17:00:00Z");
const FARM_ID = "11111111-1111-4111-8111-111111111111";

const LISTING = {
  visitability: "visitable",
  offeringType: "produce",
  standName: "Grandfather Stand",
  publicAddress: "12345 Vashon Highway SW",
  latitude: 47.4471,
  longitude: -122.4594,
  hoursText: "Daylight hours",
  paymentMethods: ["cash"],
  items: ["Eggs"],
};

function post(body: unknown): Request {
  return new Request("https://farmfriend.example/api/farmer/grandfathered-listing", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

type Claimer = GrandfatheredListingDeps["claimFarm"];
type Saver = GrandfatheredListingDeps["saveListing"];

function claimer(
  result: Awaited<ReturnType<Claimer>> = {
    status: "claimable",
    farmId: FARM_ID,
    farmName: "Grandfather Farm",
    description: null,
  },
) {
  return vi.fn<Parameters<Claimer>, ReturnType<Claimer>>(async () => result);
}

function saver(
  result: Awaited<ReturnType<Saver>> = { status: "saved", salesLocationId: "loc-1" },
) {
  return vi.fn<Parameters<Saver>, ReturnType<Saver>>(async () => result);
}

function deps(claimFarm = claimer(), saveListing = saver()): GrandfatheredListingDeps {
  return {
    db: {} as Db,
    clock: new FixedClock(T0),
    claimFarm,
    saveListing,
  };
}

describe("grandfathered listing endpoint", () => {
  it("saves the listing against the claimed farm", async () => {
    const save = saver();
    const response = await handleGrandfatheredListingPost(
      deps(claimer(), save),
      post({ farmId: FARM_ID, ...LISTING }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "saved" });
    expect(save).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        farmId: FARM_ID,
        standName: "Grandfather Stand",
        occurredAt: T0,
      }),
    );
  });

  it("REFUSES a farm that already has a farmer, and writes nothing", async () => {
    // The core guarantee. Without it this endpoint lets anyone overwrite the public listing of
    // any farm on the island, including the 34 already live on VIGA's map.
    const save = saver();
    const response = await handleGrandfatheredListingPost(
      deps(claimer({ status: "already_onboarded" }), save),
      post({ farmId: FARM_ID, ...LISTING }),
    );

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "already_onboarded" });
    expect(save).not.toHaveBeenCalled();
  });

  it("re-checks the claim AT SUBMIT rather than trusting the rendered page", async () => {
    // A farmer can onboard between the dropdown rendering and this form being sent. The claim
    // is therefore resolved on THIS request; a stale page must lose that race.
    const claim = claimer({ status: "already_onboarded" });
    await handleGrandfatheredListingPost(deps(claim, saver()), post({ farmId: FARM_ID, ...LISTING }));

    expect(claim).toHaveBeenCalledWith({}, { farmId: FARM_ID });
  });

  it("takes the farm NAME from the resolved farm, never from the request body", async () => {
    // The body may name a farm; it may not name what that farm is CALLED on the public map.
    const save = saver();
    await handleGrandfatheredListingPost(
      deps(claimer(), save),
      post({ farmId: FARM_ID, ...LISTING, standName: null, farmName: "Impostor Farm" }),
    );

    expect(save).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ standName: "Grandfather Farm" }),
    );
  });

  it("refuses a malformed farm id BEFORE touching the database", async () => {
    const claim = claimer();
    const save = saver();
    const response = await handleGrandfatheredListingPost(
      deps(claim, save),
      post({ farmId: "not-a-uuid", ...LISTING }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(claim).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses a missing farm id", async () => {
    const response = await handleGrandfatheredListingPost(
      deps(),
      post({ ...LISTING }),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
  });

  it("answers an unknown farm without saying whether the id names anything", async () => {
    // Farm ids are not secret — they are in the dropdown — so this leaks nothing either way.
    // It is answered honestly rather than as a save.
    const response = await handleGrandfatheredListingPost(
      deps(claimer({ status: "unknown_farm" }), saver()),
      post({ farmId: FARM_ID, ...LISTING }),
    );
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "unknown_farm" });
  });

  it("stamps the SERVER's time, never a time from the request", async () => {
    const save = saver();
    await handleGrandfatheredListingPost(
      deps(claimer(), save),
      post({ farmId: FARM_ID, ...LISTING, occurredAt: new Date(0).toISOString() }),
    );

    expect(save).toHaveBeenCalledWith({}, expect.objectContaining({ occurredAt: T0 }));
  });

  it("refuses malformed JSON", async () => {
    const response = await handleGrandfatheredListingPost(deps(), post("{not json"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
  });

  it("applies the SAME field validation as the invited path", async () => {
    // Shared, not duplicated: one statement of what a listing may contain. A missing
    // visitability answer is the field the writer may never default (B-024).
    const save = saver();
    const response = await handleGrandfatheredListingPost(
      deps(claimer(), save),
      post({ farmId: FARM_ID, ...LISTING, visitability: undefined }),
    );

    expect(response.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it("KEEPS the address and pin on a contact-only stand (F-088)", async () => {
    const save = saver();
    await handleGrandfatheredListingPost(
      deps(claimer(), save),
      post({ farmId: FARM_ID, ...LISTING, visitability: "contact_only" }),
    );

    expect(save).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        listing: expect.objectContaining({
          // F-088 — a farm with no stand is now PLACED like any other. Stripping here would
          // discard a location the farmer gave us; `visitability` is what stops the map
          // inviting the drive, and it travels untouched.
          publicAddress: "12345 Vashon Highway SW",
          latitude: 47.4471,
          longitude: -122.4594,
        }),
      }),
    );
  });

  it("reports a writer refusal to the farmer rather than as a save", async () => {
    const response = await handleGrandfatheredListingPost(
      deps(claimer(), saver({ status: "incomplete_location" })),
      post({ farmId: FARM_ID, ...LISTING }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "incomplete_location" });
  });
});
describe("the grandfathered farmer's phone (F-098)", () => {
  /*
    THE REGRESSION THIS REPAIRS, and why it is not a new feature.

    `JOIN <token>` was removed 2026-08-07: farm identity moved to a phone the farmer states on
    the onboarding form, and a bare START now matches an inbound handset against
    `pending_phone_hash`. That column lives on `farmer_invitations` — a row this door could not
    write, because `created_by_administrator_id` was NOT NULL and there is no administrator in
    the honour-system loop.

    So this door's farmer lost their only route to SMS and got no replacement: they could
    publish a listing and then never finish onboarding. Migration 0035 makes the issuer optional
    so a SELF-ISSUED claim can carry the phone, and every downstream path — START matching,
    redemption, authorization, the welcome text — keys on that row and is unchanged.
  */
  it("records the stated phone as a self-issued claim, with no administrator", async () => {
    const record = vi.fn(async () => ({ status: "recorded" as const }));
    const response = await handleGrandfatheredListingPost(
      { ...deps(), recordSelfIssuedClaim: record },
      post({ farmId: FARM_ID, ...LISTING, phone: "(206) 555-0143", agreedToSms: true }),
    );

    expect(response.status).toBe(200);
    expect(record).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        farmId: FARM_ID,
        // RAW for the boundary to normalize and hash — the same contract the invited door has.
        phone: "(206) 555-0143",
        agreedToSms: true,
        occurredAt: T0,
      }),
    );
  });

  it("refuses a phone it cannot make sense of, and writes nothing", async () => {
    const save = saver();
    const record = vi.fn(async () => ({ status: "invalid" as const }));
    const response = await handleGrandfatheredListingPost(
      { ...deps(claimer(), save), recordSelfIssuedClaim: record },
      post({ farmId: FARM_ID, ...LISTING, phone: "12", agreedToSms: true }),
    );

    // Actionable, and shown against the field — unlike the uniform refusals above, which must
    // not disclose anything about a farm.
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_phone" });
    // The listing must NOT be published behind a phone that failed: a farmer would be on the
    // map with no way to ever update it, which is the exact dead end this repairs.
    expect(save).not.toHaveBeenCalled();
  });

  it("still publishes for a farmer who states no phone", async () => {
    // The phone is how a farmer reaches SMS, not a condition of appearing on the map. A farmer
    // who only wants a listing must not be blocked, and one who returns later can text LINK.
    const record = vi.fn(async () => ({ status: "recorded" as const }));
    const response = await handleGrandfatheredListingPost(
      { ...deps(), recordSelfIssuedClaim: record },
      post({ farmId: FARM_ID, ...LISTING }),
    );

    expect(response.status).toBe(200);
    expect(record).not.toHaveBeenCalled();
  });

  it("does not record a phone the farmer never agreed to be texted on", async () => {
    // The tick is the consent, and it gates the claim rather than decorating it. Recording a
    // handset the farmer did not agree to would make their next START authorize a farm they
    // never opted into.
    const record = vi.fn(async () => ({ status: "recorded" as const }));
    const response = await handleGrandfatheredListingPost(
      { ...deps(), recordSelfIssuedClaim: record },
      post({ farmId: FARM_ID, ...LISTING, phone: "(206) 555-0143", agreedToSms: false }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "sms_agreement_required" });
    expect(record).not.toHaveBeenCalled();
  });
});
