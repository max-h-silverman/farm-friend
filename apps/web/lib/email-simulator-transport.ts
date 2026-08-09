import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { EmailTransport } from "@farm-friend/core";

// F-079 local development — the mail sink.
//
// The counterpart to `SMS_PROVIDER=simulator`: the same idea applied to the other last-mile
// channel, so both are one pattern rather than two. Without it the farmer verification flow is
// a dead end on a laptop — `resolveEmailConfig` returns `not_configured`, the route returns the
// uniform "sent" answer, and the six-digit code exists nowhere a developer can read it.
//
// **This must never run on a deployment.** A sink that accepts every message and reports
// success is indistinguishable from a working relay in the logs, so if it reached production,
// farmers would stop receiving codes while every check stayed green. That is GL-019 exactly —
// `LLM_PROVIDER` defaulting to `stub` and production running the test double for its whole
// life. Two independent barriers: it is opt-in (`EMAIL_PROVIDER=simulator`, never a default,
// see `composition.ts`), and it refuses to construct under `NODE_ENV=production` regardless of
// what else is set. The refusal is the load-bearing one, because it holds even if someone
// copies the wrong `.env` onto a server.
//
// Written to a file rather than the console deliberately: a live verification code in log
// output is a credential in a stream that gets shipped, aggregated, and retained. A file under
// the working directory is git-ignored, local, and easy to delete.

export interface EmailSimulatorOptions {
  /** Where messages are written. One file per message. */
  directory: string;
  /** Passed in rather than read from `process.env` so the refusal itself is testable. */
  nodeEnv: string | undefined;
}

/**
 * Build the local mail sink. Throws under `NODE_ENV=production`.
 */
export function createEmailSimulatorTransport(options: EmailSimulatorOptions): EmailTransport {
  if (options.nodeEnv === "production") {
    throw new Error(
      "EMAIL_PROVIDER=simulator must never be used on a deployment: it accepts every message " +
        "and reports success, so real verification emails would silently stop reaching " +
        "farmers. Configure EMAIL_PROVIDER=gmail instead, or leave email unconfigured.",
    );
  }

  const { directory } = options;

  return async function send(request) {
    mkdirSync(directory, { recursive: true });

    // The key is the message's own idempotency key, so a re-request lands beside the first
    // rather than overwriting it — otherwise the earlier code silently disappears mid-test.
    // Prefixed with a timestamp so the newest message is last in a directory listing, and
    // sanitized because the key reaches the filesystem.
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const safeKey = request.idempotencyKey.replace(/[^A-Za-z0-9_-]/g, "_");
    const file = join(directory, `${stamp}-${safeKey}.txt`);

    const rendered = [
      `To: ${request.toEmail}`,
      `From: ${request.fromName ? `${request.fromName} <${request.fromAddress}>` : request.fromAddress}`,
      `Subject: ${request.subject}`,
      "",
      request.text,
      "",
    ].join("\n");

    writeFileSync(file, rendered, "utf8");

    return { providerMessageId: `simulated-${request.idempotencyKey}` };
  };
}
