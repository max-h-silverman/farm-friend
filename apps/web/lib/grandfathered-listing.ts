import { hashPhone, normalizePhone, type Clock } from "@farm-friend/core";
import {
  claimGrandfatheredFarm,
  recordSelfIssuedFarmerClaim,
  saveOnboardingListing,
  type ClaimGrandfatheredFarmResult,
  type Db,
  type PendingStockEntry,
  type SaveOnboardingListingInput,
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
//     still requires a `farmer_authorizations` row, which still requires a handset. The honour
//     system therefore buys a listing, never the ability to speak as the farm.
//
//     **The handset proof is a bare `START`, not `JOIN <token>`** (corrected 2026-08-09). That
//     grammar was removed 2026-08-07 and this line went on naming it for two days — the exact
//     shape of stale claim CLAUDE.md warns about, and it hid a real regression: with `JOIN`
//     gone and no phone field on this door, its farmer had NO route to authorization at all.
//     The phone stated on the form is now recorded as a self-issued claim (F-098), and the
//     farmer's own inbound START is matched against it.
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
    input: SaveOnboardingListingInput,
  ) => Promise<SaveOnboardingListingResult>;
  /**
   * Record the handset this farmer will text START from, as a SELF-ISSUED claim (F-098).
   *
   * Optional so a deployment that has not wired it still publishes listings — the phone is how
   * a farmer reaches SMS, never a condition of appearing on the map.
   *
   * **Not consent and not a grant.** It records which handset to expect, exactly as the invited
   * door's `recordPendingPhone` does; the inbound START is still the possession proof and the
   * opt-in, through the same consent writer every other opt-in uses.
   */
  recordSelfIssuedClaim?: (
    db: Db,
    input: {
      farmId: string;
      phone: string;
      agreedToSms: boolean;
      pendingStock?: PendingStockEntry[];
      occurredAt: Date;
    },
  ) => Promise<{ status: "recorded" } | { status: "invalid" }>;
  /** The HMAC salt the phone hash is built under (Golden Rule #5). */
  phoneSalt?: string;
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

  /*
    THE PHONE, validated and claimed BEFORE the listing is published (F-098).

    Ordered this way deliberately: a listing published behind a phone that failed would put a
    farmer on the map with no way to ever update it — the same dead end the `JOIN <token>`
    removal left this door in. The invited path validates its phone ahead of its save for the
    identical reason.

    Absent phone is not an error. A farmer who wants only a listing gets one, and can text LINK
    later; what must not happen is a stated phone silently going nowhere.
  */
  const rawPhone = body.phone;
  if (rawPhone !== undefined && rawPhone !== null && rawPhone !== "") {
    if (typeof rawPhone !== "string") {
      return Response.json({ error: "invalid_phone" }, { status: 400 });
    }
    // The tick is the consent and it GATES the claim. Recording a handset the farmer did not
    // agree to would let their next START authorize a farm they never opted into.
    if (body.agreedToSms !== true) {
      return Response.json({ error: "sms_agreement_required" }, { status: 400 });
    }
    if (deps.recordSelfIssuedClaim !== undefined) {
      const claimed = await deps.recordSelfIssuedClaim(deps.db, {
        farmId: claim.farmId,
        // RAW, for the writer to normalize and hash — Golden Rule #5 keeps that in one place.
        phone: rawPhone,
        agreedToSms: true,
        ...(submission.currentStock === null ? {} : { pendingStock: submission.currentStock }),
        occurredAt: deps.clock.now(),
      });
      if (claimed.status === "invalid") {
        // Actionable, and shown against the field — unlike this door's uniform refusals, which
        // must not disclose anything about a farm.
        return Response.json({ error: "invalid_phone" }, { status: 400 });
      }
    }
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
  /** Injected so the salt read is testable without touching the process environment. */
  env?: NodeJS.ProcessEnv;
}): GrandfatheredListingDeps {
  return {
    db: context.db,
    clock: context.clock,
    claimFarm: claimGrandfatheredFarm,
    saveListing: saveOnboardingListing,
    /*
      The phone is normalized and hashed HERE, where the salt is injected — never inside the
      database layer, which must not read configuration (Golden Rule #5: raw E.164 in exactly
      one column, the hash as the only lookup key).
    */
    recordSelfIssuedClaim: async (db, input) => {
      const salt = (context.env ?? process.env).PHONE_HASH_SALT?.trim();
      if (salt === undefined || salt === "") return { status: "invalid" };
      let phoneE164: string;
      let phoneHash: string;
      try {
        phoneE164 = normalizePhone(input.phone);
        phoneHash = hashPhone(input.phone, salt);
      } catch {
        return { status: "invalid" };
      }
      return recordSelfIssuedFarmerClaim(db, {
        farmId: input.farmId,
        phoneE164,
        phoneHash,
        agreedToSms: input.agreedToSms,
        ...(input.pendingStock === undefined ? {} : { pendingStock: input.pendingStock }),
        occurredAt: input.occurredAt,
      });
    },
  };
}
