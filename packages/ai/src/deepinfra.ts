// The DeepInfra provider adapter (F-024).
//
// DeepInfra hosts open-weight instruct models behind an OpenAI-compatible chat-completions
// API. Farm Friend uses it as an inference HOST: the attested data-handling terms that gate
// this adapter are DeepInfra's, not the model author's, because DeepInfra is who receives,
// serves, and may log or retain the request.
//
// WHAT THIS ADAPTER IS NOT GIVEN. It holds an API key and an HTTP client. It has no database,
// repository, record loader, clock, or provider-managed conversation/file/memory/retrieval
// store, and it cannot obtain one — `generateJson` accepts a `ModelSafeContext` and nothing
// else, so the only text it can send is what a projection already narrowed
// (docs/AI_ARCHITECTURE.md §"The model provider seam"). Swapping the stub for this must not
// change a single authority property; the harness, not the brain, owns every consequence.
//
// CALLS ARE STATELESS BY CONSTRUCTION. Every request sends exactly the projected context. No
// conversation id, no thread, no prior turn, no server-side session — so there is nothing for
// the provider to accumulate across calls even if its API offered it.

import type { LLMProvider } from "./index";
import type { ModelSafeContext } from "./projections";
import {
  assertProviderApproved,
  ProviderGateError,
  type ProviderDataHandling,
} from "./provider-gate";

/**
 * DeepInfra's attested data handling (F-024). Reviewed and directed by max, 2026-07-28.
 *
 * Lives beside the adapter it gates, so EVERY consumer — the web composition root, seed
 * scripts, live evals — approves the same declaration through
 * `assertDeepInfraSelectionApproved` below rather than each carrying its own copy.
 *
 * The attested terms are **DeepInfra's, as the inference host** — the model author's licence
 * is not the relevant contract, because DeepInfra is who receives, serves, and may log or
 * retain the request. Sources reviewed:
 *
 *   - https://docs.deepinfra.com/account/data-privacy (the operative inference terms)
 *   - https://deepinfra.com/privacy (the general privacy policy, which defers to the above)
 *
 * What the terms state, verbatim, per field:
 *
 *   trainsOnData: false — "We do not use data you submit to our APIs for training models,
 *     except when using Google or Anthropic models, where the receiving company's training
 *     policy applies." The exception is a model ROUTED to a third-party vendor's endpoints;
 *     `assertDeepInfraSelectionApproved` refuses those model namespaces, so the attested
 *     value holds for every configuration the gate can admit.
 *
 *   statefulStorage: false — "Input data is not stored to disk during inference — it exists
 *     only in memory while the request is being processed"; "Output data is not stored — it
 *     is sent to you and then deleted from memory." No provider-managed conversation, file,
 *     memory, or retrieval store exists, and the adapter sends no session identifier for one
 *     to accumulate under. (The terms' stated storage exceptions — image-generation outputs
 *     and bulk/async inference — are API surfaces Farm Friend does not call.)
 *
 *   requestLoggingDisabled: true — "We generally do not log the content of your requests. We
 *     log metadata useful for debugging: request ID, cost, sampling parameters." Content
 *     logging is off as the provider's default, with no toggle to mis-set; the logged
 *     metadata carries no farmer or customer text.
 *
 *   retentionDays: 0 — the stated design is zero retention for real-time inference: inputs
 *     exist only in memory during processing and outputs are deleted once returned (quoted
 *     above). The terms state no other number.
 *
 * KNOWN CAVEAT, recorded so the attestation does not overclaim: DeepInfra "reserve[s] the
 * right to log a small portion of requests when necessary for debugging or security
 * purposes", with no stated bound. That is a discretionary exception to the zero-retention
 * default, not a stated retention window — inventing a number for it would itself be the
 * inference this gate forbids. It was reviewed and accepted as compatible with Farm Friend's
 * own short-lived raw-context posture.
 *
 * These fields are an ATTESTATION, not a setting: they record that a human read the
 * contract; they do not make the vendor behave. If DeepInfra's terms change, re-read them
 * and move this block, its citation date, and the pinned test together.
 */
export const DEEPINFRA_ATTESTED_DATA_HANDLING: ProviderDataHandling = {
  trainsOnData: false,
  statefulStorage: false,
  requestLoggingDisabled: true,
  retentionDays: 0,
};

/**
 * Model namespaces DeepInfra serves by ROUTING to the named third-party vendor's endpoints.
 * The attestation above is conditional on not using them — DeepInfra's terms transfer data
 * to the receiving vendor, whose training and retention policies then apply and were never
 * attested. Conservative by prefix: this also refuses vendor-authored open-weight models
 * DeepInfra self-hosts (e.g. `google/gemma-*`), which is deliberate fail-closed reading of
 * ambiguous contract language ("Google or Anthropic models") — selecting one is a re-read
 * of the terms, not a config change.
 */
export const DEEPINFRA_THIRD_PARTY_ROUTED_MODEL_PREFIXES = ["anthropic/", "google/"];

/**
 * Approve a DeepInfra selection through the privacy gate, or throw.
 *
 * The one sanctioned pre-flight for ANY code that constructs this adapter. Checks the
 * attested declaration against the gate's requirements and refuses a model the attestation
 * does not cover, so no consumer can quietly route farmer or customer text to a vendor
 * whose terms nobody read.
 */
export function assertDeepInfraSelectionApproved(model: string): void {
  const routed = DEEPINFRA_THIRD_PARTY_ROUTED_MODEL_PREFIXES.find((prefix) =>
    model.trim().toLowerCase().startsWith(prefix),
  );
  if (routed !== undefined) {
    throw new ProviderGateError(
      `DEEPINFRA_MODEL="${model}" is routed to a third-party vendor ("${routed}" ` +
        "namespace): DeepInfra's attested no-training terms exclude Google and Anthropic " +
        "models, whose own data-handling policies apply and were never attested. " +
        "Choose a DeepInfra-hosted open-weight model, or re-read and re-attest the terms.",
    );
  }
  assertProviderApproved("deepinfra", DEEPINFRA_ATTESTED_DATA_HANDLING);
}

/** How long a single model call may take before it is abandoned. */
const REQUEST_TIMEOUT_MS = 20_000;

export interface DeepInfraConfig {
  apiKey: string;
  /** The served model, e.g. a mid-size instruct model. Chosen by config, not hard-coded. */
  model: string;
  /** Overridable for tests; defaults to DeepInfra's OpenAI-compatible endpoint. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/**
 * The system instruction.
 *
 * DEFENCE IN DEPTH ONLY, NEVER ENFORCEMENT (CLAUDE.md Golden Rule #6). Every safety property
 * that must not fail — privacy, consent, commitment, grounding — is enforced by code the model
 * cannot reach around: projections narrow the input before the call, Zod validation rejects
 * malformed output after it, and code renders every consequential and cross-actor message. If
 * this string were deleted entirely, no authority property would change; the evals would still
 * have to pass. It is here to improve QUALITY, which is the only thing the brain is trusted for.
 */
const SYSTEM_INSTRUCTION =
  "You extract structured data and return ONLY a single JSON object matching the requested " +
  "schema. No prose, no markdown fences, no explanation. If the input does not support a " +
  "field, omit it rather than inventing a value.";

/**
 * Build the user message from a projected context.
 *
 * The context's `fields` are serialized as JSON rather than interpolated into a sentence:
 * a projection's values are untrusted SENDER text, and pasting them into a prose template is
 * how an injection gains the appearance of an instruction. JSON keeps them visibly data.
 */
function renderPrompt(ctx: ModelSafeContext): string {
  const parts = [
    `Task: ${ctx.seam}`,
    `Input (JSON): ${JSON.stringify(ctx.fields)}`,
  ];
  parts.push(`Output requirements: ${ctx.outputInstructions}`);
  parts.push("Respond with a single JSON object and nothing else.");
  return parts.join("\n\n");
}

/**
 * Strip a markdown code fence if the model wrapped its JSON in one.
 *
 * Not leniency about correctness — `generateValidated` still parses and schema-validates the
 * result, and still refuses anything malformed. This only removes a formatting habit that is
 * near-universal in instruct models and would otherwise spend the single repair retry on a
 * problem that is not a content problem.
 */
function stripCodeFence(text: string): string {
  const fenced = /^\s*```(?:json)?\s*\n([\s\S]*?)\n?\s*```\s*$/.exec(text);
  return fenced ? fenced[1]!.trim() : text.trim();
}

export function createDeepInfraProvider(config: DeepInfraConfig): LLMProvider {
  const baseUrl = config.baseUrl ?? "https://api.deepinfra.com/v1/openai";
  const doFetch = config.fetchImpl ?? fetch;

  return {
    async generateJson(ctx: ModelSafeContext): Promise<string> {
      // Bounded so a hung provider cannot hold an SMS worker open indefinitely. The pass
      // that called this is itself budgeted; cron recovers whatever a timeout drops.
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(), REQUEST_TIMEOUT_MS);

      try {
        const response = await doFetch(`${baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.apiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            model: config.model,
            // Deterministic decoding: the same projected context should produce the same
            // extraction. Evals are only meaningful against a stable decode.
            temperature: 0,
            // Ask for JSON at the API level where supported; validation never relies on it.
            response_format: { type: "json_object" },
            messages: [
              { role: "system", content: SYSTEM_INSTRUCTION },
              { role: "user", content: renderPrompt(ctx) },
            ],
          }),
          signal: abort.signal,
        });

        if (!response.ok) {
          // The body may echo the prompt, which carries sender text, so it is NOT included
          // in the error. `generateValidated` turns any throw into `provider_error`, and the
          // seam clarifies or flags rather than guessing.
          throw new Error(`deepinfra responded ${response.status}`);
        }

        const payload = (await response.json()) as {
          choices?: { message?: { content?: unknown } }[];
        };
        const content = payload.choices?.[0]?.message?.content;
        if (typeof content !== "string") {
          throw new Error("deepinfra returned no message content");
        }

        return stripCodeFence(content);
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
