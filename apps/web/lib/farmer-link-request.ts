import {
  PhoneNormalizationError,
  hashPhone,
  type Clock,
  type PublicActionThrottle,
} from "@farm-friend/core";
import {
  requestFarmerStandLink,
  type Db,
  type RequestFarmerStandLinkResult,
} from "@farm-friend/db";
import { clientSignalFor } from "./client-signal";

// F-073 — the HTTP boundary for "text me my update link".
//
// A farmer whose farm is already on Farm Friend arrives from the public picker with no
// credential at all. They prove who they are by naming a number that is already on file for
// that farm — and the proof is that the LINK GOES TO THAT HANDSET, not that this endpoint tells
// them they were right.
//
// Three containments, each for a different failure:
//
//   * **It is not an oracle.** Every well-formed request gets the same `accepted`. A different
//     answer for a match would turn this into a lookup service for whether any given number
//     belongs to a farmer.
//   * **The number is hashed here and goes no further.** The raw string reaches `hashPhone` and
//     stops; the writer takes a hash, and the raw column is read only by the send path
//     (Golden Rule #5).
//   * **The throttle fronts it.** Each accepted request sends a real text, which costs money and
//     reaches a real person — so an unrationed endpoint is both a bill and a way to pester a
//     farmer with link messages.

/** A farm id must be a UUID before any database work — a malformed one is a bad request. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Bounded before hashing: a real number is nowhere near this, an abuse payload is. */
const MAX_PHONE = 40;

export interface FarmerLinkRequestDeps {
  db: Db;
  clock: Clock;
  /** Injected so the boundary's contract is testable without a database. */
  requestLink: (
    db: Db,
    input: {
      farmId: string;
      contactHash: string;
      occurredAt: Date;
      publicBaseUrl: string;
    },
  ) => Promise<RequestFarmerStandLinkResult>;
  throttle: PublicActionThrottle;
  /** The lookup-key salt. Same salt the rest of the system hashes numbers under. */
  phoneSalt: string;
  /** Salt for the coarse client bucket. Never identity — a rate bucket only. */
  clientSignalSalt: string;
  /** Where the link points. CONFIGURED, never taken from the request. */
  publicBaseUrl: string;
}

/**
 * Ask Farm Friend to text a farmer their own stand link.
 *
 * Answers `accepted` for every well-formed request, whether or not the number matched. The
 * farmer learns the answer from their phone.
 */
export async function handleFarmerLinkRequestPost(
  deps: FarmerLinkRequestDeps,
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

  const phone = body.phone;
  if (typeof phone !== "string" || phone.length > MAX_PHONE) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  // BEFORE the writer, so a refused request sends no text and costs nothing. The signal is
  // coarse and is never identity.
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

  // Hashed HERE, so the raw number reaches nothing below this line. A number that is not a
  // number at all is a bad request rather than a miss — the farmer mistyped and should be told,
  // which discloses nothing about who is or is not a farmer.
  let contactHash: string;
  try {
    contactHash = hashPhone(phone, deps.phoneSalt);
  } catch (error) {
    if (error instanceof PhoneNormalizationError) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    throw error;
  }

  const result = await deps.requestLink(deps.db, {
    farmId,
    contactHash,
    occurredAt: deps.clock.now(),
    // Configured. A request-supplied host would let a caller have Farm Friend text a real
    // farmer a link pointing at a site the caller controls.
    publicBaseUrl: deps.publicBaseUrl,
  });

  return Response.json({ status: result.status });
}

/**
 * The configuration this route needs, resolved WITHOUT the full composition root.
 *
 * `appContext()` validates every configured surface — SMS credentials, the model provider, the
 * public map URL — so binding this unauthenticated farmer page to it made it 500 when an
 * unrelated variable was missing. That was found by running the route, not by the suite: every
 * test injects these dependencies, so no test could see the composition.
 *
 * Reading the two values here keeps the public path free of the model graph, exactly as
 * `publicReadContext` does for the map.
 */
export function farmerLinkRequestConfig(env: Record<string, string | undefined>): {
  phoneSalt: string;
  publicBaseUrl: string;
} {
  const phoneSalt = env.PHONE_HASH_SALT?.trim();
  if (phoneSalt === undefined || phoneSalt === "") {
    throw new Error("PHONE_HASH_SALT is required");
  }
  const publicBaseUrl = env.PUBLIC_BASE_URL?.trim();
  if (publicBaseUrl === undefined || publicBaseUrl === "") {
    throw new Error("PUBLIC_BASE_URL is required");
  }
  return { phoneSalt, publicBaseUrl };
}

/** The production wiring: the real writer behind the boundary above. */
export function farmerLinkRequestDeps(context: {
  db: Db;
  clock: Clock;
  throttle: PublicActionThrottle;
  phoneSalt: string;
  clientSignalSalt: string;
  publicBaseUrl: string;
}): FarmerLinkRequestDeps {
  return {
    db: context.db,
    clock: context.clock,
    requestLink: requestFarmerStandLink,
    throttle: context.throttle,
    phoneSalt: context.phoneSalt,
    clientSignalSalt: context.clientSignalSalt,
    publicBaseUrl: context.publicBaseUrl,
  };
}
