import { describe, expect, it, vi } from "vitest";
import { FixedClock } from "@farm-friend/core";
import type { Db } from "@farm-friend/db";
import {
  handleFarmerOnboardingAgreementPost,
  type FarmerOnboardingDeps,
} from "./farmer-onboarding";

// The HTTP boundary for the one thing the onboarding page writes: that the farmer accepted
// the SMS agreement shown on it.
//
// The rule this boundary exists to hold is that it CANNOT be a consent write. Anyone who
// has the link can reach it, so a tick here proves only that someone with the link ticked;
// the consent record is written later, when a `SIGNUP <token>` arrives from a handset. The
// durable half of that lives in `packages/db/src/farmer-onboarding-consent.integration.test.ts`
// against real Postgres. These tests own the request contract: what shapes are refused,
// what the answer discloses, and that the write is reached with the clock's time and never
// with anything from the request body.

const T0 = new Date(Date.now() - 60 * 60 * 1000);
const TOKEN = "a".repeat(64);

function post(body: unknown): Request {
  return new Request("https://farmfriend.example/api/farmer/onboarding", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

type Recorder = FarmerOnboardingDeps["recordAgreement"];

function recorder(status: "agreed" | "invalid") {
  return vi.fn<Parameters<Recorder>, ReturnType<Recorder>>(async () => ({ status }));
}

function deps(recordAgreement: Recorder): FarmerOnboardingDeps {
  return { db: {} as Db, clock: new FixedClock(T0), recordAgreement };
}

describe("farmer onboarding agreement endpoint", () => {
  it("records the agreement and answers 200", async () => {
    const record = recorder("agreed");
    const response = await handleFarmerOnboardingAgreementPost(
      deps(record),
      post({ token: TOKEN }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "agreed" });
    expect(record).toHaveBeenCalledWith({}, { token: TOKEN, occurredAt: T0 });
  });

  it("stamps the SERVER's time, never a time from the request", async () => {
    // The stamp is consent provenance. A caller-supplied instant would let anyone with the
    // link backdate the moment the agreement was shown.
    const record = recorder("agreed");
    await handleFarmerOnboardingAgreementPost(
      deps(record),
      post({ token: TOKEN, occurredAt: new Date(0).toISOString() }),
    );

    expect(record).toHaveBeenCalledWith({}, { token: TOKEN, occurredAt: T0 });
  });

  it("refuses a token that is not 64 hex characters WITHOUT touching the database", async () => {
    // Shape-checked before any DB work, exactly as `resolveStandFromToken` is. An endpoint
    // that queried on arbitrary input would answer differently for a malformed token than
    // for a wrong one, which is a probe.
    const record = recorder("agreed");
    for (const token of ["", "nope", "A".repeat(64), "a".repeat(63), "a".repeat(65)]) {
      const response = await handleFarmerOnboardingAgreementPost(
        deps(record),
        post({ token }),
      );
      expect(response.status, token).toBe(400);
    }
    expect(record).not.toHaveBeenCalled();
  });

  it("refuses a missing or non-string token", async () => {
    const record = recorder("agreed");
    for (const body of [{}, { token: 7 }, { token: null }, { token: [TOKEN] }]) {
      const response = await handleFarmerOnboardingAgreementPost(deps(record), post(body));
      expect(response.status).toBe(400);
    }
    expect(record).not.toHaveBeenCalled();
  });

  it("refuses a body that is not JSON", async () => {
    const record = recorder("agreed");
    const response = await handleFarmerOnboardingAgreementPost(
      deps(record),
      post("{not json"),
    );

    expect(response.status).toBe(400);
    expect(record).not.toHaveBeenCalled();
  });

  it("answers an expired or redeemed invitation with the same uniform refusal", async () => {
    // Non-disclosure: this endpoint must not become an oracle telling a stranger with a
    // guessed token whether an invitation exists, is spent, or has expired. The page
    // already renders one uniform "no longer available" for all three.
    const record = recorder("invalid");
    const response = await handleFarmerOnboardingAgreementPost(
      deps(record),
      post({ token: TOKEN }),
    );

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({ error: "invitation_unavailable" });
  });

  it("never echoes the token back in its answer", async () => {
    // The token is the whole credential. An error body repeating it puts it into logs and
    // browser history entries that the URL alone would not.
    const record = recorder("invalid");
    const response = await handleFarmerOnboardingAgreementPost(
      deps(record),
      post({ token: TOKEN }),
    );

    expect(await response.text()).not.toContain(TOKEN);
  });
});
