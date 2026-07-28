import type { z } from "zod";
import type { ModelSafeContext } from "./projections";

export * from "./projections";

/** Result of a validated model call. `ok=false` carries the reason a seam should clarify/flag. */
export type GenerateResult<T> =
  | { ok: true; value: T; repairCount: number }
  | { ok: false; reason: "invalid_output" | "provider_error"; repairCount: number };

/**
 * The model provider seam. `generateJson` accepts ONLY a `ModelSafeContext`, and the
 * adapter is deliberately given NO other capability — no database, repository, record
 * loader, provider-managed conversation, file, memory, or retrieval store. It cannot
 * acquire context beyond the projection it is handed (docs/AI_ARCHITECTURE.md).
 */
export interface LLMProvider {
  readonly name: string;
  /** Produce a raw JSON string for a seam given a projected context. Output is UNTRUSTED —
   *  the validate-and-repair wrapper below validates it before anything acts on it. */
  generateJson(ctx: ModelSafeContext, schemaName: string): Promise<string>;
}

/**
 * Validate-and-repair wrapper: parse the provider's output against `schema`; on failure, one
 * repair retry, then give up with `invalid_output` (clarify/flag — never a silent guess).
 * Model output is untrusted input; this is the only sanctioned way to turn it into a value.
 *
 * This is the package's public model-call entry point. The low-level `generateJson` is
 * reachable only through a `ModelSafeContext`, which only a projection can construct.
 */
export async function generateValidated<T>(
  provider: LLMProvider,
  ctx: ModelSafeContext,
  schemaName: string,
  schema: z.ZodType<T>,
): Promise<GenerateResult<T>> {
  for (let attempt = 0; attempt <= 1; attempt++) {
    let raw: string;
    try {
      raw = await provider.generateJson(ctx, schemaName);
    } catch {
      return { ok: false, reason: "provider_error", repairCount: attempt };
    }
    try {
      const parsed = schema.parse(JSON.parse(raw));
      return { ok: true, value: parsed, repairCount: attempt };
    } catch {
      // fall through to one repair retry
    }
  }
  return { ok: false, reason: "invalid_output", repairCount: 1 };
}

/** Deterministic stub provider for tests/evals. Returns a fixed response per seam. */
export class StubLLMProvider implements LLMProvider {
  readonly name = "stub";
  constructor(private readonly responses: Record<string, string> = {}) {}

  async generateJson(ctx: ModelSafeContext, _schemaName: string): Promise<string> {
    const canned = this.responses[ctx.seam];
    if (canned === undefined) {
      throw new Error(`StubLLMProvider has no canned response for seam "${ctx.seam}"`);
    }
    return canned;
  }
}

export * from "./deepinfra";
export * from "./inventory-seam";
export * from "./inquiry-seam";
export * from "./offering-seam";
export * from "./provider-gate";
