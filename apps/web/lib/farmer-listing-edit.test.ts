import { describe, expect, it, vi } from "vitest";
import { FixedClock } from "@farm-friend/core";
import type { Db } from "@farm-friend/db";
import {
  handleFarmerListingEditPost,
  type FarmerListingEditDeps,
} from "./farmer-listing-edit";

// F-073 — an ALREADY-ONBOARDED farmer edits their own listing facts.
//
// Before this, listing facts were frozen for everyone except a farmer mid-onboarding: the
// F-067/F-069 form is bound to a one-use invitation token, so once a farmer was set up there was
// no way to change hours, address, payments, or what they usually sell. This is the third
// credential onto the SAME writer.
//
//   * THE STAND LINK IS THE CREDENTIAL, and it names the farm. A `farmId` in the body is
//     ignored — the same rule the invited path holds, and for the same reason: a link must only
//     reach the stand it was issued for.
//   * REVOCATION IS IMMEDIATE. `resolveFarmerLink` re-reads the authorization per request, so a
//     revoked farmer's link resolves to nothing. Inherited, not reimplemented.
//   * IT WRITES LISTING FACTS ONLY. No inventory revision — F-066's separation ("I usually sell
//     eggs" is not "eggs are on the table today") must survive a new writer.

const T0 = new Date("2026-08-06T17:00:00Z");
const TOKEN = "b".repeat(64);
const FARM_ID = "11111111-1111-4111-8111-111111111111";

const LISTING = {
  visitability: "visitable",
  offeringType: "produce",
  standName: "Edited Stand",
  publicAddress: "12345 Vashon Highway SW",
  latitude: 47.4471,
  longitude: -122.4594,
  hoursText: "Dawn to dusk",
  paymentMethods: ["Cash"],
  items: ["Eggs"],
};

function post(body: unknown): Request {
  return new Request("https://farmfriend.example/api/farmer/listing-edit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

type Resolver = FarmerListingEditDeps["resolveLink"];
type Saver = FarmerListingEditDeps["saveListing"];

function resolver(
  result: Awaited<ReturnType<Resolver>> = {
    authorizationId: "auth-1",
    farmId: FARM_ID,
    salesLocationId: "loc-1",
    providerId: "provider-1",
    senderHash: "hash-1",
  },
) {
  return vi.fn<Parameters<Resolver>, ReturnType<Resolver>>(async () => result);
}

function saver(
  result: Awaited<ReturnType<Saver>> = { status: "saved", salesLocationId: "loc-1" },
) {
  return vi.fn<Parameters<Saver>, ReturnType<Saver>>(async () => result);
}

type Renamer = FarmerListingEditDeps["renameFarm"];

function renamer(result: Awaited<ReturnType<Renamer>> = { status: "saved" }) {
  return vi.fn<Parameters<Renamer>, ReturnType<Renamer>>(async () => result);
}

function deps(
  resolveLink = resolver(),
  saveListing = saver(),
  renameFarm = renamer(),
): FarmerListingEditDeps {
  return {
    db: {} as Db,
    clock: new FixedClock(T0),
    resolveLink,
    saveListing,
    renameFarm,
  };
}

describe("farmer listing edit endpoint", () => {
  it("saves against the farm the LINK names", async () => {
    const save = saver();
    const response = await handleFarmerListingEditPost(
      deps(resolver(), save),
      post({ token: TOKEN, ...LISTING }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "saved" });
    expect(save).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        farmId: FARM_ID,
        standName: "Edited Stand",
        occurredAt: T0,
      }),
    );
  });

  it("passes the LINK's authorization to the writer, so the farmer gets a schedule", async () => {
    // F-081 — the writer seeds the default weekly reminder only when a door tells it who the
    // farmer is. The writer's own tests cannot see whether this door actually passes it, so a
    // door that quietly stopped would leave every editing farmer unscheduled with the writer
    // suite still green.
    const save = saver();
    await handleFarmerListingEditPost(
      deps(resolver(), save),
      post({ token: TOKEN, ...LISTING }),
    );

    expect(save).toHaveBeenCalledWith(
      {},
      // From the LINK's resolved authorization, never the request body.
      expect.objectContaining({ authorizationId: "auth-1" }),
    );
  });

  it("IGNORES a farm id in the request body", async () => {
    // The attack the invited path also refuses: a caller-supplied farm would let any farmer's
    // link overwrite any other farm's public listing.
    const save = saver();
    await handleFarmerListingEditPost(
      deps(resolver(), save),
      post({ token: TOKEN, ...LISTING, farmId: "22222222-2222-4222-8222-222222222222" }),
    );

    expect(save).toHaveBeenCalledWith({}, expect.objectContaining({ farmId: FARM_ID }));
  });

  // The farm's name is public on the map beside the stand and was previously immutable —
  // set when the invitation was created and changeable by nobody, farmer or administrator.
  describe("renaming the farm", () => {
    it("renames the farm the LINK names when a new name is sent", async () => {
      const rename = renamer();
      await handleFarmerListingEditPost(
        deps(resolver(), saver(), rename),
        post({ token: TOKEN, ...LISTING, farmName: "Misty Hollow Farm" }),
      );

      expect(rename).toHaveBeenCalledWith(
        {},
        { farmId: FARM_ID, name: "Misty Hollow Farm" },
      );
    });

    it("renames nothing when the request carries no farm name", async () => {
      // Every existing caller omits the field. Absence must mean "leave it alone", never
      // "rename it to empty" — the listing form posts a whole listing on every save.
      const rename = renamer();
      await handleFarmerListingEditPost(
        deps(resolver(), saver(), rename),
        post({ token: TOKEN, ...LISTING }),
      );

      expect(rename).not.toHaveBeenCalled();
    });

    it("renames the farm from the LINK even when the body names another", async () => {
      // The same attack the listing writer refuses: a caller-supplied farm id would let any
      // farmer's link rename any other farm.
      const rename = renamer();
      await handleFarmerListingEditPost(
        deps(resolver(), saver(), rename),
        post({
          token: TOKEN,
          ...LISTING,
          farmName: "Renamed",
          farmId: "22222222-2222-4222-8222-222222222222",
        }),
      );

      expect(rename).toHaveBeenCalledWith({}, expect.objectContaining({ farmId: FARM_ID }));
    });

    it("refuses a blank farm name rather than erasing it", async () => {
      const rename = renamer();
      const response = await handleFarmerListingEditPost(
        deps(resolver(), saver(), rename),
        post({ token: TOKEN, ...LISTING, farmName: "   " }),
      );

      expect(response.status).toBe(400);
      expect(rename).not.toHaveBeenCalled();
    });

    it("does not rename when the link is revoked", async () => {
      const rename = renamer();
      await handleFarmerListingEditPost(
        deps(resolver(null), saver(), rename),
        post({ token: TOKEN, ...LISTING, farmName: "Renamed" }),
      );

      expect(rename).not.toHaveBeenCalled();
    });
  });

  it("refuses a REVOKED or unknown link, and writes nothing", async () => {
    // `resolveFarmerLink` returns null for a revoked authorization as well as an unknown token,
    // so revocation is immediate here without this file restating the rule.
    const save = saver();
    const response = await handleFarmerListingEditPost(
      deps(resolver(null), save),
      post({ token: TOKEN, ...LISTING }),
    );

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({ error: "link_unavailable" });
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses a malformed token BEFORE touching the database", async () => {
    const resolve = resolver();
    const save = saver();
    const response = await handleFarmerListingEditPost(
      deps(resolve, save),
      post({ token: "not-a-token", ...LISTING }),
    );

    expect(response.status).toBe(400);
    expect(resolve).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("applies the SAME field validation as the other two doors", async () => {
    const save = saver();
    const response = await handleFarmerListingEditPost(
      deps(resolver(), save),
      post({ token: TOKEN, ...LISTING, visitability: undefined }),
    );

    expect(response.status).toBe(400);
    expect(save).not.toHaveBeenCalled();
  });

  it("KEEPS the address and pin on a contact-only stand (F-088)", async () => {
    const save = saver();
    await handleFarmerListingEditPost(
      deps(resolver(), save),
      post({ token: TOKEN, ...LISTING, visitability: "contact_only" }),
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

  it("stamps the SERVER's time, never a time from the request", async () => {
    const save = saver();
    await handleFarmerListingEditPost(
      deps(resolver(), save),
      post({ token: TOKEN, ...LISTING, occurredAt: new Date(0).toISOString() }),
    );

    expect(save).toHaveBeenCalledWith({}, expect.objectContaining({ occurredAt: T0 }));
  });

  it("reports a writer refusal to the farmer rather than as a save", async () => {
    const response = await handleFarmerListingEditPost(
      deps(resolver(), saver({ status: "incoherent_availability" })),
      post({ token: TOKEN, ...LISTING }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "incoherent_availability" });
  });

  it("refuses a blank stand name rather than silently renaming the stand", async () => {
    // The other two doors default a missing name to the farm's own. This one is CHANGING an
    // existing stand, so the same default would quietly rename it.
    const save = saver();
    for (const standName of [null, "", "   "]) {
      const response = await handleFarmerListingEditPost(
        deps(resolver(), save),
        post({ token: TOKEN, ...LISTING, standName }),
      );
      expect(response.status).toBe(400);
    }
    expect(save).not.toHaveBeenCalled();
  });

  it("refuses malformed JSON", async () => {
    const response = await handleFarmerListingEditPost(deps(), post("{"));
    expect(response.status).toBe(400);
  });
});
