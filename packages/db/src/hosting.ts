import {
  hashFarmerInviteToken,
  issueFarmerInviteToken,
  validatePublicStrings,
  type ProhibitedPublicStringKind,
} from "@farm-friend/core";
import type { Db } from "./index";
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
    */
    const providers = await tx`
      insert into stand_providers (
        sales_location_id, seller_id, lifecycle_state, invited_at
      ) values (
        ${input.salesLocationId}, ${sellerId}, 'pending', ${input.occurredAt.toISOString()}
      )
      on conflict (sales_location_id, seller_id) do nothing
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
