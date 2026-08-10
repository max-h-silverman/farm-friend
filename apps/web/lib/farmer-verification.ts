import {
  EmailNormalizationError,
  normalizeEmail,
  renderVerificationEmail,
  type Clock,
  type PublicActionThrottle,
  type VerificationOutcome,
} from "@farm-friend/core";
import type { Db, IssueVerificationResult, LiveVerification } from "@farm-friend/db";

import { clientSignalFor } from "./client-signal";

// F-079 — the HTTP boundary for proving you control an address VIGA holds for a farm.
//
// ## What verification actually grants, and what it deliberately does not
//
// A verified code grants LISTING-PUBLISH RIGHTS for one farm, and nothing else. It never
// creates a `farmer_authorizations` row, so it never makes anyone a farmer who can update
// stock by text — that still requires an inbound message from a consented handset, which is
// the consent architecture and the 10DLC campaign, not a policy choice we may relax here.
//
// The page says so in words, because the alternative is a farmer discovering it when their
// first text is refused. But the guarantee is structural: `grantPublishRights` is the only
// capability this module is handed, and no seam here can reach authorization.
//
// ## Two responses, both deliberately uninformative
//
// **Requesting a code always answers `sent`.** On file or not, already issued, budget spent,
// relay refused — one answer. Any variation turns this into a service for asking which address
// VIGA holds for a farm. The farmer learns the truth from their inbox. Same discipline as
// `phone-step.tsx`'s "if that number is on file".
//
// **Every refusal on submit answers identically too.** Wrong, expired, already used, capped,
// never issued — one body. A distinction anywhere tells someone grinding codes whether they are
// close, which is precisely what a six-digit space cannot afford to leak.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The two salts this feature needs, read WITHOUT the full composition root.
 *
 * Same reason as `farmerLinkRequestConfig`: `appContext()` validates SMS, the model provider,
 * and the map URL, so binding an unauthenticated farmer page to it makes it 500 on an unrelated
 * missing variable — found by running F-073's route, not by any suite.
 *
 * **Two distinct salts, and not `PHONE_HASH_SALT` reused.** Separate hash spaces mean one
 * leaked salt does not compromise the other; a shared one would let anyone holding it correlate
 * a farmer's address with their phone across both tables. `EMAIL_HASH_SALT` must match whatever
 * the roster ingest used, or every farmer's address silently fails to match.
 */
export function verificationConfig(env: Record<string, string | undefined>): {
  emailSalt: string;
  codeSalt: string;
} {
  const emailSalt = env.EMAIL_HASH_SALT?.trim();
  if (emailSalt === undefined || emailSalt === "") {
    throw new Error("EMAIL_HASH_SALT is required");
  }
  const codeSalt = env.VERIFICATION_CODE_SALT?.trim();
  if (codeSalt === undefined || codeSalt === "") {
    throw new Error("VERIFICATION_CODE_SALT is required");
  }
  return { emailSalt, codeSalt };
}

/** Bounded before normalizing or hashing. A real address is nowhere near this. */
const MAX_EMAIL = 254;

/** Bounded likewise. The code is six digits; this leaves room for spaces and hyphens. */
const MAX_CODE = 32;

/**
 * How long a publish grant lasts.
 *
 * Long enough to fill in a listing form without racing a timer — a farmer typing their hours,
 * payment methods and item list is doing real work. Short enough that an abandoned session on a
 * shared machine is not a standing key to the farm's listing. It is an authentication EVENT,
 * not the durable `/stand/[token]` capability, which is why it expires at all.
 */
export const GRANT_TTL_MS = 2 * 60 * 60 * 1000;

export interface VerificationRequestDeps {
  db: Db;
  clock: Clock;
  throttle: PublicActionThrottle;
  /** Salt for the address hash. */
  emailSalt: string;
  /** Salt for the code hash. */
  codeSalt: string;
  /** Coarse rate bucket only. Never identity. */
  clientSignalSalt: string;
  findVerifiableFarm: (
    db: Db,
    query: { farmId: string; email: string; salt: string },
  ) => Promise<boolean>;
  issueCode: (
    db: Db,
    input: {
      farmId: string;
      email: string;
      salt: string;
      codeSalt: string;
      now: Date;
    },
  ) => Promise<IssueVerificationResult>;
  sendCode: (input: {
    farmId: string;
    email: string;
    subject: string;
    text: string;
    html: string;
    idempotencyKey: string;
  }) => Promise<{ outcome: string; errorCode?: string }>;
  /**
   * Record what the send actually did (B-026).
   *
   * The RESPONSE is uniform by design — it must not reveal which addresses are on file — so
   * without this the server had no idea whether a farmer's code was delivered or dropped. A
   * farmer reporting "no email" left nothing to read.
   *
   * Optional so a caller that has not wired it still works; the route wires it.
   */
  logSend?: (entry: {
    outcome: string;
    errorCode?: string;
    farmId: string;
    idempotencyKey: string;
  }) => void;
}

/** The one response this endpoint ever gives a well-formed request. */
const SENT = { status: "sent" } as const;

/**
 * Ask Farm Friend to email a verification code.
 *
 * A malformed farm id or address is a `400`, and that is not a leak: "that is not an email
 * address" says nothing about who is on file, and the alternative is a farmer with a typo
 * waiting for mail that can never arrive. Everything past well-formedness is uniform.
 */
export async function handleVerificationRequestPost(
  deps: VerificationRequestDeps,
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

  const rawEmail = body.email;
  if (typeof rawEmail !== "string" || rawEmail.length > MAX_EMAIL) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  let email: string;
  try {
    email = normalizeEmail(rawEmail);
  } catch (error) {
    if (error instanceof EmailNormalizationError) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    throw error;
  }

  // BEFORE any issuance, so a refused request sends no mail and costs nothing. This is the
  // coarse cost throttle; the per-farm and per-address limits live in the database, because a
  // client bucket cannot see someone rotating their signal to bury one farmer's inbox.
  const decision = deps.throttle.admit(
    clientSignalFor(request.headers, deps.clientSignalSalt),
  );
  if (!decision.allowed) {
    return Response.json(
      { error: "rate_limited" },
      { status: 429, headers: { "retry-after": String(decision.retryAfterSeconds) } },
    );
  }

  // Everything from here answers SENT regardless of what happens, including the failures.
  const onFile = await deps.findVerifiableFarm(deps.db, {
    farmId,
    email,
    salt: deps.emailSalt,
  });
  if (!onFile) return Response.json(SENT);

  const issued = await deps.issueCode(deps.db, {
    farmId,
    email,
    salt: deps.emailSalt,
    codeSalt: deps.codeSalt,
    now: deps.clock.now(),
  });
  if (issued.status !== "issued") return Response.json(SENT);

  const sent = await deps.sendCode({
    farmId,
    email,
    ...renderVerificationEmail({
      code: issued.code,
    }),
    idempotencyKey: issued.id,
  });

  /*
    WHAT HAPPENED, on the server only (B-026).

    The farmer's answer stays uniform below; this is the operator's record. It carries the
    outcome, the transport's error code, and the FARM — never the address, because the hash is
    the only permitted log key (Golden Rule #5) and an address here would be the rich personal
    record the privacy posture refuses.

    The accepted case is logged too: logging only failures makes an absent line ambiguous
    between "no send" and "a send that worked".
  */
  deps.logSend?.({
    outcome: sent.outcome,
    ...(sent.errorCode === undefined ? {} : { errorCode: sent.errorCode }),
    farmId,
    idempotencyKey: issued.id,
  });

  return Response.json(SENT);
}

export interface VerificationSubmitDeps {
  db: Db;
  clock: Clock;
  throttle: PublicActionThrottle;
  codeSalt: string;
  clientSignalSalt: string;
  readLive: (db: Db, input: { farmId: string }) => Promise<LiveVerification | null>;
  /** Injected so the boundary's ordering is testable without a database. */
  decide: (input: {
    record: LiveVerification;
    submitted: string;
    salt: string;
    now: Date;
  }) => VerificationOutcome;
  /**
   * Consume the code AND mint its publish grant, atomically. Returns the raw grant token, or
   * null when another request won the race.
   *
   * **This is the ONLY capability this module holds, and it grants LISTING-PUBLISH rights and
   * nothing else.** It cannot write a `farmer_authorizations` row — there is no seam here that
   * could — which is what makes "publishing is not farmer authorization" structural rather than
   * a promise in the page copy.
   *
   * Consuming and granting are one commitment: a consume that succeeded while the grant failed
   * would spend the farmer's only code and hand them nothing.
   */
  consumeAndGrant: (db: Db, input: { id: string; now: Date }) => Promise<string | null>;
  recordFailure: (db: Db, input: { id: string }) => Promise<void>;
  /** Receives the raw grant token so the route can set it as an HttpOnly cookie. */
  onGranted?: (token: string) => Promise<void> | void;
}

/** The one refusal body. Every failing path returns exactly this. */
const REFUSED = { error: "verification_failed" } as const;

/**
 * Submit a code.
 *
 * The order below is the security property. The decision is made against the stored record,
 * the code is CONSUMED, and only a successful consume grants anything — so two simultaneous
 * redemptions of one code produce exactly one grant, decided by the database rather than by
 * whichever request read first.
 */
export async function handleVerificationSubmitPost(
  deps: VerificationSubmitDeps,
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

  const code = body.code;
  if (typeof code !== "string" || code.length > MAX_CODE) {
    return Response.json({ error: "invalid_request" }, { status: 400 });
  }

  // Stops someone cycling records to grind the digit space; the per-record cap only rations
  // guesses against ONE code.
  const decision = deps.throttle.admit(
    clientSignalFor(request.headers, deps.clientSignalSalt),
  );
  if (!decision.allowed) {
    return Response.json(
      { error: "rate_limited" },
      { status: 429, headers: { "retry-after": String(decision.retryAfterSeconds) } },
    );
  }

  const record = await deps.readLive(deps.db, { farmId });
  // No live code is the SAME refusal as a wrong one. Otherwise this answers "has anyone
  // started verifying this farm?" to anybody who asks.
  if (record === null) return Response.json(REFUSED, { status: 400 });

  const outcome = deps.decide({
    record,
    submitted: code,
    salt: deps.codeSalt,
    now: deps.clock.now(),
  });

  if (outcome.outcome !== "verified") {
    // A wrong guess is counted; a malformed submission is not. A farmer who typed four digits
    // made a typo, and charging it would exhaust the honest case faster than the attacking one.
    if (outcome.outcome === "wrong_code") {
      await deps.recordFailure(deps.db, { id: record.id });
    }
    return Response.json(REFUSED, { status: 400 });
  }

  // One statement commits the consume and the grant together, and it is also what decides the
  // race: exactly one caller matches `consumed_at is null`. A null return means another
  // request won, and that caller must be handed nothing.
  const grantToken = await deps.consumeAndGrant(deps.db, {
    id: record.id,
    now: deps.clock.now(),
  });
  if (grantToken === null) return Response.json(REFUSED, { status: 400 });

  // The token goes in the COOKIE the route sets, never in this body: a body value is readable
  // by script, and this credential publishes onto VIGA's public map. `onGranted` hands it to
  // the route out-of-band so the response the browser sees carries no credential at all.
  await deps.onGranted?.(grantToken);

  return Response.json({ status: "verified" });
}
