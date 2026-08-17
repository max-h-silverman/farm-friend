import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "@farm-friend/core";
import {
  authorizeDispatch,
  createDb,
  setInventoryPromptPreference,
  type Db,
} from "@farm-friend/db";
import { runScheduledPromptPass } from "./scheduled-prompts";

/*
  F-114 Phase C.4 — THE SCHEDULER PASS REACHES A HOSTED SELLER.

  ## The gate this closes

  C.4b made the cadence per-listing, so Zoe can now SAVE a schedule for Gracie's Greens at
  Kelsey's stand. The pass that acts on it could not: it read `sales_locations.own_seller_id` and
  used it three times —

    * the designated authorization had to name the STAND'S OWN seller,
    * VIGA's approval was looked up for the STAND'S OWN seller,
    * and the durable subject recorded the STAND'S OWN seller as `owner_seller_id`.

  For Zoe all three are Kelsey. The first two refuse her outright — her authorization names
  Gracie's Greens, not Kelsey's Farm — so a hosted seller's cadence would sit in the table
  forever, `next_due_at` in the past, and nothing would ever text her. The third is worse than a
  refusal: had the first two passed, the subject would have recorded Kelsey as the owner of Zoe's
  prompt, and `scheduled_prompt_subjects_authorization_owner_fk` binds that pair.

  Whose reminder this is is the PREFERENCE'S own fact. It already names the provider and the
  designated authorization; the pass reads both rather than re-deriving either from the roof.

  ## The fixture

  Two listings at one stand, on different cadences, with different recipients — the shape no
  suite had before C.4. Both are due in the same pass, which is also what proves the pass does
  not simply pick the stand's own listing and stop.
*/

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required; a skipped integration run is not green");

const BASE = new Date("2026-03-01T18:00:00.000Z");
const DUE = new Date("2026-03-14T17:00:00.000Z");

describe("F-114 C.4 scheduled prompts for a hosted seller (integration)", () => {
  let admin: ReturnType<typeof postgres> | undefined;
  let db: Db | undefined;
  let databaseName = "";

  let hostSellerId = "";
  let hostStandId = "";
  let hostProviderId = "";
  let hostAuthorizationId = "";
  let hostSenderHash = "";
  let hostPreferenceId = "";

  let guestSellerId = "";
  let guestProviderId = "";
  let guestAuthorizationId = "";
  let guestSenderHash = "";
  let guestPreferenceId = "";
  let guestRevisionId = "";

  let venueStandId = "";
  let venueSellerId = "";
  let venueProviderId = "";
  let venueAuthorizationId = "";
  let venueSenderHash = "";
  let venuePreferenceId = "";

  function handle(): Db {
    if (!db) throw new Error("database unavailable");
    return db;
  }

  /** A seller, its VIGA approval, an authorized handset, and active SMS consent. */
  async function mkSeller(input: {
    name: string;
    phone: string;
    administratorId: string;
  }): Promise<{ sellerId: string; authorizationId: string; senderHash: string }> {
    const sql = handle().sql;
    const senderHash = `h${randomUUID().replaceAll("-", "")}`;
    const sellers = await sql`insert into sellers (name) values (${input.name}) returning id`;
    const sellerId = sellers[0]?.id as string;
    const contacts = await sql`
      insert into contacts (phone_e164, phone_hash, created_at)
      values (${input.phone}, ${senderHash}, ${BASE}) returning id
    `;
    const authorizations = await sql`
      insert into farmer_authorizations (
        seller_id, contact_id, phone_verified_at, authorized_at
      ) values (${sellerId}, ${contacts[0]?.id as string}, ${BASE}, ${BASE}) returning id
    `;
    await sql`
      insert into seller_approvals (seller_id, administrator_id, approved_at)
      values (${sellerId}, ${input.administratorId}, ${BASE})
    `;
    await sql`
      insert into sms_consents (
        recipient_hash, state, capture_source, captured_at, capture_evidence_ref, updated_at
      ) values (
        ${senderHash}, 'active', 'farmer_onboarding', ${BASE},
        ${`hosted-prompt-${input.name}`}, ${BASE}
      )
    `;
    return { sellerId, authorizationId: authorizations[0]?.id as string, senderHash };
  }

  /** One published revision with one item, so the prompt can offer SAME. */
  async function publish(input: {
    sellerId: string;
    salesLocationId: string;
    providerId: string;
    authorizationId: string;
    senderHash: string;
    itemName: string;
  }): Promise<string> {
    const sql = handle().sql;
    const proposals = await sql`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, provider_id, payload, proposal_version,
        has_inventory, has_closure, base_revision_id, base_is_first_publication,
        state, closed_at
      ) values (
        ${input.senderHash}, ${input.salesLocationId}, ${input.providerId},
        ${sql.json({ entries: [] })}, 1, true, false, null, true, 'invalidated', ${BASE}
      ) returning id
    `;
    const approvals = await sql`
      select id from seller_approvals where seller_id = ${input.sellerId}
    `;
    const revisions = await sql`
      insert into inventory_revisions (
        seller_id, sales_location_id, provider_id, proposal_id,
        published_by_authorization_id, farm_approval_id, source, published_at
      ) values (
        ${input.sellerId}, ${input.salesLocationId}, ${input.providerId},
        ${proposals[0]?.id as string}, ${input.authorizationId},
        ${approvals[0]?.id as string}, 'sms', ${BASE}
      ) returning id
    `;
    const revisionId = revisions[0]?.id as string;
    await sql`
      insert into inventory_entries (
        inventory_revision_id, sales_location_id, item_name, quantity, unit,
        price_text, approximation, sort_order
      ) values (
        ${revisionId}, ${input.salesLocationId}, ${input.itemName}, 3, 'bunches',
        '$4', 'plentiful', 0
      )
    `;
    return revisionId;
  }

  beforeAll(async () => {
    databaseName = `ff_c4hosted_${process.pid}_${randomUUID().replaceAll("-", "")}`;
    admin = postgres(databaseUrl, { max: 1 });
    await admin.unsafe(`create database "${databaseName}"`);
    const url = new URL(databaseUrl);
    url.pathname = `/${databaseName}`;
    const migrationClient = postgres(url.toString(), { max: 1 });
    await migrate(drizzle(migrationClient), {
      migrationsFolder: resolve(process.cwd(), "packages/db/drizzle"),
    });
    await migrationClient.end({ timeout: 5 });
    db = createDb(url.toString());
    const sql = handle().sql;

    const administrators = await sql`
      insert into administrators (email, authorized_at)
      values ('board@vigavashon.org', ${BASE}) returning id
    `;
    const administratorId = administrators[0]?.id as string;

    ({ sellerId: hostSellerId, authorizationId: hostAuthorizationId,
       senderHash: hostSenderHash } = await mkSeller({
      name: "Kelseys Farm", phone: "+12065554000", administratorId,
    }));
    ({ sellerId: guestSellerId, authorizationId: guestAuthorizationId,
       senderHash: guestSenderHash } = await mkSeller({
      name: "Gracies Greens", phone: "+12065554001", administratorId,
    }));

    const locations = await sql`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      ) values (
        ${hostSellerId}, 'farm_stand', 'Kelseys Stand', 'America/Los_Angeles',
        'visitable', 'produce', '1 Kelsey Way', 47.45, -122.46, false, true
      ) returning id
    `;
    hostStandId = locations[0]?.id as string;

    const own = await sql`
      select id from stand_providers
      where sales_location_id = ${hostStandId} and seller_id = ${hostSellerId}
    `;
    hostProviderId = own[0]?.id as string;

    const hosted = await sql`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${hostStandId}, ${guestSellerId}, 'active', false,
        ${BASE}, ${BASE}, 'viga', ${BASE}
      ) returning id
    `;
    guestProviderId = hosted[0]?.id as string;

    /*
      A VENUE — `own_seller_id` NULL, the Morgan Hill shape. Nobody owns the place; every
      seller there is a provider and nothing else. The old dispatch revalidation looked up
      VIGA's approval for the stand's own seller, so here it looked one up for NULL, found
      nothing, and refused before any of its other checks could speak.
    */
    ({ sellerId: venueSellerId, authorizationId: venueAuthorizationId,
       senderHash: venueSenderHash } = await mkSeller({
      name: "Hollow Creek Orchard", phone: "+12065554002", administratorId,
    }));
    const venues = await sql`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      ) values (
        null, 'farm_stand', 'Hollow Creek Commons', 'America/Los_Angeles',
        'visitable', 'produce', '9 Hollow Creek Rd', 47.42, -122.48, false, true
      ) returning id
    `;
    venueStandId = venues[0]?.id as string;
    const venueProviders = await sql`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${venueStandId}, ${venueSellerId}, 'active', false,
        ${BASE}, ${BASE}, 'viga', ${BASE}
      ) returning id
    `;
    venueProviderId = venueProviders[0]?.id as string;
  }, 90_000);

  afterAll(async () => {
    if (db) await db.close();
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  });

  beforeEach(async () => {
    const sql = handle().sql;
    /*
      The truncate CASCADES from `inventory_publication_proposals` into `inventory_revisions`,
      so the published listings have to be rebuilt here rather than in `beforeAll` — measured,
      after a first draft published once up front and every case saw an empty stand while still
      queueing a prompt. `offers_same: false` and a null base are what a stand with no current
      inventory legitimately produces, so the shape assertions all passed and only the BODY
      would have caught it.
    */
    await sql`
      truncate scheduled_inventory_prompt_subjects, inventory_prompt_preferences,
        inventory_publication_proposals, outbox_work, sender_states restart identity cascade
    `;
    await publish({
      sellerId: hostSellerId, salesLocationId: hostStandId, providerId: hostProviderId,
      authorizationId: hostAuthorizationId, senderHash: hostSenderHash, itemName: "Kale",
    });
    guestRevisionId = await publish({
      sellerId: guestSellerId, salesLocationId: hostStandId, providerId: guestProviderId,
      authorizationId: guestAuthorizationId, senderHash: guestSenderHash, itemName: "Sourdough",
    });
    const host = await setInventoryPromptPreference(handle(), {
      senderHash: hostSenderHash,
      authorizationId: hostAuthorizationId,
      providerId: hostProviderId,
      cadence: "every_2_days",
      clock: new FixedClock(BASE),
    });
    const guest = await setInventoryPromptPreference(handle(), {
      senderHash: guestSenderHash,
      authorizationId: guestAuthorizationId,
      providerId: guestProviderId,
      cadence: "weekly",
      clock: new FixedClock(BASE),
    });
    await publish({
      sellerId: venueSellerId, salesLocationId: venueStandId, providerId: venueProviderId,
      authorizationId: venueAuthorizationId, senderHash: venueSenderHash, itemName: "Cider",
    });
    const venue = await setInventoryPromptPreference(handle(), {
      senderHash: venueSenderHash,
      authorizationId: venueAuthorizationId,
      providerId: venueProviderId,
      cadence: "weekly",
      clock: new FixedClock(BASE),
    });
    if (host.status !== "saved" || guest.status !== "saved" || venue.status !== "saved") {
      throw new Error("hosted prompt fixture failed to save every cadence");
    }
    hostPreferenceId = host.preferenceId;
    guestPreferenceId = guest.preferenceId;
    venuePreferenceId = venue.preferenceId;
    await sql`update inventory_prompt_preferences set next_due_at = ${DUE}`;
  });

  it("prompts the HOSTED seller about her own listing, on her own handset", async () => {
    /*
      The case the old pass could not survive. Zoe's preference names Gracie's Greens' listing
      and Zoe's authorization; the stand's own seller is Kelsey and is irrelevant to both.

      The body is asserted, not just the row: `renderScheduledInventoryPrompt` is handed the
      entries `readCurrentInventory` returns for THIS provider, so a pass that resolved the
      stand's listing instead would queue Kelsey's kale to Zoe's phone and every structural
      assertion would still pass.
    */
    expect(await runScheduledPromptPass({ db: handle(), clock: new FixedClock(DUE) })).toEqual({
      scheduled: 3,
      deferred: 0,
    });

    const rows = await handle().sql`
      select subject.owner_seller_id, subject.provider_id, subject.authorization_id,
             subject.sales_location_id, subject.inventory_base_revision_id,
             subject.offers_same, work.recipient_hash, work.body
      from scheduled_inventory_prompt_subjects subject
      join outbox_work work on work.id = subject.outbox_work_id
      where subject.preference_id = ${guestPreferenceId}
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      owner_seller_id: guestSellerId,
      provider_id: guestProviderId,
      authorization_id: guestAuthorizationId,
      sales_location_id: hostStandId,
      inventory_base_revision_id: guestRevisionId,
      offers_same: true,
      recipient_hash: guestSenderHash,
    });
    expect(rows[0]?.body).toContain("- Sourdough (3 bunches, $4)");
    expect(rows[0]?.body).not.toContain("Kale");
  });

  it("never files a hosted prompt under the stand owner", async () => {
    // `owner_seller_id` is the column a roof-rooted pass gets wrong in the direction nothing
    // else notices: the prompt would still reach Zoe's handset, and only this column would say
    // the goods were Kelsey's. Asserted as an ABSENCE beside the positive above, because
    // "the subject names Gracie's Greens" and "no subject names Kelsey for Zoe's listing" are
    // two different claims.
    await runScheduledPromptPass({ db: handle(), clock: new FixedClock(DUE) });
    expect(await handle().sql`
      select count(*)::int as count from scheduled_inventory_prompt_subjects
      where provider_id = ${guestProviderId} and owner_seller_id = ${hostSellerId}
    `).toEqual([{ count: 0 }]);
  });

  it("prompts BOTH listings at one stand, each on its own handset", async () => {
    // Two due preferences at one `sales_location_id`. The pass takes a row lock on the stand,
    // so this also proves the second is not starved or collapsed into the first.
    await runScheduledPromptPass({ db: handle(), clock: new FixedClock(DUE) });
    const rows = await handle().sql`
      select subject.provider_id, subject.owner_seller_id, work.recipient_hash
      from scheduled_inventory_prompt_subjects subject
      join outbox_work work on work.id = subject.outbox_work_id
      where subject.sales_location_id = ${hostStandId}
      order by work.recipient_hash
    `;
    expect(rows).toHaveLength(2);
    const byProvider = new Map(
      rows.map((row) => [row.provider_id as string, row]),
    );
    expect(byProvider.get(hostProviderId)).toMatchObject({
      owner_seller_id: hostSellerId,
      recipient_hash: hostSenderHash,
    });
    expect(byProvider.get(guestProviderId)).toMatchObject({
      owner_seller_id: guestSellerId,
      recipient_hash: guestSenderHash,
    });
  });

  it("refuses the hosted prompt when VIGA's approval of THAT seller is revoked", async () => {
    /*
      The approval gate must follow the provider's seller too, and this is the case that
      isolates it: Kelsey's approval stays intact throughout, so a pass still checking the
      stand's owner would sail through and queue a prompt for a seller VIGA has revoked.

      §hosting and approval lifecycle: VIGA may revoke a seller globally. A revoked seller may
      not publish, and a prompt is an offer to publish.
    */
    await handle().sql`
      update seller_approvals set revoked_at = ${DUE} where seller_id = ${guestSellerId}
    `;
    const result = await runScheduledPromptPass({ db: handle(), clock: new FixedClock(DUE) });
    await handle().sql`
      update seller_approvals set revoked_at = null where seller_id = ${guestSellerId}
    `;

    expect(result).toEqual({ scheduled: 2, deferred: 0 });
    expect(await handle().sql`
      select count(*)::int as count from scheduled_inventory_prompt_subjects
      where preference_id = ${guestPreferenceId}
    `).toEqual([{ count: 0 }]);
    // Kelsey's is the one that ran, so the pass refused the right one rather than stopping.
    expect(await handle().sql`
      select count(*)::int as count from scheduled_inventory_prompt_subjects
      where preference_id = ${hostPreferenceId}
    `).toEqual([{ count: 1 }]);
  });

  it("refuses the hosted prompt when the hosted seller's own authorization is revoked", async () => {
    // The authority gate, isolated the same way: Kelsey's authorization is untouched, so only a
    // pass reading the PREFERENCE'S designated authorization can refuse this.
    await handle().sql`
      update farmer_authorizations set revoked_at = ${DUE} where id = ${guestAuthorizationId}
    `;
    const result = await runScheduledPromptPass({ db: handle(), clock: new FixedClock(DUE) });
    await handle().sql`
      update farmer_authorizations set revoked_at = null where id = ${guestAuthorizationId}
    `;

    expect(result).toEqual({ scheduled: 2, deferred: 0 });
    expect(await handle().sql`
      select count(*)::int as count from scheduled_inventory_prompt_subjects
      where preference_id = ${guestPreferenceId}
    `).toEqual([{ count: 0 }]);
  });

  it("refuses the hosted prompt once the RELATIONSHIP ends, leaving the host's alone", async () => {
    // Zoe's seller, authorization and approval are all intact; what is gone is her listing at
    // this stand. A prompt here would ask her to confirm goods she no longer sells there.
    await handle().sql`
      update stand_providers set ended_at = ${DUE} where id = ${guestProviderId}
    `;
    const result = await runScheduledPromptPass({ db: handle(), clock: new FixedClock(DUE) });
    await handle().sql`
      update stand_providers set ended_at = null where id = ${guestProviderId}
    `;

    expect(result).toEqual({ scheduled: 2, deferred: 0 });
    expect(await handle().sql`
      select count(*)::int as count from scheduled_inventory_prompt_subjects
      where preference_id = ${guestPreferenceId}
    `).toEqual([{ count: 0 }]);
    expect(await handle().sql`
      select count(*)::int as count from scheduled_inventory_prompt_subjects
      where preference_id = ${hostPreferenceId}
    `).toEqual([{ count: 1 }]);
  });

  it("keeps the stand's shutdown overriding EVERY listing, hosted included", async () => {
    /*
      §facts and authority: a stand shutdown overrides every provider. The closure is a fact
      about the PLACE — Kelsey's stand is locked, so nobody's goods are buyable there — and the
      pass must defer both prompts, not just the stand owner's.

      Hosted sellers are deliberately NOT notified of the closure itself; this asserts only that
      the prompt is withheld, which is the part the pass owns.
    */
    const proposals = await handle().sql`
      insert into inventory_publication_proposals (
        sender_hash, sales_location_id, provider_id, payload, proposal_version,
        has_inventory, has_closure, base_revision_id, base_is_first_publication,
        closure_base_revision_id, closure_base_is_first_instruction,
        state, closed_at
      ) values (
        ${hostSenderHash}, ${hostStandId}, ${hostProviderId},
        ${handle().sql.json({ entries: [] })}, 1, false, true, null, null,
        null, true, 'invalidated', ${BASE}
      ) returning id
    `;
    const approvals = await handle().sql`
      select id from seller_approvals where seller_id = ${hostSellerId}
    `;
    const closure = await handle().sql`
      insert into closure_revisions (
        sales_location_id, owner_seller_id, owner_authorization_id, owner_approval_id,
        proposal_id, result, closure_kind, starts_on, published_at
      ) values (
        ${hostStandId}, ${hostSellerId}, ${hostAuthorizationId}, ${approvals[0]?.id as string},
        ${proposals[0]?.id as string}, 'close', 'temporary', '2026-03-01', ${BASE}
      ) returning id
    `;

    const result = await runScheduledPromptPass({ db: handle(), clock: new FixedClock(DUE) });
    // SUPERSEDED, never deleted: a trigger refuses to delete a published closure revision, which
    // is Golden Rule #1 protecting the history. Clearing `is_current` is the same move the real
    // writer makes when a stand reopens.
    await handle().sql`
      update closure_revisions set is_current = false, superseded_at = ${DUE}
      where id = ${closure[0]?.id as string}
    `;

    // The venue is a different place and its seller is prompted regardless; only Kelsey's
    // stand is shut, so only its two listings defer.
    expect(result).toEqual({ scheduled: 1, deferred: 2 });
    expect(await handle().sql`
      select count(*)::int as count from scheduled_inventory_prompt_subjects
      where sales_location_id = ${hostStandId}
    `).toEqual([{ count: 0 }]);
  });

  /*
    THE DISPATCH END OF THE SAME QUESTION.

    Queuing a prompt is half the journey; `authorizeDispatch` revalidates the whole basis under
    lock before the message is claimed, and an invalid basis is not a deferral — it closes the
    proposal `invalidated` and suppresses the outbox row. Nothing logs it.

    The pass above was converted to read the PREFERENCE'S provider and seller; the revalidation
    was not, so it re-derived both from `sales_locations.own_seller_id`. For Zoe that is Kelsey,
    so her basis reads invalid and her prompt is destroyed silently between queue and send.
  */
  async function authorizeFor(preferenceId: string) {
    const rows = await handle().sql`
      select outbox_work_id from scheduled_inventory_prompt_subjects
      where preference_id = ${preferenceId}
    `;
    if (rows.length !== 1) throw new Error("expected exactly one queued subject");
    return authorizeDispatch(handle(), {
      outboxWorkId: rows[0]?.outbox_work_id as string,
      now: DUE,
    });
  }

  it("dispatches the HOSTED seller's prompt rather than suppressing it", async () => {
    await runScheduledPromptPass({ db: handle(), clock: new FixedClock(DUE) });

    expect(await authorizeFor(guestPreferenceId)).toMatchObject({ status: "authorized" });
    // Asserted as an absence too: the failure mode is a silent suppression that leaves her
    // proposal closed, so "not suppressed" and "her proposal is still open" are two claims.
    expect(await handle().sql`
      select proposal.state from scheduled_inventory_prompt_subjects subject
      join inventory_publication_proposals proposal on proposal.id = subject.proposal_id
      where subject.preference_id = ${guestPreferenceId}
    `).toEqual([{ state: "open" }]);
  });

  it("still dispatches the stand owner's own prompt", async () => {
    // The 31-of-38 case that kept the defect invisible. It must stay working after the fix.
    await runScheduledPromptPass({ db: handle(), clock: new FixedClock(DUE) });
    expect(await authorizeFor(hostPreferenceId)).toMatchObject({ status: "authorized" });
  });

  it("dispatches a VENUE seller's prompt, where the stand owns no seller at all", async () => {
    /*
      The harder half of the same defect. A hosted seller's prompt revalidated against the
      WRONG seller; a venue seller's revalidated against NULL, so `seller_approvals` returned
      no rows and the basis was invalid before any real check ran. Nothing distinguishes that
      refusal from a genuinely revoked approval.
    */
    await runScheduledPromptPass({ db: handle(), clock: new FixedClock(DUE) });
    expect(await authorizeFor(venuePreferenceId)).toMatchObject({ status: "authorized" });
  });

  it("still suppresses a venue prompt when VIGA revokes that seller", async () => {
    // Proves the approval gate is live on the venue arm rather than merely skipped: with the
    // stand owning nobody, the subject's seller is the only seller this lookup can name.
    await runScheduledPromptPass({ db: handle(), clock: new FixedClock(DUE) });
    await handle().sql`
      update seller_approvals set revoked_at = ${DUE} where seller_id = ${venueSellerId}
    `;
    const claim = await authorizeFor(venuePreferenceId);
    await handle().sql`
      update seller_approvals set revoked_at = null where seller_id = ${venueSellerId}
    `;
    expect(claim).toEqual({ status: "suppressed" });
  });

  it("still suppresses a hosted prompt whose basis moved under it", async () => {
    /*
      The revalidation must keep REFUSING, or "read the subject's seller" would be
      indistinguishable from deleting the check. The hosted seller changing her own cadence
      between queue and claim bumps the preference version, which is what the subject records
      and what the stale prompt no longer matches — the ordinary invalidation, exercised on the
      hosted arm for the first time.
    */
    await runScheduledPromptPass({ db: handle(), clock: new FixedClock(DUE) });
    await handle().sql`
      update inventory_prompt_preferences set version = version + 1
      where id = ${guestPreferenceId}
    `;
    expect(await authorizeFor(guestPreferenceId)).toEqual({ status: "suppressed" });
    // The stand owner's prompt, queued in the same pass, is untouched by her change.
    expect(await authorizeFor(hostPreferenceId)).toMatchObject({ status: "authorized" });
  });
});
