import type { Db } from "./index";
import type { Sql, Tx } from "./sql";

/*
  F-114 Phase C.2 — the ONE place that answers "may this phone write this provider's stock".

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

export type AuthorityReader = Db | Sql | Tx;

function queryable(db: AuthorityReader): Sql | Tx {
  return "sql" in db ? (db as Db).sql : (db as Sql | Tx);
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
