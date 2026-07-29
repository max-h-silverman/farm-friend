import { randomUUID, webcrypto } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LLMProvider, ModelSafeContext } from "@farm-friend/ai";
import { createInquiryModel, createInventoryInterpreter } from "@farm-friend/ai";
import { FixedClock, hashPhone } from "@farm-friend/core";
import { authorizeDispatch, createDb, type Db, type Sql } from "@farm-friend/db";
import { runInboundPass } from "./workers";

// F-023 — inbound SMS routed END TO END, from a validly signed webhook POST to the durable
// consequence, against real Postgres.
//
// The point of this suite is that it drives the REAL webhook route handler
// (`apps/web/app/api/sms/webhook/route.ts`) rather than a reimplementation of it. Before
// F-023 the ingress suite proved the handler persisted correctly and stopped there; the gap
// was that nothing then ROUTED what it persisted. A test that re-implemented ingress would
// have kept passing across that entire gap, so it must be the real module.
//
// The webhook route imports the process-wide composition root, so the environment is set up
// before it is imported and the module is loaded dynamically inside `beforeAll`.

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");
const databaseUrl = process.env.DATABASE_URL;
const phoneSalt = "f023-test-salt";

// Fixture instants are OFFSETS from a clock-derived anchor, never calendar literals: a
// suite whose result depends on the date is not a suite (B-003).
const T0 = new Date(Date.now() - 24 * 60 * 60 * 1000);
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

function requiredDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required; a skipped integration run is not green");
  }
  return databaseUrl;
}

type KeyPair = { privateKey: webcrypto.CryptoKey; publicKey: webcrypto.CryptoKey };

/**
 * A model that FAILS THE TEST if it is ever called.
 *
 * "STOP unsubscribes with no model call anywhere on the path" is the acceptance criterion
 * most easily faked with a comment. Here the provider itself throws, so a routing order that
 * consults a seam before deterministic parsing cannot pass — regardless of what any comment
 * claims.
 */
class ForbiddenProvider implements LLMProvider {
  readonly name = "forbidden";
  calls = 0;
  async generateJson(ctx: ModelSafeContext): Promise<string> {
    this.calls += 1;
    throw new Error(`MODEL CALLED on a deterministic path (seam ${ctx.seam})`);
  }
}

/** A model that returns scripted output per seam, for the free-text paths. */
class ScriptedProvider implements LLMProvider {
  readonly name = "scripted";
  readonly seen: ModelSafeContext[] = [];
  constructor(private readonly payloads: Record<string, string>) {}
  async generateJson(ctx: ModelSafeContext): Promise<string> {
    this.seen.push(ctx);
    const payload = this.payloads[ctx.seam];
    if (payload === undefined) throw new Error(`no payload for seam ${ctx.seam}`);
    return payload;
  }
}

describe("inbound routing end to end (integration)", () => {
  let adminClient: Sql | undefined;
  let sql: Sql | undefined;
  let db: Db | undefined;
  let testDatabaseName: string | undefined;
  let keys: KeyPair;
  let webhookPOST: (req: Request) => Promise<Response>;

  const customerPhone = "+12065550811";
  const customerHash = hashPhone(customerPhone, phoneSalt);
  const farmerPhone = "+12065550822";
  const farmerHash = hashPhone(farmerPhone, phoneSalt);

  const timestamp = String(Math.floor(Date.now() / 1000));

  beforeAll(async () => {
    const baseUrl = requiredDatabaseUrl();
    testDatabaseName = `farm_friend_f023_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);

    const url = new URL(baseUrl);
    url.pathname = `/${testDatabaseName}`;

    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });

    sql = postgres(url.toString(), { max: 4 });
    db = createDb(url.toString());

    keys = (await webcrypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as KeyPair;
    const publicKey = Buffer.from(
      await webcrypto.subtle.exportKey("raw", keys.publicKey),
    ).toString("base64");

    // The real route reads the process-wide composition root, so configure it BEFORE the
    // module is imported. Telnyx is selected because the route refuses to trust an inbound
    // webhook without a verification key.
    process.env.DATABASE_URL = url.toString();
    process.env.PHONE_HASH_SALT = phoneSalt;
    // Required by the composition root since F-032. Nothing on the SMS path uses them; they
    // are set so `appContext()` resolves at all.
    process.env.MAGIC_LINK_SECRET = "test-magic-secret";
    process.env.PUBLIC_BASE_URL = "https://ff.example";
    // GL-019: no default provider. These suites drive deterministic paths and assert no
    // model is reached, so the stub is the right choice — it now has to be stated.
    process.env.LLM_PROVIDER = "stub";
    process.env.SMS_PROVIDER = "telnyx";
    process.env.TELNYX_API_KEY = "test-api-key";
    process.env.TELNYX_MESSAGING_PROFILE_ID = "test-profile";
    process.env.TELNYX_FROM_NUMBER = "+12065550999";
    process.env.TELNYX_PUBLIC_KEY = publicKey;

    const route = await import("../app/api/sms/webhook/route");
    webhookPOST = route.POST;
  }, 60_000);

  afterAll(async () => {
    if (db) await db.close();
    if (sql) await sql.end({ timeout: 5 });
    if (adminClient && testDatabaseName) {
      await adminClient.unsafe(
        `drop database if exists "${testDatabaseName}" with (force)`,
      );
      await adminClient.end({ timeout: 5 });
    }
  }, 30_000);

  function client(): Sql {
    if (!sql) throw new Error("test database is not initialized");
    return sql;
  }

  function database(): Db {
    if (!db) throw new Error("test database is not initialized");
    return db;
  }

  beforeEach(async () => {
    await client()`
      truncate table provider_inbox_events, sms_messages, outbox_work, sms_consents,
        consent_transition_watermarks, sender_states, inventory_publication_proposals,
        inventory_revisions, inventory_entries, flags, farmer_authorizations,
        farm_approvals, sales_locations, farms, contacts
      restart identity cascade
    `;
    await client()`
      insert into contacts (phone_e164, phone_hash)
      values (${customerPhone}, ${customerHash}), (${farmerPhone}, ${farmerHash})
    `;
  });

  /** Sign and POST a `message.received` webhook through the REAL route handler. */
  async function deliverInbound(input: {
    fromPhone: string;
    text: string;
    occurredAt?: Date;
    providerEventId?: string;
  }): Promise<Response> {
    const rawBody = JSON.stringify({
      data: {
        event_type: "message.received",
        id: input.providerEventId ?? `evt-${randomUUID()}`,
        occurred_at: (input.occurredAt ?? at(0)).toISOString(),
        payload: {
          id: `msg-${randomUUID()}`,
          from: { phone_number: input.fromPhone },
          to: [{ phone_number: "+12065550999" }],
          text: input.text,
        },
      },
    });

    const signature = Buffer.from(
      await webcrypto.subtle.sign(
        "Ed25519",
        keys.privateKey,
        Buffer.from(`${timestamp}|${rawBody}`, "utf8"),
      ),
    ).toString("base64");

    return webhookPOST(
      new Request("https://farm-friend.test/api/sms/webhook", {
        method: "POST",
        headers: {
          "telnyx-signature-ed25519": signature,
          "telnyx-timestamp": timestamp,
          "content-type": "application/json",
        },
        body: rawBody,
      }),
    );
  }

  /**
   * Run the inbound pass with a model that must never be reached.
   *
   * B-004 note: the route now KICKS this sender's passes after acknowledging, so the
   * webhook is no longer inert and a claimed event may already be in flight when this runs.
   * `settleKick` waits for that to finish first, which keeps every assertion below about
   * the DURABLE consequence rather than about which processor got there first. When the
   * kick has already handled the event, this pass finds nothing pending and is a no-op —
   * exactly what the row lock guarantees, and what B-004's own race tests prove directly.
   *
   * The "no model on the compliance path" guarantee does not rest on this provider: it is a
   * structural property proven in `routing.test.ts` by a seam that throws on any call, and
   * a second time by the kick's own passes here reaching the same durable outcome.
   */
  async function runPassWithForbiddenModel(): Promise<ForbiddenProvider> {
    await settleKick();
    const provider = new ForbiddenProvider();
    await runInboundPass({
      db: database(),
      interpreter: createInventoryInterpreter(provider),
      inquiry: createInquiryModel(provider),
      clock: new FixedClock(at(1)),
    });
    return provider;
  }

  /**
   * Assert the route's own KICK carried the event to `processed` — end to end, through the
   * real webhook, with no test-supplied worker involved.
   *
   * What this DOES prove: the B-004 kick reaches the same durable consequence the local
   * pass used to, so the webhook is genuinely doing the work in production shape.
   *
   * What it does NOT prove, and must not be read as proving: "no model on the compliance
   * path." Sabotage established the limit honestly — moving the `freeText` call ahead of
   * `parseCommand` still passes here, because these fixtures leave the database empty, an
   * empty retrieval is short-circuited in code before any seam (Golden Rule #4), and the
   * composition root's response-less stub is therefore never reached. That guarantee is
   * owned structurally by `routing.test.ts`, whose throwing seam fails 8 tests on exactly
   * this sabotage, and it stays owned there.
   */
  async function expectKickProcessedIt(): Promise<void> {
    // Poll for the kick to reach the TERMINAL state on its own. Deliberately not
    // `settleKick`: an event the kick abandoned stays `pending`, so waiting for `pending` to
    // clear would simply time out and let a local pass finish the job — which is exactly how
    // an earlier version of this helper passed the model-first sabotage.
    const deadline = Date.now() + 5_000;
    let states: string[] = [];
    while (Date.now() < deadline) {
      const rows = await client()`
        select state from provider_inbox_events where event_type = 'message_received'
      `;
      states = rows.map((row) => row.state as string);
      if (states.length > 0 && states.every((state) => state === "processed")) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(
      `the route's kick did not process the event; states=${JSON.stringify(states)}. ` +
        "A seam consulted on a compliance path throws in the composition root's " +
        "response-less stub provider, which leaves the event unprocessed.",
    );
  }

  /**
   * Persist a verified inbound message WITHOUT the route's B-004 kick.
   *
   * For the tests that must own the model interaction: they script a provider and then run
   * their own pass, so the event has to still be there when they do. The kick would consume
   * it first using the composition root's real provider, and the scripted seam would never
   * be reached — the test would be asserting against a different model than the one it set
   * up. This commits exactly what the route commits before acknowledging, so what follows is
   * ordinary pending work.
   *
   * Signature verification and the minimized projection are proven by the real-route tests
   * above and by `ingress.integration.test.ts`; what these tests own is what happens AFTER.
   */
  async function deliverInboundOnly(input: {
    fromPhone: string;
    text: string;
    occurredAt?: Date;
    providerEventId?: string;
  }): Promise<void> {
    const senderHash = hashPhone(input.fromPhone, phoneSalt);
    const { acceptProviderEvent } = await import("@farm-friend/db");
    await acceptProviderEvent(database(), {
      providerEventId: input.providerEventId ?? `evt-${randomUUID()}`,
      eventType: "message_received",
      providerMessageId: `msg-${randomUUID()}`,
      senderHash,
      body: input.text,
      occurredAt: input.occurredAt ?? at(0),
    });
  }

  /**
   * Wait until no inbound event is mid-claim, so a test's own pass is not racing the kick
   * the route just started. Bounded, and a timeout simply proceeds: a stuck claim is a
   * failure the assertions below should report, not one to hide behind a hang.
   */
  async function settleKick(): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
      const rows = await client()`
        select count(*)::integer as count from provider_inbox_events
        where state in ('pending', 'processing')
      `;
      if (((rows[0]?.count as number) ?? 0) === 0) return;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  describe("compliance keywords, with no model on the path", () => {
    it("a verified STOP unsubscribes end to end and calls no model", async () => {
      const response = await deliverInbound({ fromPhone: customerPhone, text: "STOP" });
      expect(response.status).toBe(200);

      // The route's kick carries this end to end in production shape.
      await expectKickProcessedIt();

      // ...and separately, with the kick out of the way, the ForbiddenProvider pass still
      // owns "no seam is consulted on this path" exactly as F-023 wrote it.
      await client()`truncate table provider_inbox_events, sms_messages, sms_consents,
        consent_transition_watermarks, sender_states, outbox_work restart identity cascade`;
      await deliverInboundOnly({ fromPhone: customerPhone, text: "STOP" });
      const provider = await runPassWithForbiddenModel();

      // The durable consequence, not the return value.
      const consent = await client()`
        select state from sms_consents where recipient_hash = ${customerHash}
      `;
      expect(consent[0]?.state).toBe("stopped");
      // Proven, not asserted in a comment: the seam threw if it was ever reached.
      expect(provider.calls).toBe(0);

      const events = await client()`
        select state from provider_inbox_events
      `;
      expect(events[0]?.state).toBe("processed");
    });

    it("every registered opt-out keyword unsubscribes through the real route", async () => {
      for (const word of ["STOPALL", "UNSUBSCRIBE", "CANCEL", "END", "QUIT"]) {
        await client()`truncate table sms_consents, consent_transition_watermarks,
          provider_inbox_events, sms_messages, sender_states, outbox_work
          restart identity cascade`;

        await deliverInbound({ fromPhone: customerPhone, text: word });
        const provider = await runPassWithForbiddenModel();

        const consent = await client()`
          select state from sms_consents where recipient_hash = ${customerHash}
        `;
        expect(consent[0]?.state, word).toBe("stopped");
        expect(provider.calls, word).toBe(0);
      }
    });

    it("queues the registered opt-out copy as required_reply, which STOP cannot suppress", async () => {
      await deliverInbound({ fromPhone: customerPhone, text: "STOP" });
      await runPassWithForbiddenModel();

      const work = await client()`
        select message_category, body from outbox_work
        where recipient_hash = ${customerHash}
      `;
      expect(work).toHaveLength(1);
      expect(work[0]?.message_category).toBe("required_reply");
      expect(work[0]?.body).toMatch(/unsubscribed/i);
    });

    it("JOIN establishes the one launch program with its capture source recorded", async () => {
      await deliverInbound({ fromPhone: customerPhone, text: "JOIN" });
      const provider = await runPassWithForbiddenModel();

      const consent = await client()`
        select state, capture_source from sms_consents
        where recipient_hash = ${customerHash}
      `;
      expect(consent[0]?.state).toBe("active");
      expect(consent[0]?.capture_source).toBe("join");
      expect(provider.calls).toBe(0);
    });

    it("START restores consent with its own distinct capture source", async () => {
      await deliverInbound({ fromPhone: customerPhone, text: "START" });
      await runPassWithForbiddenModel();

      const consent = await client()`
        select state, capture_source from sms_consents
        where recipient_hash = ${customerHash}
      `;
      expect(consent[0]?.state).toBe("active");
      expect(consent[0]?.capture_source).toBe("start");
    });

    it("an older START delivered after a newer STOP cannot restore consent", async () => {
      // The consent watermark is provider-time ordered, so late delivery cannot resurrect
      // a subscription the sender already ended.
      await deliverInbound({
        fromPhone: customerPhone,
        text: "STOP",
        occurredAt: at(10),
      });
      await runPassWithForbiddenModel();

      await deliverInbound({
        fromPhone: customerPhone,
        text: "START",
        occurredAt: at(5),
      });
      await runPassWithForbiddenModel();

      const consent = await client()`
        select state from sms_consents where recipient_hash = ${customerHash}
      `;
      expect(consent[0]?.state).toBe("stopped");
    });

    it("HELP returns the registered help auto-response without touching consent", async () => {
      await deliverInbound({ fromPhone: customerPhone, text: "HELP" });
      const provider = await runPassWithForbiddenModel();

      const work = await client()`
        select message_category, body from outbox_work
        where recipient_hash = ${customerHash}
      `;
      expect(work[0]?.body).toMatch(/board@vigavashon\.org/);
      expect(work[0]?.message_category).toBe("required_reply");
      expect(provider.calls).toBe(0);

      // Asking for help is not opting in.
      const consent = await client()`
        select state from sms_consents where recipient_hash = ${customerHash}
      `;
      expect(consent).toHaveLength(0);
    });

    it("INFO returns the same registered help auto-response", async () => {
      await deliverInbound({ fromPhone: customerPhone, text: "INFO" });
      await runPassWithForbiddenModel();

      const work = await client()`
        select body from outbox_work where recipient_hash = ${customerHash}
      `;
      expect(work[0]?.body).toMatch(/board@vigavashon\.org/);
    });

    it("FLAG creates a durable review item without a model call", async () => {
      await deliverInbound({ fromPhone: customerPhone, text: "FLAG" });
      const provider = await runPassWithForbiddenModel();

      const flags = await client()`
        select contact_hash, reason_code, status from flags
      `;
      expect(flags).toHaveLength(1);
      expect(flags[0]?.contact_hash).toBe(customerHash);
      expect(flags[0]?.status).toBe("open");
      expect(provider.calls).toBe(0);
    });
  });

  describe("duplicates, ordering, and serialization at the ROUTE level", () => {
    it("a retried webhook delivery produces exactly one consequence", async () => {
      // Telnyx retries on any non-2xx or timeout; the same event ID must be a no-op.
      const providerEventId = `evt-${randomUUID()}`;
      const first = await deliverInbound({
        fromPhone: customerPhone,
        text: "JOIN",
        providerEventId,
      });
      const second = await deliverInbound({
        fromPhone: customerPhone,
        text: "JOIN",
        providerEventId,
      });
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);

      await runPassWithForbiddenModel();
      await runPassWithForbiddenModel();

      const events = await client()`
        select count(*)::integer as count from provider_inbox_events
      `;
      expect(events[0]?.count).toBe(1);

      // One opt-in reply, not two: the outbox logical key deduplicates.
      const work = await client()`
        select count(*)::integer as count from outbox_work
        where recipient_hash = ${customerHash}
      `;
      expect(work[0]?.count).toBe(1);
    });

    it("a stale event fails closed and mutates nothing", async () => {
      // Advance the sender's conversation watermark with a newer event first.
      await deliverInbound({
        fromPhone: customerPhone,
        text: "HELP",
        occurredAt: at(20),
      });
      await runPassWithForbiddenModel();

      // Now deliver an OLDER free-text event. It must not reach a model, because a stale
      // event is rejected before routing.
      await deliverInbound({
        fromPhone: customerPhone,
        text: "what do you have?",
        occurredAt: at(5),
      });
      const provider = await runPassWithForbiddenModel();

      expect(provider.calls).toBe(0);
      const rejected = await client()`
        select state, failure_code from provider_inbox_events
        where state = 'rejected'
      `;
      expect(rejected).toHaveLength(1);
      expect(rejected[0]?.failure_code).toBe("stale_conversation_event");
    });

    it("a DELAYED STOP still unsubscribes, even behind a newer processed message (GL-002)", async () => {
      // The failure this pins down: conversation staleness was rejecting events BEFORE they
      // were parsed, so a STOP delayed in the carrier network — arriving after a newer
      // ordinary message had already advanced the conversation watermark — was discarded as
      // `stale_conversation_event` and never reached `applyConsentTransition` at all.
      //
      // That is a compliance failure, not an ordering nicety: the sender said STOP, the
      // carrier delivered it, and Farm Friend recorded them as still subscribed.
      //
      // Consent has its own watermark (`consent_transition_watermarks`), entirely separate
      // from `sender_states.conversation_occurred_at`, and it does its own ordering with STOP
      // winning an exact tie. So a late STOP is safe to route; only the conversation
      // watermark had any objection to it, and consent is not conversation state.
      await deliverInbound({ fromPhone: customerPhone, text: "JOIN", occurredAt: at(5) });
      await runPassWithForbiddenModel();

      // A newer ordinary message is fully processed and advances the conversation watermark.
      await deliverInbound({
        fromPhone: customerPhone,
        text: "HELP",
        occurredAt: at(30),
      });
      await runPassWithForbiddenModel();

      // The STOP is OLDER than that watermark: this is the delayed-delivery case.
      await deliverInbound({
        fromPhone: customerPhone,
        text: "STOP",
        occurredAt: at(20),
      });
      const provider = await runPassWithForbiddenModel();

      // 1. Consent actually changed — the durable consequence, not the return value.
      const consent = await client()`
        select state from sms_consents where recipient_hash = ${customerHash}
      `;
      expect(consent[0]?.state).toBe("stopped");

      // 2. It was processed, not rejected as stale.
      const stopEvent = await client()`
        select event.state, event.failure_code
        from provider_inbox_events as event
        join sms_messages as message on message.id = event.message_id
        where message.body = 'STOP'
      `;
      expect(stopEvent[0]?.state).toBe("processed");
      expect(stopEvent[0]?.failure_code).toBeNull();

      // 3. Still no model call: a delayed STOP is routed deterministically like any other.
      expect(provider.calls).toBe(0);

      // 4. The point of all of it — a later proactive send is now suppressed. Consent that
      //    changes state but does not reach the dispatch guard would be a paper opt-out.
      const outboxId = randomUUID();
      await client()`
        insert into outbox_work (
          id, recipient_hash, logical_key, message_category, body, body_expires_at,
          state, available_at, created_at
        ) values (
          ${outboxId}, ${customerHash}, ${`gl002-proactive-${outboxId}`},
          'inventory_prompt', 'Anything fresh at your stand today?', ${at(60 * 24 * 30)},
          'queued', ${at(40)}, ${at(40)}
        )
      `;
      const authorization = await authorizeDispatch(database(), {
        outboxWorkId: outboxId,
        now: at(41),
      });
      expect(authorization.status).toBe("suppressed");
    });

    it("a delayed STOP does NOT resurrect stale ordinary conversation handling", async () => {
      // The guard on the fix. Routing a late consent command must not become "route
      // everything late": an ordinary message and a confirmation token that arrive behind a
      // newer processed event are still refused, because those DO mutate conversation state
      // and have no independent watermark to order them.
      await deliverInbound({
        fromPhone: customerPhone,
        text: "HELP",
        occurredAt: at(30),
      });
      await runPassWithForbiddenModel();

      for (const text of ["what do you have?", "YES"]) {
        await deliverInbound({ fromPhone: customerPhone, text, occurredAt: at(10) });
      }
      const provider = await runPassWithForbiddenModel();
      await runPassWithForbiddenModel();

      const rejected = await client()`
        select event.failure_code
        from provider_inbox_events as event
        join sms_messages as message on message.id = event.message_id
        where event.state = 'rejected'
        order by message.body
      `;
      expect(rejected).toHaveLength(2);
      expect(rejected.map((row) => row.failure_code)).toEqual([
        "stale_conversation_event",
        "stale_conversation_event",
      ]);
      expect(provider.calls).toBe(0);
    });

    it("concurrent passes over one sender claim the event exactly once", async () => {
      await deliverInboundOnly({ fromPhone: customerPhone, text: "JOIN" });

      // Two passes racing: the per-sender row lock must let only one claim the event.
      const [a, b] = await Promise.all([
        runInboundPass({
          db: database(),
          interpreter: createInventoryInterpreter(new ForbiddenProvider()),
          inquiry: createInquiryModel(new ForbiddenProvider()),
          clock: new FixedClock(at(1)),
        }),
        runInboundPass({
          db: database(),
          interpreter: createInventoryInterpreter(new ForbiddenProvider()),
          inquiry: createInquiryModel(new ForbiddenProvider()),
          clock: new FixedClock(at(1)),
        }),
      ]);

      expect(a.processed + b.processed).toBe(1);
      const work = await client()`
        select count(*)::integer as count from outbox_work
        where recipient_hash = ${customerHash}
      `;
      expect(work[0]?.count).toBe(1);
    });
  });

  describe("free text — the only path a model may run on", () => {
    /** An approved farm with one location and one verified authorized farmer. */
    async function seedFarmer(): Promise<{ locationId: string; farmId: string }> {
      const farm = await client()`
        insert into farms (name) values ('Test Farm') returning id
      `;
      const farmId = farm[0]?.id as string;

      const adminContact = await client()`
        insert into contacts (phone_e164, phone_hash)
        values ('+12065550833', ${"9".repeat(64)})
        on conflict (phone_hash) do update set phone_hash = excluded.phone_hash
        returning id
      `;
      const admin = await client()`
        insert into administrators (email, contact_id, authorized_at)
        values ('routing-admin@viga.example', ${adminContact[0]?.id as string}, ${at(-60)})
        returning id
      `;

      const location = await client()`
        insert into sales_locations (
          farm_id, kind, name, public_address, public_latitude, public_longitude,
          farm_bucks_accepted, farm_bucks_eligible
        )
        values (${farmId}, 'farm_stand', 'Test Stand', '1 Test Rd', 47.45, -122.46,
                false, false)
        returning id
      `;
      const contact = await client()`
        select id from contacts where phone_hash = ${farmerHash}
      `;
      await client()`
        insert into farmer_authorizations (
          farm_id, contact_id, phone_verified_at, authorized_at
        )
        values (${farmId}, ${contact[0]?.id as string}, ${at(-60)}, ${at(-59)})
      `;
      await client()`
        insert into farm_approvals (farm_id, administrator_id, approved_at)
        values (${farmId}, ${admin[0]?.id as string}, ${at(-58)})
      `;
      return { locationId: location[0]?.id as string, farmId };
    }

    it("a farmer's inventory text opens exactly one proposal and queues its prompt", async () => {
      await seedFarmer();
      await deliverInboundOnly({ fromPhone: farmerPhone, text: "kale and eggs today" });

      const provider = new ScriptedProvider({
        "inventory-extraction": JSON.stringify({
          kind: "edits",
          additions: [{ itemName: "kale" }, { itemName: "eggs" }],
          changes: [],
          removals: [],
        }),
      });

      await runInboundPass({
        db: database(),
        interpreter: createInventoryInterpreter(provider),
        inquiry: createInquiryModel(provider),
        clock: new FixedClock(at(1)),
      });

      const proposals = await client()`
        select id, state, proposal_version, activated_at
        from inventory_publication_proposals where sender_hash = ${farmerHash}
      `;
      expect(proposals).toHaveLength(1);
      expect(proposals[0]?.state).toBe("open");

      // NOT yet activated: the prompt has not been accepted by the provider, so no token
      // can commit it. This is what "a token predating its prompt cannot commit" rests on.
      expect(proposals[0]?.activated_at).toBeNull();

      const work = await client()`
        select message_category from outbox_work where recipient_hash = ${farmerHash}
      `;
      expect(work[0]?.message_category).toBe("inventory_confirmation");
    });

    it("a YES arriving before its prompt was accepted commits nothing", async () => {
      await seedFarmer();
      await deliverInboundOnly({
        fromPhone: farmerPhone,
        text: "kale and eggs",
        occurredAt: at(0),
      });

      const provider = new ScriptedProvider({
        "inventory-extraction": JSON.stringify({
          kind: "edits",
          additions: [{ itemName: "kale" }],
          changes: [],
          removals: [],
        }),
      });
      await runInboundPass({
        db: database(),
        interpreter: createInventoryInterpreter(provider),
        inquiry: createInquiryModel(provider),
        clock: new FixedClock(at(1)),
      });

      // Precondition, asserted rather than assumed: the proposal is genuinely open and
      // un-activated. Without this the test could pass because NOTHING was proposed, which
      // is a different bug wearing the same green check.
      const before = await client()`
        select state, activated_at, base_revision_id
        from inventory_publication_proposals where sender_hash = ${farmerHash}
      `;
      expect(before).toHaveLength(1);
      expect(before[0]?.state).toBe("open");
      expect(before[0]?.activated_at).toBeNull();

      // The farmer texts YES while the prompt is still queued (never provider-accepted).
      await deliverInbound({
        fromPhone: farmerPhone,
        text: "YES",
        occurredAt: at(2),
      });
      const forbidden = await runPassWithForbiddenModel();

      // No publication, and no model consulted for the token.
      const revisions = await client()`
        select count(*)::integer as count from inventory_revisions
      `;
      expect(revisions[0]?.count).toBe(0);
      expect(forbidden.calls).toBe(0);

      // POSITIVE CONTROL: the SAME proposal publishes once its prompt is accepted, with
      // only activation changed. Without this, "nothing published" could be caused by any
      // unrelated refusal (a base conflict, a missing approval) and the test would still
      // be green while proving nothing about activation.
      await client()`
        update inventory_publication_proposals
        set activation_outbox_id = (
              select id from outbox_work where recipient_hash = ${farmerHash}
                and message_category = 'inventory_confirmation' limit 1
            ),
            activated_version = proposal_version,
            activated_at = ${at(3)},
            expires_at = ${at(180)}
        where sender_hash = ${farmerHash} and state = 'open'
      `;
      await deliverInboundOnly({
        fromPhone: farmerPhone,
        text: "YES",
        occurredAt: at(4),
      });
      await runPassWithForbiddenModel();

      const afterActivation = await client()`
        select count(*)::integer as count from inventory_revisions
      `;
      expect(
        afterActivation[0]?.count,
        "the same YES must publish once its prompt is activated",
      ).toBe(1);

      // Consumed exactly once by the token that was finally eligible.
      const proposals = await client()`
        select state, consumed_token from inventory_publication_proposals
        where sender_hash = ${farmerHash}
      `;
      expect(proposals[0]?.state).toBe("accepted");
      expect(proposals[0]?.consumed_token).toBe("yes");
    });

    it("a customer question is answered from retrieved rows, not model prose", async () => {
      const { locationId, farmId } = await seedFarmer();

      // Publish a current revision the inquiry can retrieve. A published revision must
      // cite the proposal, authorization, and approval it came from, so the fixture
      // builds a consumed proposal rather than inventing a revision from nothing.
      const prompt = await client()`
        insert into outbox_work (
          logical_key, recipient_hash, message_category, body, body_expires_at,
          available_at, state, dispatch_authorized_at, completed_at
        )
        values (${`seed-${randomUUID()}`}, ${farmerHash}, 'inventory_confirmation',
                'Confirm', ${new Date(T0.getTime() + 172_800_000)}, ${at(-31)}, 'sent',
                ${at(-31)}, ${at(-31)})
        returning id
      `;
      const proposal = await client()`
        insert into inventory_publication_proposals (
          sender_hash, sales_location_id, payload, schema_version, proposal_version,
          yes_token, no_token, base_is_first_publication, state,
          activation_outbox_id, activated_version, activated_at, expires_at,
          consumed_token, consumption_provider_event_id, closed_at
        )
        values (
          ${farmerHash}, ${locationId}, ${client().json({ entries: [] })}, '1', 1,
          'YES', 'NO', true, 'accepted',
          ${prompt[0]?.id as string}, 1, ${at(-31)},
          ${new Date(T0.getTime() + 3_600_000)}, 'yes', ${`ev-${randomUUID()}`},
          ${at(-31)}
        )
        returning id
      `;
      const auth = await client()`
        select id from farmer_authorizations where farm_id = ${farmId} limit 1
      `;
      const approval = await client()`
        select id from farm_approvals where farm_id = ${farmId} limit 1
      `;
      const revision = await client()`
        insert into inventory_revisions (
          farm_id, sales_location_id, proposal_id, published_by_authorization_id,
          farm_approval_id, published_at, is_current
        )
        values (${farmId}, ${locationId}, ${proposal[0]?.id as string},
                ${auth[0]?.id as string}, ${approval[0]?.id as string}, ${at(-30)}, true)
        returning id
      `;
      await client()`
        insert into inventory_entries (
          inventory_revision_id, sales_location_id, item_name, sort_order
        )
        values (${revision[0]?.id as string}, ${locationId}, 'kale', 0)
      `;

      await deliverInboundOnly({ fromPhone: customerPhone, text: "who has kale?" });

      // The model interprets and selects identifiers; it never authors the answer. This
      // one also tries to smuggle prose through the selection seam.
      const provider = new ScriptedProvider({
        "inquiry-interpretation": JSON.stringify({
          kind: "lookup",
          items: ["kale"],
          ranking: "freshest",
          outOfScopeRequest: false,
          originDependent: false,
        }),
        "grounded-fact-selection": JSON.stringify({
          kind: "selection",
          factIds: [locationId],
        }),
      });

      await runInboundPass({
        db: database(),
        interpreter: createInventoryInterpreter(provider),
        inquiry: createInquiryModel(provider),
        clock: new FixedClock(at(1)),
      });

      const work = await client()`
        select message_category, body from outbox_work
        where recipient_hash = ${customerHash}
      `;
      expect(work).toHaveLength(1);
      expect(work[0]?.message_category).toBe("inquiry_reply");
      // Code rendered it: the stand name and a recency label the model never supplied.
      expect(work[0]?.body).toContain("Test Stand");
      expect(work[0]?.body).toMatch(/updated .* ago|updated just now/);
    });

    it("a customer inquiry creates no durable consent", async () => {
      await deliverInboundOnly({ fromPhone: customerPhone, text: "who has kale?" });

      const provider = new ScriptedProvider({
        "inquiry-interpretation": JSON.stringify({
          kind: "lookup",
          items: ["kale"],
          ranking: "freshest",
          outOfScopeRequest: false,
          originDependent: false,
        }),
      });
      await runInboundPass({
        db: database(),
        interpreter: createInventoryInterpreter(provider),
        inquiry: createInquiryModel(provider),
        clock: new FixedClock(at(1)),
      });

      // Answering a question is not enrollment: it licenses this reply and nothing later.
      const consent = await client()`
        select count(*)::integer as count from sms_consents
        where recipient_hash = ${customerHash}
      `;
      expect(consent[0]?.count).toBe(0);
    });
  });
});
