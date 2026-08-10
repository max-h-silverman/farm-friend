import { createPublicActionThrottle, createEmailSender } from "@farm-friend/core";
import {
  findVerifiableFarmByEmail,
  issueVerificationCode,
} from "@farm-friend/db";
import { publicReadContext, sharedClock } from "../../../../lib/public-context";
import { resolveEmailDelivery } from "../../../../lib/email-delivery";
import {
  handleVerificationRequestPost,
  verificationConfig,
} from "../../../../lib/farmer-verification";

// F-079 — "email me a code".
//
// Built from `publicReadContext` and a narrow config read, NOT the full composition root. That
// is the F-073 lesson: `appContext()` validates SMS, the model provider, and the map URL, so
// binding an unauthenticated farmer page to it makes it 500 on an unrelated missing variable.

export const dynamic = "force-dynamic";

/**
 * Rationing for a route that SENDS REAL MAIL on every accepted request.
 *
 * Module scope, so the window is shared across requests in a process. Takes `sharedClock()`
 * rather than `publicReadContext()` — `next build` imports every route module in a process with
 * no environment, and constructing the database pool there is what made the image build fail
 * with "Failed to collect page data" while every local check passed.
 *
 * This is the COARSE cost bucket only. The limits that actually protect a farmer's inbox are
 * per-farm and per-address, counted in the database, because rotating a client signal is free.
 */
const throttle = createPublicActionThrottle({
  clock: sharedClock(),
  limit: 5,
  windowMs: 60_000,
});

export async function POST(request: Request): Promise<Response> {
  const context = publicReadContext();
  const config = verificationConfig(process.env);

  // SMTP, the local simulator, or nothing — one answer, resolved in one place.
  const delivery = resolveEmailDelivery(process.env);
  if (!delivery.available) {
    // Email unconfigured is a supported deployment (F-078), so this is not a crash — but a code
    // cannot be sent, and the answer must still be the UNIFORM one rather than a distinct
    // error that reveals how the deployment is configured.
    return Response.json({ status: "sent" });
  }
  const send = createEmailSender({
    config: delivery.config,
    transport: delivery.transport,
  });

  return handleVerificationRequestPost(
    {
      db: context.db,
      clock: context.clock,
      throttle,
      emailSalt: config.emailSalt,
      codeSalt: config.codeSalt,
      clientSignalSalt: config.emailSalt,
      findVerifiableFarm: findVerifiableFarmByEmail,
      issueCode: issueVerificationCode,
      sendCode: async (input) =>
        send({
          toEmail: input.email,
          subject: input.subject,
          text: input.text,
          html: input.html,
          idempotencyKey: input.idempotencyKey,
        }),
      /*
        WHAT THE SEND DID, on the server (B-026).

        `createEmailSender`'s own `logger` is optional and nothing ever passed one, so every
        outcome — accepted and failed alike — was discarded. A farmer reporting "no email"
        left literally nothing to read, and three investigations of one incident had to
        reason from timing instead of evidence.

        `console.log` because Cloud Run collects stdout as structured logs; a JSON line is
        queryable there without adding a logging dependency for one call site. The farmer's
        address is deliberately absent — the farm and the outcome are what an operator needs.
      */
      logSend: (entry) => {
        console.log(JSON.stringify({ event: "farmer_verification_send", ...entry }));
      },
    },
    request,
  );
}
