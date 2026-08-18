import {
  hashFarmerInviteToken,
  issueFarmerInviteToken,
  validatePublicStrings,
  type ProhibitedPublicStringKind,
} from "@farm-friend/core";
import type { Db } from "./index";
import { invalidateProviderWork } from "./provider-invalidation";
import { visibleFarms } from "./test-farms";
import { PROVIDER_SELLER_ARM } from "./provider-write-authority";
import type { Sql, Tx } from "./sql";

/*
  F-114 Phase C.1 — inviting a seller to sell at a stand.

  ## The whole shape, in one paragraph

  A stand owner (or VIGA) names a seller and gets a one-use link to forward. That writes two rows:
  a `pending` `stand_providers` relationship, and an ordinary `farmer_invitations` row bound to it.
  The invited seller opens the link, fills the same onboarding form a stand owner fills, and texts
  a bare `START` — at which point the existing redemption authorizes them for their seller and
  activates the relationship. There is no approval queue, no second form, and no VIGA step.

  ## Why this reuses the farmer invitation rather than adding a hosting one

  §there is no second permission system cut the "access grant" an earlier framing of C.1 was going
  to build: the permission that follows acceptance is an ORDINARY authorization for the seller who
  accepted. The same reasoning applies one level up. `farmer_invitations` already names a seller,
  holds the handset the redemption must arrive from, carries the SMS agreement, and mints the
  authorization and the approval in one transaction. A hosted seller needs no second lifecycle
  beside it — only for the redemption to say WHICH relationship it accepts, which is one column.

  A `hosting_invitations` table with its own token, expiry, redemption path and consent story
  would be a second mechanism doing one mechanism's job, and every rule the first enforces would
  have to be restated and kept in step.

  ## The decisions behind the shape (max, 2026-08-15)

  - **Onboarding always happens, even for a seller Farm Friend already knows.** The stand-specific
    details vary — hours, season, what they sell there, whether the host may restock for them — so
    Fernhorn invited to a second stand still fills a form. One path parameterized by whether the
    seller exists, rather than two that would drift.
  - **The host forwards the link; Farm Friend never texts the invited seller first.** No consent
    row exists for a number nobody gave us, so an outbound send would be suppressed anyway.
  - **VIGA is the approver on record whenever VIGA issues the link**, even when a coordinator is
    doing it for a stand owner who asked.
  - **Nothing is public until the seller finishes.** `pending` is already excluded by every public
    reader, so an invitation nobody answers lists nobody.

  ## What is deliberately NOT here

  The acceptance itself lives in `farmer.ts`, inside the redemption transaction it belongs to.
  Splitting it out would put the activation in a second commit from the authorization that makes
  it legal — the exact silent dead end F-067 closed for the ordinary farmer.
*/

function driver(db: Db): Sql {
  return db.sql;
}

/** Matches `createFarmerInvitation`. One TTL for both doors, so neither drifts. */
const HOSTING_INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type InviteSellerToStandResult =
  | {
      status: "invited";
      /** Returned ONCE. Only the hash is stored; the host forwards the link. */
      token: string;
      sellerId: string;
      sellerName: string;
      standProviderId: string;
    }
  | { status: "unknown_stand" }
  | { status: "unknown_seller" }
  | { status: "invalid_seller" }
  /** The proposed name would put contact details on the public map. */
  | { status: "unsafe_public_text"; prohibited: ProhibitedPublicStringKind[] }
  | { status: "invalid_issuer" }
  | { status: "not_authorized" }
  | { status: "already_selling_here" };

export interface HostStandChoice {
  standId: string;
  name: string;
}

/**
 * The stands a self-selecting seller may pick from (F-117).
 *
 * max settled that the host stand comes from an autocomplete of EXISTING stands, never free
 * text: a typed name would be ambiguous about which stand was meant and would make the host we
 * then text a guess. Picking a real stand makes the host unambiguous.
 *
 * **A name and an id, and nothing else.** `listPublicStands` builds the whole map — inventory,
 * closures, availability, payment methods, per-provider facts — and running it to fill a
 * dropdown would put all of that behind a keystroke, on a surface that needs neither.
 *
 * **The same visibility rule the map uses**, composed from `visibleFarms` rather than restated.
 * This list is shown to a stranger part-way through onboarding, so a retired stand, an unlisted
 * one or a test farm appearing here would be a disclosure through a form nobody authenticates
 * to reach — and would let a seller attach herself to a stand the public cannot see.
 *
 * Test farms are never included: the deliberate-viewer escape hatches (`?hidden=true`, a listed
 * sender hash) are about SEEING fake stands, and neither is a reason to sell at one.
 */
export async function listHostStandChoices(db: Db): Promise<HostStandChoice[]> {
  const rows = await driver(db).unsafe(`
    select location.id as stand_id, location.name as stand_name
    from sales_locations as location
    -- LEFT join: a VENUE has no seller of its own (Morgan Hill), and it is exactly the kind of
    -- place a self-selecting seller sells at. An inner join would silently drop the strongest
    -- case for this whole flow. The farm rule is asked only where there is a farm to ask about.
    left join sellers as farm on farm.id = location.own_seller_id
    where location.is_public
      and location.retired_at is null
      and (farm.id is null or ${visibleFarms("farm", false)})
    order by lower(location.name), location.id
  `);
  return rows.map((row) => ({
    standId: row.stand_id as string,
    name: row.stand_name as string,
  }));
}

export type SelfSelectHostStandResult =
  | { status: "selling"; providerId: string }
  | { status: "unknown_stand" }
  | { status: "unknown_seller" }
  /** The stand she picked is her own. The native arrangement already exists. */
  | { status: "own_stand" }
  | { status: "already_selling_here" };

/**
 * A seller onboarding on her own says she sells at somebody else's stand (F-117).
 *
 * **The inverse of `inviteSellerToStand`, and deliberately not a flag on it.** That path starts
 * with a HOST offering a place and ends with the seller accepting, so it writes `pending` and
 * mints a link. Here the seller is the one acting and is already present, so there is nobody to
 * invite and nothing to accept later — the arrangement is complete at the moment she submits.
 * One function with a direction flag would have two disjoint halves and a name that lied about
 * one of them.
 *
 * **She is live immediately** (max, 2026-08-17). Weighing an unconfirmed listing against making
 * her wait on a host who may never reply, max chose live: *"i really don't imagine any fraud
 * here."* The realistic error is a mis-picked stand, and the host confirmation catches that.
 *
 * **No VIGA approval anywhere** — keeping the volunteer out of it is the whole point — and
 * `approval_source = 'seller'` records exactly that. See the enum: `viga` would make her
 * indistinguishable from a seller VIGA approved, and `host` names a vouching authorization that
 * does not exist until the host answers.
 *
 * **The same `stand_providers` shape F-114 built**, so every liveness predicate, targeting arm
 * and participation control already reaches her. A second mechanism would be a second thing to
 * teach each of them, and the one that gets forgotten.
 */
export async function selfSelectHostStand(
  db: Db,
  input: { sellerId: string; salesLocationId: string; occurredAt: Date },
): Promise<SelfSelectHostStandResult> {
  return driver(db).begin(async (tx) => {
    const sellers = await tx`
      select id from sellers where id = ${input.sellerId} for update
    `;
    if (sellers.length === 0) return { status: "unknown_seller" as const };

    const stands = await tx`
      select id, own_seller_id from sales_locations
      where id = ${input.salesLocationId}
      for update
    `;
    const stand = stands[0] as Record<string, unknown> | undefined;
    if (stand === undefined) return { status: "unknown_stand" as const };

    // Her own stand is not a host stand. Picking it is a mis-pick, and the arrangement it would
    // describe is the native one onboarding already wrote.
    if (stand.own_seller_id === input.sellerId) return { status: "own_stand" as const };

    /*
      The partial unique index is the arbiter, exactly as it is for an invitation: `for update`
      cannot serialize a row that does not exist yet, so a double-tapped submit is resolved by
      the index rather than by a preceding read. An empty result means the other one won.

      `where ended_at is null` names the index's own predicate — `0051` made it partial so a
      seller who left can come back, and an `on conflict` target omitting the predicate matches
      no index at all.
    */
    const providers = await tx`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state,
        invited_at, accepted_at, approval_source, approved_at
      ) values (
        ${input.salesLocationId}, ${input.sellerId}, 'active',
        ${input.occurredAt.toISOString()}, ${input.occurredAt.toISOString()},
        'seller', ${input.occurredAt.toISOString()}
      )
      on conflict (sales_location_id, seller_id) where ended_at is null do nothing
      returning id
    `;
    const providerId = providers[0]?.id as string | undefined;
    if (providerId === undefined) return { status: "already_selling_here" as const };

    await tx`
      insert into audit_events (action, actor_contact_hash, subject_type, subject_id, occurred_at)
      values ('stand_provider_self_selected', null, 'stand_provider', ${providerId},
        ${input.occurredAt.toISOString()})
    `;

    return { status: "selling" as const, providerId };
  });
}

export interface InviteSellerToStandInput {
  salesLocationId: string;
  /** An existing seller. Mutually exclusive with `newSellerName`. */
  sellerId?: string;
  /** Create and invite a seller under this name. Mutually exclusive with `sellerId`. */
  newSellerName?: string;
  /**
   * EXACTLY ONE ISSUER. The stand owner's authorization, or VIGA's administrator — never both and
   * never neither, which is what `farmer_invitations_hosting_issuer` enforces and what decides
   * the `approval_source` recorded at acceptance.
   */
  invitedByAuthorizationId?: string;
  administratorId?: string;
  occurredAt: Date;
}

/**
 * Invite one seller to sell at one stand, and mint the link the host forwards.
 *
 * **Authority is derived, never stored** (§there is no second permission system). "Stand owner"
 * is not a role: a phone may invite to a stand when it is authorized for the seller that stand
 * names as itself, or — for a venue with no such seller, like Morgan Hill — authorized for the
 * stand directly through the arm `0043` added. Both are read here, under lock, at the moment the
 * write happens, rather than inherited from whatever resolved the request.
 */
export async function inviteSellerToStand(
  db: Db,
  input: InviteSellerToStandInput,
): Promise<InviteSellerToStandResult> {
  const byAuthorization = input.invitedByAuthorizationId ?? null;
  const byAdministrator = input.administratorId ?? null;
  // Answered HERE rather than left to the CHECK, so a caller bug returns a result instead of a
  // constraint violation, and no seller is created pointing at an invitation never minted.
  if ((byAuthorization === null) === (byAdministrator === null)) {
    return { status: "invalid_issuer" };
  }

  // Trimmed before every test below, so padding decides nothing: `"  "` is blank, and a padded
  // real name is stored clean rather than reaching the public map with its whitespace. Same rule
  // and same reason as `createFarmerInvitation`.
  const newSellerName = input.newSellerName?.trim();
  const requestedSellerId = input.sellerId ?? null;
  if (newSellerName !== undefined && requestedSellerId !== null) {
    return { status: "invalid_seller" };
  }
  if (newSellerName === undefined && requestedSellerId === null) {
    return { status: "invalid_seller" };
  }
  if (newSellerName !== undefined && newSellerName === "") {
    return { status: "invalid_seller" };
  }

  /*
    A SELLER NAME IS PUBLIC TEXT, and this writer is the only place one is typed.

    §suppression follows a pointer credits every hosted seller on the stand's public card, so a
    name minted here lands on the island's only guide. `saveSalesLocationParticipants` already
    holds this boundary for the display-only names beside it, and the stand owner's own door
    means an untrusted farmer now types the real ones — the same rule has to reach both.

    Answered before the transaction opens, so a refusal creates no seller and mints no
    invitation. An EXISTING seller is deliberately not re-validated: its name is already public
    and refusing it here would block an invitation over a row this call did not write.
  */
  if (newSellerName !== undefined) {
    const validation = validatePublicStrings([newSellerName]);
    if (!validation.ok) {
      return { status: "unsafe_public_text", prohibited: validation.prohibited };
    }
  }

  return driver(db).begin(async (tx) => {
    // Lock order is stand → provider → authorization, matching §resolved questions' outermost-
    // first discipline and every other writer in this package.
    const stands = await tx`
      select id, own_seller_id from sales_locations
      where id = ${input.salesLocationId}
      for update
    `;
    const stand = stands[0];
    if (stand === undefined) return { status: "unknown_stand" as const };
    const ownSellerId = (stand.own_seller_id as string | null) ?? null;

    const permitted = await authorizedForStand(tx, {
      salesLocationId: input.salesLocationId,
      ownSellerId,
      authorizationId: byAuthorization,
      administratorId: byAdministrator,
    });
    if (!permitted) return { status: "not_authorized" as const };

    // The seller: an existing one, or a new one created here. A person decides this name — code
    // never matches it against the retained participant list, which is §the 11 hosted names'
    // standing prohibition and the reason `Fernhorn Bakery` and `Fern Horn Bakery` are still two
    // rows in that table rather than one guessed identity.
    let sellerId: string;
    let sellerName: string;
    if (newSellerName !== undefined) {
      const created = await tx`
        insert into sellers (name) values (${newSellerName}) returning id, name
      `;
      sellerId = created[0]?.id as string;
      sellerName = created[0]?.name as string;
    } else {
      const sellers = await tx`
        select id, name from sellers where id = ${requestedSellerId!}
      `;
      if (sellers.length === 0) return { status: "unknown_seller" as const };
      sellerId = sellers[0]?.id as string;
      sellerName = sellers[0]?.name as string;
    }

    // A stand's own seller already sells there — that is what the self-pointer MEANS, and its
    // provider row was created by `create_own_seller_provider` when the stand was saved.
    if (sellerId === ownSellerId) {
      return { status: "already_selling_here" as const };
    }

    /*
      THE INDEX IS THE ARBITER, not the read above it.

      `stand_providers_one_per_seller_per_location` decides which of two writers racing to add the
      same seller at one stand wins. A preceding `select … for update` cannot serialize a row that
      does not exist yet, so both would observe "none" and the second insert would raise instead of
      answering. `on conflict do nothing returning` makes an empty result the honest "someone else
      already did this" — the same first-insert reasoning B-011, F-050 and Phase B all needed.

      **`where ended_at is null` is the index's own predicate, and Postgres requires it.** The
      index is PARTIAL since `0051` — at most one LIVE relationship per pair, any number of ended
      ones, so a seller who left can be invited back. An `on conflict` target that omits the
      predicate matches no index at all and raises *"there is no unique or exclusion constraint
      matching the ON CONFLICT specification"* on EVERY invitation, which is how this was found.
      Naming it also states which conflict is being answered: an ended row is not one.
    */
    const providers = await tx`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, invited_at
      ) values (
        ${input.salesLocationId}, ${sellerId}, 'pending', ${input.occurredAt.toISOString()}
      )
      on conflict (sales_location_id, seller_id) where ended_at is null do nothing
      returning id
    `;
    const standProviderId = providers[0]?.id as string | undefined;
    if (standProviderId === undefined) {
      return { status: "already_selling_here" as const };
    }

    const token = issueFarmerInviteToken();
    await tx`
      insert into farmer_invitations (
        seller_id, stand_provider_id, token_hash, channel,
        created_by_administrator_id, invited_by_authorization_id,
        created_at, expires_at
      ) values (
        ${sellerId}, ${standProviderId}, ${hashFarmerInviteToken(token)}, 'sms',
        ${byAdministrator}, ${byAuthorization},
        ${input.occurredAt.toISOString()},
        ${new Date(input.occurredAt.getTime() + HOSTING_INVITE_TTL_MS).toISOString()}
      )
    `;

    // The audit event names whoever actually acted, in the column that describes them. Attributing
    // a stand owner's invitation to a coordinator who never clicked anything would put a false
    // claim in the trail, which is the reasoning `authorizeInvitedFarmerIn` already states.
    await tx`
      insert into audit_events (
        action, actor_administrator_id, actor_contact_hash, subject_type, subject_id, occurred_at
      ) values (
        'stand_provider_invited', ${byAdministrator},
        ${
          byAuthorization === null
            ? null
            : tx`(
                select contacts.phone_hash from farmer_authorizations
                join contacts on contacts.id = farmer_authorizations.contact_id
                where farmer_authorizations.id = ${byAuthorization}
              )`
        },
        'stand_provider', ${standProviderId}, ${input.occurredAt.toISOString()}
      )
    `;

    return {
      status: "invited" as const,
      token,
      sellerId,
      sellerName,
      standProviderId,
    };
  }) as Promise<InviteSellerToStandResult>;
}

/**
 * May this issuer invite a seller to this stand?
 *
 * **Two ways to be the stand's manager, and neither is a stored role.** A phone authorized for the
 * seller the stand names as itself IS its owner — derived through the self-pointer, exactly as
 * §there is no second permission system requires. A venue like Morgan Hill has no such seller, so
 * its managers hold the STAND arm `0043` added, and this is the first writer that reads it.
 *
 * VIGA's administrator needs neither: the coordinator door is the one that resolves the 11
 * retained hosted names, and it is already gated by an administrator session.
 */
async function authorizedForStand(
  tx: Tx,
  input: {
    salesLocationId: string;
    ownSellerId: string | null;
    authorizationId: string | null;
    administratorId: string | null;
  },
): Promise<boolean> {
  if (input.administratorId !== null) {
    // Re-read under lock, for the reason `authorizeFarmer` states: a principal resolved at the
    // start of a request proves they were an administrator then; this proves they are one now.
    const administrators = await tx`
      select id from administrators
      where id = ${input.administratorId} and revoked_at is null
      for update
    `;
    return administrators.length > 0;
  }
  if (input.authorizationId === null) return false;

  const authorizations = await tx`
    select id from farmer_authorizations
    where id = ${input.authorizationId}
      and revoked_at is null
      and (
        (seller_id is not null and seller_id = ${input.ownSellerId})
        or (sales_location_id is not null and sales_location_id = ${input.salesLocationId})
      )
    for update
  `;
  return authorizations.length > 0;
}

/*
  F-114 Phase C.4 / F-115 Tranche D — PAUSING AND ENDING A HOSTING RELATIONSHIP.

  ## The gap this closes

  Phase B built the whole CONSEQUENCE of pausing and left no way to do it. `paused` was in the
  lifecycle enum, every liveness predicate excluded ended rows and admitted paused ones, the
  re-open confirmation was written in C.4, and `invalidateProviderWork` was written and fully
  tested — with zero production callers. No statement anywhere set `lifecycle_state = 'paused'`
  or `ended_at`, so no row could ever be in the state all of that machinery served.

  This is a trigger and a surface, not a new mechanism. `invalidateProviderWork` is the
  consequence for both transitions, exactly as its own header says.

  ## Who may do what, and why it is asymmetric

  **PAUSE / RESUME — the seller, or VIGA. Never the host.**
  **END — either party, or VIGA.**

  The rule is §facts and authority's — *"Either side may end it; the seller may pause/resume
  without ending it"* — and `stand_providers.host_may_update_stock` names pause explicitly among
  what a host may never do.

  The reason it is this way round and not the intuitive inverse: a host who could pause could
  hide a seller's goods from the public indefinitely without ever ending anything — eviction by
  another name, with no visible act and nothing for the seller to answer. Ending is visible and
  final, so either party may walk away from an arrangement that is not working. **The graver
  power is HIDING, not TERMINATING.**

  `host_may_update_stock` governs CURRENT STOCK only and is not consulted here, with or without
  it. The host arm never reaches the pause path, so the question of whether that opt-in widens it
  does not arise.
*/

export type ProviderParticipationTransition = "pause" | "resume" | "end";

/** The past-tense audit verb per transition. Spelled out so no template invents `endd`. */
const PARTICIPATION_AUDIT_ACTION: Record<ProviderParticipationTransition, string> = {
  pause: "paused",
  resume: "resumed",
  end: "ended",
};

export type SetProviderParticipationResult =
  | {
      status: "changed";
      lifecycleState: "active" | "paused";
      ended: boolean;
      /** What the transition invalidated. Zero for a listing with nothing open. */
      proposalsInvalidated: number;
      remindersSuppressed: number;
    }
  /** The row is already in the state asked for. Idempotent, never an error. */
  | { status: "unchanged"; lifecycleState: "active" | "paused"; ended: boolean }
  | { status: "unknown_provider" }
  /** The relationship has ended, or was never accepted. There is nothing to pause or resume. */
  | { status: "provider_not_live" }
  /** Authorized for this listing, but not for THIS act — the host asking to pause. */
  | { status: "not_authorized" };

/**
 * Pause, resume, or end one seller's participation at one stand.
 *
 * **Authority is resolved inside the transaction, under lock**, and the pause arm is narrowed
 * from it rather than checked separately: `resolveProviderWriteAuthority` already reports WHICH
 * arm said yes, and `via: "host"` is exactly the case pause must refuse. A second enumeration of
 * who counts as the seller would be a fourth place to keep the arms in step.
 *
 * **VIGA reaches every transition**, through `administratorId` rather than through a phone. The
 * operator is not a farmer and holds no authorization; this is the same shape
 * `inviteSellerToStand` uses.
 *
 * Every transition invalidates THAT PROVIDER'S open confirmations and queued reminders, and only
 * that provider's — a seller pausing at a shared stand must not cancel her host's live
 * confirmation. Resume invalidates too: a token minted while the listing was live and answered
 * after a pause-and-resume would publish against a basis nobody re-confirmed.
 */
export async function setProviderParticipation(
  db: Db,
  input: {
    providerId: string;
    transition: ProviderParticipationTransition;
    /** The acting phone. Mutually exclusive with `administratorId`. */
    senderHash?: string;
    /** VIGA. Mutually exclusive with `senderHash`. */
    administratorId?: string;
    occurredAt: Date;
  },
): Promise<SetProviderParticipationResult> {
  const senderHash = input.senderHash ?? null;
  const administratorId = input.administratorId ?? null;
  if ((senderHash === null) === (administratorId === null)) {
    return { status: "not_authorized" };
  }

  return driver(db).begin(async (tx) => {
    // The row first and under lock, so two handsets racing to pause and end the same listing
    // serialize here rather than both reading `active` and both writing.
    const rows = await tx`
      select id, sales_location_id, seller_id, lifecycle_state, ended_at
      from stand_providers
      where id = ${input.providerId}
      for update
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    if (row === undefined) return { status: "unknown_provider" as const };

    const salesLocationId = row.sales_location_id as string;
    const lifecycleState = row.lifecycle_state as "pending" | "active" | "paused";
    const alreadyEnded = row.ended_at !== null;

    /*
      AUTHORITY, then the narrower question of whether this actor may make THIS transition.

      VIGA reaches all three. A phone reaches them through the arm that granted it: the seller
      arm reaches all three, the host arm reaches `end` alone. `pending` and ended are refused
      by the seam itself as `provider_not_live`, which is the right answer here too — there is
      no live arrangement to pause, resume, or walk away from.
    */
    if (administratorId === null) {
      if (alreadyEnded || lifecycleState === "pending") {
        return { status: "provider_not_live" as const };
      }
      const arm = await participationArm(tx, {
        salesLocationId,
        sellerId: row.seller_id as string,
        senderHash: senderHash as string,
      });
      if (arm === null) return { status: "not_authorized" as const };
      // THE CONTRACT'S CORE PROTECTION. A host may end and may never pause. Asserted on the ARM
      // rather than on a role: `host_may_update_stock` is not consulted at all, because it
      // governs current stock and this is participation.
      if (arm === "host" && input.transition !== "end") {
        return { status: "not_authorized" as const };
      }
    } else {
      const administrators = await tx`
        select id from administrators
        where id = ${administratorId} and revoked_at is null
        for update
      `;
      if (administrators.length === 0) return { status: "not_authorized" as const };
      // VIGA gets the same liveness answer a phone would, from the row rather than the seam.
      if (alreadyEnded || lifecycleState === "pending") {
        return { status: "provider_not_live" as const };
      }
    }

    const target: { lifecycleState: "active" | "paused"; ended: boolean } =
      input.transition === "end"
        ? { lifecycleState: lifecycleState as "active" | "paused", ended: true }
        : {
            lifecycleState: input.transition === "pause" ? "paused" : "active",
            ended: false,
          };

    // Idempotent, and deliberately BEFORE the write rather than after: a second pause must not
    // invalidate a confirmation the seller opened since the first one.
    if (
      target.ended === alreadyEnded &&
      target.lifecycleState === lifecycleState
    ) {
      return {
        status: "unchanged" as const,
        lifecycleState: lifecycleState as "active" | "paused",
        ended: alreadyEnded,
      };
    }

    /*
      `lifecycle_state` is left ALONE by an ending, and that is not an oversight.

      `stand_providers_hosting_lifecycle_coherent` requires `active` or `paused` to carry an
      acceptance and an approval, and ending removes neither — the seller did accept and VIGA
      did approve. `ended_at` is the ending, exactly as the column's own comment says: *"Either
      side ended it. Not a lifecycle value."* Writing a fourth state would put one fact in two
      places and make every liveness predicate read both.
    */
    if (input.transition === "end") {
      await tx`
        update stand_providers
        set ended_at = ${input.occurredAt}, updated_at = ${input.occurredAt}
        where id = ${input.providerId} and ended_at is null
      `;
    } else {
      await tx`
        update stand_providers
        set lifecycle_state = ${target.lifecycleState}, updated_at = ${input.occurredAt}
        where id = ${input.providerId} and ended_at is null
      `;
    }

    const invalidation = await invalidateProviderWork(tx, {
      salesLocationId,
      providerId: input.providerId,
      occurredAt: input.occurredAt,
    });

    await tx`
      insert into audit_events (
        action, actor_administrator_id, actor_contact_hash, subject_type, subject_id, occurred_at
      ) values (
        ${`stand_provider_${PARTICIPATION_AUDIT_ACTION[input.transition]}`},
        ${administratorId}, ${senderHash},
        'stand_provider', ${input.providerId}, ${input.occurredAt}
      )
    `;

    return {
      status: "changed" as const,
      lifecycleState: target.lifecycleState,
      ended: target.ended,
      proposalsInvalidated: invalidation.proposalsInvalidated,
      remindersSuppressed: invalidation.remindersSuppressed,
    };
  }) as Promise<SetProviderParticipationResult>;
}

/**
 * Which side of the relationship this phone is: the SELLER, the HOST, or neither.
 *
 * A separate question from `resolveProviderWriteAuthority`, and deliberately not that function
 * with a flag. That seam answers *may this phone state THIS PROVIDER'S STOCK*, and its host arm
 * is gated on `host_may_update_stock` — correctly, because stating someone else's stock is a
 * grant the seller makes. **Participation is not a grant.** A host who never wanted to restock
 * for a hosted seller is still the host, and §facts and authority lets either side walk away.
 * Routing this through the stock seam would tie ending to an opt-in that has nothing to do with
 * it: only the hosts who agreed to restock could end an arrangement.
 *
 * The two arms are the same two everywhere else — an authorization for the seller, or the
 * stand's own authority, which at a venue takes the stand arm because there is no seller to
 * name. Deliberately NOT composed from `PROVIDER_AUTHORITY_ARMS`: that fragment carries the
 * stock opt-in and the liveness filter, both of which are the caller's business here (liveness
 * is decided from the locked row above, so a phone gets `provider_not_live` rather than
 * `not_authorized` for a relationship that already ended).
 *
 * **The seller arm wins when a phone holds both**, matching the stock seam for the same reason:
 * the seller acting on her own participation needs nobody's permission, and attributing it to
 * the host arm would then narrow what she may do.
 */
async function participationArm(
  tx: Tx,
  input: { salesLocationId: string; sellerId: string; senderHash: string },
): Promise<"seller" | "host" | null> {
  // The seller test is `PROVIDER_SELLER_ARM`'s, against a provider projected from the caller's
  // ids rather than joined — this walks in from the CONTACT, so there is no `provider` row in
  // scope to join to. Same sentence, one statement of it (F-101).
  const rows = await tx.unsafe(
    `
      select (${PROVIDER_SELLER_ARM}) as is_seller
      from farmer_authorizations as auth
      join contacts on contacts.id = auth.contact_id
      join sales_locations as location on location.id = $2
      cross join (select $3::uuid as seller_id) as provider
      where contacts.phone_hash = $1
        and auth.revoked_at is null
        and (
          ${PROVIDER_SELLER_ARM}
          or (auth.seller_id is not null and auth.seller_id = location.own_seller_id)
          or (auth.sales_location_id is not null and auth.sales_location_id = location.id)
        )
      order by is_seller desc
      limit 1
      for update of auth
    `,
    [input.senderHash, input.salesLocationId, input.sellerId],
  );
  const row = rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return row.is_seller === true ? "seller" : "host";
}
