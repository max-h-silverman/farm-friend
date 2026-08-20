import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createDb,
  resolveProviderWriteAuthority,
  setProviderParticipation,
  type Db,
  type Sql,
} from "./index";

/*
  F-115 Tranche D — PAUSING AND ENDING A HOSTED SELLING RELATIONSHIP.

  ## What was missing

  F-114 built the entire consequence of pausing and shipped no way to cause it. `paused` was in
  the enum, every liveness predicate admitted it, the re-open confirmation was written in C.4,
  and `invalidateProviderWork` was 122 fully-tested lines with **zero production callers**. No
  statement anywhere set `lifecycle_state = 'paused'` or `ended_at`, and `0042`'s backfill and
  its `create_own_seller_provider` trigger both insert `'active'` only — so no row in any
  database could reach the state all of that served.

  ## The rule these cases enforce

  **PAUSE / RESUME — the seller, or VIGA. Never the host.**
  **END — either party, or VIGA.**

  §facts and authority: *"Either side may end it; the seller may pause/resume without ending
  it."* `schema.ts` names pause explicitly among what a host may never do.

  The asymmetry is the point, and case 2 below is the contract's core protection. A host who
  could pause could hide a seller's goods from the public indefinitely without ever ending
  anything — eviction by another name, with no visible act and nothing for the seller to answer.
  Ending is visible and final, so either party may walk away. **The graver power is HIDING.**

  `host_may_update_stock` governs CURRENT STOCK only, so it is asserted BOTH ways: a host who
  holds it still cannot pause. Reading it here at all would be the defect.
*/

const migrationsDir = resolve(process.cwd(), "packages/db", "drizzle");

describe("F-115 pausing and ending a hosting relationship (integration)", () => {
  let admin: Sql | undefined;
  let client: Sql | undefined;
  let db: Db | undefined;
  let databaseName = "";

  const T0 = new Date("2026-04-01T17:00:00.000Z");
  const T1 = new Date("2026-04-02T17:00:00.000Z");

  let administratorId = "";
  let hostSellerId = "";
  let hostStandId = "";
  let hostProviderId = "";
  let hostSenderHash = "";

  let guestSellerId = "";
  let guestProviderId = "";
  let guestSenderHash = "";

  const sql = (): Sql => client as Sql;
  const database = (): Db => db as Db;

  /** A seller with a VIGA approval and one authorized, verified handset. */
  /** The authorization id is never needed here: every act is reached by a PHONE, or by VIGA. */
  async function mkSeller(name: string, phone: string) {
    const senderHash = `h${randomUUID().replaceAll("-", "")}`;
    const sellers = await sql()`insert into sellers (name) values (${name}) returning id`;
    const sellerId = sellers[0]?.id as string;
    const contacts = await sql()`
      insert into contacts (phone_e164, phone_hash, created_at)
      values (${phone}, ${senderHash}, ${T0}) returning id
    `;
    const authorizations = await sql()`
      insert into farmer_authorizations (seller_id, contact_id, phone_verified_at, authorized_at)
      values (${sellerId}, ${contacts[0]?.id as string}, ${T0}, ${T0}) returning id
    `;
    await sql()`
      insert into seller_approvals (seller_id, administrator_id, approved_at)
      values (${sellerId}, ${administratorId}, ${T0})
    `;
    if (authorizations.length !== 1) throw new Error("the seller fixture wrote no authorization");
    return { sellerId, senderHash };
  }

  /**
   * One OPEN, ACTIVATED proposal with its prompt still queued.
   *
   * Activated on purpose: an activated proposal is the one whose confirmation token is live in
   * somebody's phone, which is the whole thing a pause has to kill. `activation_coherent`
   * requires the four columns together, so a half-filled fixture is refused by the schema
   * rather than quietly standing in for the case that matters.
   */
  async function openProposal(providerId: string, senderHash: string): Promise<string> {
    const work = await sql()`
      insert into outbox_work (
        logical_key, recipient_hash, message_category, body, body_expires_at,
        available_at, created_at
      ) values (
        ${`prompt-${randomUUID()}`}, ${senderHash}, 'inventory_prompt', 'What do you have?',
        ${T1}, ${T0}, ${T0}
      ) returning id
    `;
    const proposals = await sql()`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, provider_id, payload, proposal_version,
        has_inventory, has_closure, base_revision_id, base_is_first_publication,
        state, activation_outbox_id, activated_version, activated_at, expires_at
      ) values (
        ${senderHash}, ${hostStandId}, ${providerId},
        ${sql().json({ entries: [] })}, 1, true, false, null, true, 'open',
        ${work[0]?.id as string}, 1, ${T0}, ${T1}
      ) returning id
    `;
    return proposals[0]?.id as string;
  }

  beforeAll(async () => {
    const base = process.env.DATABASE_URL;
    if (!base) throw new Error("DATABASE_URL is required; a skipped integration run is not green");
    databaseName = `ff_participation_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(base, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(base);
    url.pathname = `/${databaseName}`;
    client = postgres(url.toString(), { max: 4 });
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), { migrationsFolder: migrationsDir });
    await migrationClient.end({ timeout: 5 });
    db = createDb(url.toString());

    const administrators = await sql()`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', ${T0}) returning id
    `;
    administratorId = administrators[0]?.id as string;

    ({ sellerId: hostSellerId, senderHash: hostSenderHash } =
      await mkSeller("Kelseys Farm", "+12065556000"));
    ({ sellerId: guestSellerId, senderHash: guestSenderHash } =
      await mkSeller("Gracies Greens", "+12065556001"));

    const locations = await sql()`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        public_address, public_latitude, public_longitude
      ) values (
        ${hostSellerId}, 'farm_stand', 'Kelseys Stand', 'America/Los_Angeles',
        'visitable', 'produce', '1 Kelsey Way', 47.45, -122.46
      ) returning id
    `;
    hostStandId = locations[0]?.id as string;
    const own = await sql()`
      select id from stand_providers
      where sales_location_id = ${hostStandId} and seller_id = ${hostSellerId}
    `;
    hostProviderId = own[0]?.id as string;
  }, 60_000);

  afterAll(async () => {
    if (db) await db.close();
    if (client) await client.end({ timeout: 5 });
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  }, 30_000);

  beforeEach(async () => {
    await sql()`
      truncate inventory_publication_proposals, outbox_work, audit_events restart identity cascade
    `;
    await sql()`delete from stand_providers where seller_id = ${guestSellerId}`;
    const hosted = await sql()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${hostStandId}, ${guestSellerId}, 'active', false,
        ${T0}, ${T0}, 'viga', ${T0}
      ) returning id
    `;
    guestProviderId = hosted[0]?.id as string;
    // The host's own listing is restored to `active` between cases, since several end it.
    await sql()`
      update stand_providers set lifecycle_state = 'active', ended_at = null
      where id = ${hostProviderId}
    `;
  });

  async function state(providerId: string) {
    const rows = await sql()`
      select lifecycle_state, ended_at from stand_providers where id = ${providerId}
    `;
    return {
      lifecycleState: rows[0]?.lifecycle_state as string,
      ended: rows[0]?.ended_at !== null,
    };
  }

  // ------------------------------------------------------------------ property 1: pause hides

  it("takes a paused listing off every surface the liveness predicates guard", async () => {
    /*
      The whole reason `paused` exists. Asserted through the shared arms rather than through a
      column read, because the column is what a broken predicate would still agree with — a
      test that read `lifecycle_state = 'paused'` back would pass while the map went on
      publishing her goods.
    */
    expect(
      await setProviderParticipation(database(), {
        providerId: guestProviderId,
        transition: "pause",
        senderHash: guestSenderHash,
        occurredAt: T1,
      }),
    ).toMatchObject({ status: "changed", lifecycleState: "paused", ended: false });
    expect(await state(guestProviderId)).toEqual({
      lifecycleState: "paused",
      ended: false,
    });
  });

  // ------------------------------------------- property 2: THE CONTRACT'S CORE PROTECTION

  it("REFUSES a host who tries to pause a hosted seller, without the stock opt-in", async () => {
    /*
      Kelsey holds a live authorization at this stand and can reach Zoe's listing. What he may
      NOT do is hide her goods. Refused as `not_authorized` rather than silently ignored, so the
      surface can say so.
    */
    expect(
      await setProviderParticipation(database(), {
        providerId: guestProviderId,
        transition: "pause",
        senderHash: hostSenderHash,
        occurredAt: T1,
      }),
    ).toEqual({ status: "not_authorized" });
    expect(await state(guestProviderId)).toEqual({
      lifecycleState: "active",
      ended: false,
    });
  });

  it("REFUSES a host who tries to pause even WITH host_may_update_stock", async () => {
    /*
      The half that would be missed by a case using only the default. `host_may_update_stock`
      governs CURRENT STOCK; a writer that consulted it here would grant pause to exactly the
      hosts who asked for restocking rights, which is the widest possible reading of the
      narrowest possible grant.

      The opt-in is proved LIVE in the same case — Kelsey's authority resolves through the host
      arm — so this cannot pass merely because he was refused for some earlier reason.
    */
    await sql()`
      update stand_providers set host_may_update_stock = true where id = ${guestProviderId}
    `;
    const authority = await resolveProviderWriteAuthority(database(), {
      providerId: guestProviderId,
      senderHash: hostSenderHash,
    });
    expect(authority).toMatchObject({ status: "authorized", via: "host" });

    expect(
      await setProviderParticipation(database(), {
        providerId: guestProviderId,
        transition: "pause",
        senderHash: hostSenderHash,
        occurredAt: T1,
      }),
    ).toEqual({ status: "not_authorized" });
    expect(await state(guestProviderId)).toEqual({
      lifecycleState: "active",
      ended: false,
    });
  });

  it("REFUSES a host who tries to RESUME a hosted seller she paused", async () => {
    // The mirror. A host who could resume could undo the seller's own withdrawal, which is the
    // same power in the other direction — and it is not "un-hiding", because it republishes
    // goods the seller took down.
    await setProviderParticipation(database(), {
      providerId: guestProviderId,
      transition: "pause",
      senderHash: guestSenderHash,
      occurredAt: T1,
    });
    expect(
      await setProviderParticipation(database(), {
        providerId: guestProviderId,
        transition: "resume",
        senderHash: hostSenderHash,
        occurredAt: T1,
      }),
    ).toEqual({ status: "not_authorized" });
    expect(await state(guestProviderId)).toMatchObject({ lifecycleState: "paused" });
  });

  // ------------------------------------------------------------------ property 3: both may end

  it("lets the HOST end the relationship", async () => {
    expect(
      await setProviderParticipation(database(), {
        providerId: guestProviderId,
        transition: "end",
        senderHash: hostSenderHash,
        occurredAt: T1,
      }),
    ).toMatchObject({ status: "changed", ended: true });
    expect(await state(guestProviderId)).toMatchObject({ ended: true });
  });

  it("lets the SELLER end the relationship", async () => {
    expect(
      await setProviderParticipation(database(), {
        providerId: guestProviderId,
        transition: "end",
        senderHash: guestSenderHash,
        occurredAt: T1,
      }),
    ).toMatchObject({ status: "changed", ended: true });
    expect(await state(guestProviderId)).toMatchObject({ ended: true });
  });

  it("leaves lifecycle_state alone when ending, so the acceptance record survives", async () => {
    // `stand_providers_hosting_lifecycle_coherent` requires `active`/`paused` to carry an
    // acceptance and an approval, and ending removes neither: the seller DID accept and VIGA
    // DID approve. `ended_at` is the ending. A fourth state would put one fact in two places.
    await setProviderParticipation(database(), {
      providerId: guestProviderId,
      transition: "end",
      senderHash: guestSenderHash,
      occurredAt: T1,
    });
    expect(await state(guestProviderId)).toEqual({
      lifecycleState: "active",
      ended: true,
    });
    expect(await sql()`
      select accepted_at, approved_at, approval_source from stand_providers
      where id = ${guestProviderId}
    `).toEqual([{ accepted_at: T0, approved_at: T0, approval_source: "viga" }]);
  });

  it("ends a PAUSED relationship without resurrecting it", async () => {
    // Pause then end. A writer that set `lifecycle_state = 'active'` on ending would make a
    // paused seller's departure look like a return.
    await setProviderParticipation(database(), {
      providerId: guestProviderId,
      transition: "pause",
      senderHash: guestSenderHash,
      occurredAt: T1,
    });
    await setProviderParticipation(database(), {
      providerId: guestProviderId,
      transition: "end",
      senderHash: guestSenderHash,
      occurredAt: T1,
    });
    expect(await state(guestProviderId)).toEqual({
      lifecycleState: "paused",
      ended: true,
    });
  });

  it("refuses every transition once the relationship has ENDED", async () => {
    await setProviderParticipation(database(), {
      providerId: guestProviderId,
      transition: "end",
      senderHash: guestSenderHash,
      occurredAt: T1,
    });
    for (const transition of ["pause", "resume", "end"] as const) {
      expect(
        await setProviderParticipation(database(), {
          providerId: guestProviderId,
          transition,
          senderHash: guestSenderHash,
          occurredAt: T1,
        }),
      ).toEqual({ status: "provider_not_live" });
    }
  });

  // ------------------------------------------------------------------ property 4: VIGA

  it("lets VIGA pause, resume and end", async () => {
    expect(
      await setProviderParticipation(database(), {
        providerId: guestProviderId,
        transition: "pause",
        administratorId,
        occurredAt: T1,
      }),
    ).toMatchObject({ status: "changed", lifecycleState: "paused" });
    expect(
      await setProviderParticipation(database(), {
        providerId: guestProviderId,
        transition: "resume",
        administratorId,
        occurredAt: T1,
      }),
    ).toMatchObject({ status: "changed", lifecycleState: "active" });
    expect(
      await setProviderParticipation(database(), {
        providerId: guestProviderId,
        transition: "end",
        administratorId,
        occurredAt: T1,
      }),
    ).toMatchObject({ status: "changed", ended: true });
  });

  it("refuses a REVOKED administrator", async () => {
    /*
      The operator's own liveness, re-read under lock — a principal resolved at the start of a
      request proves they were an administrator then, not that they are one now.

      Revoked in place rather than as a second row: `administrators_fixed_identity` permits
      exactly one email, which is the launch posture (one VIGA account, no roles).
    */
    await sql()`update administrators set revoked_at = ${T1} where id = ${administratorId}`;
    const refused = await setProviderParticipation(database(), {
      providerId: guestProviderId,
      transition: "pause",
      administratorId,
      occurredAt: T1,
    });
    await sql()`update administrators set revoked_at = null where id = ${administratorId}`;

    expect(refused).toEqual({ status: "not_authorized" });
    expect(await state(guestProviderId)).toMatchObject({ lifecycleState: "active" });
  });

  it("refuses a phone with no authorization at this stand at all", async () => {
    expect(
      await setProviderParticipation(database(), {
        providerId: guestProviderId,
        transition: "pause",
        senderHash: `h${randomUUID().replaceAll("-", "")}`,
        occurredAt: T1,
      }),
    ).toEqual({ status: "not_authorized" });
  });

  it("refuses when both a phone and an administrator are supplied, and when neither is", async () => {
    // Two principals in one call is a caller bug, and picking one would attribute the act to
    // whichever the code happened to check first.
    expect(
      await setProviderParticipation(database(), {
        providerId: guestProviderId,
        transition: "pause",
        senderHash: guestSenderHash,
        administratorId,
        occurredAt: T1,
      }),
    ).toEqual({ status: "not_authorized" });
    expect(
      await setProviderParticipation(database(), {
        providerId: guestProviderId,
        transition: "pause",
        occurredAt: T1,
      }),
    ).toEqual({ status: "not_authorized" });
    expect(await state(guestProviderId)).toMatchObject({ lifecycleState: "active" });
  });

  // --------------------------------------------------- property 5: invalidation, scoped

  it("invalidates THAT provider's open confirmation and its queued reminder", async () => {
    const proposalId = await openProposal(guestProviderId, guestSenderHash);

    expect(
      await setProviderParticipation(database(), {
        providerId: guestProviderId,
        transition: "pause",
        senderHash: guestSenderHash,
        occurredAt: T1,
      }),
    ).toMatchObject({
      status: "changed",
      proposalsInvalidated: 1,
      remindersSuppressed: 1,
    });
    expect(await sql()`
      select state from inventory_publication_proposals where id = ${proposalId}
    `).toEqual([{ state: "invalidated" }]);
  });

  it("leaves an UNRELATED seller's open confirmation at the same stand alone", async () => {
    /*
      The case a stand-keyed implementation gets silently wrong. Zoe pausing must not cancel
      Kelsey's live confirmation — he did not withdraw anything, and his token would simply stop
      working with nothing on his phone to say why.

      Asserted as an ABSENCE beside the positive above: "hers was invalidated" and "his was not"
      are two claims, and only the second can catch a stand-scoped call.
    */
    const hers = await openProposal(guestProviderId, guestSenderHash);
    const his = await openProposal(hostProviderId, hostSenderHash);

    const result = await setProviderParticipation(database(), {
      providerId: guestProviderId,
      transition: "pause",
      senderHash: guestSenderHash,
      occurredAt: T1,
    });

    expect(result).toMatchObject({ proposalsInvalidated: 1 });
    expect(await sql()`
      select id, state from inventory_publication_proposals order by provider_id
    `).toEqual(
      expect.arrayContaining([
        { id: hers, state: "invalidated" },
        { id: his, state: "open" },
      ]),
    );
  });

  it("invalidates on RESUME too", async () => {
    // A token minted while the listing was live, and answered after a pause-and-resume, would
    // publish against a basis nobody re-confirmed. The pause already killed the first one; this
    // is about one opened DURING the pause, which the re-open confirmation replaces.
    await setProviderParticipation(database(), {
      providerId: guestProviderId,
      transition: "pause",
      senderHash: guestSenderHash,
      occurredAt: T1,
    });
    await openProposal(guestProviderId, guestSenderHash);
    expect(
      await setProviderParticipation(database(), {
        providerId: guestProviderId,
        transition: "resume",
        senderHash: guestSenderHash,
        occurredAt: T1,
      }),
    ).toMatchObject({ proposalsInvalidated: 1 });
  });

  it("is idempotent, and a second pause does NOT invalidate what she opened since", async () => {
    /*
      The reason the unchanged check sits BEFORE the write. A seller who pauses twice — a
      double-tap, a retried request — must not have the confirmation she opened in between
      silently destroyed by the second one.
    */
    await setProviderParticipation(database(), {
      providerId: guestProviderId,
      transition: "pause",
      senderHash: guestSenderHash,
      occurredAt: T1,
    });
    const opened = await openProposal(guestProviderId, guestSenderHash);

    expect(
      await setProviderParticipation(database(), {
        providerId: guestProviderId,
        transition: "pause",
        senderHash: guestSenderHash,
        occurredAt: T1,
      }),
    ).toEqual({ status: "unchanged", lifecycleState: "paused", ended: false });
    expect(await sql()`
      select state from inventory_publication_proposals where id = ${opened}
    `).toEqual([{ state: "open" }]);
  });

  it("records who acted, in the column that describes them", async () => {
    // The audit trail must not attribute a farmer's own pause to VIGA, or the reverse.
    await setProviderParticipation(database(), {
      providerId: guestProviderId,
      transition: "pause",
      senderHash: guestSenderHash,
      occurredAt: T1,
    });
    await setProviderParticipation(database(), {
      providerId: guestProviderId,
      transition: "end",
      administratorId,
      occurredAt: T1,
    });
    expect(await sql()`
      select action, actor_administrator_id, actor_contact_hash from audit_events
      where subject_id = ${guestProviderId} order by occurred_at, action
    `).toEqual([
      {
        action: "stand_provider_ended",
        actor_administrator_id: administratorId,
        actor_contact_hash: null,
      },
      {
        action: "stand_provider_paused",
        actor_administrator_id: null,
        actor_contact_hash: guestSenderHash,
      },
    ]);
  });

  it("refuses a listing that is still PENDING acceptance", async () => {
    // There is no arrangement yet to pause or walk away from — an unaccepted invitation is
    // declined by not answering it, not ended.
    await sql()`delete from stand_providers where id = ${guestProviderId}`;
    const pending = await sql()`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, invited_at
      ) values (${hostStandId}, ${guestSellerId}, 'pending', ${T0}) returning id
    `;
    expect(
      await setProviderParticipation(database(), {
        providerId: pending[0]?.id as string,
        transition: "end",
        senderHash: guestSenderHash,
        occurredAt: T1,
      }),
    ).toEqual({ status: "provider_not_live" });
  });

  it("refuses an unknown listing", async () => {
    expect(
      await setProviderParticipation(database(), {
        providerId: randomUUID(),
        transition: "pause",
        senderHash: guestSenderHash,
        occurredAt: T1,
      }),
    ).toEqual({ status: "unknown_provider" });
  });
});
