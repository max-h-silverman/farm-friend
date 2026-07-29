import { hashPhone } from "@farm-friend/core";
import { acceptProviderEvent } from "@farm-friend/db";
import { parseTelnyxEvent, verifyTelnyxSignature } from "@farm-friend/sms";
import { appContext } from "../../../../lib/composition";
import { enqueueSenderWork } from "../../../../lib/immediate-work";

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
// B-004 — after acknowledging, that sender's worker passes run immediately so the reply goes
// out in seconds rather than waiting for the next scheduled sweep.
//
// HOW THAT HAPPENS CHANGED WITH THE MOVE TO CLOUD RUN, and the change is the migration's
// main architectural gain. It used to be `waitUntil(kickSenderPasses(...))`: a promise
// registered with the Vercel runtime, running INSIDE this invocation, sharing its timeout and
// cancelled when that elapsed. Best-effort by construction — and B-009 was the sharper
// version, where a bare `void` meant the runtime never knew about the work at all and every
// inbound message was committed, acknowledged, and silently abandoned in production.
//
// Now this route enqueues a durable Cloud Task and returns. The queue owns the work: it
// survives this container, retries on its own policy, and calls `/api/internal/kick` to run
// the passes. Post-response work no longer depends on the lifetime of the request that
// scheduled it, which is the property `waitUntil` could not provide at any price.
//
// WHAT DID NOT CHANGE. The enqueue is still not allowed to fail the acknowledgement: the
// durable commit above has already succeeded, and turning a successful ingress into a failed
// invocation would make Telnyx retry a message Farm Friend has already accepted.
// `enqueueSenderWork` therefore never throws. The scheduled pass remains the recovery net for
// anything the queue misses and the only trigger for F-026's retention purge, so this is
// still a LATENCY optimization that owns no guarantee. `kick-wiring.test.ts` fails if the
// acknowledgement stops preceding it or if the enqueue is ever allowed to reject.

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

    // AWAITED, and that is the correct shape here — the opposite of what `waitUntil`
    // required.
    //
    // The old code could not await, because the awaited thing was the passes themselves:
    // a model call and a provider call inside the request Telnyx is waiting on. What is
    // awaited now is only the task CREATION — one bounded API call — and awaiting it is
    // what makes the work durable BEFORE this handler returns. A fire-and-forget enqueue
    // would reintroduce B-009 exactly: a floating promise the runtime may discard when the
    // container is reclaimed, leaving a message committed, acknowledged, and abandoned.
    //
    // `enqueueSenderWork` never throws and never retries, so this cannot delay the
    // acknowledgement beyond one attempt or fail an ingress that already succeeded. When
    // the queue is unreachable the result is simply `enqueued: false` and the scheduled
    // pass picks this sender up within the minute — latency lost, nothing else.
    await enqueueSenderWork(context.immediateWork, {
      senderHash,
      providerEventId: event.providerEventId,
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
