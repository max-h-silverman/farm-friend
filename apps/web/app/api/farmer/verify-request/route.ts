import { createPublicActionThrottle, createEmailSender, resolveEmailConfig } from "@farm-friend/core";
import {
  findVerifiableFarmByEmail,
  issueVerificationCode,
  readFarmName,
} from "@farm-friend/db";
import { publicReadContext, sharedClock } from "../../../../lib/public-context";
import { createSmtpTransport } from "../../../../lib/smtp-transport";
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

  const email = resolveEmailConfig(process.env);
  if (!email.ok) {
    // Email unconfigured is a supported deployment (F-078), so this is not a crash — but a code
    // cannot be sent, and the answer must still be the UNIFORM one rather than a distinct
    // error that reveals how the deployment is configured.
    return Response.json({ status: "sent" });
  }
  const send = createEmailSender({
    config: email.config,
    transport: createSmtpTransport(email.config),
  });

  return handleVerificationRequestPost(
    {
      db: context.db,
      clock: context.clock,
      throttle,
      emailSalt: config.emailSalt,
      codeSalt: config.codeSalt,
      clientSignalSalt: config.emailSalt,
      replyToAddress: email.config.fromAddress,
      findVerifiableFarm: findVerifiableFarmByEmail,
      issueCode: issueVerificationCode,
      readFarmName,
      sendCode: async (input) =>
        send({
          toEmail: input.email,
          subject: input.subject,
          text: input.text,
          idempotencyKey: input.idempotencyKey,
        }),
    },
    request,
  );
}
