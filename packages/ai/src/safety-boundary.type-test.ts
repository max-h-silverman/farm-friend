// Static provenance barrier proof (Golden Rule #6, barrier 1). This file is type-checked by
// `tsc -b`, never run. Each `@ts-expect-error` asserts that a BYPASS is a COMPILE ERROR — if a
// bypass ever type-checks, the `@ts-expect-error` becomes unused and `tsc` fails.
//
// WHAT THIS PROVES: provenance only. Every value reaching the low-level provider came from a
// task-specific projection in this package. It does NOT prove that a runtime string is clean —
// `tsc` cannot inspect content. Content is the runtime enforcement's job (projections.ts) and
// the verification suite's evidence (evals/hostile.ts).

import * as ai from "./index";
import {
  projectInventoryExtraction,
  type ModelSafeContext,
  type InventoryExtractionFields,
} from "./index";

// OK: a context produced by a task-specific projection is accepted by the seam it belongs to.
const safe: ModelSafeContext<InventoryExtractionFields> = projectInventoryExtraction({
  taskText: "kale and eggs",
  currentEntries: [{ entryId: "e1", itemName: "kale" }],
});
void safe;

// BYPASS 1 — the low-level provider call is INTERNAL to packages/ai. Ordinary callers in
// core, db, sms, apps/web, or evals cannot reach it at all: there is no exported name to call.
// This is the F-015 narrowing — a branded argument alone still let any caller invoke the
// provider with a context of its own choosing.
// @ts-expect-error the low-level provider call is not exported from @farm-friend/ai
void ai.generateJson;
// @ts-expect-error the low-level provider interface is not an exported callable surface
void ai.callProvider;

// BYPASS 2 — there is no public generic assembler taking an arbitrary object. A seam's input
// is constructible only through its own named projection, so a caller cannot widen the model's
// view by inventing a seam name and passing whatever record it holds.
// @ts-expect-error the generic arbitrary-object assembler no longer exists
void ai.assembleContext;
// @ts-expect-error the generic SMS assembler no longer exists either
void ai.assembleSmsContext;

// BYPASS 3 — you cannot hand-forge the brand: the brand symbol is not exported, so an object
// literal can never satisfy ModelSafeContext without going through a projection.
// @ts-expect-error the branded type is not constructible outside a projection
const forged: ModelSafeContext = { seam: "inventory-extraction", fields: {} };
void forged;

// BYPASS 4 — a projection accepts only its seam's declared fields. Handing it an extra field
// is a compile error, so an over-broad record cannot be laundered into a safe context.
void projectInventoryExtraction({
  taskText: "kale",
  currentEntries: [],
  // @ts-expect-error a projection accepts no fields beyond its seam's declared input
  internalNote: "farmer owes VIGA dues",
});

// BYPASS 5 — retrieved facts carry only opaque identifiers and public names. A caller cannot
// attach consent, contact, or audit data to an entry it passes in.
void projectInventoryExtraction({
  taskText: "kale",
  currentEntries: [
    // @ts-expect-error retrieved entries carry only an opaque id and a public item name
    { entryId: "e1", itemName: "kale", consentState: "subscribed" },
  ],
});
