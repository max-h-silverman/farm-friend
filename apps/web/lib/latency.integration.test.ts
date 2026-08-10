import { randomUUID, webcrypto } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { LLMProvider, ModelSafeContext } from "@farm-friend/ai";
import {
  createFarmerMessageIntentModel,
  createInquiryModel,
  createInventoryInterpreter,
} from "@farm-friend/ai";
import { SystemClock, hashPhone } from "@farm-friend/core";
import { createDb, type Db, type Sql } from "@farm-friend/db";
import { createLastMileSender } from "@farm-friend/sms";
import type { AppContext } from "./composition";
import { kickSenderPasses } from "./kick";
import { runInboundPass, runOutboundPass } from "./workers";

/**
 * The only two capabilities `runOutboundPass` actually reads off the app context. Declaring
 * the narrow shape here — rather than widening the production type for a test's benefit —
 * keeps the seam honest about what the pass depends on.
 */
type OutboundContext = Pick<AppContext, "db" | "sendSms">;

/** Adapt the narrow shape to the pass's parameter without widening production types. */
const asContext = (context: OutboundContext): AppContext => context as AppContext;

// B-004 — an inbound reply is dispatched in well under 10s, end to end, against real
// Postgres and through the REAL webhook route.
//
// The acceptance criteria this suite owns are the ones a unit test cannot reach:
//
//   * a verified inbound message is PROCESSED AND ITS REPLY DISPATCHED in well under 10s,
//     measured on the wall clock rather than asserted as "faster than cron";
//   * suppressing the kick entirely loses NOTHING — cron still recovers the work;
//   * a kick racing a concurrent cron pass cannot double-process or double-send.
//
// The last two are the ones worth the setup. "The kick made it faster" is easy to show and
// says nothing about whether the durable mechanism survived; the interesting claims are
// that the kick is REMOVABLE without loss and that it cannot duplicate a real person's SMS.

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");
const databaseUrl = process.env.DATABASE_URL;
const phoneSalt = "b004-test-salt";

function requiredDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required; a skipped integration run is not green");
  }
  return databaseUrl;
}

type KeyPair = { privateKey: webcrypto.CryptoKey; publicKey: webcrypto.CryptoKey };

/** A model that fails the test if it is ever called. */
class ForbiddenProvider implements LLMProvider {
  calls = 0;
  async generateJson(ctx: ModelSafeContext): Promise<string> {
    this.calls += 1;
    throw new Error(`MODEL CALLED on a deterministic path (seam ${ctx.seam})`);
  }
}

describe("inbound reply latency (integration)", () => {
  let adminClient: Sql | undefined;
  let sql: Sql | undefined;
  let db: Db | undefined;
  let testDatabaseName: string | undefined;
  let keys: KeyPair;
  let webhookPOST: (req: Request) => Promise<Response>;
  let kickPOST: (req: Request) => Promise<Response>;

  const senderPhone = "+12065550733";
  const senderHash = hashPhone(senderPhone, phoneSalt);

  const timestamp = String(Math.floor(Date.now() / 1000));

  beforeAll(async () => {
    const baseUrl = requiredDatabaseUrl();
    testDatabaseName = `farm_friend_b004_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);

    const url = new URL(baseUrl);
    url.pathname = `/${testDatabaseName}`;

    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });

    sql = postgres(url.toString(), { max: 8 });
    db = createDb(url.toString());

    keys = (await webcrypto.subtle.generateKey("Ed25519", true, [
      "sign",
      "verify",
    ])) as KeyPair;
    const publicKey = Buffer.from(
      await webcrypto.subtle.exportKey("raw", keys.publicKey),
    ).toString("base64");

    // The real route reads the process-wide composition root, so configure before import.
    // The simulator transport stands in for Telnyx delivery: this suite measures Farm
    // Friend's own latency, and a real provider round trip would measure the network.
    process.env.DATABASE_URL = url.toString();
    process.env.PHONE_HASH_SALT = phoneSalt;
    // Required by the composition root since F-032. Nothing on the SMS path uses them; they
    // are set so `appContext()` resolves at all.
    process.env.PUBLIC_BASE_URL = "https://ff.example";
    process.env.PUBLIC_MAP_URL = "https://www.vigavashon.org/farm-stand-map";
    // GL-019: no default provider. These suites drive deterministic paths and assert no
    // model is reached, so the stub is the right choice — it now has to be stated.
    process.env.LLM_PROVIDER = "stub";
    process.env.SMS_PROVIDER = "telnyx";
    process.env.TELNYX_API_KEY = "test-api-key";
    process.env.TELNYX_MESSAGING_PROFILE_ID = "test-profile";
    process.env.TELNYX_FROM_NUMBER = "+12065550999";
    process.env.TELNYX_PUBLIC_KEY = publicKey;

    // The Cloud Tasks queue, configured for real so the composition root builds the actual
    // adapter rather than the no-op. Its single HTTP call is intercepted at the `fetch`
    // boundary below and turned into an invocation of the REAL kick route — which is what
    // Cloud Tasks does in production, minus the network and the delay.
    //
    // This is deliberately not a hand-written fake queue. The webhook, the enqueue seam, the
    // task payload, the kick route's own parsing and role guard, and both worker passes are
    // all the production code path; only the transport between them is local.
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
  }, 60_000);

  // The route's own context is built with SMS_PROVIDER=telnyx — it must be, because the
  // webhook refuses to trust an inbound event without a verification key, and provider
  // selection deliberately couples that key to the delivery transport so the simulator can
  // never inherit live secrets. That coupling is a safety property, not an obstacle to route
  // around, so this suite stubs the NETWORK boundary instead: the one `fetch` the Telnyx
  // transport makes. Everything above it — claim, consent recheck, dispatch authorization,
  // result recording — is the real production path.
  const realFetch = globalThis.fetch;

  /**
   * Tasks this suite's stub queue accepted, so a test can assert what was enqueued and drive
   * delivery deterministically where it needs to.
   */
  let acceptedTasks: { senderHash: string; providerEventId: string }[] = [];
  /** Set false to make the queue refuse, standing in for a Cloud Tasks outage. */
  let queueAvailable = true;
  /** Set false to accept tasks without delivering them — the "task never ran" case. */
  let deliverTasks = true;

  beforeAll(() => {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.startsWith("https://api.telnyx.com/")) {
        return Response.json(
          { data: { id: `telnyx-stub-${randomUUID()}` } },
          { status: 200 },
        );
      }

      // The Cloud Run metadata server, which mints the token the Cloud Tasks adapter sends.
      // Intercepted here rather than injected, so the adapter's real token path is exercised.
      if (url.startsWith("http://metadata.google.internal/")) {
        return Response.json({ access_token: "test-access-token" });
      }

      // The Cloud Tasks API. Accepting here is what "the task is durable" means in
      // production — the queue has it, and delivery follows independently of the caller.
      if (url.startsWith("https://cloudtasks.googleapis.com/")) {
        if (!queueAvailable) {
          return new Response("backend unavailable", { status: 503 });
        }

        const body = JSON.parse(String(init?.body ?? "{}")) as {
          task: { httpRequest: { body: string } };
        };
        const payload = JSON.parse(
          Buffer.from(body.task.httpRequest.body, "base64").toString("utf8"),
        ) as { senderHash: string; providerEventId: string };
        acceptedTasks.push(payload);

        if (deliverTasks) {
          // Delivered ASYNCHRONOUSLY, deliberately. Cloud Tasks calls the worker after the
          // enqueue returns, never during it — so invoking the kick route inline here would
          // make the webhook's own response wait on the passes and quietly invert the
          // property this suite exists to prove.
          setTimeout(() => {
            void kickPOST(
              new Request("https://worker.test/api/internal/kick", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(payload),
              }),
            ).catch(() => {
              // A failed task is retried by the queue in production; here the scheduled
              // pass is the net, exactly as it is for a task that never ran.
            });
          }, 0);
        }

        return Response.json({ name: "projects/p/locations/l/queues/q/tasks/t" });
      }

      return realFetch(input, init);
    }) as typeof globalThis.fetch;
  });

  afterAll(async () => {
    globalThis.fetch = realFetch;
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
    acceptedTasks = [];
    queueAvailable = true;
    deliverTasks = true;
    await client()`
      truncate table provider_inbox_events, sms_messages, outbox_work, outbox_dispatch_attempts,
        sms_consents, consent_transition_watermarks, sender_states, flags, contacts
      restart identity cascade
    `;
    await client()`
      insert into contacts (phone_e164, phone_hash)
      values (${senderPhone}, ${senderHash})
    `;
  });

  /** Sign and POST a `message.received` webhook through the REAL route handler. */
  async function deliverInbound(input: {
    text: string;
    providerEventId?: string;
  }): Promise<Response> {
    const rawBody = JSON.stringify({
      data: {
        event_type: "message.received",
        id: input.providerEventId ?? `evt-${randomUUID()}`,
        // Wall-clock "now": this suite measures elapsed real time, so the event is current.
        occurred_at: new Date().toISOString(),
        payload: {
          id: `msg-${randomUUID()}`,
          from: { phone_number: senderPhone },
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

  /** Wait for a condition, polling fast, so elapsed time reflects the system not the poll. */
  async function waitFor(
    condition: () => Promise<boolean>,
    timeoutMs: number,
  ): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await condition()) return true;
      await new Promise((r) => setTimeout(r, 10));
    }
    return false;
  }

  /** Has the sender's reply been handed to the provider? */
  async function replyDispatched(): Promise<boolean> {
    const rows = await client()`
      select count(*)::integer as count from outbox_work
      where recipient_hash = ${senderHash} and state = 'sent'
    `;
    return ((rows[0]?.count as number) ?? 0) > 0;
  }

  /**
   * The outbound pass's dependencies, bound to THIS suite's database.
   *
   * Assembled directly rather than through `appContext()` / `createAppContext`, both of
   * which resolve their pool through the process-wide `sharedDb` cache: that cache ignores
   * the URL after its first construction, so whichever suite imported a route first owns
   * the pool, and closing it would tear it out from under the others. Building the two
   * things `runOutboundPass` actually needs keeps this suite independent of import order.
   *
   * The transport is the in-process simulator — this suite measures Farm Friend's own
   * latency, and a live provider round trip would measure the network instead.
   */
  function outboundContext(): OutboundContext {
    return {
      db: database(),
      sendSms: createLastMileSender({
        resolver: {
          async resolveForDelivery(recipientHash) {
            const rows = await client()`
              select phone_e164 from contacts where phone_hash = ${recipientHash}
            `;
            return (rows[0]?.phone_e164 as string | undefined) ?? null;
          },
        },
        transport: async ({ idempotencyKey }) => ({
          providerMessageId: `simulated-${idempotencyKey}`,
        }),
      }),
    };
  }

  /**
   * The cron route's own passes, unscoped — exactly what the recovery net runs. Nothing here
   * is kick-aware, which is the point: the kick calls the SAME passes.
   */
  async function runCronPasses(): Promise<void> {
    const provider = new ForbiddenProvider();
    await runInboundPass({
      db: database(),
      farmerIntent: createFarmerMessageIntentModel(provider),
      customerIntent: {
            classify: async () => {
              throw new Error("the customer intent seam must not run on this path");
            },
          },
      stockOut: {
            parseItem: async () => {
              throw new Error("the stock-out seam must not run on this path");
            },
          },
      interpreter: createInventoryInterpreter(provider),
      inquiry: createInquiryModel(provider),
      clock: new SystemClock(),
      // F-040: configured origin for a farmer standing link. Never a request header.
      publicBaseUrl: "https://farmfriend.example",
      publicMapUrl: "https://www.vigavashon.org/farm-stand-map",
    });
    await runOutboundPass({
      context: asContext(outboundContext()),
      clock: new SystemClock(),
    });
  }

  it("dispatches a STOP acknowledgement in well under 10 seconds", async () => {
    // The end-to-end criterion, on the wall clock. A `STOP` is the right probe: it is the
    // compliance-flavoured path a carrier tester exercises, and it needs no model.
    const started = Date.now();

    const response = await deliverInbound({ text: "STOP" });
    expect(response.status).toBe(200);

    // No cron pass runs in this test at all — only the kick the route fired.
    const dispatched = await waitFor(replyDispatched, 9_000);
    const elapsed = Date.now() - started;

    expect(dispatched).toBe(true);
    // Well under the 10s target, and nowhere near the ~60s cron floor it replaces.
    expect(elapsed).toBeLessThan(5_000);

    // The durable consequence is right, not merely fast.
    const consent = await client()`
      select state from sms_consents where recipient_hash = ${senderHash}
    `;
    expect(consent[0]?.state).toBe("stopped");
  }, 30_000);

  it("the acknowledgement returns before the reply is dispatched", async () => {
    // The kick must not be inside the request Telnyx waits on. If the route awaited the
    // kick, the reply would already be dispatched by the time the 200 resolved.
    const response = await deliverInbound({ text: "HELP" });
    expect(response.status).toBe(200);

    // Checked IMMEDIATELY after the response resolves, before any wait.
    const dispatchedAtAck = await replyDispatched();
    expect(dispatchedAtAck).toBe(false);

    // ...and it still completes on its own shortly after.
    expect(await waitFor(replyDispatched, 9_000)).toBe(true);
  }, 30_000);

  describe("the kick is removable — cron loses nothing", () => {
    it("a suppressed kick still gets the reply out on the next cron pass", async () => {
      // THE criterion that keeps the durable mechanism honest. The kick is suppressed
      // entirely — as if the invocation was killed the instant after it acknowledged — and
      // the ordinary cron passes must still carry the message all the way to dispatch.
      const response = await deliverInboundWithoutKick({ text: "STOP" });
      expect(response.status).toBe(200);

      // Nothing has run: no kick fired, and cron has not swept yet.
      expect(await replyDispatched()).toBe(false);

      await runCronPasses();

      expect(await replyDispatched()).toBe(true);
      const consent = await client()`
        select state from sms_consents where recipient_hash = ${senderHash}
      `;
      expect(consent[0]?.state).toBe("stopped");
    }, 30_000);

    it("a kick that throws loses nothing either", async () => {
      // The other half of "loses nothing": not a kick that never ran, but one that ran and
      // failed. The event is durable before the kick is ever invoked, so a throwing kick
      // leaves ordinary pending work for cron.
      await deliverInboundWithoutKick({ text: "HELP" });

      await kickSenderPasses(
        {
          runInbound: async () => {
            throw new Error("kick died mid-pass");
          },
          runOutbound: async () => {
            throw new Error("kick died mid-pass");
          },
        },
        senderHash,
      );

      expect(await replyDispatched()).toBe(false);
      await runCronPasses();
      expect(await replyDispatched()).toBe(true);
    }, 30_000);
  });

  describe("a kick racing a cron pass", () => {
    it("cannot double-process or double-send the same message", async () => {
      // The race the design must survive: the webhook kicks this sender at the same instant
      // a scheduled sweep picks them up. Exclusion is the per-sender row lock inside
      // `claimNextInboundEvent`, not anything the kick does — the kick adds no new
      // concurrency control, it just arrives at the existing one from a second direction.
      //
      // Sabotage established which guard actually carries this (B-004). The claim has three
      // layers, and the load-bearing one is the `sender_states` upsert: it takes the row
      // lock that serializes the whole claim transaction. Disabling the explicit
      // `for update`, the `alreadyProcessing` check, and the `state = 'pending'` filter each
      // left this suite green, because the upsert alone still serialized every claimant.
      // Only removing the upsert's lock produced genuine double-processing — and then these
      // assertions failed, which is what makes them assertions.
      await deliverInboundWithoutKick({ text: "STOP" });

      const provider = new ForbiddenProvider();
      const context = asContext(outboundContext());
      const deps = {
        db: database(),
        farmerIntent: createFarmerMessageIntentModel(provider),
        customerIntent: {
            classify: async () => {
              throw new Error("the customer intent seam must not run on this path");
            },
          },
        stockOut: {
            parseItem: async () => {
              throw new Error("the stock-out seam must not run on this path");
            },
          },
        interpreter: createInventoryInterpreter(provider),
        inquiry: createInquiryModel(provider),
        clock: new SystemClock(),
        // F-040: configured origin for a farmer standing link. Never a request header.
        publicBaseUrl: "https://farmfriend.example",
        publicMapUrl: "https://www.vigavashon.org/farm-stand-map",
      };

      // Fired together: kicks (sender-scoped) and cron passes (unscoped sweeps), REPEATED
      // so the claim windows genuinely overlap. Two bare `Promise.all` branches are not a
      // race — the first branch's claim transaction resolves before the second one starts,
      // so the passes serialize themselves and the test cannot fail. Verified: with the
      // claim's own exclusion sabotaged, a two-branch version still passed. Enough
      // simultaneous claimants to actually contend is what makes this an assertion.
      const contenders = 8;
      await Promise.all(
        Array.from({ length: contenders }, (_unused, index) =>
          index % 2 === 0
            ? kickSenderPasses(
                {
                  runInbound: (senderHashes) => runInboundPass(deps, senderHashes),
                  runOutbound: () =>
                    runOutboundPass({ context, clock: new SystemClock() }),
                },
                senderHash,
              )
            : (async () => {
                await runInboundPass(deps);
                await runOutboundPass({ context, clock: new SystemClock() });
              })(),
        ),
      );

      // Exactly one inbound event, processed exactly once.
      const events = await client()`
        select state, count(*)::integer as count from provider_inbox_events
        group by state
      `;
      expect(events).toHaveLength(1);
      expect(events[0]?.state).toBe("processed");
      expect(events[0]?.count).toBe(1);

      // Exactly one outbox row — the logical key deduplicates a doubly-routed reply...
      const work = await client()`
        select count(*)::integer as count from outbox_work
        where recipient_hash = ${senderHash}
      `;
      expect(work[0]?.count).toBe(1);

      // ...and, the claim that actually matters to a real person, exactly ONE dispatch
      // attempt. Two attempts would be two SMS messages to the same phone.
      const attempts = await client()`
        select count(*)::integer as count from outbox_dispatch_attempts
      `;
      expect(attempts[0]?.count).toBe(1);
    }, 30_000);

    it("two concurrent kicks for one sender send exactly one reply", async () => {
      // Telnyx retries a webhook it thinks failed, so two invocations for one sender can
      // overlap. The duplicate event is a no-op at ingress and the row lock serializes the
      // passes, so the person receives one message.
      const providerEventId = `evt-${randomUUID()}`;
      await deliverInboundWithoutKick({ text: "STOP", providerEventId });
      await deliverInboundWithoutKick({ text: "STOP", providerEventId });

      const provider = new ForbiddenProvider();
      const context = asContext(outboundContext());
      const deps = {
        db: database(),
        farmerIntent: createFarmerMessageIntentModel(provider),
        customerIntent: {
            classify: async () => {
              throw new Error("the customer intent seam must not run on this path");
            },
          },
        stockOut: {
            parseItem: async () => {
              throw new Error("the stock-out seam must not run on this path");
            },
          },
        interpreter: createInventoryInterpreter(provider),
        inquiry: createInquiryModel(provider),
        clock: new SystemClock(),
        // F-040: configured origin for a farmer standing link. Never a request header.
        publicBaseUrl: "https://farmfriend.example",
        publicMapUrl: "https://www.vigavashon.org/farm-stand-map",
      };
      const kick = () =>
        kickSenderPasses(
          {
            runInbound: (senderHashes) => runInboundPass(deps, senderHashes),
            runOutbound: () => runOutboundPass({ context, clock: new SystemClock() }),
          },
          senderHash,
        );

      // Eight overlapping kicks, for the same reason as above: two is not contention.
      await Promise.all(Array.from({ length: 8 }, () => kick()));

      const attempts = await client()`
        select count(*)::integer as count from outbox_dispatch_attempts
      `;
      expect(attempts[0]?.count).toBe(1);
    }, 30_000);
  });

  /**
   * Deliver a webhook with the kick suppressed — the "invocation died right after the 200"
   * case. It commits exactly what the route commits before acknowledging, so what follows
   * is ordinary pending work with no kick behind it.
   */
  async function deliverInboundWithoutKick(input: {
    text: string;
    providerEventId?: string;
  }): Promise<Response> {
    const { acceptProviderEvent } = await import("@farm-friend/db");
    const providerEventId = input.providerEventId ?? `evt-${randomUUID()}`;
    await acceptProviderEvent(database(), {
      providerEventId,
      eventType: "message_received",
      providerMessageId: `msg-${randomUUID()}`,
      senderHash,
      body: input.text,
      occurredAt: new Date(),
    });
    return Response.json({ received: true }, { status: 200 });
  }
});
