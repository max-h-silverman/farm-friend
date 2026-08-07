import { createPublicActionThrottle, verifySubmittedCode } from "@farm-friend/core";
import {
  consumeAndGrant,
  readLiveVerification,
  recordFailedAttempt,
} from "@farm-friend/db";
import { publicReadContext, sharedClock } from "../../../../lib/public-context";
import {
  GRANT_TTL_MS,
  handleVerificationSubmitPost,
  verificationConfig,
} from "../../../../lib/farmer-verification";
import { serializePublishGrantCookie } from "../../../../lib/publish-grant";

// F-079 — submitting the emailed code.
//
// Same composition discipline as the request route: `publicReadContext` plus a narrow config
// read, never `appContext()`.

export const dynamic = "force-dynamic";

/**
 * Rationing for code SUBMISSION.
 *
 * The per-record cap (`MAX_CODE_ATTEMPTS`) stops guessing against one code; this stops someone
 * cycling records to grind the six-digit space more broadly. Both are needed — neither
 * substitutes for the other.
 */
const throttle = createPublicActionThrottle({
  clock: sharedClock(),
  limit: 10,
  windowMs: 60_000,
});

export async function POST(request: Request): Promise<Response> {
  const context = publicReadContext();
  const config = verificationConfig(process.env);

  let grantToken: string | null = null;

  const response = await handleVerificationSubmitPost(
    {
      db: context.db,
      clock: context.clock,
      throttle,
      codeSalt: config.codeSalt,
      clientSignalSalt: config.emailSalt,
      readLive: readLiveVerification,
      decide: verifySubmittedCode,
      consumeAndGrant: (db, input) =>
        consumeAndGrant(db, { ...input, grantTtlMs: GRANT_TTL_MS }),
      recordFailure: recordFailedAttempt,
      onGranted: (token) => {
        grantToken = token;
      },
    },
    request,
  );

  if (grantToken === null) return response;

  // The grant travels as an HttpOnly cookie, never in the body: a body value would be readable
  // by script, and this is the credential that publishes onto VIGA's public map.
  const withCookie = new Response(response.body, response);
  withCookie.headers.append(
    "set-cookie",
    serializePublishGrantCookie(grantToken, GRANT_TTL_MS),
  );
  return withCookie;
}
