import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  FixedClock,
  hashEmail,
  ISSUE_REPORT_CONFIRMATION,
  ISSUE_REPORT_FILED,
  ISSUE_REPORT_FILED_WITH_REPLY,
  type InventoryInterpreter,
} from "@farm-friend/core";
import type {
  RequestCategory,
  RequestClassificationModel,
  CatalogMatcher,
  StockOutModel,
} from "@farm-friend/ai";
import type { Db, Sql } from "@farm-friend/db";
import { handleFreeText } from "./free-text";
import { routeInboundMessage } from "./routing";

/*
  B-091 — someone tells us our own information is wrong, and VIGA hears about it.

  The shape max asked for: the classifier RECOGNISES an issue report and asks "Do you want to
  let VIGA know about this issue?", and only a YES files it.

  What these tests are really defending is the line the recognition must not cross. The model
  names a possibility; it never creates the review item (Golden Rule #3). So the assertions
  come in pairs — after the model has spoken, the queue is still empty; after the sender
  confirms, it is not. A test that only checked the happy path would pass just as well against
  an implementation that filed on classification alone, which is the bug worth preventing.

  Real Postgres, because the pending row, its unique index, its expiry and the `flags` insert
  ARE the mechanism. A stubbed driver would assert the mock.
*/

const T0 = new Date(Date.now() - 60_000);
const minutesAfter = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

describe("B-091 issue reports reach VIGA only on confirmation (integration)", () => {
  let admin: Sql | undefined;
  let sql: Sql | undefined;
  let databaseName = "";

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `ff_issue_report_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: "packages/db/drizzle" });
    await migrationClient.end({ timeout: 5 });
    sql = postgres(url.toString(), { max: 10 });
  }, 30_000);

  afterAll(async () => {
    if (sql) await sql.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  beforeEach(async () => {
    await client()`truncate contacts, sellers restart identity cascade`;
    await client()`truncate pending_issue_reports`;
    await client()`truncate flags`;
    await client()`truncate provider_inbox_events restart identity cascade`;
  });

  function client(): Sql {
    if (!sql) throw new Error("database not initialized");
    return sql;
  }

  function database(): Db {
    return { sql: client(), orm: {}, close: async () => {} } as unknown as Db;
  }

  const senderHash = "d".repeat(64);
  const REPORT = "your map shows the wrong hours for Pinecone";

  function classifier(byText: Record<string, RequestCategory>): RequestClassificationModel {
    return {
      async classify({ taskText }) {
        const kind = byText[taskText];
        if (kind === undefined) {
          throw new Error(`unscripted classification for ${JSON.stringify(taskText)}`);
        }
        if (kind === "search_stands") return { ok: true, kind, request: { operation: "inventory" } };
        if (kind === "stand_lookup") return { ok: true, kind, request: { operation: "overview" } };
        return { ok: true, kind };
      },
    };
  }

  function deps(intent: RequestClassificationModel) {
    return {
      db: database(),
      interpreter: {
        interpret: async () => {
          throw new Error("the farmer interpreter must not run for a customer");
        },
      } as unknown as InventoryInterpreter,
      catalogMatcher: {
        async match() {
          throw new Error("retrieval must not run for an issue report");
        },
      } as CatalogMatcher,
      classifier: intent,
      stockOut: {
        async parseItem() {
          throw new Error("the stock-out seam must not run for an issue report");
        },
      } as unknown as StockOutModel,
      clock: new FixedClock(T0),
    };
  }

  /**
   * An inbound event row, because both the pending report and the filed flag reference one.
   *
   * `pending` is the state a message occupies while its reply is still being decided, and it
   * is the only shape `provider_inbox_events_coherent_claim_state` accepts with no claim or
   * finalization columns — so it is both the honest state here and the simplest legal one.
   */
  async function inboxEvent(occurredAt = T0): Promise<string> {
    await client()`
      insert into contacts (phone_hash, phone_e164)
      values (${senderHash}, '+12065550142')
      on conflict (phone_hash) do nothing
    `;
    /*
      ACTIVE CONSENT, because F-121 gates everything downstream of compliance: a sender who
      never agreed is invited to join rather than answered, and every assertion below about
      what an issue report does would instead be measuring the consent gate.
    */
    await client()`
      insert into sms_consents
        (recipient_hash, state, capture_source, captured_at, capture_evidence_ref, updated_at)
      values (${senderHash}, 'active', 'join', ${T0}, 'test-join-evidence', ${T0})
      on conflict (recipient_hash) do nothing
    `;
    const messages = await client()`
      insert into sms_messages
        (provider_message_id, sender_hash, body, body_expires_at, received_at)
      values (
        ${randomUUID()}, ${senderHash}, ${REPORT},
        ${new Date(occurredAt.getTime() + 30 * 24 * 3_600_000)}, ${occurredAt}
      ) returning id
    `;
    const rows = await client()`
      insert into provider_inbox_events
        (provider_event_id, occurred_at, state, event_type, message_id, sender_hash)
      values (
        ${randomUUID()}, ${occurredAt}, 'pending', 'message_received',
        ${messages[0]?.id as string}, ${senderHash}
      ) returning id
    `;
    return rows[0]?.id as string;
  }

  async function openFlags(): Promise<{ reason: string; eventId: string }[]> {
    const rows = await client()`
      select reason_code, inbox_event_id from flags where status = 'open'
    `;
    return rows.map((row) => ({
      reason: row.reason_code as string,
      eventId: row.inbox_event_id as string,
    }));
  }


  async function report(inboxEventId: string, occurredAt = T0) {
    return handleFreeText(deps(classifier({ [REPORT]: "issue_report" })), {
      senderHash,
      taskText: REPORT,
      occurredAt,
      providerEventId: `evt-${randomUUID()}`,
      inboxEventId,
    });
  }

  /**
   * A YES arriving through DETERMINISTIC ROUTING, which is where it is really answered.
   *
   * Routed rather than called directly: the whole question is whether an issue confirmation
   * can reach the filing path without displacing an inventory publication, and only the real
   * router decides that order.
   */
  /** Send an arbitrary body through routing — for the `YES <email>` grammar. */
  async function confirmWith(
    body: string,
    occurredAt = minutesAfter(1),
    /*
      `"none"` rather than `undefined`, because a default parameter cannot express "explicitly
      no salt" — passing `undefined` selects the default and the test would silently exercise
      the configured case it means to rule out.
    */
    salt: string | "none" = "test-email-salt",
  ) {
    return confirm(body as "YES" | "NO", occurredAt, salt);
  }

  async function confirm(
    token: "YES" | "NO",
    occurredAt = minutesAfter(1),
    salt: string | "none" = "test-email-salt",
  ) {
    return routeInboundMessage(
      {
        db: database(),
        clock: new FixedClock(occurredAt),
        publicBaseUrl: "https://example.test",
        publicMapUrl: "https://example.test/map",
        emailSalt: salt === "none" ? undefined : salt,
        freeText: async () => {
          throw new Error("a commitment token must never reach the model");
        },
        nextPage: async () => {
          throw new Error("a commitment token must never page");
        },
        farmerTarget: async () => {
          throw new Error("a commitment token is not a farmer keyword");
        },
        selectStand: async () => {
          throw new Error("a commitment token is not a stand selection");
        },
        hostConfirmation: async () => ({ status: "no_open_question" as const }),
        scheduledSame: async () => {
          throw new Error("a commitment token is not SAME");
        },
      },
      {
        senderHash,
        body: token,
        occurredAt,
        providerEventId: `evt-${randomUUID()}`,
        inboxEventId: await inboxEvent(),
      },
    );
  }

  it("asks before it files, and files nothing until the sender says yes", async () => {
    const eventId = await inboxEvent();

    const asked = await report(eventId);
    expect(asked.replies[0]?.body).toBe(ISSUE_REPORT_CONFIRMATION);
    // THE POINT: the model has classified, and VIGA's queue is still empty.
    expect(await openFlags()).toHaveLength(0);

    const confirmed = await confirm("YES");
    expect(confirmed.replies[0]?.body).toBe(ISSUE_REPORT_FILED);

    const flags = await openFlags();
    expect(flags).toHaveLength(1);
    expect(flags[0]?.reason).toBe("issue_reported");
    // It points at the message that DESCRIBES the problem, not at the bare YES, which carries
    // nothing a coordinator could read.
    expect(flags[0]?.eventId).toBe(eventId);
  });

  /*
    THE OPTIONAL ADDRESS (max, 2026-08-19).

    A reporter may ask to hear back, and the only way to answer them is an address. It is
    scoped to the one flag it was given for and disappears with it — a customer acquires no
    durable profile by reporting a problem (Golden Rule #5). The raw value lives in exactly one
    column with its hash beside it, the same discipline `seller_emails` follows.
  */
  it("keeps the address a reporter offers, with its hash beside it", async () => {
    await report(await inboxEvent());
    const confirmed = await confirmWith("YES cathy@example.com");

    // The reply says the address landed, which is the half the reporter cannot otherwise see.
    expect(confirmed.replies[0]?.body).toBe(ISSUE_REPORT_FILED_WITH_REPLY);

    const rows = await client()`
      select reporter_email, reporter_email_hash from flags where status = 'open'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reporter_email).toBe("cathy@example.com");
    // The hash is the lookup key and must actually be derivable, not merely present.
    expect(rows[0]?.reporter_email_hash).toBe(hashEmail("cathy@example.com", "test-email-salt"));
  });

  it("normalizes the address before storing it", async () => {
    // One spelling per address, so the same person is one person however they typed it.
    await report(await inboxEvent());
    await confirmWith("YES Cathy@Example.COM");

    const rows = await client()`select reporter_email from flags where status = 'open'`;
    expect(rows[0]?.reporter_email).toBe("cathy@example.com");
  });

  it("files with no address when the reporter does not offer one", async () => {
    await report(await inboxEvent());
    const confirmed = await confirm("YES");

    expect(confirmed.replies[0]?.body).toBe(ISSUE_REPORT_FILED);
    const rows = await client()`
      select reporter_email, reporter_email_hash from flags where status = 'open'
    `;
    // Both columns absent together — the CHECK refuses any other combination.
    expect(rows[0]?.reporter_email).toBeNull();
    expect(rows[0]?.reporter_email_hash).toBeNull();
  });

  it("refuses the address rather than storing it unfindable, when no salt is configured", async () => {
    /*
      A REAL DEPLOYMENT SHAPE, not a hypothetical: `EMAIL_HASH_SALT` is mounted on the web
      service only, and the WORKER runs the inbound pass. The hash is the only lookup key an
      address has, so storing one without it would leave a value nobody can ever find — and
      the CHECK refuses that pairing outright.

      So the address is dropped and the reporter is told what is actually true: someone will
      look. Promising a reply we cannot send would be the worse failure.
    */
    await report(await inboxEvent());
    const confirmed = await confirmWith("YES cathy@example.com", minutesAfter(1), "none");

    expect(confirmed.replies[0]?.body).toBe(ISSUE_REPORT_FILED);
    const rows = await client()`
      select reporter_email, reporter_email_hash from flags where status = 'open'
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.reporter_email).toBeNull();
    expect(rows[0]?.reporter_email_hash).toBeNull();
  });

  it("does not read a mistyped address as a bare confirmation", async () => {
    /*
      The failure `JOIN <token>` used to have, and the reason this grammar is admitted at all:
      a mistyped argument must not be silently swallowed. "YES cathy@" is not an address, so it
      is not a commitment — it stays free text, the report stays open, and the sender can try
      again rather than wondering what happened.
    */
    await report(await inboxEvent());
    await confirmWith("YES cathy@").catch(() => undefined);

    expect(await openFlags()).toHaveLength(0);
    expect(
      (await client()`select count(*)::int as n from pending_issue_reports`)[0]?.n,
    ).toBe(1);
  });

  it("files nothing when the sender declines, and forgets the report", async () => {
    await report(await inboxEvent());
    await confirm("NO");
    expect(await openFlags()).toHaveLength(0);

    // A later unrelated YES must not resurrect a report already declined.
    await confirm("YES", minutesAfter(2));
    expect(await openFlags()).toHaveLength(0);
  });

  it("forgets a report the sender never confirmed, rather than filing it later", async () => {
    await report(await inboxEvent());
    // Past the TTL. Expiry is judged against the MESSAGE's clock, so a delayed YES cannot
    // commit a report the sender has long since moved on from.
    await confirm("YES", minutesAfter(30));
    expect(await openFlags()).toHaveLength(0);
  });

  it("keeps one open report per sender, so one YES cannot file two", async () => {
    await report(await inboxEvent());
    const second = await inboxEvent();
    await report(second, minutesAfter(1));

    expect(
      (await client()`select count(*)::int as n from pending_issue_reports`)[0]?.n,
    ).toBe(1);

    await confirm("YES", minutesAfter(2));
    const flags = await openFlags();
    expect(flags).toHaveLength(1);
    // The SECOND description is what VIGA holds — the one the sender was last asked about.
    expect(flags[0]?.eventId).toBe(second);
  });

  it("never lets an issue confirmation displace an inventory publication", async () => {
    /*
      Three things mean YES, and the consequential one must win. A sender with a live
      publication proposal who texts YES publishes their inventory — the issue question waits.
      Asserted by leaving the proposal open and checking the report survives unfiled.
    */
    await report(await inboxEvent());

    const sellers = await client()`insert into sellers (name) values ('Pinecone') returning id`;
    const farmId = sellers[0]?.id as string;

    const locations = await client()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        public_address, public_latitude, public_longitude
      ) values (
        ${farmId}, 'farm_stand', 'Pinecone', 'America/Los_Angeles', 'visitable',
        'produce', '1 Road', 47.44, -122.46
      ) returning id
    `;
    await client()`
      insert into inventory_publication_proposals
        (sender_hash, sales_location_id, payload, proposal_version,
         has_inventory, has_closure, closure_base_is_first_instruction, state, created_at)
      values (
        ${senderHash}, ${locations[0]?.id as string},
        ${client().json({ closure: {} })}, 1, false, true, true, 'open', ${T0}
      )
    `;

    await confirm("YES", minutesAfter(2)).catch(() => undefined);

    // The publication path owned the token, so no issue was filed and the report is still open.
    expect(await openFlags()).toHaveLength(0);
    expect(
      (await client()`select count(*)::int as n from pending_issue_reports`)[0]?.n,
    ).toBe(1);
  });
});
