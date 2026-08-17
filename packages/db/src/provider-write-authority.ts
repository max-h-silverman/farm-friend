import type { Db } from "./index";
import type { Sql, Tx } from "./sql";
import { reachableProviders } from "./provider-liveness";

/*
  F-114 Phase C.2 — the ONE place that answers "may this phone write this".

  Two questions, because there are two kinds of fact and a stand shutdown is not anybody's stock:

    * `resolveProviderWriteAuthority` — may this phone state THIS PROVIDER'S stock?
    * `resolveStandWriteAuthority`    — may this phone state a fact about THIS PLACE?

  They are separate functions rather than one with a flag, because at a venue the second has an
  answer and the first has nothing to ask about: Morgan Hill has no provider of its own. Merging
  them would make one call return "authorized for no provider", which every caller would then
  have to interpret.

  ## Why this is a seam and not a line in each writer

  Every inventory writer asked the same question before this module, and every one of them asked
  it the same wrong way: *is this phone authorized for the stand's OWN seller?* That is correct
  for 31 of 38 stands and wrong for every hosted relationship. It locks a hosted seller out of
  her own goods at her host's stand, and it locks a venue's manager out of a stand that has no
  seller of its own to authorize against.

  The question a writer actually needs is *may this phone write THIS provider's stock, and under
  which authorization?* There are exactly three ways to say yes. Enumerating them at each writer
  would mean a writer that forgets one silently refuses a farmer their own listing, and a writer
  that invents a fourth silently publishes someone else's goods. They are enumerated once, here.

  ## The three ways to say yes

  1. **The seller's own phone** — an authorization naming the provider's seller. This is Zoe at
     Kelsey's stand, and it is equally every farmer at their own stand: the stand's own seller is
     a seller like any other, so the ordinary case is not a special case and there is no native
     branch to keep in step with this one.
  2. **The stand's phone, when the seller permitted it** — `stand_providers.host_may_update_stock`,
     off by default and the SELLER'S to grant (§the Venison Valley case). A baker who drops off at
     dawn may want the host marking the last loaf gone; Zoe specifically does not. It is therefore
     a property of the RELATIONSHIP, not of the stand and not of a role.
  3. **The stand arm, for a venue** — Morgan Hill has no seller of its own, so its manager cannot
     be reached through a seller authorization at all. `farmer_authorizations.sales_location_id`
     is that arm, and it confers the same host right under the same opt-in, never more.

  ## What this deliberately is NOT

  - **Not a default.** Acceptance never turns the right on; it may not grant more access than it
    says (§hosting and approval lifecycle).
  - **Not a general permission.** Current stock only. Identity, standing prices, payment, pause,
    and participation still need an authorization for that seller (§facts and authority).
  - **Not transitive.** A host right at one stand says nothing about the same seller elsewhere.
  - **Not an availability answer.** Whether the listing is OPEN is `intersectAvailability`'s
    question. This answers only who may write.

  ## Paused is authorized, and that is the point

  §facts and authority: *a paused provider is offered re-opening, never refused.* A caller told
  `not_authorized` would answer "you cannot do that"; a paused seller must instead be offered
  their listing back. So pause is reported as a FLAG on an authorized answer rather than as a
  refusal — two answers, because they are two answers. `ended_at` and `pending` are refusals,
  because neither is a relationship the seller can be offered back into by replying to a prompt.
*/

/**
 * Who may state facts about the PLACE — its closure, and the stand-level facts beside it.
 *
 * A different question from `ProviderWriteAuthority`, and deliberately a second function rather
 * than a flag on the first. §facts and authority: a stand shutdown OVERRIDES every provider and
 * renders nothing itemized. It is not any seller's stock, so "whose goods may I state" cannot
 * answer it — at a venue there is no provider to ask about at all.
 *
 * The two arms mirror `farmer_authorizations` exactly, which is the point: stand authority is
 * DERIVED, never stored. There is no "stand owner" role.
 *
 * - **A stand with a seller of its own** — authority is being authorized for that seller,
 *   resolved through the self-pointer. `sellerId` and `approvalId` are that seller's, and the
 *   approval is required, because VIGA's approval gates whether that seller may be public.
 * - **A venue** — a stand-armed authorization naming the stand itself. Both are NULL: there is
 *   no seller to name and therefore no seller-approval, since a venue sells nothing.
 */
export type StandWriteAuthority =
  | {
      status: "authorized";
      authorizationId: string;
      salesLocationId: string;
      /** The stand's own seller — NULL at a venue. */
      sellerId: string | null;
      /** VIGA's approval of that seller — NULL at a venue, with the seller. */
      approvalId: string | null;
    }
  | { status: "unknown_stand" }
  /** The stand has its own seller, but VIGA's approval of that seller is gone. */
  | { status: "not_approved" }
  | { status: "not_authorized" };

export type ProviderWriteAuthority =
  | {
      status: "authorized";
      /** Which of the three ways said yes. Recorded so a writer can attribute the claim. */
      via: "seller" | "host";
      /** The authorization the write is performed under — never the seller's, when `via` is host. */
      authorizationId: string;
      /** Whose goods these are. */
      sellerId: string;
      salesLocationId: string;
      providerId: string;
      /** The seller's own opt-in, reported so a settings surface can show what was granted. */
      hostMayUpdateStock: boolean;
      /** The listing is paused: publish only after the re-open confirmation. */
      paused: boolean;
    }
  | { status: "unknown_provider" }
  /** `pending` or ended — there is no live relationship to write against. */
  | { status: "provider_not_live" }
  | { status: "not_authorized" };

/**
 * The three ways to say yes, as SQL text, for the readers that ask in the OTHER direction.
 *
 * `resolveProviderWriteAuthority` answers *may this phone write this provider*. Two readers ask
 * *which providers may this phone reach* — `lockLiveTargets` builds the SMS menu, and
 * `resolveFarmerLink` re-checks a standing link on every load. Enumerating the arms in each of
 * them is exactly the drift this module exists to prevent: a menu offering a listing the writer
 * then refuses is a farmer told to choose and then told no.
 *
 * Expects `provider`, `location`, and `auth` in scope. It is composed SQL TEXT, so any query
 * using it must go through `.unsafe(…)` — a tagged template would send it as a bind parameter
 * and die at parse (DEVELOPMENT.md §gotchas).
 *
 * `paused` is deliberately INCLUDED and `pending`/ended are not: §facts and authority offers a
 * paused seller their listing back rather than refusing them.
 */
export const PROVIDER_AUTHORITY_ARMS = `
  ${reachableProviders("provider")}
  and (
    auth.seller_id = provider.seller_id
    or (
      provider.host_may_update_stock
      and (
        (auth.seller_id is not null and auth.seller_id = location.own_seller_id)
        or (auth.sales_location_id is not null and auth.sales_location_id = location.id)
      )
    )
  )
`;

export type AuthorityReader = Db | Sql | Tx;

/**
 * The ONE listing an authorization holds at a named stand, or nothing.
 *
 * F-114 Phase C.3. VIGA's Farms roster shows one row per stand, and a link opens one listing —
 * so the operator's `(authorization, stand)` pair has to become a provider before it can issue
 * anything. This refuses on zero AND on more than one rather than picking: a stand where the
 * operator's chosen farmer holds two listings is a genuine ambiguity, and resolving it silently
 * would hand out a link to the wrong seller's goods with nothing on screen to say so.
 *
 * The arms are the shared ones, so the operator can never issue a link the writer would refuse.
 */
export async function resolveAdministratorLinkTarget(
  db: AuthorityReader,
  input: { authorizationId: string; salesLocationId: string },
): Promise<{ providerId: string; sellerId: string } | null> {
  const sql = queryable(db);
  const rows = await sql.unsafe(
    `
      select provider.id as provider_id, provider.seller_id
      from stand_providers as provider
      join sales_locations as location on location.id = provider.sales_location_id
      join farmer_authorizations as auth on ${PROVIDER_AUTHORITY_ARMS}
      where auth.id = $1
        and location.id = $2
        and auth.revoked_at is null
      limit 2
    `,
    [input.authorizationId, input.salesLocationId],
  );
  if (rows.length !== 1) return null;
  return {
    providerId: rows[0]?.provider_id as string,
    sellerId: rows[0]?.seller_id as string,
  };
}

function queryable(db: AuthorityReader): Sql | Tx {
  return "sql" in db ? (db as Db).sql : (db as Sql | Tx);
}

/**
 * Does this phone hold a live listing at the stand it just named?
 *
 * The access fork in `free-text.ts` asks exactly this and nothing more: a farmer's words about a
 * stand they sell at are an update to publish; the same words about anyone else's stand are a
 * report to pass along. It needs a boolean, not an authorization — the update path resolves its
 * own target afterwards through `resolveFarmerTarget`, which reads the same arms.
 *
 * It was written as *is this phone authorized for the stand's OWN seller?*, so a hosted seller
 * naming her host's stand failed and her own inventory update was filed as a customer stock-out
 * report about herself. Fail-safe in the Golden Rule #1 sense — it can only move a farmer away
 * from publishing — but her primary SMS journey silently did not work.
 *
 * The arms are the shared ones, which is what keeps this from being a fourth enumeration: a
 * stand the fork sends to the publish path is a stand `resolveFarmerTarget` can then target.
 */
export async function senderHasListingAtStand(
  db: AuthorityReader,
  input: { senderHash: string; salesLocationId: string; occurredAt: Date },
): Promise<boolean> {
  const sql = queryable(db);
  // `.unsafe` because the arms are composed SQL TEXT; a tagged template would send them as a
  // bind parameter and die at parse (DEVELOPMENT.md §gotchas).
  const rows = await sql.unsafe(
    `
      select 1
      from stand_providers as provider
      join sales_locations as location on location.id = provider.sales_location_id
      join farmer_authorizations as auth on ${PROVIDER_AUTHORITY_ARMS}
      join contacts on contacts.id = auth.contact_id
      where location.id = $1
        and contacts.phone_hash = $2
        and auth.revoked_at is null
        and auth.phone_verified_at is not null
        and auth.authorized_at <= $3
      limit 1
    `,
    [input.salesLocationId, input.senderHash, input.occurredAt],
  );
  return rows.length > 0;
}

/**
 * Resolve who, if anyone, this phone is when it writes this provider's stock.
 *
 * Both arms are resolved in ONE statement rather than two round trips, so a revocation
 * committing between them cannot let a caller pass on the first arm and be denied on the
 * second — or worse, be granted under an authorization that no longer exists.
 *
 * **The seller arm is preferred over the host arm** when a phone somehow holds both. It is the
 * stronger claim: the seller stating their own stock needs no permission from anybody, so
 * attributing the write to the host's authorization would file a fact about the seller's goods
 * under someone else's name for no reason.
 */
export async function resolveProviderWriteAuthority(
  db: AuthorityReader,
  input: { providerId: string; senderHash: string },
): Promise<ProviderWriteAuthority> {
  const sql = queryable(db);
  /*
    Deliberately NOT written with `PROVIDER_AUTHORITY_ARMS`, and the reason is the difference
    between the two directions. The readers ask *which providers may this phone reach* and want
    one boolean. This function must additionally report WHICH arm said yes and WHICH
    authorization the write is performed under, and it must distinguish a refusal
    (`not_authorized`) from a relationship that is not live (`provider_not_live`) — so it reads
    the provider row unconditionally and decides in code.

    `provider-write-authority.integration.test.ts` asserts the two agree on every arm, which is
    the guarantee that matters; sharing the text would not add one, and folding the lateral
    joins into a filter would lose the arm the caller is told about.
  */
  const rows = await sql`
    select
      provider.id as provider_id,
      provider.seller_id,
      provider.sales_location_id,
      provider.lifecycle_state,
      provider.ended_at,
      provider.host_may_update_stock,
      seller_auth.id as seller_authorization_id,
      host_auth.id as host_authorization_id
    from stand_providers as provider
    join sales_locations as location on location.id = provider.sales_location_id
    left join lateral (
      select auth.id
      from farmer_authorizations as auth
      join contacts on contacts.id = auth.contact_id
      where auth.seller_id = provider.seller_id
        and contacts.phone_hash = ${input.senderHash}
        and auth.revoked_at is null
      limit 1
    ) as seller_auth on true
    left join lateral (
      select auth.id
      from farmer_authorizations as auth
      join contacts on contacts.id = auth.contact_id
      where contacts.phone_hash = ${input.senderHash}
        and auth.revoked_at is null
        -- The two arms of the stand's OWN authority, one record with two shapes: a seller-armed
        -- authorization for the stand's own seller, or a stand-armed one naming the stand
        -- itself. A venue has only the second, because it has no seller to name.
        and (
          (auth.seller_id is not null and auth.seller_id = location.own_seller_id)
          or (auth.sales_location_id is not null and auth.sales_location_id = location.id)
        )
      limit 1
    ) as host_auth on true
    where provider.id = ${input.providerId}
  `;

  const row = rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return { status: "unknown_provider" };

  const lifecycleState = row.lifecycle_state as string;
  if (row.ended_at !== null || lifecycleState === "pending") {
    return { status: "provider_not_live" };
  }

  const hostMayUpdateStock = row.host_may_update_stock as boolean;
  const sellerAuthorizationId = row.seller_authorization_id as string | null;
  const hostAuthorizationId = row.host_authorization_id as string | null;

  // The seller arm first — see the doc comment. The host arm requires the opt-in; without it a
  // phone that is only the host's is not a writer here at all.
  const resolved: { via: "seller" | "host"; authorizationId: string } | null =
    sellerAuthorizationId !== null
      ? { via: "seller", authorizationId: sellerAuthorizationId }
      : hostMayUpdateStock && hostAuthorizationId !== null
        ? { via: "host", authorizationId: hostAuthorizationId }
        : null;
  if (resolved === null) return { status: "not_authorized" };

  return {
    status: "authorized",
    via: resolved.via,
    authorizationId: resolved.authorizationId,
    sellerId: row.seller_id as string,
    salesLocationId: row.sales_location_id as string,
    providerId: row.provider_id as string,
    hostMayUpdateStock,
    paused: lifecycleState === "paused",
  };
}

/**
 * Resolve who, if anyone, this phone is when it states a fact about this stand.
 *
 * Both arms in ONE statement, for the same reason the provider seam uses one: a revocation
 * committing between two reads could otherwise let a caller pass one arm and be granted under
 * an authorization that no longer exists.
 *
 * **The arm is decided by the STAND, never chosen by the caller.** A stand with a seller of its
 * own must be reached through that seller — otherwise its owner could take the venue's arm and
 * publish with no VIGA approval behind it, turning the venue's arm into an escape hatch for all
 * 38 stands. The same rule the `closure_revisions_guard_arm` trigger enforces on the row.
 */
export async function resolveStandWriteAuthority(
  db: AuthorityReader,
  input: { salesLocationId: string; senderHash: string },
): Promise<StandWriteAuthority> {
  const sql = queryable(db);
  const rows = await sql`
    select
      location.id as sales_location_id,
      location.own_seller_id,
      seller_auth.id as seller_authorization_id,
      stand_auth.id as stand_authorization_id,
      approval.id as approval_id
    from sales_locations as location
    left join lateral (
      select auth.id
      from farmer_authorizations as auth
      join contacts on contacts.id = auth.contact_id
      where auth.seller_id is not null
        and auth.seller_id = location.own_seller_id
        and contacts.phone_hash = ${input.senderHash}
        and auth.revoked_at is null
      limit 1
    ) as seller_auth on true
    left join lateral (
      select auth.id
      from farmer_authorizations as auth
      join contacts on contacts.id = auth.contact_id
      where auth.sales_location_id is not null
        and auth.sales_location_id = location.id
        and contacts.phone_hash = ${input.senderHash}
        and auth.revoked_at is null
      limit 1
    ) as stand_auth on true
    left join lateral (
      select seller_approvals.id
      from seller_approvals
      where seller_approvals.seller_id = location.own_seller_id
        and seller_approvals.revoked_at is null
      limit 1
    ) as approval on true
    where location.id = ${input.salesLocationId}
  `;

  const row = rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return { status: "unknown_stand" };

  const ownSellerId = row.own_seller_id as string | null;
  if (ownSellerId === null) {
    // A venue. Only the stand arm can reach it, because there is no seller to name.
    const standAuthorizationId = row.stand_authorization_id as string | null;
    if (standAuthorizationId === null) return { status: "not_authorized" };
    return {
      status: "authorized",
      authorizationId: standAuthorizationId,
      salesLocationId: row.sales_location_id as string,
      sellerId: null,
      approvalId: null,
    };
  }

  // A stand with its own seller. Reached through that seller and no other way — see the arm
  // rule above. A stand-armed authorization naming it is not a second door.
  const sellerAuthorizationId = row.seller_authorization_id as string | null;
  if (sellerAuthorizationId === null) return { status: "not_authorized" };
  const approvalId = row.approval_id as string | null;
  if (approvalId === null) return { status: "not_approved" };
  return {
    status: "authorized",
    authorizationId: sellerAuthorizationId,
    salesLocationId: row.sales_location_id as string,
    sellerId: ownSellerId,
    approvalId,
  };
}
