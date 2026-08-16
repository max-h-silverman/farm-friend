import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  renderFarmerAuthorizedNotification,
  hashFarmerLinkToken,
  issueFarmerLinkToken,
} from "@farm-friend/core";
import {
  approveFarm,
  authorizeDispatch,
  authorizeFarmer,
  confirmInventoryPublication,
  issueFarmerLink,
  listFarmerAuthorizations,
  openFarmerOnboardingRequest,
  openOrReviseProposal,
  resolveFarmerLink,
  revokeFarmerAuthorization,
  createDb,
  readNativeProviderId,
  type Db,
  type Sql,
} from "./index";

// F-040 — the writer `farmer_authorizations` never had, and the standing link it backs.
//
// The gap this file closes: publication requires `published_by_authorization_id`, and until
// now the ONLY way an authorization existed was a test fixture inserting one. A real farmer
// who texted an update resolved to no authorization, fell through to the customer branch, and
// nothing reported why. Every suite was green.
//
// **The rule for this file, borrowed from `admin-approval.integration.test.ts`: no test
// inserts `farmer_authorizations` or `farmer_links` directly.** Authority comes from
// `authorizeFarmer`, and a link comes from `issueFarmerLink`, or neither exists. A fixture
// that hand-writes the row it is supposed to be proving is the exact shape of the defect.

const dbPackage = resolve(process.cwd(), "packages/db");
const migrationsDir = resolve(dbPackage, "drizzle");
const databaseUrl = process.env.DATABASE_URL;

function requiredDatabaseUrl(): string {
  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is required; a skipped integration run is not green",
    );
  }
  return databaseUrl;
}

function testDatabaseUrl(baseUrl: string, databaseName: string): string {
  const url = new URL(baseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

describe("farmer authorization and standing links (integration)", () => {
  let adminClient: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let testDatabaseName: string | undefined;

  // Clock-derived, never a date literal (the architecture tripwire forbids one in a fixture).
  const anchor = Date.now() - 24 * 60 * 60 * 1000;
  const at = (hours: number) => new Date(anchor + hours * 60 * 60 * 1000);
  const sql = () => client as Sql;
  const database = () => db as Db;

  let administratorId: string;

  /**
   * A contact with a real phone hash, the way ingress creates one. `label` distinguishes the
   * cases; the digits are derived from a counter so every number is a valid E.164 — the
   * `contacts_phone_e164_normalized` check refuses anything else, which is how it should be.
   */
  let contactCounter = 0;
  async function contact(label: string): Promise<string> {
    contactCounter += 1;
    const digits = String(1000 + contactCounter);
    // Hex, because the masking assertions below check that no 64-hex string reaches the
    // operator queue — a hash containing a non-hex character would dodge that check.
    const hash = `${label}${contactCounter.toString(16)}`.padStart(64, "0");
    await sql()`
      insert into contacts (phone_e164, phone_hash)
      values (${`+1206555${digits}`}, ${hash})
      on conflict (phone_hash) do nothing
    `;
    return hash;
  }

  /** Create or recover the opaque open request VIGA must answer. */
  async function onboardingRequest(contactHash: string): Promise<string> {
    await openFarmerOnboardingRequest(database(), {
      contactHash,
      occurredAt: at(0),
      publicBaseUrl: "https://farmfriend.test",
    });
    const rows = await sql()`
      select id from farmer_onboarding_requests
      where contact_hash = ${contactHash} and settled_at is null
    `;
    return rows[0]?.id as string;
  }

  /** A farm with one sales location. Returns both ids. */
  async function farmWithStand(
    name: string,
  ): Promise<{ farmId: string; salesLocationId: string }> {
    const sellers = await sql()`
      insert into sellers (name) values (${name}) returning id
    `;
    const farmId = sellers[0]?.id as string;
    const locations = await sql()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      )
      values (
        ${farmId}, 'farm_stand', ${`${name} Stand`}, 'America/Los_Angeles', 'visitable', 'produce', '1 Vashon Hwy', 47.4, -122.4,
        false, false
      )
      returning id
    `;
    return { farmId, salesLocationId: locations[0]?.id as string };
  }

  beforeAll(async () => {
    const baseUrl = requiredDatabaseUrl();
    testDatabaseName = `farm_friend_farmer_auth_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    adminClient = postgres(baseUrl, { max: 1 });
    await adminClient.unsafe(`create database "${testDatabaseName}"`);
    const url = testDatabaseUrl(baseUrl, testDatabaseName);
    client = postgres(url, { max: 1 });
    const migrationClient = postgres(url, { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    db = createDb(url);

    const administrators = await sql()`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', ${at(0).toISOString()})
      returning id
    `;
    administratorId = administrators[0]?.id as string;
  }, 30_000);

  afterAll(async () => {
    if (db) await db.close();
    if (client) await client.end({ timeout: 5 });
    if (adminClient && testDatabaseName) {
      await adminClient.unsafe(`drop database if exists "${testDatabaseName}"`);
      await adminClient.end({ timeout: 5 });
    }
  });

  describe("authorizing a farmer", () => {
    it("creates the authorization VIGA approved, recording the administrator", async () => {
      const contactHash = await contact("a1");
      const { farmId } = await farmWithStand(`Authorize Farm ${randomUUID()}`);

      const result = await authorizeFarmer(database(), {
        farmId,
        requestId: await onboardingRequest(contactHash),
        administratorId,
        occurredAt: at(1),
        publicBaseUrl: "https://farmfriend.test",
      });
      expect(result.status).toBe("authorized");

      const rows = await sql()`
        select a.id, a.seller_id, a.phone_verified_at, a.authorized_at, a.revoked_at,
               c.phone_hash
        from farmer_authorizations a
        join contacts c on c.id = a.contact_id
        where a.seller_id = ${farmId}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.phone_hash).toBe(contactHash);
      expect(rows[0]?.revoked_at).toBeNull();
      // The phone is verified by the fact that the farmer texted from it, at the moment VIGA
      // acted. The schema demands verification precede authorization.
      expect(rows[0]?.phone_verified_at).not.toBeNull();

      // The audit event commits with the authorization or not at all.
      const audit = await sql()`
        select actor_administrator_id, subject_type, subject_id from audit_events
        where action = 'farmer_authorized' and subject_id = ${rows[0]?.id as string}
      `;
      expect(audit).toHaveLength(1);
      expect(audit[0]?.actor_administrator_id).toBe(administratorId);
      expect(audit[0]?.subject_type).toBe("farmer_authorization");
    });

    it("queues the 'you're all set' text with the authorization, atomically", async () => {
      // max's decision: a farmer approved on Tuesday otherwise has no idea until they guess.
      // Queued INSIDE the authorization transaction, so there is no window in which a farmer
      // is authorized and uninformed, or told they are set up when nothing was written.
      const contactHash = await contact("a7");
      const { farmId } = await farmWithStand(`Notify Farm ${randomUUID()}`);

      await authorizeFarmer(database(), {
        farmId,
        requestId: await onboardingRequest(contactHash),
        administratorId,
        occurredAt: at(1),
        publicBaseUrl: "https://farmfriend.test",
      });

      const queued = await sql()`
        select body, message_category, state from outbox_work
        where recipient_hash = ${contactHash}
      `;
      expect(queued).toHaveLength(1);
      /*
        F-094 — the message CARRIES the farmer's private link, minted in this same
        transaction. `farmWithStand` gave this farm a sales location, which is what makes a
        link possible: `issueFarmerLinkIn` needs one, and the no-stand fallback is covered by
        its own case in the unit suite.

        Asserted on the VALUE — the token in the body must be a real live link row — rather
        than on the shape. A body containing "/stand/" and a plausible-looking token would
        satisfy a `toContain` while resolving to nothing for the farmer.
      */
      const body = queued[0]?.body as string;
      const token = /\/stand\/([A-Za-z0-9_-]{22,64})/.exec(body)?.[1];
      expect(token).toBeDefined();
      const live = await sql()`
        select authorization_id from farmer_links
        where token_hash = ${hashFarmerLinkToken(token as string)} and revoked_at is null
      `;
      expect(live).toHaveLength(1);
      expect(body).toBe(
        // This fixture's farm has exactly ONE stand, so the body must be the one-stand form —
        // `STAND` is named only for a farmer who has a second one to pick between (max
        // 2026-08-09). Stating the count here rather than taking the default is what makes this
        // assert the branch the fixture actually exercises.
        renderFarmerAuthorizedNotification(
          `https://farmfriend.test/stand/${token as string}`,
          { standCount: 1 },
        ),
      );
      expect(queued[0]?.state).toBe("queued");
      // A PROACTIVE category: Farm Friend is speaking first. Categorizing it as a reply
      // would let it reach a farmer with no consent basis, which is the exact bypass
      // "approval is not consent" forbids.
      expect(queued[0]?.message_category).toBe("inventory_prompt");
    });

    it("queues NOTHING when the authorization is refused", async () => {
      // The other half of atomicity. A farmer told "you're all set" who was never authorized
      // is worse than one who heard nothing.
      const contactHash = await contact("a8");
      const before = await sql()`
        select count(*)::int as n from outbox_work where recipient_hash = ${contactHash}
      `;

      const result = await authorizeFarmer(database(), {
        farmId: randomUUID(),
        requestId: await onboardingRequest(contactHash),
        administratorId,
        occurredAt: at(1),
        publicBaseUrl: "https://farmfriend.test",
      });
      expect(result.status).toBe("unknown_farm");

      const after = await sql()`
        select count(*)::int as n from outbox_work where recipient_hash = ${contactHash}
      `;
      expect(after[0]?.n).toBe(before[0]?.n);
    });

    it("APPROVAL IS NOT CONSENT — the text is suppressed for a farmer who never opted in", async () => {
      // The property the settled design names explicitly. VIGA deciding a farmer is genuine
      // says nothing about that farmer agreeing to receive messages; only JOIN/START does.
      //
      // Asserted at the DISPATCH CLAIM rather than at the queue, because that is where the
      // guarantee actually lives — queuing is unconditional by design, and a test that only
      // checked "we didn't queue it" would prove nothing about what gets sent.
      const contactHash = await contact("a9");
      const { farmId } = await farmWithStand(`No Consent ${randomUUID()}`);

      await authorizeFarmer(database(), {
        farmId,
        requestId: await onboardingRequest(contactHash),
        administratorId,
        occurredAt: at(1),
        publicBaseUrl: "https://farmfriend.test",
      });
      const queued = await sql()`
        select id from outbox_work where recipient_hash = ${contactHash}
      `;

      const authorization = await authorizeDispatch(database(), {
        outboxWorkId: queued[0]?.id as string,
        now: at(2),
      });
      expect(authorization.status).toBe("suppressed");

      const rows = await sql()`
        select state from outbox_work where id = ${queued[0]?.id as string}
      `;
      expect(rows[0]?.state).toBe("suppressed");
    });

    it("sends the text to a farmer who DID opt in", async () => {
      // The complement, so the suppression above is not passing for the wrong reason — a
      // notification nobody can ever receive would satisfy the previous test perfectly.
      const contactHash = await contact("aa");
      const { farmId } = await farmWithStand(`With Consent ${randomUUID()}`);
      await sql()`
        insert into sms_consents (
          recipient_hash, state, capture_source, captured_at, capture_evidence_ref,
          updated_at
        )
        values (
          ${contactHash}, 'active', 'join', ${at(0).toISOString()},
          ${`evt-${randomUUID()}`}, ${at(0).toISOString()}
        )
      `;

      await authorizeFarmer(database(), {
        farmId,
        requestId: await onboardingRequest(contactHash),
        administratorId,
        occurredAt: at(1),
        publicBaseUrl: "https://farmfriend.test",
      });
      const queued = await sql()`
        select id from outbox_work where recipient_hash = ${contactHash}
      `;

      const authorization = await authorizeDispatch(database(), {
        outboxWorkId: queued[0]?.id as string,
        now: at(2),
      });
      expect(authorization.status).toBe("authorized");
    });

    it("refuses an administrator who was revoked, writing nothing", async () => {
      const contactHash = await contact("a2");
      const { farmId } = await farmWithStand(`Revoked Admin Farm ${randomUUID()}`);
      const revoked = await sql()`
        insert into administrators (email, authorized_at, revoked_at)
        values (
          'board@vigavashon.org', ${at(0).toISOString()},
          ${at(1).toISOString()}
        )
        returning id
      `;

      const result = await authorizeFarmer(database(), {
        farmId,
        requestId: await onboardingRequest(contactHash),
        administratorId: revoked[0]?.id as string,
        occurredAt: at(2),
        publicBaseUrl: "https://farmfriend.test",
      });
      expect(result.status).toBe("not_an_administrator");

      const rows = await sql()`
        select id from farmer_authorizations where seller_id = ${farmId}
      `;
      expect(rows).toHaveLength(0);
    });

    it("refuses an unknown farm and an unknown request, writing nothing", async () => {
      const contactHash = await contact("a3");
      const { farmId } = await farmWithStand(`Unknown Farm ${randomUUID()}`);

      const unknownFarm = await authorizeFarmer(database(), {
        farmId: randomUUID(),
        requestId: await onboardingRequest(contactHash),
        administratorId,
        occurredAt: at(1),
        publicBaseUrl: "https://farmfriend.test",
      });
      expect(unknownFarm.status).toBe("unknown_farm");

      const unknownRequest = await authorizeFarmer(database(), {
        farmId,
        requestId: randomUUID(),
        administratorId,
        occurredAt: at(1),
        publicBaseUrl: "https://farmfriend.test",
      });
      expect(unknownRequest.status).toBe("unknown_request");

      const rows = await sql()`
        select id from farmer_authorizations where seller_id = ${farmId}
      `;
      expect(rows).toHaveLength(0);
    });

    it("answers `already_authorized` rather than creating a second live grant", async () => {
      const contactHash = await contact("a4");
      const { farmId } = await farmWithStand(`Twice Farm ${randomUUID()}`);

      const first = await authorizeFarmer(database(), {
        farmId,
        requestId: await onboardingRequest(contactHash),
        administratorId,
        occurredAt: at(1),
        publicBaseUrl: "https://farmfriend.test",
      });
      expect(first.status).toBe("authorized");

      const second = await authorizeFarmer(database(), {
        farmId,
        requestId: await onboardingRequest(contactHash),
        administratorId,
        occurredAt: at(2),
        publicBaseUrl: "https://farmfriend.test",
      });
      expect(second.status).toBe("already_authorized");

      const rows = await sql()`
        select id from farmer_authorizations
        where seller_id = ${farmId} and revoked_at is null
      `;
      expect(rows).toHaveLength(1);
    });

    it("lets a farm have two authorized farmers — a household is not one phone", async () => {
      // The partial unique index is per (farm, contact), not per farm. A farm run by two
      // people who both text is ordinary, and refusing the second would be a product defect
      // dressed as a constraint.
      const one = await contact("a5");
      const two = await contact("a6");
      const { farmId } = await farmWithStand(`Household Farm ${randomUUID()}`);

      expect(
        (
          await authorizeFarmer(database(), {
            farmId,
            requestId: await onboardingRequest(one),
            administratorId,
            occurredAt: at(1),
            publicBaseUrl: "https://farmfriend.test",
          })
        ).status,
      ).toBe("authorized");
      expect(
        (
          await authorizeFarmer(database(), {
            farmId,
            requestId: await onboardingRequest(two),
            administratorId,
            occurredAt: at(1),
            publicBaseUrl: "https://farmfriend.test",
          })
        ).status,
      ).toBe("authorized");

      const rows = await sql()`
        select id from farmer_authorizations
        where seller_id = ${farmId} and revoked_at is null
      `;
      expect(rows).toHaveLength(2);
    });
  });

  describe("revoking a farmer", () => {
    it("revokes rather than deletes, and records who acted", async () => {
      const contactHash = await contact("b1");
      const { farmId } = await farmWithStand(`Revoke Farm ${randomUUID()}`);
      const created = await authorizeFarmer(database(), {
        farmId,
        requestId: await onboardingRequest(contactHash),
        administratorId,
        occurredAt: at(1),
        publicBaseUrl: "https://farmfriend.test",
      });
      const authorizationId =
        created.status === "authorized" ? created.authorizationId : "";
      expect(authorizationId).not.toBe("");

      const revoked = await revokeFarmerAuthorization(database(), {
        authorizationId,
        administratorId,
        occurredAt: at(3),
      });
      expect(revoked.status).toBe("revoked");

      // The row SURVIVES: `inventory_revisions` references the authorization each
      // publication was made under, so erasing it would erase who published what.
      const rows = await sql()`
        select revoked_at from farmer_authorizations where id = ${authorizationId}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.revoked_at).not.toBeNull();

      const audit = await sql()`
        select actor_administrator_id from audit_events
        where action = 'farmer_authorization_revoked' and subject_id = ${authorizationId}
      `;
      expect(audit).toHaveLength(1);
      expect(audit[0]?.actor_administrator_id).toBe(administratorId);
    });

    it("answers `not_authorized` for an already-revoked or unknown authorization", async () => {
      const contactHash = await contact("b2");
      const { farmId } = await farmWithStand(`Twice Revoke ${randomUUID()}`);
      const created = await authorizeFarmer(database(), {
        farmId,
        requestId: await onboardingRequest(contactHash),
        administratorId,
        occurredAt: at(1),
        publicBaseUrl: "https://farmfriend.test",
      });
      const authorizationId =
        created.status === "authorized" ? created.authorizationId : "";

      expect(
        (
          await revokeFarmerAuthorization(database(), {
            authorizationId,
            administratorId,
            occurredAt: at(3),
          })
        ).status,
      ).toBe("revoked");
      expect(
        (
          await revokeFarmerAuthorization(database(), {
            authorizationId,
            administratorId,
            occurredAt: at(4),
          })
        ).status,
      ).toBe("not_authorized");
      expect(
        (
          await revokeFarmerAuthorization(database(), {
            authorizationId: randomUUID(),
            administratorId,
            occurredAt: at(4),
          })
        ).status,
      ).toBe("not_authorized");
    });

    it("lets the same farmer be re-authorized after revocation", async () => {
      // Revocation is not a ban. A farmer whose phone was lost gets set up again, and the
      // partial index only excludes LIVE rows so the history stays intact.
      const contactHash = await contact("b3");
      const { farmId } = await farmWithStand(`Reauthorize ${randomUUID()}`);
      const first = await authorizeFarmer(database(), {
        farmId,
        requestId: await onboardingRequest(contactHash),
        administratorId,
        occurredAt: at(1),
        publicBaseUrl: "https://farmfriend.test",
      });
      await revokeFarmerAuthorization(database(), {
        authorizationId:
          first.status === "authorized" ? first.authorizationId : "",
        administratorId,
        occurredAt: at(2),
      });

      const again = await authorizeFarmer(database(), {
        farmId,
        requestId: await onboardingRequest(contactHash),
        administratorId,
        occurredAt: at(3),
        publicBaseUrl: "https://farmfriend.test",
      });
      expect(again.status).toBe("authorized");

      const all = await sql()`
        select revoked_at from farmer_authorizations where seller_id = ${farmId}
        order by authorized_at
      `;
      expect(all).toHaveLength(2);
      expect(all[0]?.revoked_at).not.toBeNull();
      expect(all[1]?.revoked_at).toBeNull();
    });
  });

  describe("the onboarding request queue", () => {
    it("records a farmer's ask without granting anything", async () => {
      const contactHash = await contact("c1");

      const opened = await openFarmerOnboardingRequest(database(), {
        contactHash,
        occurredAt: at(1),
        publicBaseUrl: "https://farmfriend.test",
      });
      expect(opened.status).toBe("opened");

      // THE property: a request is inert. Nothing about it is authority.
      const authorizations = await sql()`
        select a.id from farmer_authorizations a
        join contacts c on c.id = a.contact_id
        where c.phone_hash = ${contactHash}
      `;
      expect(authorizations).toHaveLength(0);
    });

    it("keeps ONE open request per phone however many times a farmer asks", async () => {
      const contactHash = await contact("c2");

      for (let i = 0; i < 5; i += 1) {
        const result = await openFarmerOnboardingRequest(database(), {
          contactHash,
          occurredAt: at(1 + i),
          publicBaseUrl: "https://farmfriend.test",
        });
        expect(result.status).toBe(i === 0 ? "opened" : "already_open");
      }

      const rows = await sql()`
        select id from farmer_onboarding_requests
        where contact_hash = ${contactHash} and settled_at is null
      `;
      expect(rows).toHaveLength(1);
    });

    it("opens ONE request when a farmer texts SIX times at once", async () => {
      // The real shape of an impatient farmer is a burst. A check-then-write would let
      // several through, and the partial unique index would then raise an error instead of
      // an honest answer — so the writer must resolve the race itself.
      const contactHash = await contact("c3");

      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          openFarmerOnboardingRequest(database(), {
            contactHash,
            occurredAt: at(1),
            publicBaseUrl: "https://farmfriend.test",
          }),
        ),
      );

      expect(results.filter((r) => r.status === "opened")).toHaveLength(1);
      expect(results.filter((r) => r.status === "already_open")).toHaveLength(5);

      const rows = await sql()`
        select id from farmer_onboarding_requests
        where contact_hash = ${contactHash} and settled_at is null
      `;
      expect(rows).toHaveLength(1);
    });

    it("settles the open request when VIGA authorizes that farmer", async () => {
      const contactHash = await contact("c4");
      const { farmId } = await farmWithStand(`Settle Farm ${randomUUID()}`);
      await openFarmerOnboardingRequest(database(), {
        contactHash,
        occurredAt: at(1),
        publicBaseUrl: "https://farmfriend.test",
      });

      const authorized = await authorizeFarmer(database(), {
        farmId,
        requestId: await onboardingRequest(contactHash),
        administratorId,
        occurredAt: at(2),
        publicBaseUrl: "https://farmfriend.test",
      });
      expect(authorized.status).toBe("authorized");

      const rows = await sql()`
        select settled_at, settled_by_administrator_id, authorization_id
        from farmer_onboarding_requests where contact_hash = ${contactHash}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.settled_at).not.toBeNull();
      expect(rows[0]?.settled_by_administrator_id).toBe(administratorId);
      // The queue can answer "what came of this ask", which is the point of settling
      // rather than deleting.
      expect(rows[0]?.authorization_id).toBe(
        authorized.status === "authorized" ? authorized.authorizationId : null,
      );

      // And the farmer may ask again later — settled rows do not block a new request.
      expect(
        (
          await openFarmerOnboardingRequest(database(), {
            contactHash,
            occurredAt: at(9),
            publicBaseUrl: "https://farmfriend.test",
          })
        ).status,
      ).toBe("opened");
    });
  });

  describe("the standing link", () => {
    it("rejects every NULL exact-target shape in real Postgres", async () => {
      const contactHash = await contact("d0");
      const { farmId, salesLocationId } = await farmWithStand(
        `Required Target ${randomUUID()}`,
      );
      const authorized = await authorizeFarmer(database(), {
        farmId,
        requestId: await onboardingRequest(contactHash),
        administratorId,
        occurredAt: at(1),
        publicBaseUrl: "https://farmfriend.test",
      });
      const authorizationId =
        authorized.status === "authorized" ? authorized.authorizationId : "";

      for (const target of [
        { ownerSellerId: null, salesLocationId: null },
        { ownerSellerId: farmId, salesLocationId: null },
        { ownerSellerId: null, salesLocationId },
      ]) {
        await expect(
          sql()`
            insert into farmer_links (
              token_hash, authorization_id, owner_seller_id, sales_location_id, issued_at
            ) values (
              ${randomUUID().replaceAll("-", "").repeat(2)}, ${authorizationId},
              ${target.ownerSellerId}, ${target.salesLocationId}, ${at(2).toISOString()}
            )
          `,
        ).rejects.toMatchObject({ code: "23502" });
      }

      // Exactly the ONE link authorization itself minted for the setup message (F-094), and
      // none of the three malformed rows above. Asserting zero here would now be asserting
      // that the farmer never got their link.
      expect(await sql()`select id from farmer_links where authorization_id = ${authorizationId}`)
        .toHaveLength(1);
    });

    it("resolves to exactly one authorization and its one sales location", async () => {
      const contactHash = await contact("d1");
      const { farmId, salesLocationId } = await farmWithStand(
        `Link Farm ${randomUUID()}`,
      );
      const authorized = await authorizeFarmer(database(), {
        farmId,
        requestId: await onboardingRequest(contactHash),
        administratorId,
        occurredAt: at(1),
        publicBaseUrl: "https://farmfriend.test",
      });
      const authorizationId =
        authorized.status === "authorized" ? authorized.authorizationId : "";

      const issued = await issueFarmerLink(database(), {
        authorizationId,
        providerId: await readNativeProviderId(database(), { salesLocationId }),
        occurredAt: at(2),
      });
      expect(issued.status).toBe("issued");
      const token = issued.status === "issued" ? issued.token : "";

      const resolved = await resolveFarmerLink(database(), {
        tokenHash: hashFarmerLinkToken(token),
      });
      expect(resolved).not.toBeNull();
      expect(resolved?.authorizationId).toBe(authorizationId);
      expect(resolved?.farmId).toBe(farmId);
      expect(resolved?.salesLocationId).toBe(salesLocationId);
      expect(resolved?.senderHash).toBe(contactHash);
    });

    it("stores only the HASH — the raw token is nowhere in the database", async () => {
      const contactHash = await contact("d2");
      const { farmId, salesLocationId } = await farmWithStand(`Hash Farm ${randomUUID()}`);
      const authorized = await authorizeFarmer(database(), {
        farmId,
        requestId: await onboardingRequest(contactHash),
        administratorId,
        occurredAt: at(1),
        publicBaseUrl: "https://farmfriend.test",
      });
      const issued = await issueFarmerLink(database(), {
        authorizationId:
          authorized.status === "authorized" ? authorized.authorizationId : "",
        providerId: await readNativeProviderId(database(), { salesLocationId }),
        occurredAt: at(2),
      });
      const token = issued.status === "issued" ? issued.token : "";

      const rows = await sql()`
        select token_hash from farmer_links
        where token_hash = ${hashFarmerLinkToken(token)}
      `;
      expect(rows).toHaveLength(1);
      // A database read cannot recover a live credential — the same discipline as the
      // session token and the phone hash.
      expect(rows[0]?.token_hash).not.toBe(token);

      const raw = await sql()`
        select id from farmer_links where token_hash = ${token}
      `;
      expect(raw).toHaveLength(0);
    });

    it("DIES ON THE NEXT REQUEST when the authorization is revoked", async () => {
      // The whole safety net. max chose a link that never expires, so this is the only thing
      // standing between a leaked link and a farmer's listing.
      const contactHash = await contact("d3");
      const { farmId, salesLocationId } = await farmWithStand(`Revoke Link ${randomUUID()}`);
      const authorized = await authorizeFarmer(database(), {
        farmId,
        requestId: await onboardingRequest(contactHash),
        administratorId,
        occurredAt: at(1),
        publicBaseUrl: "https://farmfriend.test",
      });
      const authorizationId =
        authorized.status === "authorized" ? authorized.authorizationId : "";
      const issued = await issueFarmerLink(database(), {
        authorizationId,
        providerId: await readNativeProviderId(database(), { salesLocationId }),
        occurredAt: at(2),
      });
      const tokenHash = hashFarmerLinkToken(
        issued.status === "issued" ? issued.token : "",
      );

      expect(await resolveFarmerLink(database(), { tokenHash })).not.toBeNull();

      await revokeFarmerAuthorization(database(), {
        authorizationId,
        administratorId,
        occurredAt: at(3),
      });

      // Immediately — not when something expires, because nothing does.
      expect(await resolveFarmerLink(database(), { tokenHash })).toBeNull();
    });

    it("dies on a revoked AUTHORIZATION even when its link row is still open", async () => {
      // Sabotage found this gap. The test above cannot prove the authorization is checked:
      // `revokeFarmerAuthorization` also revokes the link rows, so deleting the
      // `auth.revoked_at is null` clause from the resolver still passed — the link clause
      // was doing all the work, and the guarantee "a revoked FARMER cannot use a link" was
      // untested while looking covered.
      //
      // So this revokes the authorization ALONE, leaving `farmer_links.revoked_at` null. The
      // only thing that can refuse this request is the authorization check itself. That
      // matters beyond the test: the authorization is the authority, and any future writer
      // that withdraws it without remembering to sweep the links must still lock the farmer
      // out on the next request.
      const contactHash = await contact("d6");
      const { farmId, salesLocationId } = await farmWithStand(`Auth Only ${randomUUID()}`);
      const authorized = await authorizeFarmer(database(), {
        farmId,
        requestId: await onboardingRequest(contactHash),
        administratorId,
        occurredAt: at(1),
        publicBaseUrl: "https://farmfriend.test",
      });
      const authorizationId =
        authorized.status === "authorized" ? authorized.authorizationId : "";
      const issued = await issueFarmerLink(database(), {
        authorizationId,
        providerId: await readNativeProviderId(database(), { salesLocationId }),
        occurredAt: at(2),
      });
      const tokenHash = hashFarmerLinkToken(
        issued.status === "issued" ? issued.token : "",
      );
      expect(await resolveFarmerLink(database(), { tokenHash })).not.toBeNull();

      await sql()`
        update farmer_authorizations set revoked_at = ${at(3).toISOString()}
        where id = ${authorizationId}
      `;

      // The link row is still open — confirmed, so this test cannot silently become the
      // previous one if a future change starts sweeping links here too.
      const linkRows = await sql()`
        select revoked_at from farmer_links where token_hash = ${tokenHash}
      `;
      expect(linkRows[0]?.revoked_at).toBeNull();

      expect(await resolveFarmerLink(database(), { tokenHash })).toBeNull();
    });

    it("dies when the LINK alone is revoked, leaving the authorization intact", async () => {
      const contactHash = await contact("d4");
      const { farmId, salesLocationId } = await farmWithStand(`Link Only ${randomUUID()}`);
      const authorized = await authorizeFarmer(database(), {
        farmId,
        requestId: await onboardingRequest(contactHash),
        administratorId,
        occurredAt: at(1),
        publicBaseUrl: "https://farmfriend.test",
      });
      const authorizationId =
        authorized.status === "authorized" ? authorized.authorizationId : "";
      const first = await issueFarmerLink(database(), {
        authorizationId,
        providerId: await readNativeProviderId(database(), { salesLocationId }),
        occurredAt: at(2),
      });
      const firstHash = hashFarmerLinkToken(
        first.status === "issued" ? first.token : "",
      );

      // Re-issuing revokes the previous link: the "lost phone" case must not leave the old
      // one working.
      const second = await issueFarmerLink(database(), {
        authorizationId,
        providerId: await readNativeProviderId(database(), { salesLocationId }),
        occurredAt: at(3),
      });
      const secondHash = hashFarmerLinkToken(
        second.status === "issued" ? second.token : "",
      );

      expect(await resolveFarmerLink(database(), { tokenHash: firstHash })).toBeNull();
      expect(
        await resolveFarmerLink(database(), { tokenHash: secondHash }),
      ).not.toBeNull();

      // The farmer's SMS authority is untouched — only the browser key changed.
      const rows = await sql()`
        select revoked_at from farmer_authorizations where id = ${authorizationId}
      `;
      expect(rows[0]?.revoked_at).toBeNull();
    });

    it("refuses to issue a link for a revoked or unknown authorization", async () => {
      const contactHash = await contact("d5");
      const { farmId, salesLocationId } = await farmWithStand(`No Link ${randomUUID()}`);
      const authorized = await authorizeFarmer(database(), {
        farmId,
        requestId: await onboardingRequest(contactHash),
        administratorId,
        occurredAt: at(1),
        publicBaseUrl: "https://farmfriend.test",
      });
      const authorizationId =
        authorized.status === "authorized" ? authorized.authorizationId : "";
      await revokeFarmerAuthorization(database(), {
        authorizationId,
        administratorId,
        occurredAt: at(2),
      });

      expect(
        (await issueFarmerLink(database(), {
          authorizationId,
          providerId: await readNativeProviderId(database(), { salesLocationId }),
          occurredAt: at(3),
        }))
          .status,
      ).toBe("not_authorized");
      expect(
        (
          await issueFarmerLink(database(), {
            authorizationId: randomUUID(),
            providerId: await readNativeProviderId(database(), { salesLocationId }),
            occurredAt: at(3),
          })
        ).status,
      ).toBe("not_authorized");

      // No LIVE link. Authorization mints one for the setup message (F-094), and revoking the
      // authorization revokes it in the same transaction — so the row still exists and is
      // dead, which is the property that matters. Asserting the row is absent would now pass
      // only if the farmer had never been sent their link at all.
      const rows = await sql()`
        select id from farmer_links
        where authorization_id = ${authorizationId} and revoked_at is null
      `;
      expect(rows).toHaveLength(0);
    });

    it("resolves only the exact selected stand on a multi-stand farm", async () => {
      const contactHash = await contact("d7");
      const { farmId, salesLocationId: firstStandId } = await farmWithStand(
        `Two Stands ${randomUUID()}`,
      );
      const second = await sql()`
        insert into sales_locations (
          own_seller_id, kind, name, timezone, visitability, offering_type, public_address, public_latitude, public_longitude,
          farm_bucks_accepted, farm_bucks_eligible
        )
        values (
          ${farmId}, 'farm_stand', ${`Second Stand ${randomUUID()}`}, 'America/Los_Angeles', 'visitable', 'produce', '2 Vashon Hwy',
          47.41, -122.41, false, false
        )
        returning id
      `;
      const secondStandId = second[0]?.id as string;

      const authorized = await authorizeFarmer(database(), {
        farmId,
        requestId: await onboardingRequest(contactHash),
        administratorId,
        occurredAt: at(1),
        publicBaseUrl: "https://farmfriend.test",
      });
      const issued = await issueFarmerLink(database(), {
        authorizationId:
          authorized.status === "authorized" ? authorized.authorizationId : "",
        providerId: await readNativeProviderId(database(), {
            salesLocationId: secondStandId,
      }),
        occurredAt: at(2),
      });

      const resolved = await resolveFarmerLink(database(), {
        tokenHash: hashFarmerLinkToken(
          issued.status === "issued" ? issued.token : "",
        ),
      });
      expect(resolved?.salesLocationId).toBe(secondStandId);
      expect(resolved?.salesLocationId).not.toBe(firstStandId);
    });

    it("resolves nothing for a fabricated token", async () => {
      // The token is opaque random material checked against the database. There is no
      // signature to forge, and guessing is 256 bits of work.
      expect(
        await resolveFarmerLink(database(), {
          tokenHash: hashFarmerLinkToken(issueFarmerLinkToken()),
        }),
      ).toBeNull();
    });
  });

  describe("what an authorization actually unlocks (Golden Rule #1 and #3)", () => {
    it("closes the chain: an authorized farmer on an approved farm can publish", async () => {
      // The acceptance criterion the whole item exists for. Every step is a real writer:
      // authorization from `authorizeFarmer`, approval from `approveFarm`, publication only
      // through the confirmation gate.
      const contactHash = await contact("e1");
      const { farmId, salesLocationId } = await farmWithStand(
        `Publish Farm ${randomUUID()}`,
      );
      await authorizeFarmer(database(), {
        farmId,
        requestId: await onboardingRequest(contactHash),
        administratorId,
        occurredAt: at(1),
        publicBaseUrl: "https://farmfriend.test",
      });
      await approveFarm(database(), {
        farmId,
        administratorId,
        occurredAt: at(1),
      });

      const proposal = await openOrReviseProposal(database(), {
        senderHash: contactHash,
        salesLocationId,
        entries: [{ entryId: "draft_authorized_duck_eggs", itemName: "duck eggs" }],
        now: at(2),
      });
      await proposal.activate({
        providerAcceptedAt: at(2),
      });

      const confirmed = await confirmInventoryPublication(database(), {
        proposalId: proposal.proposalId,
        senderHash: contactHash,
        token: "yes",
        occurredAt: at(3),
        providerEventId: `evt-${randomUUID()}`,
        clock: { now: () => at(3) },
      });
      expect(confirmed.status).toBe("published");
    });

    it("stops publishing the moment the farmer's authorization is revoked", async () => {
      const contactHash = await contact("e2");
      const { farmId, salesLocationId } = await farmWithStand(
        `Revoked Publish ${randomUUID()}`,
      );
      const authorized = await authorizeFarmer(database(), {
        farmId,
        requestId: await onboardingRequest(contactHash),
        administratorId,
        occurredAt: at(1),
        publicBaseUrl: "https://farmfriend.test",
      });
      await approveFarm(database(), {
        farmId,
        administratorId,
        occurredAt: at(1),
      });

      const proposal = await openOrReviseProposal(database(), {
        senderHash: contactHash,
        salesLocationId,
        entries: [{ entryId: "draft_revoked_lamb", itemName: "lamb" }],
        now: at(2),
      });
      await proposal.activate({
        providerAcceptedAt: at(2),
      });

      // Revoked AFTER the prompt was sent, BEFORE the farmer answered.
      await revokeFarmerAuthorization(database(), {
        authorizationId:
          authorized.status === "authorized" ? authorized.authorizationId : "",
        administratorId,
        occurredAt: at(3),
      });

      const confirmed = await confirmInventoryPublication(database(), {
        proposalId: proposal.proposalId,
        senderHash: contactHash,
        token: "yes",
        occurredAt: at(4),
        providerEventId: `evt-${randomUUID()}`,
        clock: { now: () => at(4) },
      });
      expect(confirmed.status).toBe("not_authorized");

      const revisions = await sql()`
        select id from inventory_revisions where sales_location_id = ${salesLocationId}
      `;
      expect(revisions).toHaveLength(0);
    });
  });

  describe("the authorization queue VIGA sees", () => {
    it("lists every farmer's access with its farm, and masks the phone", async () => {
      // "VIGA can see and revoke every farmer's access" — the seeing half. A queue that
      // shows only live rows could not answer "who did we revoke, and when".
      const contactHash = await contact("f1");
      const { farmId } = await farmWithStand(`Queue Farm ${randomUUID()}`);
      const authorized = await authorizeFarmer(database(), {
        farmId,
        requestId: await onboardingRequest(contactHash),
        administratorId,
        occurredAt: at(1),
        publicBaseUrl: "https://farmfriend.test",
      });
      const authorizationId =
        authorized.status === "authorized" ? authorized.authorizationId : "";

      const listed = await listFarmerAuthorizations(database());
      const row = listed.find((r) => r.authorizationId === authorizationId);
      expect(row).toBeDefined();
      expect(row?.farmId).toBe(farmId);
      expect(row?.revokedAt).toBeNull();

      // Golden Rule #5: the operator sees the last four digits, never the number or the
      // hash. Asserted on the whole serialized row so a future field carrying either fails.
      const serialized = JSON.stringify(row);
      expect(serialized).not.toMatch(/\+1\d{10}/);
      expect(serialized).not.toMatch(/[0-9a-f]{64}/);
      // The same masked form every other operator queue uses — one mechanism, not a second
      // way to render a phone.
      expect(row?.senderMask).toMatch(/^\(•••\) •••-\d{4}$/);
    });

    it("keeps a revoked authorization visible, marked as revoked", async () => {
      const contactHash = await contact("f2");
      const { farmId } = await farmWithStand(`Revoked Queue ${randomUUID()}`);
      const authorized = await authorizeFarmer(database(), {
        farmId,
        requestId: await onboardingRequest(contactHash),
        administratorId,
        occurredAt: at(1),
        publicBaseUrl: "https://farmfriend.test",
      });
      const authorizationId =
        authorized.status === "authorized" ? authorized.authorizationId : "";
      await revokeFarmerAuthorization(database(), {
        authorizationId,
        administratorId,
        occurredAt: at(2),
      });

      const listed = await listFarmerAuthorizations(database());
      const row = listed.find((r) => r.authorizationId === authorizationId);
      expect(row).toBeDefined();
      expect(row?.revokedAt).not.toBeNull();
    });

    it("reports whether a live link exists, without exposing it", async () => {
      const contactHash = await contact("f3");
      const { farmId, salesLocationId } = await farmWithStand(`Link Queue ${randomUUID()}`);
      const authorized = await authorizeFarmer(database(), {
        farmId,
        requestId: await onboardingRequest(contactHash),
        administratorId,
        occurredAt: at(1),
        publicBaseUrl: "https://farmfriend.test",
      });
      const authorizationId =
        authorized.status === "authorized" ? authorized.authorizationId : "";

      // Live from the moment of authorization (F-094) — the setup message carries a link, so
      // there is one to report. The false case still has to be proven, so it is reached by
      // revoking rather than by assuming a farmer starts without one.
      const before = (await listFarmerAuthorizations(database())).find(
        (r) => r.authorizationId === authorizationId,
      );
      expect(before?.hasLiveLink).toBe(true);

      await sql()`
        update farmer_links set revoked_at = ${at(2).toISOString()}
        where authorization_id = ${authorizationId} and revoked_at is null
      `;
      const revoked = (await listFarmerAuthorizations(database())).find(
        (r) => r.authorizationId === authorizationId,
      );
      expect(revoked?.hasLiveLink).toBe(false);

      const issued = await issueFarmerLink(database(), {
        authorizationId,
        providerId: await readNativeProviderId(database(), { salesLocationId }),
        occurredAt: at(2),
      });
      const token = issued.status === "issued" ? issued.token : "";

      const after = (await listFarmerAuthorizations(database())).find(
        (r) => r.authorizationId === authorizationId,
      );
      expect(after?.hasLiveLink).toBe(true);
      // The operator learns a link EXISTS, never what it is — the queue must not become a
      // place to read a farmer's standing credential off a screen.
      expect(JSON.stringify(after)).not.toContain(token);
    });
  });
});
