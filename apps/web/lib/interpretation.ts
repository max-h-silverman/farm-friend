import { randomUUID } from "node:crypto";
import {
  applyInventoryEdits,
  projectClosure,
  renderProposedFarmerUpdate,
  validateInterpretation,
  validateStructuredInventoryEdit,
  vashonLocalDate,
  type ClosureInstruction,
  type Clock,
  type InventoryCompositionBase,
  type InventoryInterpreter,
  type ProposedSnapshot,
  type SnapshotEntry,
  type StructuredInventoryEdit,
} from "@farm-friend/core";
import { openOrReviseProposal, type Db } from "@farm-friend/db";

// Farmer inventory text → the one pending proposal.
//
// The model interprets; CODE decides the consequence. The interpreter receives only the
// farmer's own current text plus opaque entry identifiers — the `inventory-extraction`
// projection in `packages/ai` is what constructs that, and it is the only context that
// crosses the seam. Output is validated against the retrieved snapshot before anything acts
// on it, and the resulting pending payload is the complete snapshot bound to the published
// revision the proposal started from.
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

/**
 * What to compose a proposal FROM: the farmer's words, or an edit they built directly.
 *
 * The web form expresses edits structurally — turning an item off already *is*
 * `removals: [{entryId}]`. Rendering that into a sentence for the model to parse back into
 * the shape it started as would add a lossy step and make the model a dependency of an edit
 * that needs no interpreting. So a structured edit skips the MODEL.
 *
 * It skips nothing else. Both forms meet code-owned validation against the same retrieved
 * snapshot, compose the same proposal, and reach the same confirmation gate.
 */
type InterpretationTarget = {
  senderHash: string;
  salesLocationId: string;
};

export type TextInterpretationInput = InterpretationTarget & {
  /** The farmer's own message text, for the model to interpret. */
  taskText: string;
  edit?: undefined;
};

export type StructuredInterpretationInput = InterpretationTarget & {
  /** A model-free edit the farmer built directly in the web editor. */
  edit: StructuredInventoryEdit;
  taskText?: undefined;
};

export type InterpretationInput = TextInterpretationInput | StructuredInterpretationInput;

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

function pendingEntries(payload: unknown): SnapshotEntry[] {
  if (typeof payload !== "object" || payload === null) {
    throw new Error("pending inventory payload must be an object");
  }
  const entries = (payload as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) {
    throw new Error("pending inventory payload must contain entries");
  }
  return entries as SnapshotEntry[];
}

function pendingClosure(payload: unknown): ClosureInstruction | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  return (payload as { closure?: ClosureInstruction }).closure;
}

interface CompositionState {
  locationName: string;
  inventoryBase: InventoryCompositionBase;
  closureBase: ClosureInstruction | null;
  pendingInventory?: ProposedSnapshot;
  pendingClosure?: ClosureInstruction;
  closureBaseRevisionId: string | null;
  closureBaseIsFirstInstruction: boolean;
}

/**
 * Read the sender's complete pending result when one exists for this location. Only when
 * none exists does a new proposal start from the current published snapshot.
 */
async function compositionState(
  db: Db,
  senderHash: string,
  salesLocationId: string,
): Promise<CompositionState> {
  const locations = await db.sql`
    select name from sales_locations where id = ${salesLocationId}
  `;
  const locationName = locations[0]?.name as string | undefined;
  if (locationName === undefined) throw new Error("sales location does not exist");

  const pending = await db.sql`
    select payload, has_inventory, has_closure,
      base_revision_id, base_is_first_publication,
      closure_base_revision_id, closure_base_is_first_instruction
    from inventory_publication_proposals
    where sender_hash = ${senderHash}
      and sales_location_id = ${salesLocationId}
      and state = 'open'
  `;
  const pendingRow = pending[0] as Record<string, unknown> | undefined;

  const revisions = await db.sql`
    select id from inventory_revisions
    where sales_location_id = ${salesLocationId} and is_current
  `;
  const revisionId = revisions[0]?.id as string | undefined;

  const entries = revisionId
    ? await db.sql`
        select id, item_name, quantity, unit, price_text, approximation
        from inventory_entries
        where inventory_revision_id = ${revisionId}
        order by sort_order asc
      `
    : [];

  const publishedInventory: InventoryCompositionBase = revisionId
    ? {
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
      }
    : null;

  const closures = await db.sql`
    select id, result, closure_kind, starts_on::text, closed_through::text
    from closure_revisions
    where sales_location_id = ${salesLocationId} and is_current
  `;
  const closureRow = closures[0] as Record<string, unknown> | undefined;
  const currentClosure: ClosureInstruction | null = !closureRow
    ? null
    : closureRow.result === "reopen"
      ? { result: "reopen" }
      : {
          result: "close",
          closureKind: closureRow.closure_kind as "temporary" | "seasonal",
          startsOn: closureRow.starts_on as string,
          ...(closureRow.closed_through !== null
            ? { closedThrough: closureRow.closed_through as string }
            : {}),
        };

  const pendingInventory =
    pendingRow?.has_inventory === true
      ? {
          entries: pendingEntries(pendingRow.payload),
          baseRevisionId:
            (pendingRow.base_revision_id as string | null | undefined) ?? null,
          isFirstPublication: pendingRow.base_is_first_publication as boolean,
          // Reloaded as the BASE for the sender's next edit, not as a proposal being
          // confirmed. Whatever this snapshot once dropped is already absent from its
          // entries; the next edit names its own losses against this base.
          removedItemNames: [],
        }
      : undefined;
  const composedClosure =
    pendingRow?.has_closure === true ? pendingClosure(pendingRow.payload) : undefined;

  return {
    locationName,
    inventoryBase: pendingInventory ?? publishedInventory,
    closureBase: composedClosure ?? currentClosure,
    ...(pendingInventory !== undefined ? { pendingInventory } : {}),
    ...(composedClosure !== undefined ? { pendingClosure: composedClosure } : {}),
    closureBaseRevisionId:
      pendingRow?.has_closure === true
        ? ((pendingRow.closure_base_revision_id as string | null | undefined) ?? null)
        : ((closureRow?.id as string | undefined) ?? null),
    closureBaseIsFirstInstruction:
      pendingRow?.has_closure === true
        ? (pendingRow.closure_base_is_first_instruction as boolean)
        : closureRow === undefined,
  };
}

/**
 * Interpret the farmer's inventory text and open or revise their one pending proposal.
 * A clarification outcome queues a question and creates no proposal; an interpretation
 * naming an entry outside the current snapshot is rejected without consequence.
 */
export function applyInterpretedInventory(
  deps: InterpretationDeps,
  input: TextInterpretationInput,
): Promise<InterpretationOutcome>;
export function applyInterpretedInventory(
  deps: Pick<InterpretationDeps, "db" | "clock"> & { interpreter?: InventoryInterpreter },
  input: StructuredInterpretationInput,
): Promise<InterpretationOutcome>;
export async function applyInterpretedInventory(
  deps: Pick<InterpretationDeps, "db" | "clock"> & { interpreter?: InventoryInterpreter },
  input: InterpretationInput,
): Promise<InterpretationOutcome> {
  const state = await compositionState(
    deps.db,
    input.senderHash,
    input.salesLocationId,
  );

  // A structured edit is already in the interpreter's output shape, so there is nothing to
  // interpret — the model is not called at all. It is still validated below, by the same
  // code and against the same snapshot: skipping the model never skips the checks.
  // The union guarantees exactly one of these is present. Asserted rather than defaulted:
  // an empty task text is a real input the model would try to interpret, so coercing a
  // missing one into `""` would turn a caller bug into a silent model call.
  if (input.edit === undefined && input.taskText === undefined) {
    throw new Error("an interpretation needs either taskText or a structured edit");
  }

  const raw = input.edit !== undefined
    ? input.edit
    : deps.interpreter === undefined
      ? (() => {
          throw new Error("text interpretation requires an interpreter");
        })()
      : // Only the current task text and opaque identifiers cross the seam.
        await deps.interpreter.interpret({
          taskText: input.taskText as string,
          currentEntries: (state.inventoryBase?.entries ?? []).map((entry) => ({
            entryId: entry.entryId,
            itemName: entry.itemName,
          })),
          currentClosure: state.closureBase,
          currentLocalDate: vashonLocalDate(deps.clock.now()),
        });

  const validated = input.edit !== undefined
    ? validateStructuredInventoryEdit(raw, state.inventoryBase)
    // The farmer's own words travel with the output so code can check that a removal names
    // an item they actually mentioned. `input.taskText` is defined on this branch — the
    // structured-edit branch above is the only one without one.
    : validateInterpretation(raw, state.inventoryBase, input.taskText);
  if (!validated.ok) {
    return { outcome: "rejected", reason: validated.reason };
  }

  if (validated.value.kind === "clarification") {
    return { outcome: "clarification", question: validated.value.question };
  }

  const inventoryChange =
    validated.value.kind === "edits" || validated.value.kind === "clear_all"
      ? validated.value
      : undefined;
  const closureChange = "closure" in validated.value ? validated.value.closure : undefined;

  const proposedInventory = inventoryChange
    ? applyInventoryEdits(
        state.inventoryBase,
        inventoryChange,
        () => `draft_${randomUUID()}`,
      )
    : state.pendingInventory;
  const proposedClosure = closureChange ?? state.pendingClosure;

  // A future close cannot silently replace one that is active now. The farmer must first
  // reopen or clarify which window they intend; Phase 1 stores one current/upcoming window.
  if (
    closureChange?.result === "close" &&
    projectClosure(closureChange, deps.clock.now()).state === "upcoming" &&
    projectClosure(state.closureBase, deps.clock.now()).state === "active"
  ) {
    return {
      outcome: "clarification",
      question:
        "Your stand is already closed. Reopen it first, or tell me which closure should apply.",
    };
  }

  if (proposedInventory === undefined && proposedClosure === undefined) {
    return { outcome: "rejected", reason: "update contains no inventory or closure" };
  }
  const opened = await openOrReviseProposal(deps.db, {
    senderHash: input.senderHash,
    salesLocationId: input.salesLocationId,
    ...(proposedInventory !== undefined
      ? {
          entries: proposedInventory.entries.map((entry) => ({
            entryId: entry.entryId,
            itemName: entry.itemName,
            quantity: entry.quantity,
            unit: entry.unit,
            priceText: entry.priceText,
            approximation: entry.approximation,
          })),
          baseRevisionId: proposedInventory.baseRevisionId,
          baseIsFirstPublication: proposedInventory.isFirstPublication,
        }
      : {}),
    ...(proposedClosure !== undefined
      ? {
          closure: proposedClosure,
          closureBaseRevisionId: state.closureBaseRevisionId,
          closureBaseIsFirstInstruction: state.closureBaseIsFirstInstruction,
        }
      : {}),
    now: deps.clock.now(),
  });

  return {
    outcome: "proposed",
    proposalId: opened.proposalId,
    proposalVersion: opened.proposalVersion,
    confirmationText: renderProposedFarmerUpdate({
      locationName: state.locationName,
      ...(proposedInventory !== undefined ? { inventory: proposedInventory } : {}),
      ...(proposedClosure !== undefined ? { closure: proposedClosure } : {}),
      at: deps.clock.now(),
    }),
  };
}
