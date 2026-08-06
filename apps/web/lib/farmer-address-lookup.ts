import type { Clock, PublicActionThrottle } from "@farm-friend/core";
import {
  loadFarmerInvitation,
  type Db,
  type FarmerInvitationLookup,
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
//   * **The invitation token gates it.** Geocoding is billed per call, so an open lookup endpoint
//     is a way to spend VIGA's money in a loop. The same credential that gates writing the
//     listing gates the lookup — checked before any provider call.
//   * **The key stays server-side.** The response carries a coordinate and a status, nothing
//     else. A provider key in client JavaScript is a published key.
//   * **The throttle fronts it**, as the third consumer of the general mechanism — a public
//     handler performing an EXPENSIVE action, the same property the QR stock-out form and the
//     sign-in link request have (docs/ARCHITECTURE.md §abuse / cost throttle). Consulted BEFORE
//     the provider, so a refused request costs nothing.

/** The one shape a 64-hex credential may take, checked before any provider work. */
const INVITE_TOKEN_RE = /^[0-9a-f]{64}$/;

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

  const token = body.token;
  if (typeof token !== "string" || !INVITE_TOKEN_RE.test(token)) {
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

  // The credential is checked before the billed call too. An expired, redeemed, or unknown
  // invitation gets the same uniform refusal the listing endpoint gives, so this cannot be used
  // to learn whether a guessed token names anything.
  const invitation = await deps.loadInvitation(
    deps.db,
    token,
    deps.clock.now(),
  );
  if (invitation.status !== "active" || invitation.farmId === null) {
    return Response.json({ error: "invitation_unavailable" }, { status: 410 });
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
    lookupAddress: (address) =>
      lookupIslandAddress(
        { apiKey: context.geocodingApiKey, fetch },
        address,
      ),
    throttle: context.throttle,
    clientSignalSalt: context.clientSignalSalt,
  };
}
