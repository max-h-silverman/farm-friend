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

type PhoneRecorder = NonNullable<FarmerListingDeps["recordPendingPhone"]>;

/**
 * The pending-phone writer, stubbed.
 *
 * Injected like the other two so the boundary's contract — what it normalizes, what it refuses,
 * and what it hands the writer — is provable without a database.
 */
function phoneRecorder(
  result: Awaited<ReturnType<PhoneRecorder>> = { status: "recorded" },
) {
  return vi.fn<Parameters<PhoneRecorder>, ReturnType<PhoneRecorder>>(async () => result);
}

function deps(
  loadInvitation = loader(),
  saveListing = saver(),
  recordPendingPhone = phoneRecorder(),
): FarmerListingDeps {
  return {
    db: {} as Db,
    clock: new FixedClock(T0),
    phoneSalt: "test-salt",
    loadInvitation,
    saveListing,
    recordPendingPhone,
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

  it("KEEPS the address and pin on a contact-only stand (F-088)", async () => {
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

  // ── F-069: the structured availability fields ─────────────────────────────────────────
  //
  // These reach five CHECK constraints. The boundary's job is to refuse a MALFORMED request —
  // a bad enum value, a non-integer month, a weekday of 9 — before it becomes either a
  // constraint violation or, worse, a coerced value the farmer never stated.

  // ── F-088: hiding the ADDRESS without hiding the stand ────────────────────────────────
  //
  // Some Vashon stands sit at the farmer's home. The farmer wants customers to find the
  // stand and does not want their street address printed. Until F-088 the only way to
  // suppress the address was `contact_only`, which also removes the pin and tells customers
  // there is nowhere to go — a different and wrong claim.
  //
  // The flag governs DISPLAY only. The address is still stored and still required for a
  // visitable stand, so `coherentVisitability` is untouched.
  describe("F-088 address visibility", () => {
    it("carries the farmer's choice to hide their address through to the writer", async () => {
      const save = saver();
      await handleFarmerListingPost(
        deps(loader(), save),
        post({ token: TOKEN, ...LISTING, addressPublic: false }),
      );

      expect(save).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          listing: expect.objectContaining({
            // The address is still STORED — hiding is a display decision, and the database
            // still requires an address for a visitable stand.
            publicAddress: "12345 Vashon Highway SW",
            addressPublic: false,
          }),
        }),
      );
    });

    it("defaults to PUBLIC when the field is absent", async () => {
      // Every door that predates this field posts nothing for it, and every row that existed
      // before the column held an address a farmer typed into a public listing form. The
      // default must match that, or deploying this would hide every address on the island.
      const save = saver();
      await handleFarmerListingPost(
        deps(loader(), save),
        post({ token: TOKEN, ...LISTING }),
      );

      expect(save).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          listing: expect.objectContaining({ addressPublic: true }),
        }),
      );
    });

    it("treats a NON-BOOLEAN as public rather than trusting it", async () => {
      // The parse must not be truthiness. `"false"` is a truthy string and `0` is falsy, so a
      // coerced read would hide addresses on some malformed bodies and publish them on others
      // — and the direction that leaks is the one that matters. Only a real `false` hides.
      for (const value of ["false", 0, null, "no"]) {
        const save = saver();
        await handleFarmerListingPost(
          deps(loader(), save),
          post({ token: TOKEN, ...LISTING, addressPublic: value }),
        );

        expect(save).toHaveBeenCalledWith(
          {},
          expect.objectContaining({
            listing: expect.objectContaining({ addressPublic: true }),
          }),
        );
      }
    });
  });

  describe("F-069 structured availability", () => {
    const AVAILABILITY = {
      seasonKind: "date_range",
      seasonStartMonth: 3,
      seasonStartDay: 1,
      seasonEndMonth: 11,
      seasonEndDay: 30,
      openHoursKind: "dawn_to_dusk",
      openDays: [0, 1, 2, 3, 4, 5, 6],
      stockingCadence: "specific_days",
      stockingDays: [3, 6],
    };

    it("passes a fully stated availability through to the writer", async () => {
      const save = saver();
      const response = await handleFarmerListingPost(
        deps(loader(), save),
        post({ token: TOKEN, ...LISTING, ...AVAILABILITY }),
      );

      expect(response.status).toBe(200);
      expect(save).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          listing: expect.objectContaining({
            availability: {
              seasonKind: "date_range",
              seasonStartMonth: 3,
              seasonStartDay: 1,
              seasonEndMonth: 11,
              seasonEndDay: 30,
              seasonNames: null,
              openHoursKind: "dawn_to_dusk",
              openFromMinutes: null,
              openUntilMinutes: null,
              openDays: [0, 1, 2, 3, 4, 5, 6],
              stockingCadence: "specific_days",
              stockingDays: [3, 6],
            },
          }),
        }),
      );
    });

    it("passes ALL-NULL availability when the farmer states none", async () => {
      // A form that asks nothing about season must still produce a writable value rather than
      // leaving the field undefined for the writer to guess at.
      const save = saver();
      const response = await handleFarmerListingPost(
        deps(loader(), save),
        post({ token: TOKEN, ...LISTING }),
      );

      expect(response.status).toBe(200);
      const passed = save.mock.calls[0]![1].listing.availability;
      expect(passed).toEqual({
        seasonKind: null,
        seasonStartMonth: null,
        seasonStartDay: null,
        seasonEndMonth: null,
        seasonEndDay: null,
        seasonNames: null,
        openHoursKind: null,
        openFromMinutes: null,
        openUntilMinutes: null,
        openDays: null,
        stockingCadence: null,
        stockingDays: null,
      });
    });

    it("refuses an unknown enum value rather than storing it", async () => {
      for (const bad of [
        { seasonKind: "whenever" },
        { openHoursKind: "sunrise_ish" },
        { stockingCadence: "sometimes", stockingDays: [1] },
      ]) {
        const save = saver();
        const response = await handleFarmerListingPost(
          deps(loader(), save),
          post({ token: TOKEN, ...LISTING, ...bad }),
        );
        expect(response.status).toBe(400);
        expect(save).not.toHaveBeenCalled();
      }
    });

    it("refuses a non-integer month, day, or minute rather than COERCING it", async () => {
      // `Number("3")` is 3 and `Number(null)` is 0 — coercion here would turn a malformed or
      // absent value into a confident one. A string month must be refused, not parsed.
      for (const bad of [
        { seasonKind: "date_range", seasonStartMonth: "3", seasonStartDay: 1, seasonEndMonth: 11, seasonEndDay: 30 },
        { seasonKind: "date_range", seasonStartMonth: 3.5, seasonStartDay: 1, seasonEndMonth: 11, seasonEndDay: 30 },
        { openHoursKind: "clock_range", openFromMinutes: "480", openUntilMinutes: 1080 },
        { openHoursKind: "clock_range", openFromMinutes: 480.5, openUntilMinutes: 1080 },
      ]) {
        const save = saver();
        const response = await handleFarmerListingPost(
          deps(loader(), save),
          post({ token: TOKEN, ...LISTING, ...bad }),
        );
        expect(response.status).toBe(400);
        expect(save).not.toHaveBeenCalled();
      }
    });

    it("refuses an out-of-range month, day, minute, or weekday", async () => {
      for (const bad of [
        { seasonKind: "date_range", seasonStartMonth: 13, seasonStartDay: 1, seasonEndMonth: 11, seasonEndDay: 30 },
        { seasonKind: "date_range", seasonStartMonth: 3, seasonStartDay: 32, seasonEndMonth: 11, seasonEndDay: 30 },
        { openHoursKind: "clock_range", openFromMinutes: 480, openUntilMinutes: 1440 },
        { openHoursKind: "clock_range", openFromMinutes: -1, openUntilMinutes: 1080 },
        { openDays: [9] },
        { stockingCadence: "specific_days", stockingDays: [-1] },
      ]) {
        const save = saver();
        const response = await handleFarmerListingPost(
          deps(loader(), save),
          post({ token: TOKEN, ...LISTING, ...bad }),
        );
        expect(response.status).toBe(400);
        expect(save).not.toHaveBeenCalled();
      }
    });

    it("accepts minute 0 as a real opening time", async () => {
      // Midnight. A truthiness check anywhere on this path reads 0 as absent and the
      // `clock_range` constraint then refuses the row.
      const save = saver();
      const response = await handleFarmerListingPost(
        deps(loader(), save),
        post({
          token: TOKEN,
          ...LISTING,
          openHoursKind: "clock_range",
          openFromMinutes: 0,
          openUntilMinutes: 720,
        }),
      );

      expect(response.status).toBe(200);
      const passed = save.mock.calls[0]![1].listing.availability!;
      expect(passed.openFromMinutes).toBe(0);
      expect(passed.openUntilMinutes).toBe(720);
    });

    it("refuses a day array that is not an array of numbers", async () => {
      for (const bad of [
        { openDays: "everyday" },
        { openDays: [1, "2"] },
        { stockingCadence: "specific_days", stockingDays: { 0: 1 } },
      ]) {
        const save = saver();
        const response = await handleFarmerListingPost(
          deps(loader(), save),
          post({ token: TOKEN, ...LISTING, ...bad }),
        );
        expect(response.status).toBe(400);
        expect(save).not.toHaveBeenCalled();
      }
    });

    it("STRIPS detail that does not belong to the stated kind", async () => {
      // A farmer who typed dates, then switched their answer to "year-round", is the ordinary
      // case. The stale dates must not travel: `coherentSeason` refuses `year_round` carrying
      // them, and the farmer would get a refusal for a field the form no longer shows.
      const save = saver();
      const response = await handleFarmerListingPost(
        deps(loader(), save),
        post({
          token: TOKEN,
          ...LISTING,
          seasonKind: "year_round",
          seasonStartMonth: 3,
          seasonStartDay: 1,
          seasonEndMonth: 11,
          seasonEndDay: 30,
          seasonNames: ["summer"],
          openHoursKind: "dawn_to_dusk",
          openFromMinutes: 480,
          openUntilMinutes: 1080,
          stockingCadence: "daily",
          stockingDays: [3],
        }),
      );

      expect(response.status).toBe(200);
      const passed = save.mock.calls[0]![1].listing.availability!;
      expect(passed.seasonKind).toBe("year_round");
      expect(passed.seasonStartMonth).toBeNull();
      expect(passed.seasonStartDay).toBeNull();
      expect(passed.seasonEndMonth).toBeNull();
      expect(passed.seasonEndDay).toBeNull();
      expect(passed.seasonNames).toBeNull();
      expect(passed.openHoursKind).toBe("dawn_to_dusk");
      expect(passed.openFromMinutes).toBeNull();
      expect(passed.openUntilMinutes).toBeNull();
      expect(passed.stockingCadence).toBe("daily");
      expect(passed.stockingDays).toBeNull();
    });

    it("STRIPS day and date detail when no kind is stated at all", async () => {
      const save = saver();
      const response = await handleFarmerListingPost(
        deps(loader(), save),
        post({
          token: TOKEN,
          ...LISTING,
          seasonStartMonth: 3,
          seasonStartDay: 1,
          openFromMinutes: 480,
          stockingDays: [3],
        }),
      );

      expect(response.status).toBe(200);
      const passed = save.mock.calls[0]![1].listing.availability!;
      expect(passed.seasonStartMonth).toBeNull();
      expect(passed.openFromMinutes).toBeNull();
      expect(passed.stockingDays).toBeNull();
    });

    it("reports incoherent availability as something the farmer can fix", async () => {
      // The writer's refusal must reach the browser as a named error, not a 500.
      const response = await handleFarmerListingPost(
        deps(loader(), saver({ status: "incoherent_availability" })),
        post({ token: TOKEN, ...LISTING }),
      );

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: "incoherent_availability",
      });
    });

    it("passes named_season with only BLANK names on as the farmer's own incoherence", async () => {
      // An empty list must not be quietly normalized to "not stated" — the farmer chose
      // "named season" and typed nothing, and they need to hear that rather than having their
      // season silently dropped. It reaches the writer as `[]`, which `coherentAvailability`
      // refuses, so the answer is `incoherent_availability` and not a save.
      const save = saver();
      await handleFarmerListingPost(
        deps(loader(), save),
        post({
          token: TOKEN,
          ...LISTING,
          seasonKind: "named_season",
          seasonNames: ["  ", ""],
        }),
      );

      expect(save).toHaveBeenCalled();
      expect(save.mock.calls[0]![1].listing.availability!.seasonNames).toEqual([]);
    });

    it("caps how many season names one submission can write", async () => {
      const save = saver();
      const response = await handleFarmerListingPost(
        deps(loader(), save),
        post({
          token: TOKEN,
          ...LISTING,
          seasonKind: "named_season",
          seasonNames: Array.from({ length: 300 }, (_, index) => `season ${index}`),
        }),
      );

      expect(response.status).toBe(400);
      expect(save).not.toHaveBeenCalled();
    });
  });
  // ── The phone that completes onboarding (max 2026-08-07) ─────────────────────────────────
  //
  // `JOIN <token>` is gone: it asked the farmer to hand-copy 64 hex characters into a text
  // message, and every transcription slip failed identically and silently. The farm identity
  // moved here — the farmer states the phone they will text from, and a later bare `START`
  // from it completes their setup.
  //
  // **This is not consent and grants nothing.** It records which handset to expect. Consent is
  // still written only when their own message arrives, because a number typed into a web form
  // proves nothing about who holds the phone.
  describe("the phone a farmer will text from", () => {
    it("NORMALIZES the number and stores it with its hash", async () => {
      // A farmer types whatever their thumbs produce. E.164 is what the column requires and
      // what the send path can dial, so normalization happens at the boundary — never in the
      // database, and never in the browser where it could be bypassed.
      const recordPhone = phoneRecorder();
      const response = await handleFarmerListingPost(
        deps(loader(), saver(), recordPhone),
        post({ token: TOKEN, ...LISTING, phone: "(206) 555-0143" }),
      );

      expect(response.status).toBe(200);
      expect(recordPhone).toHaveBeenCalledWith(
        {},
        expect.objectContaining({
          token: TOKEN,
          phoneE164: "+12065550143",
          occurredAt: T0,
        }),
      );
      // The hash is a digest, and it is NOT the raw number under another name.
      const stored = recordPhone.mock.calls[0]?.[1] as { phoneHash: string };
      expect(stored.phoneHash).toMatch(/^[0-9a-f]{64}$/);
      expect(stored.phoneHash).not.toContain("2065550143");
    });

    it("REFUSES a number that is not a real US phone, saving nothing at all", async () => {
      // The listing and the phone commit together. A farmer who mistyped their number must not
      // end up with a published listing and no way to finish, so this refuses the whole
      // request rather than saving the listing and dropping the phone.
      for (const bad of ["555", "not a phone", "+44 20 7946 0958"]) {
        const save = saver();
        const recordPhone = phoneRecorder();
        const response = await handleFarmerListingPost(
          deps(loader(), save, recordPhone),
          post({ token: TOKEN, ...LISTING, phone: bad }),
        );

        expect(response.status, bad).toBe(400);
        await expect(response.json()).resolves.toEqual({ error: "invalid_phone" });
        expect(save, bad).not.toHaveBeenCalled();
        expect(recordPhone, bad).not.toHaveBeenCalled();
      }
    });

    it("saves the listing when no phone is given, recording none", async () => {
      // The edit and grandfathered doors send no phone, and an invited farmer who somehow
      // submits without one must still get their listing. Absent is not invalid.
      const save = saver();
      const recordPhone = phoneRecorder();
      const response = await handleFarmerListingPost(
        deps(loader(), save, recordPhone),
        post({ token: TOKEN, ...LISTING }),
      );

      expect(response.status).toBe(200);
      expect(save).toHaveBeenCalled();
      expect(recordPhone).not.toHaveBeenCalled();
    });

    it("never puts the raw number in the RESPONSE", async () => {
      // Golden Rule #5. The raw number lives in one column read by the send path; echoing it
      // back would make this endpoint a second place it exists.
      const response = await handleFarmerListingPost(
        deps(loader(), saver(), phoneRecorder()),
        post({ token: TOKEN, ...LISTING, phone: "206-555-0143" }),
      );

      expect(await response.text()).not.toContain("2065550143");
    });
  });
});
