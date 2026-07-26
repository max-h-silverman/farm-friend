import {
  applyInventoryEdits,
  renderProposedSnapshot,
  validateInterpretation,
  type Clock,
  type InventoryInterpreter,
  type PublishedSnapshot,
} from "@farm-friend/core";
import { openOrReviseProposal, type Db } from "@farm-friend/db";

// Farmer inventory text → the one pending proposal.
//
// The model interprets; CODE decides the consequence. The interpreter receives only the
// farmer's own current text plus opaque entry identifiers — the `inventory-extraction`
// projection in `packages/ai` is what constructs that, and it is the only context that
// crosses the seam. Output is validated against the retrieved snapshot before anything acts
// on it, and the resulting pending payload is the complete snapshot bound to the base
// revision it was computed from.
//
// Validation runs HERE even though the seam's schema already checked shape: that schema
// cannot see the snapshot, so membership of every selected entry ID is this layer's job.
// A hostile model is contained by this pair, not by either alone.
//
// The interpreter call happens outside every database transaction.

export interface InterpretationDeps {
  db: Db;
  interpreter: InventoryInterpreter;
  clock: Clock;
}

export interface InterpretationInput {
  senderHash: string;
  salesLocationId: string;
  /** The farmer's own message text. */
  taskText: string;
}

export type InterpretationOutcome =
  | {
      outcome: "proposed";
      proposalId: string;
      proposalVersion: number;
      /** The complete resulting snapshot the farmer will confirm. */
      confirmationText: string;
    }
  | { outcome: "clarification"; question: string }
  | { outcome: "rejected"; reason: string };

/** Read the location's current published snapshot with its stable entry identifiers. */
async function currentSnapshot(
  db: Db,
  salesLocationId: string,
): Promise<PublishedSnapshot | null> {
  const revisions = await db.sql`
    select id from inventory_revisions
    where sales_location_id = ${salesLocationId} and is_current
  `;
  const revisionId = revisions[0]?.id as string | undefined;
  if (!revisionId) return null;

  const entries = await db.sql`
    select id, item_name, quantity, unit, price_text, approximation
    from inventory_entries
    where inventory_revision_id = ${revisionId}
    order by sort_order asc
  `;

  return {
    revisionId,
    entries: entries.map((row) => {
      const record = row as Record<string, unknown>;
      return {
        entryId: record.id as string,
        itemName: record.item_name as string,
        ...(record.quantity !== null ? { quantity: record.quantity as number } : {}),
        ...(record.unit !== null ? { unit: record.unit as string } : {}),
        ...(record.price_text !== null
          ? { priceText: record.price_text as string }
          : {}),
        ...(record.approximation !== null
          ? {
              approximation: record.approximation as
                | "some"
                | "limited"
                | "plentiful",
            }
          : {}),
      };
    }),
  };
}

/**
 * Interpret the farmer's inventory text and open or revise their one pending proposal.
 * A clarification outcome queues a question and creates no proposal; an interpretation
 * naming an entry outside the current snapshot is rejected without consequence.
 */
export async function applyInterpretedInventory(
  deps: InterpretationDeps,
  input: InterpretationInput,
): Promise<InterpretationOutcome> {
  const base = await currentSnapshot(deps.db, input.salesLocationId);

  // Only the current task text and opaque identifiers cross the seam.
  const raw = await deps.interpreter.interpret({
    taskText: input.taskText,
    currentEntries: (base?.entries ?? []).map((entry) => ({
      entryId: entry.entryId,
      itemName: entry.itemName,
    })),
  });

  const validated = validateInterpretation(raw, base);
  if (!validated.ok) {
    return { outcome: "rejected", reason: validated.reason };
  }

  if (validated.value.kind === "clarification") {
    return { outcome: "clarification", question: validated.value.question };
  }

  const proposed = applyInventoryEdits(base, validated.value);
  const opened = await openOrReviseProposal(deps.db, {
    senderHash: input.senderHash,
    salesLocationId: input.salesLocationId,
    entries: proposed.entries.map((entry) => ({
      itemName: entry.itemName,
      quantity: entry.quantity,
      unit: entry.unit,
      priceText: entry.priceText,
      approximation: entry.approximation,
    })),
    now: deps.clock.now(),
    baseRevisionId: proposed.baseRevisionId,
    baseIsFirstPublication: proposed.isFirstPublication,
  });

  return {
    outcome: "proposed",
    proposalId: opened.proposalId,
    proposalVersion: opened.proposalVersion,
    confirmationText: renderProposedSnapshot(proposed),
  };
}
