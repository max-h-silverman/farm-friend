import { createEmailSender, renderVerificationEmail, resolveEmailConfig } from "@farm-friend/core";

import { createSmtpTransport } from "../apps/web/lib/smtp-transport";

// F-078 — the ONE REAL SEND. A stubbed mail server proves nothing about whether a farmer
// receives anything, so this exercises the shipped code against the real Google relay:
// `resolveEmailConfig` reads the same variables production reads, `createSmtpTransport` opens
// the same connection, and `renderVerificationEmail` produces the exact message a farmer gets.
//
//   SMTP_HOST=smtp-relay.gmail.com SMTP_PORT=587 \
//   SMTP_USERNAME=board@vigavashon.org SMTP_FROM_ADDRESS=board@vigavashon.org \
//   SMTP_PASSWORD='<16 chars, no spaces>' \
//   npx tsx scripts/send-test-email.ts you@example.com
//
// The password is passed on the command line rather than read from a file, and it is NEVER
// echoed by this script.

async function main(): Promise<number> {
  const recipient = process.argv[2];
  if (!recipient) {
    console.error("usage: npx tsx scripts/send-test-email.ts <recipient@example.com>");
    return 1;
  }

  const configured = resolveEmailConfig(process.env);
  if (!configured.ok) {
    // Names what is missing, never a value — this output is pasted into terminals and chats.
    console.error(`email is not configured: ${configured.reason}`);
    console.error(`missing: ${configured.missing.join(", ")}`);
    return 1;
  }

  const message = renderVerificationEmail({
    code: "284107",
    farmName: "Lavender Hill Farm",
    replyToAddress: configured.config.fromAddress,
  });

  console.log(`sending as ${configured.config.fromAddress} via ${configured.config.host}`);
  console.log(`subject: ${message.subject}`);

  const send = createEmailSender({
    config: configured.config,
    transport: createSmtpTransport(configured.config),
    logger: (entry) => console.log(`  [log] ${JSON.stringify(entry)}`),
  });

  const outcome = await send({
    toEmail: recipient,
    subject: message.subject,
    text: message.text,
    idempotencyKey: `test-send-${Date.now()}`,
  });

  console.log(`\noutcome: ${outcome.outcome}`);
  if (outcome.outcome === "accepted") {
    console.log(`provider message id: ${outcome.providerMessageId}`);
    console.log("\nThe relay ACCEPTED it. Check the inbox — acceptance is not delivery.");
    return 0;
  }
  console.error(`errorCode: ${outcome.errorCode}`);
  return 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    // The message may echo the credential back on an auth failure, so only the shape is shown.
    console.error(`send threw: ${(error as { name?: string }).name ?? "Error"}`);
    process.exit(1);
  },
);
