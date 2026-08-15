import {
  hashFarmerLinkToken,
  isFarmerLinkToken,
  renderPublicStringRefusal,
  renderProposedSnapshot,
  type Clock,
  type StructuredInventoryEdit,
} from "@farm-friend/core";
import {
  confirmInventoryPublication,
  readCurrentInventory,
  readNativeProviderId,
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
  // Bounded before any database work: anything outside the token shape is not a near-miss to
  // look up, and this keeps an absurd path segment from reaching the driver. The predicate is
  // core's, so the four doors that admit a link token cannot come to disagree about what one
  // looks like — and it accepts the 64-hex tokens minted before F-097 shortened them.
  if (!isFarmerLinkToken(token)) return null;
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

  // F-114 Phase B — the stand editor prefills the farmer's own listing, so the native slot.
  const providerId = await readNativeProviderId(db, { salesLocationId });
  const current = await readCurrentInventory(db, { salesLocationId, providerId });
  // Key ORDER is preserved deliberately. This value is serialized to JSON by the stand API's
  // post-publish refresh, and `JSON.stringify` emits keys in insertion order — so reordering
  // these would change bytes on the wire for a refactor that is required to change none.
  //
  // Spread conditionally rather than assigning `undefined`, for the reason the original did:
  // the editor distinguishes an absent field from a null one.
  return (current?.entries ?? []).map((entry) => ({
    entryId: entry.entryId,
    itemName: entry.itemName,
    ...(entry.quantity !== null ? { quantity: entry.quantity } : {}),
    ...(entry.unit !== null ? { unit: entry.unit } : {}),
    ...(entry.priceText !== null ? { priceText: entry.priceText } : {}),
    ...(entry.approximation !== null ? { approximation: entry.approximation } : {}),
  }));
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

/**
 * Save a returning farmer's stock in ONE action, from the direct structured editor (F-097).
 *
 * **What changed, and what deliberately did not** (max, 2026-08-08). The web editor used to
 * propose, render the snapshot back, and wait for a second press before publishing. That gate
 * is the right shape for SMS, where the farmer typed prose and code had to show its
 * interpretation before acting on it. On this surface there is nothing to interpret: the
 * farmer is looking at the exact rows they typed, so the preview restated the screen they were
 * already on and turned one errand into two.
 *
 * **The confirmation TRANSACTION is untouched.** This composes the two existing steps rather
 * than reaching around them — `confirmInventoryPublication` still re-reads live farmer
 * authority, live VIGA approval, and stand retirement under its own locks, still consumes the
 * proposal exactly once, and still refuses on a base-revision conflict. Golden Rule #1 and #3
 * hold by construction: nothing here writes a revision, and there is no argument that skips
 * the gate. What was removed is a SCREEN, not a check.
 *
 * The proposal row still exists for the instant between the two calls, which is what keeps
 * the audit trail — and the "what was the farmer shown" record — identical to the SMS path.
 */
export async function publishStructuredFromLink(
  deps: Pick<FarmerStandDeps, "db" | "clock"> & { activate: ProposalActivator },
  input: {
    token: string;
    edit: StructuredInventoryEdit;
  },
): Promise<FarmerStandConfirmation | { status: "refused"; reason: string; message?: string }> {
  const proposed = await proposeStructuredFromLink(deps, input);
  if (proposed.outcome === "not_authorized") return { status: "not_authorized" };
  if (proposed.outcome === "clarification") {
    // The structured editor cannot produce an ambiguous edit — it names entry ids — so this
    // is unreachable by the UI and is surfaced rather than swallowed. A silent success here
    // would be the surface claiming a publication that never happened.
    return { status: "refused", reason: "clarification", message: proposed.question };
  }
  if (proposed.outcome === "rejected") {
    return { status: "refused", reason: proposed.reason };
  }

  return confirmFromLink(deps, {
    token: input.token,
    proposalId: proposed.proposalId,
    accept: true,
    // The snapshot code rendered, recorded with the activation exactly as the two-step path
    // recorded it. It is no longer shown BEFORE the save, but it is still what was published
    // and still what the audit record says the farmer's action produced.
    confirmationText: proposed.confirmationText,
  });
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
