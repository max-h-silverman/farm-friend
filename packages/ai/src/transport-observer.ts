import type { LLMProvider } from "./index";
import type { ModelSafeContext } from "./projections";

/**
 * Observe whether a fixture's model calls reached the provider at all (B-089).
 *
 * WHY THIS LIVES AT THE PROVIDER. Every seam deliberately erases the difference between
 * `provider_error` and `invalid_output` before returning — `request-classification.ts` says so
 * explicitly, and it is right to: a sender who could not be understood is owed the same honest
 * reply either way. But an OPERATOR reading an eval run needs exactly the distinction the seam
 * threw away. The provider is the last place the truth still exists, so that is where it is
 * read, by wrapping rather than by loosening any seam's contract.
 *
 * WHAT COUNTS AS TRANSPORT FAILURE. A throw out of `generateJson`, and only that. The DeepInfra
 * adapter throws on a non-2xx status, a missing message body, and an abort — the provider did not
 * answer. Well-formed output that a schema rejects is the model being wrong, and it stays a
 * quality failure.
 *
 * This wrapper adds NO capability: it forwards the same `ModelSafeContext` to the same provider
 * and returns its string unchanged. It cannot widen what any seam is shown.
 */
export interface TransportMark {
  /** True if any model call since this mark began failed to reach the provider. */
  transportFailed: () => boolean;
}

export interface TransportObserver {
  /** The provider to hand to the seams in place of the real one. */
  provider: LLMProvider;
  /** Open a new observation window — one per fixture. */
  begin: () => TransportMark;
}

export function createTransportObserver(inner: LLMProvider): TransportObserver {
  let failures = 0;

  return {
    provider: {
      async generateJson(ctx: ModelSafeContext): Promise<string> {
        try {
          return await inner.generateJson(ctx);
        } catch (error) {
          failures += 1;
          throw error;
        }
      },
    },
    begin(): TransportMark {
      const failuresAtStart = failures;
      return { transportFailed: () => failures > failuresAtStart };
    },
  };
}
