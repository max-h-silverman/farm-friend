// Context-assembly boundary — layer 1 (compile) + layer 2 (runtime) of the code-enforced
// safety boundary for model calls. See docs/AI_ARCHITECTURE.md §safety boundary.
//
// Layer 1 (compile / provenance): `ModelSafeContext` is branded; its ONLY public constructors
// are the assemblers in this module. `LLMProvider.generateJson` accepts only a
// `ModelSafeContext`, so a raw record cannot reach the model by accident — there is no value of
// the right type to pass. The brand proves provenance (it came from an assembler), NOT that its
// content is clean.
//
// Layer 2 (runtime / content): `assembleContext` actually STRIPS phone numbers / secrets and
// passes only the minimal grounded fields a seam needs (data minimization). This is what proves
// the content is clean — tested directly (assembler-strips-pii).

declare const modelSafeBrand: unique symbol;

/** A context object that has passed a stripping assembler in this module. Branded so
 *  `generateJson` cannot be called with a raw record. */
export type ModelSafeContext<T = unknown> = {
  readonly seam: string;
  readonly fields: T;
  readonly outputInstructions?: string;
} & { readonly [modelSafeBrand]: true };

export const COORDINATOR_SMS_OUTPUT_INSTRUCTIONS =
  "Write a concise SMS reply. Prefer one GSM-7 segment (160 septets) when practical. " +
  "Use plain ASCII punctuation and no emoji unless the content intentionally requires one. " +
  "Preserve important details and user-provided names, addresses, and meaning; never truncate " +
  "useful information solely to meet the one-segment preference.";

export class ContextAssemblyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextAssemblyError";
  }
}

const RAW_PHONE_RE =
  /(?:\+?1[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)\d{3}[\s.-]?\d{4}/;

// Keys that must never appear in a model context, whatever their value.
const FORBIDDEN_KEY_RE = /phone(?!_hash)|secret|token|password|ssn|api[_-]?key/i;

function scrub(value: unknown, keyPath: string): void {
  if (typeof value === "string") {
    if (RAW_PHONE_RE.test(value)) {
      throw new ContextAssemblyError(
        `Refusing to assemble: raw phone number in context field "${keyPath}".`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => scrub(v, `${keyPath}[${i}]`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEY_RE.test(k)) {
        throw new ContextAssemblyError(
          `Refusing to assemble: forbidden key "${keyPath}.${k}" in context.`,
        );
      }
      scrub(v, keyPath ? `${keyPath}.${k}` : k);
    }
  }
}

/**
 * The stripping assembler. Runtime-scans `fields` for raw phone numbers and forbidden keys;
 * throws if any are present, otherwise stamps the brand. This is the ONLY way to produce a
 * `ModelSafeContext`, so `generateJson` cannot be reached with an unstripped record.
 */
export function assembleContext<T>(seam: string, fields: T): ModelSafeContext<T> {
  scrub(fields, "");
  return { seam, fields } as ModelSafeContext<T>;
}

/** Assemble model-safe context for an SMS composition call, including cost-aware style guidance. */
export function assembleSmsContext<T>(seam: string, fields: T): ModelSafeContext<T> {
  scrub(fields, "");
  return {
    seam,
    fields,
    outputInstructions: COORDINATOR_SMS_OUTPUT_INSTRUCTIONS,
  } as ModelSafeContext<T>;
}
