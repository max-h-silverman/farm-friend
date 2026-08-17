import type { OpenNowAnswer, OpenState } from "@farm-friend/core";
import type { Db } from "./index";
import type { Sql, Tx } from "./sql";
import { publicProviders } from "./provider-liveness";

/*
  B-074 / F-114 Phase A — the ONE place that answers "what is currently in stock here".

  Before this module, twelve production sites hand-wrote the same predicate — `is_current` on
  `inventory_revisions`, keyed on `sales_location_id` alone. They agreed only by convention and
  comment discipline, and the enumeration lives in
  docs/plans/farmer-behavior-architecture-plan.md §phase A.

  ## Why this ships before any provider column exists

  After F-114 Phase B a stand has SEVERAL providers, and "current inventory" becomes a
  per-provider question. A site still carrying its own `sales_location_id`-only SQL would keep
  returning stand-wide rows — output that looks correct and is wrong, on the map and in SMS,
  with no error anywhere. Consolidating first turns that entire class of defect into one
  compile-time change at one seam.

  Phase A adds NO provider column and changes NO output. Every site below returns byte-identical
  results to the SQL it replaced; `current-inventory.integration.test.ts` proves that per site
  against a populated database.

  ## Three shapes, deliberately, not one union

  The twelve sites ask the same question in three ways, and collapsing them into one row type
  would make every caller carry columns it does not use:

    1. `currentInventoryJoin` — a SQL FRAGMENT the three corpus-wide surfaces compose into their
       own larger queries (customer SMS retrieval, the public map, the VIGA admin roster). They
       select stand facts, farm facts, closure, offerings and payment in ONE round trip; turning
       that into a separate call per stand would multiply queries by the size of the corpus and
       change the ordering semantics each surface depends on. `visibleFarms` in test-sellers.ts is
       the existing precedent for exactly this, adopted for exactly this reason.
    2. `readCurrentInventory` — the stand-scoped reader, returning the revision and its entries.
    3. `readCurrentRevisionRef` — the revision identity alone, with optional `for update`, for
       the writers that need the incumbent they are about to supersede.

  ## The writers keep their locks

  Sites 10–12 in the enumeration read under `for update` inside a publishing transaction. The
  lock is the guarantee that two confirmations cannot both read the same incumbent as current and
  both insert a successor (B-070). `readCurrentRevisionRef` takes the lock as an explicit
  argument rather than defaulting it either way: a shared reader that silently dropped the lock
  would be a correctness regression wearing a refactor's clothes, and one that silently took it
  would put row locks on read-only paths.
*/

/** The single predicate. Everything in this module is a way of asking it. */
const CURRENT = "is_current";

/**
 * The join that attaches a stand's current inventory revision to a corpus-wide query.
 *
 * `locationAlias` is the caller's `sales_locations` alias; `revisionAlias` is what the caller
 * will refer to the revision by. `kind` is the caller's existing join semantics, preserved
 * exactly — `left` keeps a never-confirmed stand in the result (B-013, the public map and the
 * admin roster), `inner` drops it (customer SMS retrieval, whose offerings half carries those
 * stands instead).
 *
 * Returns SQL text rather than a composed query because the three callers each build one large
 * statement with their own projections, filters and ordering. What is shared here is the
 * PREDICATE — the thing that changes when a provider dimension arrives — not the query.
 */
export function currentInventoryJoin(input: {
  locationAlias: string;
  revisionAlias: string;
  kind: "inner" | "left";
}): string {
  const { locationAlias, revisionAlias, kind } = input;
  return `${kind} join inventory_revisions ${revisionAlias}
      on ${revisionAlias}.sales_location_id = ${locationAlias}.id and ${revisionAlias}.${CURRENT}`;
}

/**
 * The join that attaches a revision's entries.
 *
 * Separate from `currentInventoryJoin` because the two corpus-wide surfaces that aggregate
 * entries in a subquery (the admin roster) join them differently from the two that fan them out
 * as rows. Keeping them separate lets each caller keep its existing shape while both state the
 * currency rule once, above.
 */
export function currentEntriesJoin(input: {
  revisionAlias: string;
  entryAlias: string;
  kind: "inner" | "left";
}): string {
  const { revisionAlias, entryAlias, kind } = input;
  return `${kind} join inventory_entries ${entryAlias} on ${entryAlias}.inventory_revision_id = ${revisionAlias}.id`;
}

/** One published entry, in the farmer's own words. */
export interface CurrentInventoryEntry {
  entryId: string;
  itemName: string;
  quantity: number | null;
  unit: string | null;
  priceText: string | null;
  approximation: "some" | "limited" | "plentiful" | null;
  sortOrder: number;
}

/** A stand's current inventory: the revision that published it, and what it published. */
export interface CurrentInventory {
  revisionId: string;
  publishedAt: Date;
  entries: CurrentInventoryEntry[];
}

/**
 * The revision identity alone — no entries read.
 *
 * `null` means the stand has never published, or its last revision was superseded and nothing
 * replaced it. Callers distinguish "first publication" by exactly this null, which is why the
 * function returns the ref rather than a bare id.
 */
export interface CurrentRevisionRef {
  revisionId: string;
  publishedAt: Date;
}

/**
 * Anything that can run this module's queries: the handle, its raw client, or a transaction.
 *
 * A transaction is accepted directly rather than through a cast at each call site, because
 * sites 10–12 read inside a publishing transaction and their lock is only meaningful there.
 * Passing `Db` reads outside any transaction, which is what the read-only surfaces want.
 */
export type InventoryReader = Db | Sql | Tx;

const queryable = (db: InventoryReader): Sql =>
  typeof db === "function" ? (db as Sql) : (db as Db).sql;

/**
 * The stand's current revision identity.
 *
 * `lock` takes `for update` on the revision row. It is REQUIRED rather than defaulted: a writer
 * that means to supersede this row must serialize against every other writer doing the same
 * (B-070), and a read-only surface must not take a row lock. Neither default is safe for the
 * other, so neither is offered.
 */
export async function readCurrentRevisionRef(
  db: InventoryReader,
  input: { salesLocationId: string; providerId: string; lock: boolean },
): Promise<CurrentRevisionRef | null> {
  const sql = queryable(db);
  // Keyed on the PROVIDER (F-114 Phase B). Keyed on the stand, a hosted seller publishing would
  // read the HOST's revision as the incumbent it supersedes — the silently-wrong output Phase A
  // consolidated these sites to make impossible. `sales_location_id` stays in the predicate so
  // the composite key is exercised and a provider from another stand matches nothing.
  const rows = input.lock
    ? await sql`
        select id, published_at from inventory_revisions
        where sales_location_id = ${input.salesLocationId}
          and provider_id = ${input.providerId} and is_current
        for update
      `
    : await sql`
        select id, published_at from inventory_revisions
        where sales_location_id = ${input.salesLocationId}
          and provider_id = ${input.providerId} and is_current
      `;
  const row = rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) return null;
  return {
    revisionId: row.id as string,
    publishedAt: row.published_at as Date,
  };
}

/**
 * The id of the provider for a stand's OWN seller — the one that IS the stand (F-114 Phase C.0).
 *
 * **This follows the self-pointer, never a null seller.** Phase B identified the stand's own
 * inventory by `seller_id is null` — the native brand slot — and §the stand-and-sellers
 * correction removed that slot: every provider now names a real seller, and which one is the
 * stand is recorded in `sales_locations.own_seller_id`. A `seller_id is null` lookup can no
 * longer match anything at all.
 *
 * It lives at this seam because "whose inventory" is the question this module owns. Every writer
 * that published stand-wide before Phase B publishes for this provider, which is what keeps
 * output unchanged: the stand's own seller IS the stand as it always behaved.
 *
 * Throws rather than returning null, for both failure shapes, because each is a caller error
 * rather than an ordinary absence and a silent skip would hide a stand that stopped publishing:
 *
 * - **The stand has no seller of its own.** A venue like Morgan Hill Community Stand sells
 *   nothing itself, so there is no "its own inventory" to write. A caller reaching here for such
 *   a stand is asking the wrong question — it must name which nested seller it means.
 * - **The self-pointer names a seller with no provider row at this stand.** That is a broken
 *   invariant: `sales_locations_id_own_seller_unique` and the provider foreign key exist to make
 *   it unreachable.
 */
export async function readNativeProviderId(
  db: InventoryReader,
  input: { salesLocationId: string },
): Promise<string> {
  const sql = queryable(db);
  const rows = await sql`
    select p.id
    from sales_locations l
    join stand_providers p
      on p.sales_location_id = l.id and p.seller_id = l.own_seller_id
    where l.id = ${input.salesLocationId}
  `;
  const row = rows[0] as Record<string, unknown> | undefined;
  if (row === undefined) {
    throw new Error(
      `sales location ${input.salesLocationId} has no provider for its own seller`,
    );
  }
  return row.id as string;
}

/** One live provider's current entries at a stand (F-114 Phase C.3). */
export interface ProviderCurrentEntries {
  providerId: string;
  sellerId: string;
  revisionId: string;
  publishedAt: Date;
  entries: CurrentInventoryEntry[];
}

/**
 * EVERY live provider's current inventory at one stand, in one round trip.
 *
 * F-114 Phase C.3, for the readers that need to know *which sellers currently claim this item*
 * rather than *what does this listing hold*. The stock-out router is the first: a report
 * contradicts a provider only if that provider's own current revision lists the item, and
 * answering that per provider with `readCurrentInventory` would multiply queries by the number
 * of sellers at the stand and lose the shared ordering.
 *
 * A provider with no current revision is ABSENT from the result rather than present with no
 * entries, and that distinction is load-bearing: "published nothing" and "published a listing
 * without this item" are the non-claimant and the agreer, and only the second is a claim.
 *
 * `pending` and ended relationships are excluded — neither is a live listing. `paused` IS
 * included: a paused seller's last published claim is still what a customer saw.
 */
export async function readCurrentInventoryByProvider(
  db: InventoryReader,
  input: { salesLocationId: string },
): Promise<ProviderCurrentEntries[]> {
  const sql = queryable(db);
  // `.unsafe`, for the shared-fragment reason (DEVELOPMENT.md §gotchas): a tagged template
  // sends `publicProviders` as a bind PARAMETER and dies at parse.
  const rows = await sql.unsafe(
    `
      select
        provider.id as provider_id,
        provider.seller_id,
        revision.id as revision_id,
        revision.published_at,
        entry.id as entry_id,
        entry.item_name,
        entry.quantity,
        entry.unit,
        entry.price_text,
        entry.approximation,
        entry.sort_order
      from stand_providers as provider
      join inventory_revisions as revision
        on revision.provider_id = provider.id and revision.is_current
      left join inventory_entries as entry
        on entry.inventory_revision_id = revision.id
      where provider.sales_location_id = $1
        and ${publicProviders("provider")}
      order by provider.id, entry.sort_order asc, entry.id asc
    `,
    [input.salesLocationId],
  );

  const byProvider = new Map<string, ProviderCurrentEntries>();
  for (const raw of rows) {
    const row = raw as Record<string, unknown>;
    const providerId = row.provider_id as string;
    let current = byProvider.get(providerId);
    if (current === undefined) {
      current = {
        providerId,
        sellerId: row.seller_id as string,
        revisionId: row.revision_id as string,
        publishedAt: row.published_at as Date,
        entries: [],
      };
      byProvider.set(providerId, current);
    }
    // A revision with no entries left-joins to one NULL row. That is a published listing
    // holding nothing, which is a real state and a real claim — the provider is present with an
    // empty list, never dropped.
    if (row.entry_id === null) continue;
    current.entries.push({
      entryId: row.entry_id as string,
      itemName: row.item_name as string,
      quantity: row.quantity === null ? null : Number(row.quantity),
      unit: (row.unit as string | null) ?? null,
      priceText: (row.price_text as string | null) ?? null,
      approximation:
        (row.approximation as CurrentInventoryEntry["approximation"]) ?? null,
      sortOrder: Number(row.sort_order),
    });
  }
  return [...byProvider.values()];
}

/**
 * The stand's current inventory — its revision and every entry, in publication order.
 *
 * Ordered `sort_order asc, id asc`. The tiebreak on `id` is not decoration: `sort_order` is a
 * writer-assigned index and nothing in the schema makes it unique per revision, so without it a
 * duplicated index leaves the entry order to the planner. Two sites already ordered this way and
 * two did not; the total order is now stated once and every site inherits it.
 */
export async function readCurrentInventory(
  db: InventoryReader,
  input: { salesLocationId: string; providerId: string },
): Promise<CurrentInventory | null> {
  const sql = queryable(db);
  const ref = await readCurrentRevisionRef(db, {
    salesLocationId: input.salesLocationId,
    providerId: input.providerId,
    lock: false,
  });
  if (ref === null) return null;
  const rows = await sql`
    select id, item_name, quantity, unit, price_text, approximation, sort_order
    from inventory_entries
    where inventory_revision_id = ${ref.revisionId}
    order by sort_order asc, id asc
  `;
  return {
    revisionId: ref.revisionId,
    publishedAt: ref.publishedAt,
    entries: rows.map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        entryId: row.id as string,
        itemName: row.item_name as string,
        quantity: row.quantity === null ? null : Number(row.quantity),
        unit: (row.unit as string | null) ?? null,
        priceText: (row.price_text as string | null) ?? null,
        approximation:
          (row.approximation as CurrentInventoryEntry["approximation"]) ?? null,
        sortOrder: Number(row.sort_order),
      };
    }),
  };
}

/*
  ## The stand/provider availability intersection

  F-114 §facts and authority: a provider's schedule and season are CLAMPED to the stand's. A
  provider may be closed while the stand is open; a provider can NEVER be open while the stand is
  closed. That supports the real case — a hosted seller who takes only cash and locks their box
  before the stand shuts.

  It lives here, at the reader seam, because the contract requires it computed ONCE. Two surfaces
  computing it separately is the map-and-SMS disagreement this refactor exists to end.

  In Phase A there are no providers, so every call passes `provider: undefined` and the answer is
  the stand's own. The function is not speculative scaffolding: it is the seam the enumerated
  sites are being moved onto, and moving them twice — once now without it, once again in Phase B —
  is what it exists to avoid. It has a real consumer today (every site that resolves open-now
  against a stand) and its Phase A behavior is a tested identity, not a placeholder.
*/

/**
 * Clamp a provider's own open-now answer to its stand's.
 *
 * The rule is one-directional and deliberately so. A stand that is not open makes every provider
 * at it unavailable, whatever the provider says: the stand is locked, so no one's goods are
 * buyable there. A stand that IS open does not make a provider open — the provider's own answer
 * stands.
 *
 * `undefined` for the provider means the stand's native slot, which has no schedule of its own,
 * so the stand's answer passes through unchanged. That is Phase A's only case.
 *
 * `unknown` is preserved rather than resolved. It means the farmer stated nothing, and the whole
 * open-now design refuses to convert silence into "closed" (see core/public/open-now.ts). A
 * provider whose stand is `unknown` is `unknown`, not shut.
 */
export function intersectAvailability(input: {
  stand: OpenNowAnswer;
  provider?: OpenNowAnswer;
}): OpenNowAnswer {
  const { stand, provider } = input;
  if (provider === undefined) return stand;
  // The stand's negative answers are absolute — they describe a locked box, not a schedule.
  if (!STAND_PERMITS_PROVIDER.has(stand.state)) return stand;
  // The stand permits it; the provider decides. Sun times come from the provider's own answer
  // when it has them, because they are the arithmetic that decided the provider's state and a
  // caller labelling that state must not be handed a different sunset.
  return provider;
}

/**
 * Stand states that leave the provider's own answer standing.
 *
 * `unknown` is here: a stand that stated no schedule has not stated that it is shut, so it
 * cannot close a provider that DID state one. Every other non-open state describes the stand
 * being unavailable, and overrides.
 */
const STAND_PERMITS_PROVIDER: ReadonlySet<OpenState> = new Set<OpenState>([
  "open",
  "unknown",
  "by_appointment",
]);
