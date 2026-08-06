import type { Clock } from "@farm-friend/core";
import {
  claimGrandfatheredFarm,
  saveOnboardingListing,
  type ClaimGrandfatheredFarmResult,
  type Db,
  type OnboardingListingInput,
  type SaveOnboardingListingResult,
} from "@farm-friend/db";
import { parseListingSubmission } from "./farmer-listing";

// F-072 — the HTTP boundary for a grandfathered farmer's listing.
//
// VIGA's Google weekly-status form is replaced by one global Farm Friend link with a farm
// dropdown. There is NO invitation behind it and no administrator in the loop: max chose the
// honour system (2026-08-06) because no phone roster exists to verify a claimant against —
// `contacts` holds people who have texted Farm Friend, not a record of who owns which farm.
//
// **So the credential is the farm selection itself, and this is the widest door in the system.**
// Everything that keeps it narrow lives here and in `claimGrandfatheredFarm`:
//
//   * The body NAMES a farm — it must, there is no token to name one. That inverts the invited
//     path's rule (`farmer-listing.ts` ignores a body `farmId` precisely because a token is
//     available). The protection that replaces it is that the named farm is RESOLVED and
//     RE-CHECKED server-side, and refused if anyone can already publish for it.
//   * The check runs on THIS request, not at page render. A farmer can onboard in the window
//     between the dropdown loading and this form being sent; the stale page must lose.
//   * Nothing here grants authority. This writes listing facts only — publishing inventory
//     still requires a `farmer_authorizations` row, which still requires a handset (SIGNUP).
//     The honour system therefore buys a listing, never the ability to speak as the farm.
//
// The field rules are `parseListingSubmission`'s and are SHARED with the invited path rather
// than restated, so both doors publish the same shape onto the same map.

/** A farm id must be a UUID before any database work — a malformed one is a bad request. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface GrandfatheredListingDeps {
  db: Db;
  clock: Clock;
  /** Injected so the boundary's contract is testable without a database. */
  claimFarm: (
    db: Db,
    input: { farmId: string },
  ) => Promise<ClaimGrandfatheredFarmResult>;
  saveListing: (
    db: Db,
    input: {
      farmId: string;
      standName: string;
      listing: OnboardingListingInput;
      occurredAt: Date;
    },
  ) => Promise<SaveOnboardingListingResult>;
}

/**
 * Publish the listing a grandfathered farmer typed, for the farm they picked.
 *
 * Publishes on submit, silently — no VIGA notification and no admin queue entry (max,
 * 2026-08-06), matching the invited form rather than introducing a second pattern. An
 * administrator can correct a bad listing through the existing stand-data surface.
 */
export async function handleGrandfatheredListingPost(
  deps: GrandfatheredListingDeps,
  request: Request,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const farmId = body.farmId;
  if (typeof farmId !== "string" || !UUID_RE.test(farmId)) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const submission = parseListingSubmission(body);
  if (submission === null) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  // The guarantee. Resolved now, on this request, so a page rendered before the farm was
  // claimed cannot write to it.
  const claim = await deps.claimFarm(deps.db, { farmId });
  if (claim.status === "unknown_farm") {
    return Response.json({ error: "unknown_farm" }, { status: 404 });
  }
  if (claim.status !== "claimable") {
    return Response.json({ error: "already_onboarded" }, { status: 409 });
  }

  const result = await deps.saveListing(deps.db, {
    farmId: claim.farmId,
    // The farm's own name, from the RESOLVED farm rather than the request: the body may say
    // which farm, never what that farm is called on the public map.
    standName: submission.standName ?? claim.farmName,
    listing: submission.listing,
    occurredAt: deps.clock.now(),
  });

  if (result.status === "saved") return Response.json({ status: "saved" });
  const status = result.status === "unknown_farm" ? 404 : 400;
  return Response.json({ error: result.status }, { status });
}

/** The production wiring: the real claim resolver and writer behind the boundary above. */
export function grandfatheredListingDeps(context: {
  db: Db;
  clock: Clock;
}): GrandfatheredListingDeps {
  return {
    db: context.db,
    clock: context.clock,
    claimFarm: claimGrandfatheredFarm,
    saveListing: saveOnboardingListing,
  };
}
