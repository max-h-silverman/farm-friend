import { hashFarmerLinkToken, type Clock } from "@farm-friend/core";
import {
  renameFarm,
  resolveFarmerLink,
  saveOnboardingListing,
  type Db,
  type OnboardingListingInput,
  type RenameFarmResult,
  type ResolvedFarmerLink,
  type SaveOnboardingListingResult,
} from "@farm-friend/db";
import { parseListingSubmission } from "./farmer-listing";

// F-073 — the HTTP boundary for an ALREADY-ONBOARDED farmer editing their listing.
//
// **This closes a real gap rather than adding a convenience.** Listing facts were frozen for
// everyone except a farmer mid-onboarding: the F-067/F-069 form is bound to a one-use invitation
// token, so once a farmer was set up, hours, address, payment methods and what they usually sell
// could be changed by nobody — not the farmer, and only by hand in admin.
//
// It is the THIRD credential onto one writer, and adds no new rules of its own:
//
//   * The STAND LINK names the farm, so a `farmId` in the body is ignored — the same refusal the
//     invited path makes, for the same reason.
//   * Revocation is immediate and INHERITED: `resolveFarmerLink` re-reads the authorization on
//     every request, so a revoked farmer's link resolves to nothing here without this file
//     restating the rule.
//   * It writes LISTING facts only. No inventory revision — "I usually sell eggs" is a standing
//     claim, and "eggs are on the table today" is a dated one (F-066), and this door may only
//     make the first.
//
// What it deliberately CANNOT change is unchanged: Farm Bucks is a VIGA eligibility fact with
// its own admin workflow, and a farmer may not grant themselves eligibility from a form.

/** The one shape a 64-hex credential may take, checked before any database work. */
const LINK_TOKEN_RE = /^[0-9a-f]{64}$/;

export interface FarmerListingEditDeps {
  db: Db;
  clock: Clock;
  /** Injected so the boundary's contract is testable without a database. */
  resolveLink: (
    db: Db,
    input: { tokenHash: string },
  ) => Promise<ResolvedFarmerLink | null>;
  saveListing: (
    db: Db,
    input: {
      farmId: string;
      standName: string;
      listing: OnboardingListingInput;
      occurredAt: Date;
    },
  ) => Promise<SaveOnboardingListingResult>;
  renameFarm: (
    db: Db,
    input: { farmId: string; name: string },
  ) => Promise<RenameFarmResult>;
}

/**
 * Save the listing an onboarded farmer edited.
 *
 * An unknown, revoked, or expired link gets one uniform refusal, so this cannot be used to learn
 * whether a guessed token names anything.
 */
export async function handleFarmerListingEditPost(
  deps: FarmerListingEditDeps,
  request: Request,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const token = body.token;
  if (typeof token !== "string" || !LINK_TOKEN_RE.test(token)) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const submission = parseListingSubmission(body);
  if (submission === null) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  // An EDIT must name the stand, and there is no sensible fallback here. The other two doors can
  // default to the farm's name because they are creating a listing; this one is changing an
  // existing stand, and defaulting a blank field would silently RENAME it to the farm.
  if (submission.standName === null || submission.standName.trim() === "") {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  /*
    The FARM's name, which is a different record from the stand's and is optional here.

    ABSENCE MEANS LEAVE IT ALONE. This form posts a whole listing on every save, so a
    missing field must never be read as "set it to empty" — that would rename a farm to
    nothing the first time any existing caller saved. A present-but-blank name is a
    different thing: the farmer cleared the box, and that is refused rather than obeyed,
    because a farm with no name is unidentifiable on the public map.
  */
  const rawFarmName = body.farmName;
  if (rawFarmName !== undefined && typeof rawFarmName !== "string") {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const farmName = typeof rawFarmName === "string" ? rawFarmName.trim() : null;
  if (rawFarmName !== undefined && farmName === "") {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const link = await deps.resolveLink(deps.db, {
    tokenHash: hashFarmerLinkToken(token),
  });
  if (link === null) {
    return Response.json({ error: "link_unavailable" }, { status: 410 });
  }

  // After the link resolves, so a revoked farmer renames nothing, and against the farm the
  // LINK names — never a `farmId` from the body.
  if (farmName !== null && farmName !== "") {
    const renamed = await deps.renameFarm(deps.db, {
      farmId: link.farmId,
      name: farmName,
    });
    if (renamed.status !== "saved") {
      const status = renamed.status === "unknown_farm" ? 410 : 400;
      return Response.json({ error: renamed.status }, { status });
    }
  }

  const result = await deps.saveListing(deps.db, {
    // From the LINK, never the body.
    farmId: link.farmId,
    standName: submission.standName,
    listing: submission.listing,
    occurredAt: deps.clock.now(),
  });

  if (result.status === "saved") return Response.json({ status: "saved" });
  const status = result.status === "unknown_farm" ? 410 : 400;
  return Response.json({ error: result.status }, { status });
}

/** The production wiring: the real link resolver and writer behind the boundary above. */
export function farmerListingEditDeps(context: {
  db: Db;
  clock: Clock;
}): FarmerListingEditDeps {
  return {
    db: context.db,
    clock: context.clock,
    resolveLink: resolveFarmerLink,
    saveListing: saveOnboardingListing,
    renameFarm,
  };
}
