import type { Clock } from "@farm-friend/core";
import {
  recordFarmerInvitationSmsAgreement,
  type Db,
  type RecordInvitationAgreementResult,
} from "@farm-friend/db";

/** The one shape a 64-hex credential may take, checked before any database work. */
const INVITE_TOKEN_RE = /^[0-9a-f]{64}$/;

export interface FarmerOnboardingDeps {
  db: Db;
  clock: Clock;
  /** Injected so the boundary's contract is testable without a database. */
  recordAgreement: (
    db: Db,
    input: { token: string; occurredAt: Date },
  ) => Promise<RecordInvitationAgreementResult>;
}

/**
 * HTTP boundary for the onboarding page's SMS agreement.
 *
 * **This does not establish consent, and must not be changed to.** The link is the whole
 * credential and anyone holding it can reach this route, so a tick here records only that
 * the agreement was shown on this invitation and accepted. Consent is written when
 * `SIGNUP <token>` arrives from a handset — the inbound message is what ties the person who
 * agreed to the number that will be messaged.
 *
 * The time stamped is the SERVER's. A caller-supplied instant would let anyone with the link
 * backdate consent provenance.
 *
 * Expired, redeemed, and unknown invitations all get one uniform refusal, matching the page,
 * so this cannot be used to learn whether a guessed token names anything.
 */
export async function handleFarmerOnboardingAgreementPost(
  deps: FarmerOnboardingDeps,
  request: Request,
): Promise<Response> {
  let body: { token?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }
  if (typeof body.token !== "string" || !INVITE_TOKEN_RE.test(body.token)) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  const result = await deps.recordAgreement(deps.db, {
    token: body.token,
    occurredAt: deps.clock.now(),
  });

  return result.status === "agreed"
    ? Response.json({ status: "agreed" })
    : Response.json({ error: "invitation_unavailable" }, { status: 410 });
}

/** The production wiring: the real database writer behind the boundary above. */
export function farmerOnboardingDeps(context: {
  db: Db;
  clock: Clock;
}): FarmerOnboardingDeps {
  return {
    db: context.db,
    clock: context.clock,
    recordAgreement: recordFarmerInvitationSmsAgreement,
  };
}
