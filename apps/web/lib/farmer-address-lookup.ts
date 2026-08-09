import {
  hashFarmerLinkToken,
  isFarmerLinkToken,
  type Clock,
  type PublicActionThrottle,
} from "@farm-friend/core";
import {
  claimGrandfatheredFarm,
  loadFarmerInvitation,
  resolveFarmerLink,
  type ClaimGrandfatheredFarmResult,
  type Db,
  type FarmerInvitationLookup,
  type ResolvedFarmerLink,
} from "@farm-friend/db";
import { lookupIslandAddress, type AddressLookupResult } from "./address-lookup";
import { clientSignalFor } from "./client-signal";

// F-069 — the HTTP boundary for the DRAFT pin lookup.
//
// This endpoint exists because max reopened the no-geocoder boundary for farm stand onboarding
// (2026-08-05). It looks an address up and hands back a coordinate the FARMER then confirms;
// nothing here writes, and the listing still reaches the map only through
// `/api/farmer/listing` carrying the pin the farmer accepted.
//
// Three containments, each for a different failure:
//
//   * **A credential gates it.** Geocoding is billed per call, so an open lookup endpoint is a
//     way to spend VIGA's money in a loop. Whichever credential gates WRITING the listing gates
//     the lookup — checked before any provider call. Since F-072 that is either an invitation
//     token or a claimable farm; the second is weaker (farm ids are not secret), which is why
//     the throttle below rather than the credential is the real cost defense on that path.
//   * **The key stays server-side.** The response carries a coordinate and a status, nothing
//     else. A provider key in client JavaScript is a published key.
//   * **The throttle fronts it**, as the third consumer of the general mechanism — a public
//     handler performing an EXPENSIVE action, the same property the QR stock-out form and the
//     sign-in link request have (docs/ARCHITECTURE.md §abuse / cost throttle). Consulted BEFORE
//     the provider, so a refused request costs nothing.

/**
 * The shapes a credential may take here, checked before any provider work.
 *
 * Two different credentials reach this door — an invitation token (64 hex) and a farmer's
 * stand link token (base64url since F-097, or 64 hex if it was minted before that). This
 * cannot tell them apart and does not try: which one it is, is decided by which resolver
 * accepts it. `isFarmerLinkToken` already spans both, so it is the whole gate rather than one
 * of two branches — and an invitation's hex satisfies it.
 */
function looksLikeToken(token: string): boolean {
  return isFarmerLinkToken(token);
}

/** A farm id must be a UUID before any provider work — a malformed one is a bad request. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Generous, but bounded: a real address is nowhere near this, an abuse payload is. */
const MAX_ADDRESS = 300;

export interface FarmerAddressLookupDeps {
  db: Db;
  clock: Clock;
  loadInvitation: (
    db: Db,
    token: string,
    now: Date,
  ) => Promise<FarmerInvitationLookup>;
  /**
   * F-072's second credential: a farm claimed from the public dropdown, with no invitation.
   *
   * **This is the gate on a BILLED endpoint, so it is worth being precise about what it buys.**
   * A grandfathered farmer holds no token — that is the whole premise of the honour-system door
   * — so the claimable check is what stands in the token's place here. It is weaker: farm ids
   * are not secret, and the claimable set is guessable. The real cost defense on this path is
   * the throttle, which runs first and is unchanged. What the check still buys is that the
   * lookup closes for a farm as soon as it has a farmer, so the reachable set shrinks toward
   * zero rather than staying open forever.
   */
  claimFarm: (
    db: Db,
    input: { farmId: string },
  ) => Promise<ClaimGrandfatheredFarmResult>;
  /** F-073's credential: an already-onboarded farmer editing, via their stand link. */
  resolveLink: (
    db: Db,
    input: { tokenHash: string },
  ) => Promise<ResolvedFarmerLink | null>;
  /** Injected so the boundary is testable without a billed provider call. */
  lookupAddress: (address: string) => Promise<AddressLookupResult>;
  throttle: PublicActionThrottle;
  /** Salt for the coarse client bucket. Never identity — a cost bucket only. */
  clientSignalSalt: string;
}

/**
 * Look up one address on behalf of an onboarding farmer.
 *
 * Returns a draft coordinate, or an honest reason there is none. Every no-coordinate answer
 * means the same thing to the form: the farmer taps the map, which is what they did before this
 * endpoint existed.
 */
export async function handleAddressLookupPost(
  deps: FarmerAddressLookupDeps,
  request: Request,
): Promise<Response> {
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  // Exactly one credential, checked for SHAPE before any work. Both together is an ambiguous
  // request rather than a clever one, and is refused instead of picking a winner.
  const token = body.token;
  const farmId = body.farmId;
  const hasToken = token !== undefined && token !== null;
  const hasFarmId = farmId !== undefined && farmId !== null;
  if (hasToken === hasFarmId) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  // Shape cannot tell an invitation token from a stand link token — and must not try to. Each
  // is resolved by its own resolver below, and a token that is neither is refused there.
  if (hasToken && (typeof token !== "string" || !looksLikeToken(token))) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  if (hasFarmId && (typeof farmId !== "string" || !UUID_RE.test(farmId))) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const address = body.address;
  if (
    typeof address !== "string" ||
    address.trim() === "" ||
    address.length > MAX_ADDRESS
  ) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  // BEFORE the provider call, so a refused request costs nothing. The signal is coarse and is
  // never identity: it exists only to keep one caller from spending the geocoding budget.
  const decision = deps.throttle.admit(
    clientSignalFor(request.headers, deps.clientSignalSalt),
  );
  if (!decision.allowed) {
    return Response.json(
      { error: "rate_limited" },
      {
        status: 429,
        headers: { "retry-after": String(decision.retryAfterSeconds) },
      },
    );
  }

  // The credential is checked before the billed call too, whichever one was presented.
  if (hasToken) {
    // Either kind of token is acceptable, and shape does not separate them — so this asks each
    // resolver in turn rather than guessing from the string. An onboarding farmer holds an
    // invitation; an already-onboarded farmer editing their listing (F-073) holds their stand
    // link, and both are farmers placing a pin on a stand they control.
    //
    // An expired, redeemed, or unknown credential gets the same uniform refusal the listing
    // endpoints give, so this cannot be used to learn whether a guessed token names anything.
    const invitation = await deps.loadInvitation(
      deps.db,
      token as string,
      deps.clock.now(),
    );
    const invited = invitation.status === "active" && invitation.farmId !== null;
    const linked =
      invited ||
      (await deps.resolveLink(deps.db, {
        tokenHash: hashFarmerLinkToken(token as string),
      })) !== null;
    if (!linked) {
      return Response.json({ error: "invitation_unavailable" }, { status: 410 });
    }
  } else {
    // A farm that already has a farmer cannot look addresses up through the grandfather door:
    // that door is closed for it, and leaving the billed call reachable would keep a cost
    // surface open for every farm forever.
    const claim = await deps.claimFarm(deps.db, { farmId: farmId as string });
    if (claim.status !== "claimable") {
      return Response.json({ error: "invitation_unavailable" }, { status: 410 });
    }
  }

  const result = await deps.lookupAddress(address);
  // Rendered field by field rather than spread, so a future field added to the provider result
  // cannot leak into a public response by default.
  if (result.status === "found") {
    return Response.json({
      status: "found",
      latitude: result.latitude,
      longitude: result.longitude,
    });
  }
  return Response.json({ status: result.status });
}

/** The production wiring: the real invitation lookup and the real geocoder behind the boundary. */
export function farmerAddressLookupDeps(context: {
  db: Db;
  clock: Clock;
  throttle: PublicActionThrottle;
  clientSignalSalt: string;
  /** Absent in a deployment without geocoding configured, which is supported. */
  geocodingApiKey: string | undefined;
}): FarmerAddressLookupDeps {
  return {
    db: context.db,
    clock: context.clock,
    loadInvitation: loadFarmerInvitation,
    claimFarm: claimGrandfatheredFarm,
    resolveLink: resolveFarmerLink,
    lookupAddress: (address) =>
      lookupIslandAddress(
        { apiKey: context.geocodingApiKey, fetch },
        address,
      ),
    throttle: context.throttle,
    clientSignalSalt: context.clientSignalSalt,
  };
}
