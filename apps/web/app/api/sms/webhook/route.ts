import { hashPhone } from "@farm-friend/core";
import { acceptProviderEvent } from "@farm-friend/db";
import { parseTelnyxEvent, verifyTelnyxSignature } from "@farm-friend/sms";
import { appContext } from "../../../../lib/composition";
import { kickSenderPasses } from "../../../../lib/kick";
import { runInboundPass, runOutboundPass } from "../../../../lib/workers";

// The Telnyx inbound webhook (docs/ARCHITECTURE.md §SMS ingress).
//
// Order matters and is not negotiable:
//   1. read the EXACT raw bytes and verify the signature — before parsing;
//   2. parse into the minimized permitted projection;
//   3. commit that projection durably;
//   4. only then acknowledge.
//
// The raw provider envelope is never stored or logged. A duplicate or retried delivery
// is a successful no-op. Interpretation and sending happen in a worker, not here: the
// response must be prompt, and no model or SMS call belongs inside ingress.
//
// B-004 — after acknowledging, this route KICKS that sender's worker passes so the reply
// goes out in milliseconds rather than waiting up to a minute for the next cron sweep. The
// kick is started but never awaited, so it cannot delay or fail the 200: the durable commit
// above has already succeeded, and turning a successful ingress into a failed invocation
// would make Telnyx retry a message Farm Friend has already accepted.
//
// The kick is a LATENCY optimization only. It adds no durable mechanism and owns no
// guarantee — cron remains the recovery net for anything it misses, and the only trigger for
// F-026's retention purge. `kick-wiring.test.ts` fails if an `await` ever appears in front of
// it or if the acknowledgement stops preceding it.

export const dynamic = "force-dynamic";

const SIGNATURE_HEADER = "telnyx-signature-ed25519";
const TIMESTAMP_HEADER = "telnyx-timestamp";

export async function POST(req: Request): Promise<Response> {
  const context = appContext();
  if (context.config.sms.provider !== "telnyx") {
    // Without a verification key an inbound webhook cannot be trusted at all.
    return Response.json({ error: "webhook_not_configured" }, { status: 503 });
  }

  const signature = req.headers.get(SIGNATURE_HEADER);
  const timestamp = req.headers.get(TIMESTAMP_HEADER);
  if (!signature || !timestamp) {
    return Response.json({ error: "missing_signature" }, { status: 401 });
  }

  // The exact bytes Telnyx signed. Never req.json() before verification.
  const rawBody = await req.text();

  const verification = await verifyTelnyxSignature({
    rawBody,
    signature,
    timestamp,
    publicKey: context.config.sms.publicKey,
    now: new Date(),
  });
  if (!verification.valid) {
    return Response.json({ error: verification.reason }, { status: 401 });
  }

  const parsed = parseTelnyxEvent(rawBody);
  if (!parsed.ok) {
    // Acknowledge structurally unsupported events so Telnyx stops retrying them,
    // but record nothing.
    return Response.json({ ignored: parsed.reason }, { status: 200 });
  }

  const event = parsed.event;
  if (event.eventType === "message_received") {
    const senderHash = hashPhone(event.fromPhone, context.config.phoneSalt);

    // The contact row owns the single raw E.164; everything else keys by hash.
    await context.db.sql`
      insert into contacts (phone_e164, phone_hash)
      values (${event.fromPhone}, ${senderHash})
      on conflict (phone_hash) do nothing
    `;

    await acceptProviderEvent(context.db, {
      providerEventId: event.providerEventId,
      eventType: "message_received",
      providerMessageId: event.providerMessageId,
      senderHash,
      body: event.body,
      occurredAt: event.occurredAt,
    });

    // The acknowledgement is built FIRST — the message is durable and Telnyx is owed its
    // 200 regardless of what follows.
    const acknowledgement = Response.json({ received: true }, { status: 200 });

    // Started, deliberately not awaited: this is work that happens alongside the response,
    // not before it. `kickSenderPasses` swallows its own failures; `.catch` is the handler
    // a floating promise is owed so a rejection can never surface as an unhandled one.
    void kickSenderPasses(
      {
        runInbound: (senderHashes) =>
          runInboundPass(
            {
              db: context.db,
              interpreter: context.interpreter,
              inquiry: context.inquiry,
              clock: context.clock,
            },
            senderHashes,
          ),
        runOutbound: () => runOutboundPass({ context, clock: context.clock }),
      },
      senderHash,
    ).catch(() => {
      // Unreachable in practice; the kick resolves on every failure by construction.
    });

    return acknowledgement;
  }

  // Delivery callbacks share the same inbox, deduplication, and recovery path; they
  // are correlated to their dispatch attempt and never enter conversation state.
  const attempts = await context.db.sql`
    select id from outbox_dispatch_attempts
    where provider_message_id = ${event.providerMessageId}
  `;
  const dispatchAttemptId = attempts[0]?.id as string | undefined;
  if (!dispatchAttemptId) {
    return Response.json({ ignored: "unknown_dispatch_attempt" }, { status: 200 });
  }

  await acceptProviderEvent(context.db, {
    providerEventId: event.providerEventId,
    eventType: event.eventType,
    dispatchAttemptId,
    deliveryStatus: event.deliveryStatus,
    occurredAt: event.occurredAt,
  });

  return Response.json({ received: true }, { status: 200 });
}
