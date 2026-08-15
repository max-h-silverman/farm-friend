import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { MAX_CODES_PER_WINDOW, hashEmail, hashVerificationCode } from "@farm-friend/core";

import { createDb } from "./index";
import { ingestFarmEmails } from "./farm-emails";
import {
  consumeAndGrant,
  consumeVerification,
  countRecentIssuances,
  findVerifiableFarmByEmail,
  issueVerificationCode,
  readLiveVerification,
  recordFailedAttempt,
  resolvePublishGrant,
} from "./farm-verification";

// F-079 — the verification store, against real Postgres and the real constraints.
//
// This is an integration test because every claim it makes rests on something only the database
// arbitrates: the partial unique index that permits one live code per farm, `on conflict do
// nothing` as the concurrency arbiter, and the CHECK constraints on the hash columns. A fake
// database would agree with whatever the code assumed.

const migrationsDir = resolve(process.cwd(), "packages/db/drizzle");
const SALT = "verification-test-salt";
const NOW = new Date("2026-08-06T12:00:00Z");

describe("F-079 farm email verification (integration)", () => {
  let adminClient: ReturnType<typeof postgres> | undefined;
  let client: ReturnType<typeof postgres> | undefined;
  let db: ReturnType<typeof createDb> | undefined;
  let databaseName = "";
  let lavenderId = "";
  let holmesteadId = "";

  const sql = () => {
    if (!client) throw new Error("no database client");
    return client;
  };
  const database = () => {
    if (!db) throw new Error("no database");
    return db;
  };

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) {
      throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    }
    databaseName = `ff_verification_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(base, { max: 1 });
    await adminClient.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    // Enough connections to create GENUINE contention in the concurrency test below.
    client = postgres(url.toString(), { max: 10 });
    await migrate(drizzle(client), { migrationsFolder: migrationsDir });
    db = createDb(url.toString());

    for (const name of ["Lavender Hill Farm", "Holmestead"]) {
      await sql()`insert into sellers (name, created_at) values (${name}, ${NOW.toISOString()})`;
    }
    await ingestFarmEmails(
      database(),
      [
        { farmName: "Lavender Hill Farm", emails: ["cathy@example.com", "info@example.com"] },
        { farmName: "Holmestead", emails: ["holme@example.com"] },
      ],
      SALT,
      NOW,
    );
    const sellers = await sql()`select id, name from sellers order by name`;
    lavenderId = (sellers.find((f) => f.name === "Lavender Hill Farm")?.id ?? "") as string;
    holmesteadId = (sellers.find((f) => f.name === "Holmestead")?.id ?? "") as string;
  }, 120_000);

  afterAll(async () => {
    await db?.close();
    await client?.end();
    if (adminClient) {
      await adminClient.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await adminClient.end();
    }
  });

  beforeEach(async () => {
    await sql()`delete from seller_email_verifications`;
  });

  describe("finding the farm an address may verify", () => {
    it("resolves an address on file to its farm", async () => {
      const found = await findVerifiableFarmByEmail(database(), {
        farmId: lavenderId,
        email: "cathy@example.com",
        salt: SALT,
      });
      expect(found).toBe(true);
    });

    it("matches regardless of the capitalization the farmer typed", async () => {
      // VIGA recorded one spelling; the farmer types another. Both must reach the same row, or
      // verification fails for a farmer who is entirely correct.
      const found = await findVerifiableFarmByEmail(database(), {
        farmId: lavenderId,
        email: "  Cathy@Example.COM ",
        salt: SALT,
      });
      expect(found).toBe(true);
    });

    it("REFUSES an address on file for a DIFFERENT farm — the cross-farm rule", async () => {
      // The acceptance criterion: an email on file for farm X does not verify farm Y. The
      // query is scoped to the farm, which is what the 0024 migration says enforces this —
      // the unique index deliberately does not, since one couple may farm two plots.
      const found = await findVerifiableFarmByEmail(database(), {
        farmId: holmesteadId,
        email: "cathy@example.com",
        salt: SALT,
      });
      expect(found).toBe(false);
    });

    it("refuses an address on file for nobody", async () => {
      const found = await findVerifiableFarmByEmail(database(), {
        farmId: lavenderId,
        email: "stranger@example.com",
        salt: SALT,
      });
      expect(found).toBe(false);
    });

    it("never uses the RAW address as a query predicate", async () => {
      // Golden Rule #5: the hash is the only lookup key, so a submitted address never reaches
      // a query log. Proven by planting a row whose hash is deliberately not the hash of its
      // own address — a raw-address lookup would find it and a hash lookup cannot.
      await sql()`
        insert into seller_emails (seller_id, email, email_hash, added_at)
        values (${holmesteadId}, 'decoy@example.com',
                ${hashEmail("something-else@example.com", SALT)}, ${NOW.toISOString()})
      `;
      const found = await findVerifiableFarmByEmail(database(), {
        farmId: holmesteadId,
        email: "decoy@example.com",
        salt: SALT,
      });
      expect(found).toBe(false);
      await sql()`delete from seller_emails where email = 'decoy@example.com'`;
    });
  });

  describe("issuing a code", () => {
    it("stores the HASH and never the code itself", async () => {
      const issued = await issueVerificationCode(database(), {
        farmId: lavenderId,
        email: "cathy@example.com",
        salt: SALT,
        codeSalt: SALT,
        now: NOW,
      });
      expect(issued.status).toBe("issued");
      if (issued.status !== "issued") return;

      const rows = await sql()`select * from seller_email_verifications`;
      expect(rows).toHaveLength(1);
      // The plaintext code appears NOWHERE in the row.
      expect(JSON.stringify(rows[0])).not.toContain(issued.code);
      expect(rows[0]?.code_hash).toBe(hashVerificationCode(issued.code, SALT));
      // And the address does not either — the hash is what identifies the recipient.
      expect(JSON.stringify(rows[0])).not.toContain("cathy@example.com");
      expect(rows[0]?.email_hash).toBe(hashEmail("cathy@example.com", SALT));
    });

    it("permits ONE live code per farm, and the newest is the one that lives", async () => {
      const first = await issueVerificationCode(database(), {
        farmId: lavenderId,
        email: "cathy@example.com",
        salt: SALT,
        codeSalt: SALT,
        now: NOW,
      });
      expect(first.status).toBe("issued");

      const second = await issueVerificationCode(database(), {
        farmId: lavenderId,
        email: "cathy@example.com",
        salt: SALT,
        codeSalt: SALT,
        now: new Date(NOW.getTime() + 60_000),
      });
      // A second LIVE code would mean the older one still opens the listing while the farmer
      // types the newer — two keys where the design promises one. Superseding keeps that
      // promise; what it changes is that the farmer's newest request is the key that works,
      // rather than her abandoned first attempt locking the farm (see the test below).
      expect(second.status).toBe("issued");
      const live = await sql()`
        select count(*)::int as n from seller_email_verifications
        where seller_id = ${lavenderId} and consumed_at is null
      `;
      expect(live).toEqual([{ n: 1 }]);
    });

    it("SUPERSEDES a code the farmer never used, rather than locking the farm out", async () => {
      /*
        THE PRODUCTION FAILURE THIS FIXES (max, 2026-08-09).

        A farmer requested a code, the mail did not reach her, and every retry for the next 30
        minutes was refused: `one_live_per_farm` is partial on `consumed_at IS NULL`, so an
        UNUSED code holds the farm's only slot until it is consumed — and expiry does not
        release it. The route answers "sent" either way, so the screen said the mail was on its
        way while the insert had been silently refused. She was locked out by her own first
        attempt, with nothing to click to escape it.

        Superseding keeps the invariant the test above states: still exactly one live code, so
        the old one stops opening the listing the moment a new one is issued. What changes is
        WHICH request loses — the farmer's newest intent wins over her abandoned one.
      */
      const first = await issueVerificationCode(database(), {
        farmId: lavenderId,
        email: "cathy@example.com",
        salt: SALT,
        codeSalt: SALT,
        now: NOW,
      });
      expect(first.status).toBe("issued");

      const second = await issueVerificationCode(database(), {
        farmId: lavenderId,
        email: "cathy@example.com",
        salt: SALT,
        codeSalt: SALT,
        now: new Date(NOW.getTime() + 60_000),
      });
      expect(second.status).toBe("issued");

      // STILL exactly one live code — the invariant is unchanged, the winner is not.
      const live = await sql()`
        select id from seller_email_verifications
        where seller_id = ${lavenderId} and consumed_at is null
      `;
      expect(live).toHaveLength(1);
      if (second.status !== "issued") throw new Error(second.status);
      expect(live[0]?.id).toBe(second.id);

      // The superseded row is retained rather than deleted: it is the record that a code was
      // issued and never used, which is what an operator reads when a farmer reports this.
      const all = await sql()`
        select count(*)::int as n from seller_email_verifications where seller_id = ${lavenderId}
      `;
      expect(all).toEqual([{ n: 2 }]);
    });

    it("REFUSES the old code once it has been superseded", async () => {
      // Superseding is only honest if the old code stops working. Two keys where the design
      // promises one is the failure the one-live-code rule exists to prevent.
      const first = await issueVerificationCode(database(), {
        farmId: lavenderId,
        email: "cathy@example.com",
        salt: SALT,
        codeSalt: SALT,
        now: NOW,
      });
      if (first.status !== "issued") throw new Error(first.status);

      await issueVerificationCode(database(), {
        farmId: lavenderId,
        email: "cathy@example.com",
        salt: SALT,
        codeSalt: SALT,
        now: new Date(NOW.getTime() + 60_000),
      });

      const live = await readLiveVerification(database(), { farmId: lavenderId });
      // The live record is the NEW one, so the old code cannot be the one a submission is
      // checked against.
      expect(live?.id).not.toBe(first.id);
    });

    it("permits a fresh code once the previous one is CONSUMED", async () => {
      const first = await issueVerificationCode(database(), {
        farmId: lavenderId,
        email: "cathy@example.com",
        salt: SALT,
        codeSalt: SALT,
        now: NOW,
      });
      if (first.status !== "issued") throw new Error("expected an issued code");
      await consumeVerification(database(), { id: first.id, now: NOW });

      const second = await issueVerificationCode(database(), {
        farmId: lavenderId,
        email: "cathy@example.com",
        salt: SALT,
        codeSalt: SALT,
        now: new Date(NOW.getTime() + 60_000),
      });
      expect(second.status).toBe("issued");
    });

    it("lets two DIFFERENT sellers hold live codes at the same time", async () => {
      // The index is scoped to the farm; one farmer verifying must not block another.
      const a = await issueVerificationCode(database(), {
        farmId: lavenderId,
        email: "cathy@example.com",
        salt: SALT,
        codeSalt: SALT,
        now: NOW,
      });
      const b = await issueVerificationCode(database(), {
        farmId: holmesteadId,
        email: "holme@example.com",
        salt: SALT,
        codeSalt: SALT,
        now: NOW,
      });
      expect(a.status).toBe("issued");
      expect(b.status).toBe("issued");
    });

    it("issues exactly ONE code under genuine concurrency", async () => {
      // GENUINE contention: eight simultaneous claimants against one farm, each on its own
      // connection. `select`-then-`insert` cannot serialize a row that does not exist yet, so
      // the partial unique index is the arbiter — an empty `returning` means someone else won.
      const attempts = await Promise.all(
        Array.from({ length: 8 }, () =>
          issueVerificationCode(database(), {
            farmId: lavenderId,
            email: "cathy@example.com",
            salt: SALT,
            codeSalt: SALT,
            now: NOW,
          }),
        ),
      );

      const issued = attempts.filter((a) => a.status === "issued");
      expect(issued).toHaveLength(1);
      expect(await sql()`select count(*)::int as n from seller_email_verifications`).toEqual([
        { n: 1 },
      ]);
    });
  });

  describe("the issuance throttle", () => {
    it("counts recent issuances for a farm, and stops counting past the window", async () => {
      // Rows are planted directly so the window boundary is exercised without waiting an hour.
      for (const minutesAgo of [5, 30, 59, 61, 400]) {
        await sql()`
          insert into seller_email_verifications
            (seller_id, email_hash, code_hash, issued_at, expires_at, consumed_at)
          values (${lavenderId}, ${hashEmail("cathy@example.com", SALT)},
                  ${hashVerificationCode("000000", SALT)},
                  ${new Date(NOW.getTime() - minutesAgo * 60_000).toISOString()},
                  ${new Date(NOW.getTime() - (minutesAgo - 30) * 60_000).toISOString()},
                  ${new Date(NOW.getTime() - minutesAgo * 60_000).toISOString()})
        `;
      }

      const forFarm = await countRecentIssuances(database(), {
        farmId: lavenderId,
        emailHash: hashEmail("cathy@example.com", SALT),
        now: NOW,
      });
      // Three inside the hour; the 61- and 400-minute rows are outside it.
      expect(forFarm.farmCount).toBe(3);
      expect(forFarm.emailCount).toBe(3);
    });

    it("counts an address SEPARATELY from the farm, so both limits are real", async () => {
      // Lavender has two addresses on file. Codes sent to one must not exhaust the other's
      // budget silently, and the farm-wide limit must still see both.
      for (const email of ["cathy@example.com", "info@example.com"]) {
        await sql()`
          insert into seller_email_verifications
            (seller_id, email_hash, code_hash, issued_at, expires_at, consumed_at)
          values (${lavenderId}, ${hashEmail(email, SALT)},
                  ${hashVerificationCode("000000", SALT)},
                  ${NOW.toISOString()},
                  ${new Date(NOW.getTime() + 1_800_000).toISOString()},
                  ${NOW.toISOString()})
        `;
      }

      const counts = await countRecentIssuances(database(), {
        farmId: lavenderId,
        emailHash: hashEmail("cathy@example.com", SALT),
        now: NOW,
      });
      expect(counts.farmCount).toBe(2);
      expect(counts.emailCount).toBe(1);
    });

    it("refuses issuance once the farm's window budget is spent", async () => {
      for (let i = 0; i < MAX_CODES_PER_WINDOW; i += 1) {
        await sql()`
          insert into seller_email_verifications
            (seller_id, email_hash, code_hash, issued_at, expires_at, consumed_at)
          values (${lavenderId}, ${hashEmail("cathy@example.com", SALT)},
                  ${hashVerificationCode("000000", SALT)},
                  ${new Date(NOW.getTime() - (i + 1) * 60_000).toISOString()},
                  ${new Date(NOW.getTime() + 1_800_000).toISOString()},
                  ${new Date(NOW.getTime() - (i + 1) * 60_000).toISOString()})
        `;
      }

      const result = await issueVerificationCode(database(), {
        farmId: lavenderId,
        email: "cathy@example.com",
        salt: SALT,
        codeSalt: SALT,
        now: NOW,
      });
      expect(result.status).toBe("rate_limited");
    });
  });

  describe("redeeming and failing", () => {
    it("consumes a code exactly once", async () => {
      const issued = await issueVerificationCode(database(), {
        farmId: lavenderId,
        email: "cathy@example.com",
        salt: SALT,
        codeSalt: SALT,
        now: NOW,
      });
      if (issued.status !== "issued") throw new Error("expected an issued code");

      expect(await consumeVerification(database(), { id: issued.id, now: NOW })).toBe(true);
      // The SECOND call must report failure rather than succeeding silently — that is what
      // makes "commits exactly once" a guarantee rather than a hope.
      expect(await consumeVerification(database(), { id: issued.id, now: NOW })).toBe(false);
    });

    it("consumes exactly once under genuine concurrency", async () => {
      const issued = await issueVerificationCode(database(), {
        farmId: lavenderId,
        email: "cathy@example.com",
        salt: SALT,
        codeSalt: SALT,
        now: NOW,
      });
      if (issued.status !== "issued") throw new Error("expected an issued code");

      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          consumeVerification(database(), { id: issued.id, now: NOW }),
        ),
      );
      expect(results.filter(Boolean)).toHaveLength(1);
    });

    it("counts a failed attempt against the record", async () => {
      const issued = await issueVerificationCode(database(), {
        farmId: lavenderId,
        email: "cathy@example.com",
        salt: SALT,
        codeSalt: SALT,
        now: NOW,
      });
      if (issued.status !== "issued") throw new Error("expected an issued code");

      await recordFailedAttempt(database(), { id: issued.id });
      await recordFailedAttempt(database(), { id: issued.id });

      const live = await readLiveVerification(database(), { farmId: lavenderId });
      expect(live?.attemptCount).toBe(2);
    });

    it("reads back a live record with the fields the decision needs", async () => {
      const issued = await issueVerificationCode(database(), {
        farmId: lavenderId,
        email: "cathy@example.com",
        salt: SALT,
        codeSalt: SALT,
        now: NOW,
      });
      if (issued.status !== "issued") throw new Error("expected an issued code");

      const live = await readLiveVerification(database(), { farmId: lavenderId });
      expect(live).not.toBeNull();
      expect(live?.codeHash).toBe(hashVerificationCode(issued.code, SALT));
      expect(live?.consumedAt).toBeNull();
      expect(live?.attemptCount).toBe(0);
    });

    it("mints a grant and consumes the code in ONE statement", async () => {
      const issued = await issueVerificationCode(database(), {
        farmId: lavenderId,
        email: "cathy@example.com",
        salt: SALT,
        codeSalt: SALT,
        now: NOW,
      });
      if (issued.status !== "issued") throw new Error("expected an issued code");

      const token = await consumeAndGrant(database(), {
        id: issued.id,
        now: NOW,
        grantTtlMs: 1_800_000,
      });
      expect(token).not.toBeNull();

      // Both effects landed together: a consume that succeeded while the grant write failed
      // would spend the farmer's only code and hand them nothing.
      const rows = await sql()`
        select consumed_at, grant_hash, grant_expires_at from seller_email_verifications
        where id = ${issued.id}
      `;
      expect(rows[0]?.consumed_at).not.toBeNull();
      expect(rows[0]?.grant_hash).not.toBeNull();
      expect(rows[0]?.grant_expires_at).not.toBeNull();
      // The raw token is never stored.
      expect(JSON.stringify(rows[0])).not.toContain(token as string);
    });

    it("grants to exactly ONE caller under genuine concurrency", async () => {
      const issued = await issueVerificationCode(database(), {
        farmId: lavenderId,
        email: "cathy@example.com",
        salt: SALT,
        codeSalt: SALT,
        now: NOW,
      });
      if (issued.status !== "issued") throw new Error("expected an issued code");

      const tokens = await Promise.all(
        Array.from({ length: 8 }, () =>
          consumeAndGrant(database(), { id: issued.id, now: NOW, grantTtlMs: 1_800_000 }),
        ),
      );
      expect(tokens.filter((t) => t !== null)).toHaveLength(1);
    });

    it("resolves a live grant to its farm", async () => {
      const issued = await issueVerificationCode(database(), {
        farmId: lavenderId,
        email: "cathy@example.com",
        salt: SALT,
        codeSalt: SALT,
        now: NOW,
      });
      if (issued.status !== "issued") throw new Error("expected an issued code");
      const token = await consumeAndGrant(database(), {
        id: issued.id,
        now: NOW,
        grantTtlMs: 1_800_000,
      });

      const resolved = await resolvePublishGrant(database(), {
        token: token as string,
        now: new Date(NOW.getTime() + 60_000),
      });
      expect(resolved).toEqual({ farmId: lavenderId });
    });

    it("REFUSES an expired grant, compared against the clock and not the cookie", async () => {
      // A browser is free to keep sending a cookie past its Max-Age, so expiry has to be a
      // server-side comparison or it is not enforced at all.
      const issued = await issueVerificationCode(database(), {
        farmId: lavenderId,
        email: "cathy@example.com",
        salt: SALT,
        codeSalt: SALT,
        now: NOW,
      });
      if (issued.status !== "issued") throw new Error("expected an issued code");
      const token = await consumeAndGrant(database(), {
        id: issued.id,
        now: NOW,
        grantTtlMs: 1_800_000,
      });

      const resolved = await resolvePublishGrant(database(), {
        token: token as string,
        now: new Date(NOW.getTime() + 1_800_001),
      });
      expect(resolved).toBeNull();
    });

    it("REFUSES an unknown grant token", async () => {
      expect(
        await resolvePublishGrant(database(), { token: "not-a-real-token", now: NOW }),
      ).toBeNull();
    });

    it("returns no live record once one is consumed", async () => {
      const issued = await issueVerificationCode(database(), {
        farmId: lavenderId,
        email: "cathy@example.com",
        salt: SALT,
        codeSalt: SALT,
        now: NOW,
      });
      if (issued.status !== "issued") throw new Error("expected an issued code");
      await consumeVerification(database(), { id: issued.id, now: NOW });

      expect(await readLiveVerification(database(), { farmId: lavenderId })).toBeNull();
    });
  });
});
