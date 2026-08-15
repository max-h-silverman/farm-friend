import { randomUUID, webcrypto } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LLMProvider, ModelSafeContext } from "@farm-friend/ai";
import {
  createRequestClassificationModel,
  createCatalogMatcher,
  createInventoryInterpreter,
} from "@farm-friend/ai";
import {
  renderFarmerAuthorizedNotification,
  renderFarmerOnboardingComplete,
  FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT,
  CONTACT_CARD_PATH,
  CUSTOMER_WELCOME,
  FixedClock,
  hashPhone,
} from "@farm-friend/core";
import { authorizeDispatch, createDb, type Db, type Sql } from "@farm-friend/db";
import { offeringFactId } from "./inquiry";
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
  calls = 0;
  async generateJson(ctx: ModelSafeContext): Promise<string> {
    this.calls += 1;
    throw new Error(`MODEL CALLED on a deterministic path (seam ${ctx.seam})`);
  }
}

/** A model that returns scripted output per seam, for the free-text paths. */
class ScriptedProvider implements LLMProvider {
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
  let kickPOST: (req: Request) => Promise<Response>;
  const queuedKicks = new Set<Promise<void>>();

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
    process.env.PUBLIC_BASE_URL = "https://ff.example";
    process.env.PUBLIC_MAP_URL = "https://www.vigavashon.org/farm-stand-map#map";
    // GL-019: no default provider. These suites drive deterministic paths and assert no
    // model is reached, so the stub is the right choice — it now has to be stated.
    process.env.LLM_PROVIDER = "stub";
    process.env.SMS_PROVIDER = "telnyx";
    process.env.TELNYX_API_KEY = "test-api-key";
    process.env.TELNYX_MESSAGING_PROFILE_ID = "test-profile";
    process.env.TELNYX_FROM_NUMBER = "+12065550999";
    process.env.TELNYX_PUBLIC_KEY = publicKey;

    // The Cloud Tasks queue, configured for real so the composition root builds the actual
    // adapter rather than the no-op. Its HTTP calls are intercepted at the `fetch` boundary
    // and turned into invocations of the REAL kick route — what Cloud Tasks does in
    // production, minus the network. The webhook, the enqueue seam, the task payload, the
    // kick route, and both worker passes are all production code here.
    process.env.DEPLOYMENT_ROLE = "worker";
    process.env.CLOUD_TASKS_PROJECT = "test-project";
    process.env.CLOUD_TASKS_LOCATION = "us-west1";
    process.env.CLOUD_TASKS_QUEUE = "test-queue";
    process.env.CLOUD_TASKS_TARGET_URL = "https://worker.test/api/internal/kick";
    process.env.CLOUD_TASKS_INVOKER_SERVICE_ACCOUNT = "invoker@test.iam.gserviceaccount.com";

    const route = await import("../app/api/sms/webhook/route");
    webhookPOST = route.POST;
    const kickRoute = await import("../app/api/internal/kick/route");
    kickPOST = kickRoute.POST;

    // Intercept only the two Google endpoints the adapter touches; everything else, including
    // the Telnyx transport this suite already relies on, is untouched.
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const target = typeof input === "string" ? input : input.toString();

      if (target.startsWith("http://metadata.google.internal/")) {
        return Response.json({ access_token: "test-access-token" });
      }

      if (target.startsWith("https://cloudtasks.googleapis.com/")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          task: { httpRequest: { body: string } };
        };
        const payload = JSON.parse(
          Buffer.from(body.task.httpRequest.body, "base64").toString("utf8"),
        ) as { senderHash: string; providerEventId: string };

        // Asynchronous, as Cloud Tasks is: delivering inline would make the webhook's own
        // response wait on the passes and invert the property these suites prove. The fixture
        // still retains the task promise so a later reset cannot race its outbound pass.
        const kick = new Promise<void>((resolve) => setTimeout(resolve, 0))
          .then(() => kickPOST(
            new Request("https://worker.test/api/internal/kick", {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(payload),
            }),
          ))
          .then(() => undefined)
          .catch(() => {
            // Retried by the queue in production; the scheduled pass is the net here.
          });
        queuedKicks.add(kick);
        void kick.finally(() => queuedKicks.delete(kick));

        return Response.json({ name: "projects/p/locations/l/queues/q/tasks/t" });
      }

      return realFetch(input, init);
    }) as typeof globalThis.fetch;
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
        farm_approvals, admin_login_failures, admin_sessions, administrators,
        sales_locations, farms, contacts
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
      classifier: createRequestClassificationModel(provider),
      stockOut: {
            parseItem: async () => {
              throw new Error("the stock-out seam must not run on this path");
            },
          },
      interpreter: createInventoryInterpreter(provider),
      catalogMatcher: createCatalogMatcher(provider),
      clock: new FixedClock(at(1)),
      // F-040: configured origin for a farmer standing link. Never a request header.
      publicBaseUrl: "https://farmfriend.example",
      publicMapUrl: "https://www.vigavashon.org/farm-stand-map#map",
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
      if (states.length > 0 && states.every((state) => state === "processed")) {
        await settleKick();
        return;
      }
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
    // A terminal inbox row proves only that the inbound half finished. The task still runs
    // outbound dispatch and can be reading consent while the next fixture reset seeks an
    // exclusive table lock.
    await Promise.all([...queuedKicks]);
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
    it("queues only the configured MAP URL through real Postgres without a model call", async () => {
      await deliverInboundOnly({ fromPhone: customerPhone, text: "  map. " });
      const provider = await runPassWithForbiddenModel();

      const work = await client()`
        select message_category, body from outbox_work
        where recipient_hash = ${customerHash}
      `;
      expect(work).toEqual([{
        message_category: "inquiry_reply",
        body: "https://www.vigavashon.org/farm-stand-map#map",
      }]);
      expect(provider.calls).toBe(0);

      const consent = await client()`
        select state from sms_consents where recipient_hash = ${customerHash}
      `;
      expect(consent).toEqual([]);
    });

    it("keeps STOP's dispatch boundary over a later MAP reply", async () => {
      await deliverInboundOnly({ fromPhone: customerPhone, text: "STOP" });
      await runPassWithForbiddenModel();

      await deliverInboundOnly({ fromPhone: customerPhone, text: "MAP" });
      const provider = await runPassWithForbiddenModel();

      const mapWork = await client()`
        select id, message_category, body from outbox_work
        where recipient_hash = ${customerHash} and logical_key like 'map-%'
      `;
      expect(mapWork).toEqual([{
        id: expect.any(String),
        message_category: "inquiry_reply",
        body: "https://www.vigavashon.org/farm-stand-map#map",
      }]);
      expect(provider.calls).toBe(0);

      const authorization = await authorizeDispatch(database(), {
        outboxWorkId: mapWork[0]?.id as string,
        now: at(2),
      });
      expect(authorization.status).toBe("suppressed");
    });

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

    it("offers a joining customer the contact card, so the number is not a stranger", async () => {
      // F-039 built the card and linked it from the PUBLIC WEB MAP only. A customer who
      // arrived by text — which is the product — was never told it existed, so every later
      // message came from an unnamed number. Asserted at the queued body a real handset
      // receives, not against the copy constant, so a welcome that stopped being sent fails
      // here too.
      //
      // The path comes from `CONTACT_CARD_PATH`, never a literal: B-052 moved it, and a
      // hardcoded old path here would have gone on passing while the texted link rotted.
      await deliverInbound({ fromPhone: customerPhone, text: "JOIN" });
      await runPassWithForbiddenModel();

      const queued = await client()`
        select body from outbox_work where recipient_hash = ${customerHash}
      `;
      const bodies = queued.map((row) => row.body as string);
      expect(bodies.some((body) => body.includes(CONTACT_CARD_PATH))).toBe(true);
    });

    it.each(["JOIN", "START", "VIGA"])(
      "offers the contact card to a sender who establishes messaging with %s",
      async (keyword) => {
        /*
          EVERY word that turns messaging on, not the two that happened to exist first.

          F-100 made VIGA the word the onboarding form tells a farmer to text, and taught it to
          the redemption branch — but not to the contact-card condition. So the sender with the
          most use for a saved number, the farmer who will get scheduled prompts and stock-out
          alerts for months, was the only one never offered it.

          Parameterised over the keyword so adding a fourth opt-in word without teaching it here
          fails, rather than repeating the defect for the next one.
        */
        await deliverInbound({ fromPhone: customerPhone, text: keyword });
        await runPassWithForbiddenModel();

        const queued = await client()`
          select body from outbox_work where recipient_hash = ${customerHash}
        `;
        const bodies = queued.map((row) => row.body as string);
        expect(
          bodies.some((body) => body.includes(CONTACT_CARD_PATH)),
          `${keyword} establishes messaging and must offer the contact card`,
        ).toBe(true);
      },
    );

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

  describe("invited JOIN establishes consent, end to end", () => {
    // The launch blocker, driven through the REAL webhook handler against real Postgres.
    //
    // The unit and `packages/db` suites prove the pieces. This proves the composition: a
    // farmer's actual text arriving from the carrier reaches the consent writer, and what
    // Farm Friend queues back says the true thing about messaging. Before this work the
    // same journey produced an authorized farmer with no consent record and no way to
    // learn it — behind a fully green suite, because nothing exercised the whole path.

    /**
     * An administrator, an active invitation, and the PHONE the farmer stated on the form.
     *
     * The phone is what ties the handset to the farm now that `JOIN <token>` is gone (max
     * 2026-08-07): the farmer's message is a bare `START`, matched against this hash. Stating it
     * here is the fixture equivalent of filling in the onboarding form.
     */
    async function invite(agreed: boolean): Promise<string> {
      const {
        createFarmerInvitation,
        recordFarmerInvitationSmsAgreement,
        recordFarmerInvitationPendingPhone,
      } = await import("@farm-friend/db");
      const administrators = await client()`
        insert into administrators (email, authorized_at)
        values ('board@vigavashon.org', ${at(0)}) returning id
      `;
      const farms = await client()`
        insert into farms (name) values (${`Invited ${randomUUID()}`}) returning id
      `;
      const created = await createFarmerInvitation(database(), {
        farmId: farms[0]?.id as string,
        channel: "sms",
        administratorId: administrators[0]?.id as string,
        occurredAt: at(0),
      });
      if (created.status !== "created") throw new Error(created.status);
      if (agreed) {
        await recordFarmerInvitationSmsAgreement(database(), {
          token: created.token,
          occurredAt: at(0),
        });
      }
      await recordFarmerInvitationPendingPhone(database(), {
        token: created.token,
        phoneE164: farmerPhone,
        phoneHash: farmerHash,
        occurredAt: at(0),
      });
      return created.token;
    }

    it("confirms VIGA onboarding with one listing-live message, with NO model call", async () => {
      await invite(true);
      await deliverInbound({ fromPhone: farmerPhone, text: "VIGA" });
      const provider = await runPassWithForbiddenModel();

      const consent = await client()`
        select state, capture_source from sms_consents
        where recipient_hash = ${farmerHash}
      `;
      // VIGA is configured as Telnyx's start operation, so the same carrier-compatible source
      // records the inbound command that confirmed control of the handset.
      expect(consent).toEqual([{ state: "active", capture_source: "start" }]);

      const work = await client()`
        select message_category, body from outbox_work
        where recipient_hash = ${farmerHash}
        order by logical_key
      `;
      /*
        Telnyx sends the phone-confirmation receipt. Farm Friend sends the distinct
        listing-live completion, and the contact-card offer beside it.

        **The card is here by decision** (max, 2026-08-12). This used to assert
        `["inventory_prompt"]` alone — "no customer welcome or card" — and that suppressed the
        offer for the one sender with the most use for it: the farmer about to receive
        scheduled prompts and stock-out alerts from this number for months, who otherwise has
        it saved nowhere. A customer who texts JOIN was offered the card and the farmer was not.

        What must still NOT appear is the CUSTOMER WELCOME, which points at the public map when
        the farmer's next step is their own stand. That claim is asserted below on the body.
      */
      expect(work.map((row) => row.message_category)).toEqual([
        "inquiry_reply",
        "inventory_prompt",
      ]);
      expect(work.map((row) => row.body)).not.toContain(CUSTOMER_WELCOME);
      // The offer, identified by the link a farmer actually taps.
      expect(
        (work.map((row) => row.body) as string[]).some((body) =>
          body.includes(CONTACT_CARD_PATH),
        ),
      ).toBe(true);

      /*
        F-094 — the setup message. This fixture's invitation names a farm with NO stand: it
        mints the invitation directly and never runs `saveOnboardingListing`, so there is no
        `sales_locations` row and no link can be issued. The fallback is therefore what a
        farmer on THIS path receives, and it is asserted as such rather than papered over.

        The link-carrying branch is proven where a stand actually exists —
        `farmer-authorization.integration.test.ts`, against `farmWithStand`.
      */
      // Selected by CATEGORY, not by position: the contact card shares this queue and the
      // order is `logical_key`'s, so an index here would silently start asserting the wrong
      // message the next time either key changes.
      const setupBody = work.find((row) => row.message_category === "inventory_prompt")
        ?.body as string;
      expect(setupBody).toBe(renderFarmerOnboardingComplete(null));
      /*
        The farmer is taught the recovery word (F-093) and gets no footer competing with it
        (F-096).

        This used to assert `LINK`, `STAND` and `SETTINGS` from a hardcoded list, and both of
        the others have since left this message for a stated reason: `STAND` is named only for
        a farmer who has a second stand to pick between, and this fixture's farm has none at
        all; `SETTINGS` is deliberately untaught while a farmer has one edit page that `LINK`
        already opens (both max, 2026-08-09).

        Asserting their ABSENCE as well as `LINK`'s presence, so re-adding either to this
        message is a decision someone makes on purpose rather than a drift nothing notices.
      */
      expect(setupBody).toContain("LINK");
      expect(setupBody).not.toMatch(/welcome|subscribed|confirmed for messages/i);
      expect(work.map((row) => row.body)).not.toContain(
        FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT,
      );
      expect(provider.calls).toBe(0);
    });

    it("AUTHORIZES nobody when the agreement was never ticked, though START still enrolls", async () => {
      // Two facts that used to be one, and had to come apart when START took this over.
      //
      // START's consent effect is the CARRIER's and is unconditional — it must enroll and lift
      // a block whatever else is true, which is why consent is `active` here. What the missing
      // tick withholds is the AUTHORIZATION: no accepted disclosure means no informed opt-in
      // for farmer messaging, so nobody is set up and the request falls through to VIGA.
      await invite(false);
      await deliverInbound({ fromPhone: farmerPhone, text: "START" });
      const provider = await runPassWithForbiddenModel();

      const consent = await client()`
        select state from sms_consents where recipient_hash = ${farmerHash}
      `;
      expect(consent).toEqual([{ state: "active" }]);

      // No authorization, so no "your farm is ready" — that notification would be a lie.
      const authorizations = await client()`
        select count(*)::integer as count from farmer_authorizations
      `;
      expect(authorizations[0]?.count).toBe(0);

      const bodies = await client()`
        select body from outbox_work where recipient_hash = ${farmerHash}
        order by logical_key
      `;
      const texts = bodies.map((row) => row.body as string);
      // No setup message — it would be a lie — and no link, since nothing was set up.
      // Compared against the renderer's own output rather than a quoted phrase, so rewording
      // the copy cannot quietly turn this into an assertion about a string nobody sends.
      expect(texts).not.toContain(renderFarmerAuthorizedNotification(null, { standCount: 0 }));
      expect(texts.some((body) => body.includes("/stand/"))).toBe(false);

      /*
        B-043 — and this is the half that was missing.

        The farmer did exactly what the onboarding form told them to do. Before this they got
        ONLY the carrier opt-in receipt — a compliance notice that says nothing about their
        farm — and no acknowledgement, no explanation, and no sign anyone would act. A farmer
        who tries once and hears nothing does not try again.

        The old test asserted only the ABSENCE of the authorization notification, so the
        silence it left behind was invisible to it.
      */
      expect(texts).toContain(FARMER_ONBOARDING_REQUEST_ACKNOWLEDGEMENT);
      // And not the customer welcome: pointing a farmer mid-onboarding at the public map is
      // the same wrong turn the code comment already forbids for an onboarded farmer.
      expect(texts.some((body) => body.includes("Ask what is available"))).toBe(false);
      expect(provider.calls).toBe(0);
    });

    it("STOP still wins after an agreed onboarding — the later opt-out clears consent", async () => {
      // Onboarding is an opt-in path, so it must not become one that is hard to leave. The
      // consent watermark orders these independently of conversation state.
      await invite(true);
      await deliverInbound({ fromPhone: farmerPhone, text: "START", occurredAt: at(0) });
      await runPassWithForbiddenModel();
      await deliverInbound({ fromPhone: farmerPhone, text: "STOP", occurredAt: at(1) });
      await runPassWithForbiddenModel();

      const consent = await client()`
        select state from sms_consents where recipient_hash = ${farmerHash}
      `;
      expect(consent).toEqual([{ state: "stopped" }]);
    });

    it("a RETURNING farmer who once texted STOP is enrolled by START, not stranded", async () => {
      // **The case that inverts under the new credential, deliberately.**
      //
      // Under `JOIN <token>` this asserted the opposite: a stopped sender stayed stopped, because
      // `JOIN` is *our* word and cannot clear the carrier's own opt-out list — recording consent
      // would have made our record disagree with theirs (B-011).
      //
      // START is the opposite case. It is the carrier's OWN keyword and the only word that lifts
      // that block, so it is precisely the word a returning farmer sends. Refusing here would
      // spend their invitation, leave consent `stopped`, and strand them with nothing reporting
      // it — the silent dead end this architecture keeps closing.
      //
      // What still protects an opted-out person is unchanged: a WEB FORM cannot re-enroll them,
      // because a form tick writes no consent at all. Only an inbound message from the handset
      // does, and that is the one act that legitimately clears a stop.
      await deliverInbound({ fromPhone: farmerPhone, text: "STOP", occurredAt: at(0) });
      await runPassWithForbiddenModel();

      await invite(true);
      await deliverInbound({ fromPhone: farmerPhone, text: "START", occurredAt: at(1) });
      await runPassWithForbiddenModel();

      const consent = await client()`
        select state, capture_source from sms_consents where recipient_hash = ${farmerHash}
      `;
      expect(consent).toEqual([{ state: "active", capture_source: "start" }]);

      // ...and they are actually set up, which is the point of enrolling them.
      const authorizations = await client()`
        select count(*)::integer as count from farmer_authorizations
      `;
      expect(authorizations[0]?.count).toBe(1);
    });
  });

  describe("duplicates, ordering, and serialization at the ROUTE level", () => {
    it("a retried webhook delivery produces exactly one copy of each consequence", async () => {
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

      // The one accepted JOIN intentionally creates a carrier receipt, a product welcome, and
      // the contact-card offer. A retry must create no second copy of ANY of them — each
      // logical key is derived from the provider event, which is what makes the retry a no-op.
      const work = await client()`
        select logical_key, message_category from outbox_work
        where recipient_hash = ${customerHash}
        order by logical_key
      `;
      expect(work).toEqual([
        { logical_key: `consent-${providerEventId}`, message_category: "required_reply" },
        { logical_key: `contact-card-${providerEventId}`, message_category: "inquiry_reply" },
        { logical_key: `customer-welcome-${providerEventId}`, message_category: "inquiry_reply" },
      ]);
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
      const providerEventId = `evt-${randomUUID()}`;
      await deliverInboundOnly({ fromPhone: customerPhone, text: "JOIN", providerEventId });

      // Two passes racing: the per-sender row lock must let only one claim the event.
      const [a, b] = await Promise.all([
        runInboundPass({
          db: database(),
          classifier: createRequestClassificationModel(new ForbiddenProvider()),
          stockOut: {
            parseItem: async () => {
              throw new Error("the stock-out seam must not run on this path");
            },
          },
          interpreter: createInventoryInterpreter(new ForbiddenProvider()),
          catalogMatcher: createCatalogMatcher(new ForbiddenProvider()),
          clock: new FixedClock(at(1)),
          // F-040: configured origin for a farmer standing link. Never a request header.
          publicBaseUrl: "https://farmfriend.example",
          publicMapUrl: "https://www.vigavashon.org/farm-stand-map#map",
        }),
        runInboundPass({
          db: database(),
          classifier: createRequestClassificationModel(new ForbiddenProvider()),
          stockOut: {
            parseItem: async () => {
              throw new Error("the stock-out seam must not run on this path");
            },
          },
          interpreter: createInventoryInterpreter(new ForbiddenProvider()),
          catalogMatcher: createCatalogMatcher(new ForbiddenProvider()),
          clock: new FixedClock(at(1)),
          // F-040: configured origin for a farmer standing link. Never a request header.
          publicBaseUrl: "https://farmfriend.example",
          publicMapUrl: "https://www.vigavashon.org/farm-stand-map#map",
        }),
      ]);

      expect(a.processed + b.processed).toBe(1);
      const work = await client()`
        select logical_key, message_category from outbox_work
        where recipient_hash = ${customerHash}
        order by logical_key
      `;
      expect(work).toEqual([
        { logical_key: `consent-${providerEventId}`, message_category: "required_reply" },
        { logical_key: `contact-card-${providerEventId}`, message_category: "inquiry_reply" },
        { logical_key: `customer-welcome-${providerEventId}`, message_category: "inquiry_reply" },
      ]);
    });
  });

  describe("free text — the only path a model may run on", () => {
    /** An approved farm with one location and one verified authorized farmer. */
    async function seedFarmer(): Promise<{ locationId: string; farmId: string }> {
      const farm = await client()`
        insert into farms (name) values ('Test Farm') returning id
      `;
      const farmId = farm[0]?.id as string;

      const admin = await client()`
        insert into administrators (email, authorized_at)
        values ('board@vigavashon.org', ${at(-60)})
        returning id
      `;

      const location = await client()`
        insert into sales_locations (
          owner_farm_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude, public_longitude,
          farm_bucks_accepted, farm_bucks_eligible
        )
        values (${farmId}, 'farm_stand', 'Test Stand', 'America/Los_Angeles', 'visitable', 'produce', '1 Test Rd', 47.45, -122.46,
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
        "request-classification": JSON.stringify({ kind: "inventory_report" }),
        "inventory-extraction": JSON.stringify({
          kind: "edits",
          additions: [{ itemName: "kale" }, { itemName: "eggs" }],
          changes: [],
          removals: [],
        }),
      });

      await runInboundPass({
        db: database(),
        classifier: createRequestClassificationModel(provider),
        stockOut: {
            parseItem: async () => {
              throw new Error("the stock-out seam must not run on this path");
            },
          },
        interpreter: createInventoryInterpreter(provider),
        catalogMatcher: createCatalogMatcher(provider),
        clock: new FixedClock(at(1)),
        // F-040: configured origin for a farmer standing link. Never a request header.
        publicBaseUrl: "https://farmfriend.example",
        publicMapUrl: "https://www.vigavashon.org/farm-stand-map#map",
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
        select message_category, body from outbox_work where recipient_hash = ${farmerHash}
      `;
      expect(work[0]?.message_category).toBe("inventory_confirmation");

      /*
        THE PROMPT MUST ASK FOR THE CONFIRMATION IT IS WAITING ON (max, 2026-08-14).

        The message listed what the stand would show and then stopped. Nothing is published
        until a YES arrives — the gate is real and was never open — so this is a dead end
        rather than an unsafe write: the farmer is asked to approve a change without being
        told that approval is needed, or which word gives it.

        Asserted on the OUTBOX BODY, which is what the handset receives, rather than on the
        renderer's return value. The web form composes the same snapshot text as an audit
        record of what it already published, and must NOT gain a "reply YES" instruction that
        belongs to a channel it does not use.
      */
      const body = work[0]?.body as string;
      expect(body).toMatch(/\bYES\b/);
      expect(body).toMatch(/\bNO\b/);
      // The items are still what the farmer is confirming — the instruction adds to the
      // snapshot rather than replacing it.
      expect(body).toMatch(/kale/i);
      expect(body).toMatch(/eggs/i);
    });

    it("a YES arriving before its prompt was accepted commits nothing", async () => {
      await seedFarmer();
      await deliverInboundOnly({
        fromPhone: farmerPhone,
        text: "kale and eggs",
        occurredAt: at(0),
      });

      const provider = new ScriptedProvider({
        "request-classification": JSON.stringify({ kind: "inventory_report" }),
        "inventory-extraction": JSON.stringify({
          kind: "edits",
          additions: [{ itemName: "kale" }],
          changes: [],
          removals: [],
        }),
      });
      await runInboundPass({
        db: database(),
        classifier: createRequestClassificationModel(provider),
        stockOut: {
            parseItem: async () => {
              throw new Error("the stock-out seam must not run on this path");
            },
          },
        interpreter: createInventoryInterpreter(provider),
        catalogMatcher: createCatalogMatcher(provider),
        clock: new FixedClock(at(1)),
        // F-040: configured origin for a farmer standing link. Never a request header.
        publicBaseUrl: "https://farmfriend.example",
        publicMapUrl: "https://www.vigavashon.org/farm-stand-map#map",
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

    // F-046, max's decision (2026-07-31): BOTH work. A farmer with an open inventory
    // confirmation who texts MORE gets their next page AND keeps the confirmation; a
    // confirmation reply never swallows a MORE. YES/NO and MORE are different words with no
    // overlap, so blocking either would solve a collision that does not exist while making a
    // farmer feel ignored.
    //
    // BOTH DIRECTIONS are asserted, because each alone is satisfiable by the very defect it
    // is meant to forbid: "the confirmation survived" passes trivially if MORE did nothing,
    // and "the page was served" passes trivially if the confirmation was never open.
    it("a farmer can page without disturbing an open confirmation, in both directions", async () => {
      await seedFarmer();

      // An open, ACTIVATED proposal — the state in which a YES would genuinely commit. An
      // un-activated one would make direction two vacuous.
      await deliverInboundOnly({
        fromPhone: farmerPhone,
        text: "kale and eggs",
        occurredAt: at(0),
      });
      const provider = new ScriptedProvider({
        "request-classification": JSON.stringify({ kind: "inventory_report" }),
        "inventory-extraction": JSON.stringify({
          kind: "edits",
          additions: [{ itemName: "kale" }],
          changes: [],
          removals: [],
        }),
      });
      await runInboundPass({
        db: database(),
        classifier: createRequestClassificationModel(provider),
        stockOut: {
            parseItem: async () => {
              throw new Error("the stock-out seam must not run on this path");
            },
          },
        interpreter: createInventoryInterpreter(provider),
        catalogMatcher: createCatalogMatcher(provider),
        clock: new FixedClock(at(1)),
        publicBaseUrl: "https://farmfriend.example",
        publicMapUrl: "https://www.vigavashon.org/farm-stand-map#map",
      });
      await client()`
        update inventory_publication_proposals
        set activation_outbox_id = (
              select id from outbox_work where recipient_hash = ${farmerHash}
                and message_category = 'inventory_confirmation' limit 1
            ),
            activated_version = proposal_version,
            activated_at = ${at(2)},
            expires_at = ${at(180)}
        where sender_hash = ${farmerHash} and state = 'open'
      `;

      // A pending result list for the SAME sender, as a question of theirs would have left.
      //
      // The identifiers must RESOLVE to real published stands: the pager dereferences them
      // fresh and skips a page whose stands have all gone, so a list of invented ids would
      // drain itself and the assertions below would be about nothing.
      const pagedStands: string[] = [];
      for (let index = 0; index < 9; index += 1) {
        const farm = await client()`
          insert into farms (name) values (${`Paging Farm ${index}`}) returning id
        `;
        const stand = await client()`
          insert into sales_locations (
            owner_farm_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude, public_longitude,
            farm_bucks_accepted, farm_bucks_eligible
          )
          values (${farm[0]?.id as string}, 'farm_stand', ${`Paging Stand ${index}`}, 'America/Los_Angeles', 'visitable', 'produce',
                  ${`${200 + index} Paging Rd`}, 47.45, -122.46, false, false)
          returning id
        `;
        const standId = stand[0]?.id as string;
        await client()`
          insert into stand_items (sales_location_id, provider_id, display_name, usually_carried, sort_order)
          values (${standId}, (select id from stand_providers
            where sales_location_id = ${standId} and seller_id is null), 'eggs', true, 0)
        `;
        pagedStands.push(offeringFactId(standId));
      }
      // Nine offering-only stands: one fact each, so the stand counts equal the fact counts.
      await client()`
        insert into pending_result_lists (
          sender_hash, fact_ids, items_requested, "offset",
          stand_total, stand_offset, created_at, expires_at
        )
        values (
          ${farmerHash}, ${pagedStands}, ${["eggs"]}, 3,
          ${pagedStands.length}, 3, ${at(2)}, ${at(62)}
        )
      `;

      // Preconditions, asserted rather than assumed.
      const openBefore = await client()`
        select state, activated_at from inventory_publication_proposals
        where sender_hash = ${farmerHash}
      `;
      expect(openBefore).toHaveLength(1);
      expect(openBefore[0]?.state).toBe("open");
      expect(openBefore[0]?.activated_at).not.toBeNull();

      // ---- DIRECTION ONE: MORE does not consume, expire, or answer the confirmation.
      //
      // `deliverInboundOnly`, not `deliverInbound`: the latter also drives the kick route,
      // which builds its own deps from the composition root with the REAL clock — and that
      // expires a fixture proposal anchored a day in the past before the assertions run.
      await deliverInboundOnly({
        fromPhone: farmerPhone,
        text: "MORE",
        occurredAt: at(3),
      });
      const forbidden = await runPassWithForbiddenModel();
      // Paging is code end to end: not one model call for a MORE.
      expect(forbidden.calls).toBe(0);

      const afterMore = await client()`
        select state, consumed_token, activated_at
        from inventory_publication_proposals where sender_hash = ${farmerHash}
      `;
      expect(afterMore[0]?.state, "MORE must not consume the confirmation").toBe("open");
      expect(afterMore[0]?.consumed_token).toBeNull();
      // And nothing published behind it.
      const noRevisions = await client()`
        select count(*)::integer as count from inventory_revisions
      `;
      expect(noRevisions[0]?.count).toBe(0);

      // MORE was actually SERVED, so this is not passing because paging did nothing.
      //
      // Asserted on the QUEUED REPLY, not only on the offset: an implementation that claims
      // a page and then discards it still advances the offset, so the offset alone is
      // satisfied by the defect where the customer receives "I don't have a list going".
      // Caught by exactly that sabotage.
      const pagedReply = await client()`
        select body, message_category from outbox_work
        where recipient_hash = ${farmerHash} and logical_key like 'paging-%'
      `;
      expect(pagedReply, "a MORE must queue exactly one reply").toHaveLength(1);
      expect(pagedReply[0]?.body).toContain("Paging Stand 3");
      expect(pagedReply[0]?.body).toMatch(/4-6 of 9/);
      expect(pagedReply[0]?.body).not.toMatch(/don't have a list/i);
      expect(pagedReply[0]?.message_category).toBe("inquiry_reply");

      const pagedList = await client()`
        select "offset" from pending_result_lists where sender_hash = ${farmerHash}
      `;
      expect(pagedList[0]?.offset, "the page must actually have been served").toBe(6);

      // ---- DIRECTION TWO: the confirmation still works, and does not swallow the list.
      await deliverInboundOnly({
        fromPhone: farmerPhone,
        text: "YES",
        occurredAt: at(4),
      });
      await runPassWithForbiddenModel();

      const afterYes = await client()`
        select state, consumed_token from inventory_publication_proposals
        where sender_hash = ${farmerHash}
      `;
      expect(afterYes[0]?.state, "the confirmation must still commit").toBe("accepted");
      expect(afterYes[0]?.consumed_token).toBe("yes");
      const published = await client()`
        select count(*)::integer as count from inventory_revisions
      `;
      expect(published[0]?.count).toBe(1);

      // The pending list is untouched by the confirmation — a YES is not a page request.
      const listAfterYes = await client()`
        select "offset" from pending_result_lists where sender_hash = ${farmerHash}
      `;
      expect(listAfterYes).toHaveLength(1);
      expect(listAfterYes[0]?.offset).toBe(6);
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
          sender_hash, sales_location_id, provider_id, payload, proposal_version,
          has_inventory, has_closure, base_is_first_publication, state,
          activation_outbox_id, activated_version, activated_at, expires_at,
          consumed_token, consumption_provider_event_id, closed_at
        )
        values (
${farmerHash}, ${locationId},
          (select id from stand_providers
            where sales_location_id = ${locationId} and seller_id is null), ${client().json({ entries: [] })}, 1,
          true, false, true, 'accepted',
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
          farm_id, sales_location_id, provider_id, proposal_id, published_by_authorization_id,
          farm_approval_id, source, published_at, is_current
        )
        values (
${farmId}, ${locationId},
(select id from stand_providers
  where sales_location_id = ${locationId} and seller_id is null), ${proposal[0]?.id as string},
                ${auth[0]?.id as string}, ${approval[0]?.id as string}, 'sms', ${at(-30)}, true)
        returning id
      `;
      await client()`
        insert into inventory_entries (
          inventory_revision_id, sales_location_id, item_name, sort_order
        )
        values (${revision[0]?.id as string}, ${locationId}, 'kale', 0)
      `;

      await deliverInboundOnly({ fromPhone: customerPhone, text: "who has kale?" });

      // The model selects one catalog name; code expands it to stands and authors the answer.
      const provider = new ScriptedProvider({
        // F-104 — the route signal comes first now. "who has kale?" is a question.
        "request-classification": JSON.stringify({
          kind: "search_stands",
          request: { operation: "inventory" },
        }),
        "catalog-match": JSON.stringify({ matches: ["kale"] }),
      });

      await runInboundPass({
        db: database(),
        classifier: createRequestClassificationModel(provider),
        stockOut: {
          parseItem: async (): Promise<never> => {
            throw new Error("the stock-out seam must not run on a question");
          },
        },
        interpreter: createInventoryInterpreter(provider),
        catalogMatcher: createCatalogMatcher(provider),
        clock: new FixedClock(at(1)),
        // F-040: configured origin for a farmer standing link. Never a request header.
        publicBaseUrl: "https://farmfriend.example",
        publicMapUrl: "https://www.vigavashon.org/farm-stand-map#map",
      });

      const work = await client()`
        select message_category, body from outbox_work
        where recipient_hash = ${customerHash}
      `;
      expect(work).toHaveLength(1);
      expect(work[0]?.message_category).toBe("inquiry_reply");
      // Code rendered it: the stand name and a recency label the model never supplied.
      expect(work[0]?.body).toContain("Test Stand");
      expect(work[0]?.body).toMatch(/In stock \(\d+[hd] ago\)|In stock \(now\)/);
    });

    it("a customer inquiry creates no durable consent", async () => {
      await deliverInboundOnly({ fromPhone: customerPhone, text: "who has kale?" });

      const provider = new ScriptedProvider({
        // F-104 — the route signal comes first now. "who has kale?" is a question.
        "request-classification": JSON.stringify({
          kind: "search_stands",
          request: { operation: "inventory" },
        }),
        "catalog-match": JSON.stringify({ matches: ["kale"] }),
      });
      await runInboundPass({
        db: database(),
        classifier: createRequestClassificationModel(provider),
        stockOut: {
            parseItem: async () => {
              throw new Error("the stock-out seam must not run on this path");
            },
          },
        interpreter: createInventoryInterpreter(provider),
        catalogMatcher: createCatalogMatcher(provider),
        clock: new FixedClock(at(1)),
        // F-040: configured origin for a farmer standing link. Never a request header.
        publicBaseUrl: "https://farmfriend.example",
        publicMapUrl: "https://www.vigavashon.org/farm-stand-map#map",
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
