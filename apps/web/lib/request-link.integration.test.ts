import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createPublicActionThrottle,
  FixedClock,
  verifyMagicToken,
  type MailMessage,
} from "@farm-friend/core";
import { handleRequestLinkRequest, type RequestLinkDeps } from "./request-link";

// F-032 — the sign-in link request against a REAL database.
//
// The unit suite proves the handler's logic over an injected predicate. What only a real
// database can prove is that the predicate is wired to the actual `administrators` table
// with its real semantics — in particular that a REVOKED administrator is indistinguishable
// from a stranger, which is a property of the query's `revoked_at is null` clause and not of
// anything the handler can see.
//
// It also closes the loop the unit suite cannot: that the token this route mails actually
// verifies, so "a link was sent" means "a link that works was sent."

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");
const databaseUrl = process.env.DATABASE_URL;

function requiredDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required; a skipped integration run is not green");
  }
  return databaseUrl;
}

function testDatabaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

describe("sign-in link request (integration)", () => {
  let adminClient: ReturnType<typeof postgres> | undefined;
  let client: ReturnType<typeof postgres> | undefined;
  let testDatabaseName: string | undefined;
  let findAdministratorByEmail: typeof import("@farm-friend/db").findAdministratorByEmail;
  let db: import("@farm-friend/db").Db | undefined;

  const magicSecret = "integration-magic-secret";
  const sql = () => client as ReturnType<typeof postgres>;
  let sent: MailMessage[];
  let clock: FixedClock;

  function deps(overrides: Partial<RequestLinkDeps> = {}): RequestLinkDeps {
    return {
      clock,
      mail: { send: (m) => { sent.push(m); return Promise.resolve(); } },
      throttle: createPublicActionThrottle({ clock, limit: 100, windowMs: 60_000 }),
      magicLinkSecret: magicSecret,
      signalSalt: "integration-salt",
      baseUrl: "https://ff.example",
      // The real lookup, against the real table.
      isAdministrator: async (email) =>
        (await findAdministratorByEmail(db as import("@farm-friend/db").Db, email)) !== null,
      ...overrides,
    };
  }

  const post = (email: string) =>
    new Request("https://ff.example/api/auth/request-link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email }),
    });

  async function serialize(response: Response): Promise<string> {
    const headers = [...response.headers.entries()]
      .filter(([k]) => k !== "date")
      .sort()
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    return `${response.status} ${response.statusText}\n${headers}\n\n${await response.text()}`;
  }

  beforeAll(async () => {
    const baseUrl = requiredDatabaseUrl();
    testDatabaseName = `farm_friend_reqlink_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);
    const url = testDatabaseUrl(baseUrl, testDatabaseName);
    client = postgres(url, { max: 1 });
    const migrationClient = postgres(url, { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });

    // `createDb` rather than `sharedDb`, which caches its pool on first call and would
    // ignore this URL entirely.
    const dbModule = await import("@farm-friend/db");
    findAdministratorByEmail = dbModule.findAdministratorByEmail;
    db = dbModule.createDb(url);

    await sql()`
      insert into administrators (email, authorized_at)
      values ('live@viga.example', now()), ('revoked@viga.example', now())
    `;
    await sql()`
      update administrators set revoked_at = now() where email = 'revoked@viga.example'
    `;
  }, 30_000);

  afterAll(async () => {
    if (db) await db.close();
    if (client) await client.end({ timeout: 5 });
    if (adminClient && testDatabaseName) {
      await adminClient.unsafe(`drop database if exists "${testDatabaseName}"`);
      await adminClient.end({ timeout: 5 });
    }
  });

  beforeEach(() => {
    sent = [];
    clock = new FixedClock(new Date("2026-07-26T12:00:00Z"));
  });

  it("mails a live administrator a link that actually verifies", async () => {
    const response = await handleRequestLinkRequest(post("live@viga.example"), deps());
    expect(response.status).toBe(202);
    expect(sent).toHaveLength(1);

    const token = decodeURIComponent(sent[0]?.text.match(/token=([^\s&]+)/)?.[1] as string);
    const verified = verifyMagicToken(token, magicSecret, clock);
    expect(verified).toEqual({
      ok: true,
      email: "live@viga.example",
      // GL-004 — the identity that makes the link one-use. It is minted HERE, at issue time,
      // and is what the callback consumes.
      nonce: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("gives every mailed link its own single-use identity", async () => {
    // Two links requested by the same administrator at the SAME instant on a fixed clock —
    // every other claim is identical, so if the nonce were derived rather than random these
    // would be the same string, and using one would consume both.
    await handleRequestLinkRequest(post("live@viga.example"), deps());
    await handleRequestLinkRequest(post("live@viga.example"), deps());
    expect(sent).toHaveLength(2);

    const nonces = sent.map((message) => {
      const token = decodeURIComponent(message.text.match(/token=([^\s&]+)/)?.[1] as string);
      const verified = verifyMagicToken(token, magicSecret, clock);
      if (!verified.ok) throw new Error("a mailed link must verify");
      return verified.nonce;
    });
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it("keeps the raw nonce out of the mail body", async () => {
    // The nonce is a component of a bearer credential, and the whole link is deliberately
    // confined to one place in the message. A second appearance — a "reference id", a
    // tracking parameter — would be a second copy of a live secret in the mailbox.
    await handleRequestLinkRequest(post("live@viga.example"), deps());
    const body = sent[0]?.text as string;
    const token = decodeURIComponent(body.match(/token=([^\s&]+)/)?.[1] as string);
    const verified = verifyMagicToken(token, magicSecret, clock);
    if (!verified.ok) throw new Error("a mailed link must verify");

    // The nonce appears nowhere as a bare value; it exists only inside the signed token.
    expect(body).not.toContain(verified.nonce);
  });

  it("issues a link that expires in fifteen minutes", async () => {
    await handleRequestLinkRequest(post("live@viga.example"), deps());
    const token = decodeURIComponent(sent[0]?.text.match(/token=([^\s&]+)/)?.[1] as string);

    const justBefore = new FixedClock(new Date(clock.now().getTime() + 14 * 60_000));
    expect(verifyMagicToken(token, magicSecret, justBefore).ok).toBe(true);

    const justAfter = new FixedClock(new Date(clock.now().getTime() + 16 * 60_000));
    expect(verifyMagicToken(token, magicSecret, justAfter)).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("treats a REVOKED administrator exactly like a stranger", async () => {
    // The property the real table owns. A revoked operator must not receive a link, and must
    // not be distinguishable from an address that was never provisioned at all.
    const asRevoked = await handleRequestLinkRequest(post("revoked@viga.example"), deps());
    const asStranger = await handleRequestLinkRequest(post("nobody@example.com"), deps());

    expect(await serialize(asRevoked)).toBe(await serialize(asStranger));
    expect(sent).toEqual([]);
  });

  it("answers a live administrator identically to a stranger", async () => {
    const asAdmin = await handleRequestLinkRequest(post("live@viga.example"), deps());
    const asStranger = await handleRequestLinkRequest(post("nobody@example.com"), deps());
    expect(await serialize(asStranger)).toBe(await serialize(asAdmin));
  });

  it("stores nothing for any request, administrator or not", async () => {
    // A link is a signed, stateless token: requesting one writes NO row. That matters for an
    // unauthenticated endpoint — a durable write per request would be a way for a stranger to
    // grow Farm Friend's tables from the internet.
    const before = await sql()`select count(*)::int as n from admin_sessions`;
    await handleRequestLinkRequest(post("live@viga.example"), deps());
    await handleRequestLinkRequest(post("nobody@example.com"), deps());
    const after = await sql()`select count(*)::int as n from admin_sessions`;

    expect(after[0]?.n).toBe(before[0]?.n);
    // A session appears only when the link is OPENED, which is the callback's job.
    expect(after[0]?.n).toBe(0);
  });

  it("matches a stored address case-insensitively", async () => {
    await handleRequestLinkRequest(post("LIVE@VIGA.example"), deps());
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe("live@viga.example");
  });
});
