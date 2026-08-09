import nodemailer from "nodemailer";

import type { EmailTransport, SmtpConfig } from "@farm-friend/core";

// F-078 — the ONE place an SMTP library is imported.
//
// Everything about deciding what to send, to whom, and how to classify the result lives in
// `packages/core/src/email/send.ts` behind an injected `EmailTransport`. This file is the
// adapter that turns that seam into an actual connection, and it is the only reason
// `nodemailer` is a dependency of this workspace and of no other.
//
// **STARTTLS is required, not optional.** `requireTLS` makes the client REFUSE to continue if
// the relay does not upgrade the connection. Without it, nodemailer falls back to sending in
// the clear — which would put the app password and every farmer's address on the wire in
// plaintext. `secure: false` on port 587 means "start unencrypted, then upgrade", which is
// what submission ports do; it does not mean "send unencrypted".

/**
 * Build the live SMTP transport.
 *
 * The connection is created once per call rather than pooled. Farm Friend sends on the order
 * of tens of messages during migration, and a pooled connection held open across Cloud Run's
 * scale-to-zero would be reconnecting on nearly every use anyway.
 */
export function createSmtpTransport(config: SmtpConfig): EmailTransport {
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    // False on 587 means STARTTLS rather than implicit TLS. The upgrade is enforced below.
    secure: config.port === 465,
    requireTLS: true,
    auth: {
      user: config.username,
      pass: config.password,
    },
  });

  return async function send(request) {
    try {
      const info = await transporter.sendMail({
      // A display name plus the address, so a recipient's client shows "VIGA" rather than the
      // bare mailbox "board". Passed as STRUCTURED FIELDS rather than a hand-built
      // `"Name" <addr>` string: nodemailer does the header encoding, so the name cannot
      // restructure the header even though `resolveEmailConfig` already refuses the characters
      // that would let it.
      from: request.fromName
        ? { name: request.fromName, address: request.fromAddress }
        : request.fromAddress,
      to: request.toEmail,
      subject: request.subject,
      text: request.text,
      // The farmer replies to a mailbox VIGA actually reads. Same address today, but stated
      // explicitly so a future dedicated sending address does not silently send replies
      // somewhere nobody looks.
      replyTo: request.fromAddress,
      });

      return { providerMessageId: info.messageId };
    } catch (error) {
      // SMTP itself proves a 5xx was rejected before acceptance. Preserve every other failure
      // unchanged: a connection break or 4xx may still have delivered the code.
      const responseCode = (error as { responseCode?: unknown } | null)?.responseCode;
      if (typeof responseCode === "number" && responseCode >= 500 && responseCode < 600) {
        throw {
          responseCode,
          definitive: true,
          code: (error as { code?: unknown } | null)?.code,
        };
      }
      throw error;
    }
  };
}
