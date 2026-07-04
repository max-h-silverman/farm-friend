// Compile-guard proof (Golden Rule #6, layer 1). This file is type-checked by `tsc -b`, never
// run. Each `@ts-expect-error` asserts that a BYPASS of the assembler/redactor is a COMPILE
// ERROR — if a bypass ever type-checks, the `@ts-expect-error` becomes unused and `tsc` fails.
// This is how "a model call can't be made with un-stripped context" is a tested invariant.

import { assembleContext, StubLLMProvider, type ModelSafeContext } from "./index";

const provider = new StubLLMProvider({ seam: "{}" });

// OK: a context produced by the assembler is a ModelSafeContext and is accepted.
const safe: ModelSafeContext = assembleContext("seam", { rows: [] });
void provider.generateJson(safe, "schema");

// BYPASS 1 — a raw object is NOT a ModelSafeContext; passing it must not type-check.
// @ts-expect-error un-stripped raw context cannot reach generateJson (compile guard)
void provider.generateJson({ seam: "seam", fields: {} }, "schema");

// BYPASS 2 — a plain string is not a ModelSafeContext either.
// @ts-expect-error a raw value cannot be passed as a model-safe context
void provider.generateJson("just a string", "schema");

// BYPASS 3 — you cannot hand-forge the brand: the brand symbol is not exported, so an object
// literal can never satisfy ModelSafeContext without going through assembleContext.
// @ts-expect-error the branded type is not constructible outside the assembler
const forged: ModelSafeContext = { seam: "seam", fields: {} };
void forged;
