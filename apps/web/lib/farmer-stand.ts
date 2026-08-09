import {
  hashFarmerLinkToken,
  renderPublicStringRefusal,
  renderProposedSnapshot,
  type Clock,
  type StructuredInventoryEdit,
} from "@farm-friend/core";
import {
  confirmInventoryPublication,
  resolveFarmerLink,
  saveSalesLocationParticipants,
  type Db,
  type ResolvedFarmerLink,
} from "@farm-friend/db";
import { applyInterpretedInventory } from "./interpretation";

// The farmer's own web surface, behind a standing link (F-040).
//
// This is the third channel the settled design names — SMS, a texted link, a bookmarked form
// — and the rule for all three is the same: **every channel lands on the SAME confirmation
// gate, and the web path gets no bypass.**
//
// ## What "no bypass" means concretely
//
// A farmer's submission here does exactly what their text message does: it opens or revises
// their ONE pending proposal (`openOrReviseProposal`) and returns the snapshot to confirm.
// Publishing happens only through `confirmInventoryPublication`, which re-reads farmer
// authority and VIGA approval under lock. There is deliberately **no** function on this page
// that writes `inventory_revisions`, and no argument any caller can pass to skip the
// proposal step. Golden Rule #1 and #3 are untouched by construction rather than by
// convention.
//
// The one real difference from SMS is honest and small: the SMS proposal is activated when
// Telnyx accepts the prompt, because a token that predates its prompt must not commit. On the
// web the farmer is looking at the snapshot in the same request, so `confirmFromLink`
// activates and consumes in the caller's own flow — the confirmation is the same gate, reached
// without a carrier in between.
//
// ## The blast radius, by construction
//
// `resolveFarmerLink` returns ONE farm, ONE sales location, and the holder's own sender hash,
// re-reading both revocation columns on every request. Everything below is scoped to that
// projection and cannot widen it:
//
//   - it cannot change farm ownership — nothing here writes `farms` or `farmer_authorizations`;
//   - it cannot grant or alter authorization — the only writers are administrator-gated;
//   - it cannot reach another farm's listing — the location comes from the token's row, never
//     from the request;
//   - it cannot read another actor's data — no query here takes an identifier from the caller;
//   - it cannot publish without confirmation — publication is the gate, and the gate is the
//     only writer.
//
// Each of those is asserted, and sabotaged, in `farmer-stand.integration.test.ts`.

export interface FarmerStandDeps {
  db: Db;
  clock: Clock;
}

/**
 * Resolve a raw link token to the one stand it speaks for, or null.
 *
 * The raw token is hashed HERE and only the hash reaches the database, so the lookup key and
 * the credential are never the same value — the same discipline as the session token.
 */
export async function resolveStandFromToken(
  db: Db,
  token: string,
): Promise<ResolvedFarmerLink | null> {
  // Bounded before any database work: a token is a fixed-width hex string, and anything else
  // is not a near-miss to look up. This also keeps an absurd path segment from reaching the
  // driver.
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  return resolveFarmerLink(db, { tokenHash: hashFarmerLinkToken(token) });
}

/** One item as the farmer's own page shows it. Display shape, not a durable record. */
export interface StandEntryView {
  entryId: string;
  itemName: string;
  quantity?: number;
  unit?: string;
  priceText?: string;
  approximation?: "some" | "limited" | "plentiful";
}

/**
 * Read the entries the farmer's NEXT edit will be composed against, to show them.
 *
 * **The sender's open proposal wins over the published revision**, because that is the base
 * `applyInterpretedInventory` composes from. Showing the published listing instead was a real
 * defect once the listing became editable: the controls send ENTRY IDS, so a farmer who edited
 * once and came back could see items their own pending proposal had already dropped, then send
 * an id absent from the base. Natural-language SMS does not have that failure mode because it
 * names items rather than identifiers.
 *
 * Scoped to ONE sender: proposals are per-sender, so a second authorized farmer at the same
 * stand composes against what is published, and never sees the other's unconfirmed edit.
 *
 * Display only, and deliberately narrow: the location comes from the caller's already-resolved
 * link, never an identifier from the request, so it cannot be pointed at another farm's stand.
 * Nothing here publishes — the proposal is still composed and confirmed server-side.
 */
export async function readCurrentStandEntries(
  db: Db,
  salesLocationId: string,
  senderHash: string,
): Promise<StandEntryView[]> {
  const pending = await db.sql`
    select payload from inventory_publication_proposals
    where sender_hash = ${senderHash}
      and sales_location_id = ${salesLocationId}
      and state = 'open'
      and has_inventory
  `;
  const payload = pending[0]?.payload as { entries?: unknown } | undefined;
  if (payload !== undefined && Array.isArray(payload.entries)) {
    // Already the snapshot shape the proposal stores, so it is returned as-is rather than
    // re-derived: re-deriving would be a second statement of what an entry looks like.
    return payload.entries as StandEntryView[];
  }

  const rows = await db.sql`
    select entry.id, entry.item_name, entry.quantity, entry.unit,
      entry.price_text, entry.approximation
    from inventory_entries entry
    join inventory_revisions revision on revision.id = entry.inventory_revision_id
    where revision.sales_location_id = ${salesLocationId} and revision.is_current
    order by entry.sort_order asc
  `;
  return rows.map((row) => {
    const record = row as Record<string, unknown>;
    return {
      entryId: record.id as string,
      itemName: record.item_name as string,
      ...(record.quantity !== null ? { quantity: Number(record.quantity) } : {}),
      ...(record.unit !== null ? { unit: record.unit as string } : {}),
      ...(record.price_text !== null ? { priceText: record.price_text as string } : {}),
      ...(record.approximation !== null
        ? { approximation: record.approximation as "some" | "limited" | "plentiful" }
        : {}),
    };
  });
}

export type FarmerStandProposal =
  | {
      outcome: "proposed";
      proposalId: string;
      proposalVersion: number;
      /** The complete resulting snapshot the farmer is about to confirm. */
      confirmationText: string;
    }
  | { outcome: "clarification"; question: string }
  | { outcome: "rejected"; reason: string }
  /** The link no longer resolves — revoked between page load and submit. */
  | { outcome: "not_authorized" };

/**
 * Open or revise the returning farmer's one proposal from a direct structured edit.
 * The link is re-resolved on this request; revocation therefore bites before composition.
 */
export async function proposeStructuredFromLink(
  deps: Pick<FarmerStandDeps, "db" | "clock">,
  input: {
    token: string;
    edit: StructuredInventoryEdit;
  },
): Promise<FarmerStandProposal> {
  const stand = await resolveStandFromToken(deps.db, input.token);
  if (stand === null) return { outcome: "not_authorized" };

  return applyInterpretedInventory(
    deps,
    {
      senderHash: stand.senderHash,
      salesLocationId: stand.salesLocationId,
      edit: input.edit,
    },
  );
}

export type FarmerStandParticipantSave =
  | {
      status: "saved";
      activeDisplayNames: string[];
      addedDisplayNames: string[];
      retiredDisplayNames: string[];
    }
  | { status: "not_authorized" }
  | { status: "refused"; reason: "invalid_names" | "unsafe_public_text"; message?: string };

/** Save owner-confirmed public seller names for the token's one location. */
export async function saveParticipantsFromLink(
  deps: Pick<FarmerStandDeps, "db" | "clock">,
  input: { token: string; activeDisplayNames: readonly string[] },
): Promise<FarmerStandParticipantSave> {
  const stand = await resolveStandFromToken(deps.db, input.token);
  if (stand === null) return { status: "not_authorized" };

  const result = await saveSalesLocationParticipants(deps.db, {
    senderHash: stand.senderHash,
    salesLocationId: stand.salesLocationId,
    activeDisplayNames: input.activeDisplayNames,
    occurredAt: deps.clock.now(),
  });
  if (result.status === "saved" || result.status === "not_authorized") return result;
  if (result.status === "unsafe_public_text") {
    return {
      status: "refused",
      reason: result.status,
      message: renderPublicStringRefusal(result.prohibited),
    };
  }
  return { status: "refused", reason: result.status };
}

export type FarmerStandConfirmation =
  | { status: "published"; revisionId?: string; closureRevisionId?: string }
  | { status: "declined" }
  | { status: "not_authorized" }
  | { status: "refused"; reason: string; message?: string };

/**
 * Confirm or decline the farmer's pending proposal — the SAME gate SMS lands on.
 *
 * Publication runs through `confirmInventoryPublication`, which re-reads authority and VIGA
 * approval while holding its locks. Nothing here writes a revision, and there is no argument
 * that skips the gate.
 *
 * The link is re-resolved first, so a revocation between proposing and confirming refuses the
 * publication. That ordering matters: the gate itself would also refuse (the authorization is
 * re-read inside it), but failing here means a revoked holder never even reaches a
 * transaction that names their farm.
 */
export async function confirmFromLink(
  deps: Pick<FarmerStandDeps, "db" | "clock"> & {
    activate: ProposalActivator;
  },
  input: {
    token: string;
    proposalId: string;
    accept: boolean;
    /** The snapshot the farmer was shown, recorded with the activation. */
    confirmationText: string;
  },
): Promise<FarmerStandConfirmation> {
  const stand = await resolveStandFromToken(deps.db, input.token);
  if (stand === null) return { status: "not_authorized" };

  const now = deps.clock.now();

  // The web proposal has no carrier prompt to be accepted, so the confirmation window is
  // opened here. Without it the gate reports `not_activated` forever and the web path could
  // publish nothing — correct for SMS, where a token may predate the prompt it answers, and
  // wrong for a farmer reading the snapshot in this same session. It opens the window and
  // NOTHING else: every other check the gate performs still runs under its own locks.
  await deps.activate({
    proposalId: input.proposalId,
    // Scoped to the token's own sender, so activation cannot touch a proposal belonging to
    // anyone else even if a caller supplies a stranger's proposal id.
    senderHash: stand.senderHash,
    confirmationText: input.confirmationText,
    at: now,
  });

  const result = await confirmInventoryPublication(deps.db, {
    proposalId: input.proposalId,
    // From the token's row. A holder cannot confirm somebody else's proposal by naming it:
    // the gate matches the proposal to this sender hash and finds nothing otherwise.
    senderHash: stand.senderHash,
    token: input.accept ? "yes" : "no",
    occurredAt: now,
    // The web has no provider event, so the consumption is keyed to the proposal itself.
    // Still unique per proposal, which is what the exactly-once constraint requires.
    providerEventId: `web-${input.proposalId}`,
    clock: deps.clock,
  });

  if (result.status === "published") {
    return {
      status: "published",
      ...(result.revisionId !== undefined ? { revisionId: result.revisionId } : {}),
      ...(result.closureRevisionId !== undefined
        ? { closureRevisionId: result.closureRevisionId }
        : {}),
    };
  }
  if (result.status === "declined") return { status: "declined" };
  if (result.status === "unsafe_public_text") {
    return {
      status: "refused",
      reason: result.status,
      message: renderPublicStringRefusal(result.prohibited),
    };
  }
  // Every other status is a refusal to commit — expired, base conflict, revoked authority,
  // withdrawn approval. The farmer is told rather than left believing they published.
  return { status: "refused", reason: result.status };
}

/**
 * Opens the confirmation window for a web proposal.
 *
 * A seam rather than a direct call, because activation on the SMS path is owned by the
 * outbound worker at provider acceptance, and this is the one place that fact differs. Making
 * it explicit keeps `confirmFromLink` honest about what it does instead of reaching for a
 * second activation writer.
 */
export type ProposalActivator = (input: {
  proposalId: string;
  senderHash: string;
  confirmationText: string;
  at: Date;
}) => Promise<void>;

/** The snapshot text a farmer confirms. Code-rendered, never model prose. */
export { renderProposedSnapshot };
