import nodemailer from "nodemailer";

import type { EmailConfig, EmailTransport } from "@farm-friend/core";

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
export function createSmtpTransport(config: EmailConfig): EmailTransport {
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
    const info = await transporter.sendMail({
      from: request.fromAddress,
      to: request.toEmail,
      subject: request.subject,
      text: request.text,
      // The farmer replies to a mailbox VIGA actually reads. Same address today, but stated
      // explicitly so a future dedicated sending address does not silently send replies
      // somewhere nobody looks.
      replyTo: request.fromAddress,
    });

    return { providerMessageId: info.messageId };
  };
}
