import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FixedClock } from "@farm-friend/core";
import {
  confirmInventoryPublication,
  createDb,
  openOrReviseProposal,
  setProviderParticipation,
  type Db,
} from "@farm-friend/db";
import {
  handleFreeText,
  PAUSED_REOPENING_PROMPT,
  PROPOSAL_CONFIRMATION_PROMPT,
} from "./free-text";

/*
  F-114 Phase C.4 — A PAUSED LISTING IS OFFERED RE-OPENING, NEVER REFUSED.

  §facts and authority, verbatim: *Pausing invalidates that provider's open confirmations. A
  confirmation reply or a fresh inventory update arriving while paused does not publish silently
  and is not rejected: it triggers a new confirmation stating the consequence — "Publishing this
  update will re-open your listing. Reply YES to confirm, NO to cancel." One rule for both cases.
  The seller decides what they meant; code never infers it.*

  ## Why the gate is at the COMMIT, not at the door

  There are two ways in — a fresh update, and a reply to a prompt the pass sent before the pause
  (a paused listing is still prompted; `lifecycle_state in ('active','paused')`). Guarding each
  door separately would be two rules that can disagree, and would leave `SAME` — which reaches
  `confirmInventoryPublication` directly, through no door at all — publishing silently.

  So `confirmInventoryPublication` refuses a paused listing outright unless the FARMER'S OWN
  consent is on the row, and returns `paused_needs_reopening` instead. The consent is
  `reopening_stated_version`, written by the proposal writer when it composed the prompt that
  stated the consequence — never a boolean the caller passes in, which would let any path assert
  a consent no farmer gave. The copy lives at the SMS reply; code owns the consequence, and the
  model never sees it.

  `resolveProviderWriteAuthority` has reported `paused: true` on an AUTHORIZED answer since C.2
  precisely so this could be a flag rather than a refusal — a caller told `not_authorized` would
  answer "you cannot do that", and a paused seller must be offered her listing back.
*/

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required; a skipped integration run is not green");

const BASE = new Date("2026-03-01T18:00:00.000Z");

describe("F-114 C.4 a paused listing is offered re-opening (integration)", () => {
  let admin: ReturnType<typeof postgres> | undefined;
  let db: Db | undefined;
  let databaseName = "";

  let sellerId = "";
  let standId = "";
  let providerId = "";
  let authorizationId = "";
  let senderHash = "";

  /** A second, ACTIVE listing at the same stand, so "paused" is the only difference. */
  let activeSellerId = "";
  let activeProviderId = "";
  let activeSenderHash = "";

  function handle(): Db {
    if (!db) throw new Error("database unavailable");
    return db;
  }

  /**
   * One activated proposal, ready to confirm.
   *
   * `activate` is the result's own helper, which performs the real `activateAcceptedPrompt`
   * write rather than a synthetic parallel one (GL-035) — so these cases exercise the same
   * activation the outbound worker does when Telnyx accepts the prompt.
   */
  async function openProposal(input: {
    senderHash: string;
    providerId: string;
  }): Promise<{ proposalId: string; requiresReopening: boolean }> {
    const result = await openOrReviseProposal(handle(), {
      senderHash: input.senderHash,
      salesLocationId: standId,
      providerId: input.providerId,
      entries: [{
        entryId: randomUUID(),
        itemName: "Rhubarb",
        quantity: 5,
        unit: "bunches",
      }],
      now: BASE,
    });
    await result.activate({ providerAcceptedAt: BASE });
    return {
      proposalId: result.proposalId,
      requiresReopening: result.requiresReopening,
    };
  }

  beforeAll(async () => {
    databaseName = `ff_c4paused_${process.pid}_${randomUUID().replaceAll("-", "")}`;
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

    const mkSeller = async (name: string, phone: string) => {
      const hash = `h${randomUUID().replaceAll("-", "")}`;
      const sellers = await sql`insert into sellers (name) values (${name}) returning id`;
      const id = sellers[0]?.id as string;
      const contacts = await sql`
        insert into contacts (phone_e164, phone_hash, created_at)
        values (${phone}, ${hash}, ${BASE}) returning id
      `;
      const authorizations = await sql`
        insert into farmer_authorizations (
          seller_id, contact_id, phone_verified_at, authorized_at
        ) values (${id}, ${contacts[0]?.id as string}, ${BASE}, ${BASE}) returning id
      `;
      await sql`
        insert into seller_approvals (seller_id, administrator_id, approved_at)
        values (${id}, ${administratorId}, ${BASE})
      `;
      await sql`
        insert into sms_consents (
          recipient_hash, state, capture_source, captured_at, capture_evidence_ref, updated_at
        ) values (
          ${hash}, 'active', 'farmer_onboarding', ${BASE}, ${`paused-${name}`}, ${BASE}
        )
      `;
      return { id, authorizationId: authorizations[0]?.id as string, hash };
    };

    const owner = await mkSeller("Kelseys Farm", "+12065555000");
    sellerId = owner.id;
    authorizationId = owner.authorizationId;
    senderHash = owner.hash;

    const locations = await sql`
      insert into sales_locations (
        own_seller_id, kind, name, timezone, visitability, offering_type,
        public_address, public_latitude, public_longitude,
        farm_bucks_accepted, farm_bucks_eligible
      ) values (
        ${sellerId}, 'farm_stand', 'Kelseys Stand', 'America/Los_Angeles',
        'visitable', 'produce', '1 Kelsey Way', 47.45, -122.46, false, true
      ) returning id
    `;
    standId = locations[0]?.id as string;
    const own = await sql`
      select id from stand_providers
      where sales_location_id = ${standId} and seller_id = ${sellerId}
    `;
    providerId = own[0]?.id as string;

    const guest = await mkSeller("Gracies Greens", "+12065555001");
    activeSellerId = guest.id;
    activeSenderHash = guest.hash;
    const hosted = await sql`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, host_may_update_stock,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${standId}, ${activeSellerId}, 'active', false, ${BASE}, ${BASE}, 'viga', ${BASE}
      ) returning id
    `;
    activeProviderId = hosted[0]?.id as string;
  }, 90_000);

  afterAll(async () => {
    if (db) await db.close();
    if (admin && databaseName) {
      await admin.unsafe(`drop database if exists "${databaseName}" with (force)`);
      await admin.end({ timeout: 5 });
    }
  });

  beforeEach(async () => {
    await handle().sql`
      truncate inventory_publication_proposals, outbox_work, sender_states
      restart identity cascade
    `;
    await handle().sql`
      update stand_providers set lifecycle_state = 'active' where id in (${providerId}, ${activeProviderId})
    `;
  });

  /**
   * Pause through the REAL writer (F-115 Tranche D), never with a hand-written column.
   *
   * The whole point of this suite is that a paused listing behaves correctly, and until Tranche
   * D there was no production statement that could produce one — so every case here proved the
   * flow against a state no farmer could reach. Going through `setProviderParticipation` also
   * exercises the invalidation that makes the re-open confirmation honest: the old token has to
   * be dead, or a stale YES publishes silently and the seller is never asked.
   */
  async function pause(): Promise<void> {
    const result = await setProviderParticipation(handle(), {
      providerId,
      transition: "pause",
      senderHash,
      occurredAt: BASE,
    });
    if (result.status !== "changed") {
      throw new Error(`the pause fixture did not pause: ${result.status}`);
    }
  }

  it("kills a token minted BEFORE the pause, and publishes nothing on its YES", async () => {
    /*
      F-115 Tranche D changed what this case measures, and the change is the point.

      It used to pause by writing the column, so a token minted before the pause survived it and
      landed on `paused_needs_reopening`. A real pause INVALIDATES that provider's open
      confirmations (§facts and authority) — which is the guarantee the re-open confirmation
      rests on: *"a stale YES must not publish silently and the seller must be asked."*

      So the honest answer to a pre-pause YES is now `already_consumed` — the proposal is gone —
      and the router turns that into "resend". What must be true either way is the part asserted
      below: nothing publishes and the listing stays paused. The seller's next message opens a
      NEW proposal that states the consequence, which the case after this one proves.
    */
    const { proposalId, requiresReopening } = await openProposal({ senderHash, providerId });
    expect(requiresReopening).toBe(false);
    await pause();

    // The pause did the killing, before her YES ever arrives.
    expect(await handle().sql`
      select state from inventory_publication_proposals where id = ${proposalId}
    `).toEqual([{ state: "invalidated" }]);

    const result = await confirmInventoryPublication(handle(), {
      proposalId,
      senderHash,
      token: "yes",
      occurredAt: BASE,
      providerEventId: `evt-${randomUUID()}`,
      clock: new FixedClock(BASE),
    });
    expect(result.status).toBe("already_consumed");

    // Nothing published, and the listing she took down stays down. These are the two claims
    // that must hold whatever the refusal is CALLED.
    expect(await handle().sql`
      select count(*)::int as count from inventory_revisions where provider_id = ${providerId}
    `).toEqual([{ count: 0 }]);
    expect(await handle().sql`
      select lifecycle_state from stand_providers where id = ${providerId}
    `).toEqual([{ lifecycle_state: "paused" }]);
  });

  it("still answers `paused_needs_reopening` for a token that OUTLIVED the pause", async () => {
    /*
      `paused_needs_reopening` is not dead code, and this is the case that keeps it honest. A
      proposal opened AFTER the pause but before the consequence was stated — the shape a
      scheduled prompt composed against a stale basis produces — reaches the confirmation with
      `reopening_stated_version` unset, and must be refused with the third answer rather than
      published or rejected.

      Reached by opening the proposal while paused and then clearing the statement the writer
      recorded, which is the only way to construct "open, paused, consequence not stated" now
      that the writer always records it.
    */
    await pause();
    const { proposalId } = await openProposal({ senderHash, providerId });
    await handle().sql`
      update inventory_publication_proposals
      set reopening_stated_version = null where id = ${proposalId}
    `;

    const result = await confirmInventoryPublication(handle(), {
      proposalId,
      senderHash,
      token: "yes",
      occurredAt: BASE,
      providerEventId: `evt-${randomUUID()}`,
      clock: new FixedClock(BASE),
    });
    expect(result.status).toBe("paused_needs_reopening");

    // Not consumed: her snapshot must still be there to publish when she answers the new prompt.
    expect(await handle().sql`
      select state from inventory_publication_proposals where id = ${proposalId}
    `).toEqual([{ state: "open" }]);
    expect(await handle().sql`
      select count(*)::int as count from inventory_revisions where provider_id = ${providerId}
    `).toEqual([{ count: 0 }]);
    expect(await handle().sql`
      select lifecycle_state from stand_providers where id = ${providerId}
    `).toEqual([{ lifecycle_state: "paused" }]);
  });

  it("publishes and re-opens when the prompt DID state the consequence", async () => {
    // The farmer updates while paused, so the writer records the statement at this version and
    // the caller states it in the prompt. Her ordinary YES then means what it says.
    await pause();
    const { proposalId, requiresReopening } = await openProposal({ senderHash, providerId });
    expect(requiresReopening).toBe(true);

    const result = await confirmInventoryPublication(handle(), {
      proposalId,
      senderHash,
      token: "yes",
      occurredAt: BASE,
      providerEventId: `evt-${randomUUID()}`,
      clock: new FixedClock(BASE),
    });
    expect(result.status).toBe("published");

    // ACTIVE again. Publishing and LEAVING it paused would be the worse half of both answers: a
    // current revision behind a listing no public reader shows, and a farmer told her stock
    // published while nothing changed on the map.
    expect(await handle().sql`
      select lifecycle_state from stand_providers where id = ${providerId}
    `).toEqual([{ lifecycle_state: "active" }]);
  });

  it("leaves the listing PAUSED when she answers NO", async () => {
    /*
      §facts and authority: *"The seller decides what they meant; code never infers it."* NO is
      a real decision — she saw the consequence stated and declined it — so the listing stays
      down. A writer that re-opened on any answered confirmation would turn a refusal into
      exactly the publication she just refused.

      Asserted as an ABSENCE beside the positive case above: "YES re-opens" says nothing about
      what NO does, and a writer that re-opened unconditionally survives the YES case untouched.
    */
    await pause();
    const { proposalId, requiresReopening } = await openProposal({ senderHash, providerId });
    expect(requiresReopening).toBe(true);

    const result = await confirmInventoryPublication(handle(), {
      proposalId,
      senderHash,
      token: "no",
      occurredAt: BASE,
      providerEventId: `evt-${randomUUID()}`,
      clock: new FixedClock(BASE),
    });
    expect(result.status).toBe("declined");

    expect(await handle().sql`
      select lifecycle_state from stand_providers where id = ${providerId}
    `).toEqual([{ lifecycle_state: "paused" }]);
    expect(await handle().sql`
      select count(*)::int as count from inventory_revisions where provider_id = ${providerId}
    `).toEqual([{ count: 0 }]);
  });

  it("does not carry the consent across a REVISION", async () => {
    /*
      The reason the consent stores a VERSION rather than a boolean, and the case that isolates
      it. The farmer is shown the re-opening sentence, and instead of confirming she sends a
      different update. That revision bumps the version, clears the activation, and — because
      she is still paused — states the consequence again at the NEW version.

      To prove the binding rather than the re-statement, the recorded version is then rolled
      back by hand to the stale one. A boolean would still be true here and would publish.
    */
    await pause();
    const first = await openProposal({ senderHash, providerId });
    expect(first.requiresReopening).toBe(true);

    const revised = await openOrReviseProposal(handle(), {
      senderHash,
      salesLocationId: standId,
      providerId,
      entries: [{ entryId: randomUUID(), itemName: "Peas", quantity: 2, unit: "lbs" }],
      now: BASE,
    });
    await revised.activate({ providerAcceptedAt: BASE });
    expect(revised.proposalId).toBe(first.proposalId);

    await handle().sql`
      update inventory_publication_proposals
      set reopening_stated_version = 1
      where id = ${revised.proposalId}
    `;
    const result = await confirmInventoryPublication(handle(), {
      proposalId: revised.proposalId,
      senderHash,
      token: "yes",
      occurredAt: BASE,
      providerEventId: `evt-${randomUUID()}`,
      clock: new FixedClock(BASE),
    });
    expect(result.status).toBe("paused_needs_reopening");
  });

  it("leaves an ACTIVE listing's publication completely unaffected", async () => {
    // The case that keeps the gate from being a blanket refusal. Gracie's Greens is active, so
    // nothing is stated, nothing is recorded, and her YES publishes exactly as before.
    const { proposalId, requiresReopening } = await openProposal({
      senderHash: activeSenderHash,
      providerId: activeProviderId,
    });
    expect(requiresReopening).toBe(false);

    const result = await confirmInventoryPublication(handle(), {
      proposalId,
      senderHash: activeSenderHash,
      token: "yes",
      occurredAt: BASE,
      providerEventId: `evt-${randomUUID()}`,
      clock: new FixedClock(BASE),
    });
    expect(result.status).toBe("published");
    expect(await handle().sql`
      select lifecycle_state from stand_providers where id = ${activeProviderId}
    `).toEqual([{ lifecycle_state: "active" }]);
  });

  it("consenting to re-opening does NOT excuse any other refusal", async () => {
    /*
      The consent is to ONE consequence, not a bypass. A revoked authorization must still refuse
      — otherwise the recorded version would be a way around every check that follows it, and a
      farmer whose access VIGA withdrew could publish by answering a prompt sent beforehand.

      The gate is placed LAST among the refusals for exactly this reason, so the case has to
      construct a refusal that would otherwise be reached only after it.
    */
    await pause();
    const { proposalId } = await openProposal({ senderHash, providerId });
    await handle().sql`
      update farmer_authorizations set revoked_at = ${BASE} where id = ${authorizationId}
    `;

    const result = await confirmInventoryPublication(handle(), {
      proposalId,
      senderHash,
      token: "yes",
      occurredAt: BASE,
      providerEventId: `evt-${randomUUID()}`,
      clock: new FixedClock(BASE),
    });
    await handle().sql`
      update farmer_authorizations set revoked_at = null where id = ${authorizationId}
    `;

    expect(result.status).toBe("not_authorized");
    expect(await handle().sql`
      select count(*)::int as count from inventory_revisions where provider_id = ${providerId}
    `).toEqual([{ count: 0 }]);
    expect(await handle().sql`
      select lifecycle_state from stand_providers where id = ${providerId}
    `).toEqual([{ lifecycle_state: "paused" }]);
  });

  it("refuses a version that is not a version", async () => {
    // `0` would compare equal to no `proposal_version` and silently disable the consent, so a
    // farmer who was shown the sentence would be shown it forever. The CHECK is what stops a
    // future writer storing one.
    //
    // The row is created first, deliberately: an UPDATE matching NOTHING resolves rather than
    // rejecting, so without it this case passes whether or not the constraint exists.
    const { proposalId } = await openProposal({ senderHash, providerId });
    await expect(
      handle().sql`
        update inventory_publication_proposals set reopening_stated_version = 0
        where id = ${proposalId}
      `,
    ).rejects.toMatchObject({
      code: "23514",
      constraint_name: "inventory_proposals_reopening_stated_version_positive",
    });
  });

  it("carries the consequence into the farmer's actual SMS reply", async () => {
    /*
      The end-to-end case, and the one the constant's own test cannot replace: a reply that
      dropped the re-opening sentence would still render a plausible confirmation, and every
      other assertion here would pass. Proved by ABSENCE too — the ordinary publish prompt must
      not also be there, because two "Reply YES" lines is two instructions for one decision.

      The model seams are stubbed, but nothing about the paused rule reaches them: the classifier
      fixes the route and the interpreter returns edits. Which prompt is appended is code's.
    */
    await pause();
    const result = await handleFreeText(
      {
        db: handle(),
        interpreter: {
          interpret: async () => ({
            kind: "edits" as const,
            additions: [{ itemName: "Rhubarb" }],
            changes: [],
            removals: [],
          }),
        } as unknown as Parameters<typeof handleFreeText>[0]["interpreter"],
        catalogMatcher: {
          match: async () => {
            throw new Error("the catalog matcher must not run on the farmer path");
          },
        } as unknown as Parameters<typeof handleFreeText>[0]["catalogMatcher"],
        classifier: {
          classify: async () => ({ ok: true as const, kind: "inventory_report" as const }),
        } as unknown as Parameters<typeof handleFreeText>[0]["classifier"],
        stockOut: {
          parseItem: async () => {
            throw new Error("the stock-out seam must not run on the farmer path");
          },
        } as unknown as Parameters<typeof handleFreeText>[0]["stockOut"],
        clock: new FixedClock(BASE),
      },
      {
        senderHash,
        taskText: "rhubarb today",
        occurredAt: BASE,
        providerEventId: `evt-${randomUUID()}`,
        inboxEventId: randomUUID(),
      },
    );

    const body = result.replies[0]?.body ?? "";
    expect(body).toContain(PAUSED_REOPENING_PROMPT);
    expect(body).not.toContain(PROPOSAL_CONFIRMATION_PROMPT);
  });

  it("states the consequence in the farmer's own words, and stays GSM-7", async () => {
    /*
      The copy is code-owned and asserted for its VALUE, not its shape: this sentence is what
      tells a farmer that saying YES does something beyond publishing, and a renderer that
      dropped the re-opening clause would still produce a plausible confirmation.

      GSM-7 because one non-GSM-7 character re-encodes the WHOLE body to UCS-2 and halves the
      per-segment capacity (DEVELOPMENT.md §gotchas).
    */
    expect(PAUSED_REOPENING_PROMPT).toBe(
      "Publishing this update will re-open your listing. Reply YES to confirm, NO to cancel.",
    );
    // eslint-disable-next-line no-control-regex
    expect(PAUSED_REOPENING_PROMPT).toMatch(/^[\x20-\x7E]+$/);
  });
});
