import { describe, expect, it, vi } from "vitest";
import { FixedClock, createPublicActionThrottle, hashPhone } from "@farm-friend/core";
import type { Db } from "@farm-friend/db";
import {
  handleFarmerLinkRequestPost,
  type FarmerLinkRequestDeps,
} from "./farmer-link-request";

// F-073 — the HTTP boundary for "text me my update link".
//
// An already-onboarded farmer reaches this from the public picker. It is unauthenticated, it
// takes a phone number, and it causes an outbound text — which is three reasons to be strict:
//
//   * IT IS NOT AN ORACLE. A match and a miss get the SAME response. A page that answered
//     differently would let anyone ask whether a given number belongs to a farmer, one number
//     at a time, about the whole island.
//   * THE NUMBER IS HASHED AT THE BOUNDARY and never travels further. The raw string reaches
//     `hashPhone` and nothing else — not the writer, not a log, not the response.
//   * THE THROTTLE FRONTS IT. It sends SMS, which costs money and reaches a real handset, so
//     an unrationed endpoint is both a bill and a way to harass a farmer.

const T0 = new Date("2026-08-06T17:00:00Z");
const FARM_ID = "11111111-1111-4111-8111-111111111111";
const SALT = "test-salt";
const PHONE = "(206) 555-0143";

function post(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://farmfriend.example/api/farmer/link-request", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

type Requester = FarmerLinkRequestDeps["requestLink"];

function requester() {
  return vi.fn<Parameters<Requester>, ReturnType<Requester>>(async () => ({
    status: "accepted" as const,
  }));
}

function deps(
  requestLink = requester(),
  throttle = createPublicActionThrottle({
    clock: new FixedClock(T0),
    limit: 10,
    windowMs: 60_000,
  }),
): FarmerLinkRequestDeps {
  return {
    db: {} as Db,
    clock: new FixedClock(T0),
    requestLink,
    throttle,
    phoneSalt: SALT,
    clientSignalSalt: "signal-salt",
    publicBaseUrl: "https://farmfriend.example",
  };
}

describe("farmer link request endpoint", () => {
  it("hashes the phone and asks for a link against the named farm", async () => {
    const request = requester();
    const response = await handleFarmerLinkRequestPost(
      deps(request),
      post({ farmId: FARM_ID, phone: PHONE }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "accepted" });
    expect(request).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        farmId: FARM_ID,
        contactHash: hashPhone(PHONE, SALT),
        occurredAt: T0,
      }),
    );
  });

  it("NEVER passes the raw phone number past the hash", async () => {
    // The privacy boundary (Golden Rule #5): the raw string reaches `hashPhone` and stops.
    const request = requester();
    await handleFarmerLinkRequestPost(deps(request), post({ farmId: FARM_ID, phone: PHONE }));

    const passed = JSON.stringify(request.mock.calls[0]?.[1]);
    expect(passed).not.toContain("555");
    expect(passed).not.toContain("2065550143");
    expect(passed).toContain(hashPhone(PHONE, SALT));
  });

  it("normalizes the number, so formatting does not decide whether it matches", async () => {
    // A farmer typing "206-555-0143" and "(206) 555-0143" is the same farmer.
    const request = requester();
    for (const written of ["206-555-0143", "(206) 555-0143", "+1 206 555 0143"]) {
      await handleFarmerLinkRequestPost(deps(request), post({ farmId: FARM_ID, phone: written }));
    }

    const hashes = request.mock.calls.map((call) => call[1].contactHash);
    expect(new Set(hashes).size).toBe(1);
    expect(hashes[0]).toBe(hashPhone(PHONE, SALT));
  });

  it("answers a number that is NOT a farmer identically", async () => {
    // The writer already answers `accepted` either way; this proves the boundary does not
    // reintroduce a difference by, say, reporting how many messages were queued.
    const response = await handleFarmerLinkRequestPost(
      deps(),
      post({ farmId: FARM_ID, phone: PHONE }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(["status"]);
    expect(body.status).toBe("accepted");
  });

  it("refuses a number that is not a phone number, without calling the writer", async () => {
    const request = requester();
    const response = await handleFarmerLinkRequestPost(
      deps(request),
      post({ farmId: FARM_ID, phone: "hello" }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_request" });
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses a malformed farm id, without calling the writer", async () => {
    const request = requester();
    const response = await handleFarmerLinkRequestPost(
      deps(request),
      post({ farmId: "not-a-uuid", phone: PHONE }),
    );

    expect(response.status).toBe(400);
    expect(request).not.toHaveBeenCalled();
  });

  it("refuses a missing farm id or phone", async () => {
    expect(
      (await handleFarmerLinkRequestPost(deps(), post({ phone: PHONE }))).status,
    ).toBe(400);
    expect(
      (await handleFarmerLinkRequestPost(deps(), post({ farmId: FARM_ID }))).status,
    ).toBe(400);
    expect((await handleFarmerLinkRequestPost(deps(), post("{"))).status).toBe(400);
  });

  it("refuses an oversized phone field before hashing it", async () => {
    const request = requester();
    const response = await handleFarmerLinkRequestPost(
      deps(request),
      post({ farmId: FARM_ID, phone: "2".repeat(5000) }),
    );

    expect(response.status).toBe(400);
    expect(request).not.toHaveBeenCalled();
  });

  it("THROTTLES, because each accepted request sends a real text", async () => {
    const request = requester();
    const throttle = createPublicActionThrottle({
      clock: new FixedClock(T0),
      limit: 2,
      windowMs: 60_000,
    });
    const results = [];
    for (const _ of [1, 2, 3]) {
      results.push(
        await handleFarmerLinkRequestPost(
          deps(request, throttle),
          post({ farmId: FARM_ID, phone: PHONE }),
        ),
      );
    }

    expect(results.map((response) => response.status)).toEqual([200, 200, 429]);
    expect(request).toHaveBeenCalledTimes(2);
    expect(results[2]?.headers.get("retry-after")).not.toBeNull();
  });

  it("throttles BEFORE the writer, so a refused request sends nothing", async () => {
    const request = requester();
    const throttle = createPublicActionThrottle({
      clock: new FixedClock(T0),
      limit: 1,
      windowMs: 60_000,
    });
    // Spend the budget, then confirm the refused request never reaches the writer — asserted
    // by call count rather than by the response alone, since a 429 returned AFTER a send would
    // look identical from outside while still having texted someone.
    await handleFarmerLinkRequestPost(
      deps(request, throttle),
      post({ farmId: FARM_ID, phone: PHONE }),
    );
    const response = await handleFarmerLinkRequestPost(
      deps(request, throttle),
      post({ farmId: FARM_ID, phone: PHONE }),
    );

    expect(response.status).toBe(429);
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("stamps the SERVER's time, never a time from the request", async () => {
    const request = requester();
    await handleFarmerLinkRequestPost(
      deps(request),
      post({ farmId: FARM_ID, phone: PHONE, occurredAt: new Date(0).toISOString() }),
    );

    expect(request).toHaveBeenCalledWith({}, expect.objectContaining({ occurredAt: T0 }));
  });

  it("uses the CONFIGURED base url, never one from the request", async () => {
    // The link is a credential. Taking its host from the request would let a caller mint a
    // link pointing at a site they control and have Farm Friend text it to a real farmer.
    const request = requester();
    await handleFarmerLinkRequestPost(
      deps(request),
      post({ farmId: FARM_ID, phone: PHONE, publicBaseUrl: "https://evil.example" }),
    );

    expect(request).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ publicBaseUrl: "https://farmfriend.example" }),
    );
  });
});
