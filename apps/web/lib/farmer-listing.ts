import type { Clock } from "@farm-friend/core";
import {
  loadFarmerInvitation,
  saveOnboardingListing,
  type Db,
  type FarmerInvitationLookup,
  type OnboardingListingInput,
  type SaveOnboardingListingResult,
} from "@farm-friend/db";

// F-067 — the HTTP boundary for the listing details an onboarding farmer types.
//
// This is the first farmer-facing write path for PUBLIC listing data, and everything it writes
// appears on the map VIGA links from its own site. So the boundary's job is narrow and strict:
// resolve the farm from the credential, validate every field's SHAPE, and hand a typed input
// to the writer that owns the rules.
//
// **The invitation token is the only credential, and it names the farm.** A farm id in the
// request body is ignored, never trusted — accepting one would let anyone holding any
// onboarding link overwrite any farm's address and hours on the public map. This mirrors how
// the agreement endpoint refuses to be the consent write: the link proves possession of the
// link and nothing else, so it may only reach what it names.

/** The one shape a 64-hex credential may take, checked before any database work. */
const INVITE_TOKEN_RE = /^[0-9a-f]{64}$/;

/**
 * Generous ceilings on published text, because the endpoint is reachable by anyone holding a
 * link and everything it writes is public. No real farmer meets these; a defacement attempt
 * does.
 */
const MAX_TEXT = 500;
const MAX_ADDRESS = 300;
const MAX_LIST_ENTRIES = 100;

export interface FarmerListingDeps {
  db: Db;
  clock: Clock;
  /** Injected so the boundary's contract is testable without a database. */
  loadInvitation: (
    db: Db,
    token: string,
    now: Date,
  ) => Promise<FarmerInvitationLookup>;
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

/** A field that must be a string within its ceiling, or absent. */
function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length > max) return undefined;
  return value;
}

/** A list of strings within its ceilings, or absent. `undefined` means malformed. */
function stringList(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > MAX_LIST_ENTRIES) return undefined;
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length > MAX_TEXT) return undefined;
  }
  return value as string[];
}

/**
 * A coordinate, validated as a NUMBER rather than coerced into one.
 *
 * `Number(null)` is `0`, which is a real coordinate in the Atlantic — coercion here would turn
 * a missing pin into a confident one. Returns `undefined` for malformed so the caller can
 * refuse rather than guess.
 */
function optionalCoordinate(value: unknown): number | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return value;
}

/**
 * HTTP boundary for the onboarding listing form.
 *
 * Publishes on submit (max, 2026-08-05): the listing is live when the farmer sends the form
 * rather than waiting for the SIGNUP text.
 *
 * Expired, redeemed, and unknown invitations all get the same uniform refusal the agreement
 * endpoint gives, so neither can be used to learn whether a guessed token names anything. An
 * invitation naming no farm gets the same answer: there is nothing to write against, and that
 * path is still a human's.
 */
export async function handleFarmerListingPost(
  deps: FarmerListingDeps,
  request: Request,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const token = body.token;
  if (typeof token !== "string" || !INVITE_TOKEN_RE.test(token)) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  // The central question, and the one thing that may never be defaulted: whether there is a
  // place to drive to. Guessing it is what F-038 and B-024 exist to prevent.
  const visitability = body.visitability;
  if (visitability !== "visitable" && visitability !== "contact_only") {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  const offeringType = body.offeringType;
  if (
    offeringType !== "produce" &&
    offeringType !== "services" &&
    offeringType !== "by_order"
  ) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const standName = optionalText(body.standName, MAX_TEXT);
  const address = optionalText(body.publicAddress, MAX_ADDRESS);
  const hoursText = optionalText(body.hoursText, MAX_TEXT);
  const paymentMethods = stringList(body.paymentMethods);
  const items = stringList(body.items);
  const latitude = optionalCoordinate(body.latitude);
  const longitude = optionalCoordinate(body.longitude);

  if (
    standName === undefined ||
    address === undefined ||
    hoursText === undefined ||
    paymentMethods === undefined ||
    items === undefined ||
    latitude === undefined ||
    longitude === undefined
  ) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const invitation = await deps.loadInvitation(
    deps.db,
    token,
    deps.clock.now(),
  );
  // An invitation naming no farm has nothing to write against — that path still reaches VIGA.
  // Answered identically to an unknown token so this discloses no more than the page does.
  if (invitation.status !== "active" || invitation.farmId === null) {
    return Response.json(
      { error: "invitation_unavailable" },
      { status: 410 },
    );
  }

  // A contact-only stand carries NO address and NO pin, and the boundary enforces that rather
  // than trusting the form to have hidden the fields. `coherentVisitability` would refuse the
  // write anyway, but as a constraint violation the farmer cannot act on — and a farmer who
  // filled in an address and then changed their answer is the ordinary case, not an attack.
  const visitable = visitability === "visitable";

  const result = await deps.saveListing(deps.db, {
    farmId: invitation.farmId,
    // The farm's own name is the sensible default for its stand: a farmer who never renames it
    // still gets a listing titled the thing their invitation named.
    standName: standName ?? invitation.farmName ?? "",
    listing: {
      visitability,
      offeringType,
      publicAddress: visitable ? address : null,
      latitude: visitable ? latitude : null,
      longitude: visitable ? longitude : null,
      hoursText,
      paymentMethods,
      items,
    },
    occurredAt: deps.clock.now(),
  });

  if (result.status === "saved") return Response.json({ status: "saved" });
  // `unknown_farm` is unreachable through this path — the farm came from the invitation we
  // just resolved — but is answered honestly rather than reported as a save.
  const status = result.status === "unknown_farm" ? 410 : 400;
  return Response.json({ error: result.status }, { status });
}

/** The production wiring: the real invitation lookup and writer behind the boundary above. */
export function farmerListingDeps(context: {
  db: Db;
  clock: Clock;
}): FarmerListingDeps {
  return {
    db: context.db,
    clock: context.clock,
    loadInvitation: loadFarmerInvitation,
    saveListing: saveOnboardingListing,
  };
}
