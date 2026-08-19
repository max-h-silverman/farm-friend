// The first-pass request classifier: one model call, one enum out, above everything that
// currently classifies an inbound message.
//
// WHY THIS REPLACES TWO SEAMS. `farmer-message-intent` and `customer-message-intent` asked
// the same question in two taxonomies split by WHO sent the message, and the split leaked
// into language: a farmer reporting another stand's stock-out classified as their own
// inventory update (measured 3/3), which is B-053 reintroduced. One taxonomy asks what the
// message IS; code asks separately what the sender may DO about it.
//
// WHAT THIS SEAM CANNOT DO. It returns one value from a closed set. It cannot name a stand,
// choose a recipient, carry prose, decide consent, or express authority — there is no field
// for any of it, so containment is structural rather than dependent on the model declining
// (Golden Rule #6). `inventory_report` is one category for everyone; whether it publishes or
// merely notifies is decided downstream from `farmer_authorizations`.

import { z } from "zod";
import { generateValidated, nullAsAbsent, type LLMProvider } from "./index";
import { projectRequestClassification } from "./projections";
import { isAcceptanceQuestion } from "./acceptance-question";
import { farmBucksIntent } from "./farm-bucks-intent";

/**
 * The six settled categories, cut by **what code must do next** rather than by subject.
 *
 * "who takes viga bucks?" is what forced that cut: a payment question by topic, but by shape
 * identical to "who has eggs" — both search across stands. A topic-shaped taxonomy splits
 * them and a retrieval-shaped one does not.
 *
 * Ordered as measured and documented; `request-classification.test.ts` pins the order so the
 * list cannot silently grow a seventh member.
 */
export const REQUEST_CATEGORIES = [
  /** Which stand(s) meet a need — an item, a payment type, being open. */
  "search_stands",
  /** Information about one specific stand, including where it is. */
  "stand_lookup",
  /**
   * Someone asserting a stand's listed inventory needs updating — has, lacks, sold out of, or
   * will have items. **One category regardless of sender**: a customer's report, a farmer's
   * update, and a farmer reporting someone else's stand are the same statement about the
   * world, and only ACCESS separates what happens next.
   */
  "inventory_report",
  /** What the service is, how it works, the map. */
  "system_inquiry",
  /**
   * Something is WRONG and a person should know — a listing that misstates what a stand
   * carries, a map pin in the wrong place, a reply that made no sense, a stand that has
   * closed. Distinct from `system_inquiry`, which asks what the service does: this reports
   * that it did something incorrectly (max, 2026-08-19).
   *
   * **Classifying this commits nothing.** Code files the review item, and only after the
   * sender confirms — the model names a possibility, never a consequence (Golden Rule #3).
   * That gate is why a false positive here costs one question rather than a false report in
   * VIGA's queue.
   *
   * It is deliberately NOT `inventory_report`. "Pinecone is out of eggs" is a claim about the
   * world that the stock-out path already handles; "your map shows the wrong hours" is a
   * claim about US, and no amount of inventory retrieval answers it.
   */
  "issue_report",
  /** Greeting, thanks, acknowledgement, small talk. */
  "chitchat",
  /**
   * None of the above — a real, reachable category, not a fallback (max, 2026-08-13). A
   * message genuinely outside what Farm Friend does gets an honest answer rather than being
   * forced into product retrieval and told "no stand has a current listing", which is a claim
   * about the corpus in answer to a question that was never about the corpus.
   */
  "unclear",
] as const;

export type RequestCategory = (typeof REQUEST_CATEGORIES)[number];

const inventoryRequestSchema = z
  .object({
    operation: z.literal("inventory"),
    originDependent: nullAsAbsent(z.boolean()),
    outOfScopeRequest: nullAsAbsent(z.boolean()),
  })
  .strict();

const searchRequestSchema = z.discriminatedUnion("operation", [
  inventoryRequestSchema,
  z.object({
    operation: z.literal("broad"),
    originDependent: nullAsAbsent(z.boolean()),
  }).strict(),
  z.object({ operation: z.literal("payment") }).strict(),
  z.object({ operation: z.literal("hours") }).strict(),
  z.object({ operation: z.literal("clarification") }).strict(),
]);

const lookupRequestSchema = z.discriminatedUnion("operation", [
  inventoryRequestSchema,
  z.object({ operation: z.literal("payment") }).strict(),
  z.object({ operation: z.literal("hours") }).strict(),
  z.object({ operation: z.literal("location") }).strict(),
  z.object({ operation: z.literal("overview") }).strict(),
  z.object({ operation: z.literal("clarification") }).strict(),
]);

/** Strict at both discriminators: route/operation combinations cannot be represented. */
export const requestClassificationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("search_stands"), request: searchRequestSchema }).strict(),
  z.object({ kind: z.literal("stand_lookup"), request: lookupRequestSchema }).strict(),
  z.object({ kind: z.literal("inventory_report") }).strict(),
  z.object({ kind: z.literal("system_inquiry") }).strict(),
  z.object({ kind: z.literal("issue_report") }).strict(),
  z.object({ kind: z.literal("chitchat") }).strict(),
  z.object({ kind: z.literal("unclear") }).strict(),
]);

export type RequestClassificationValue = z.infer<typeof requestClassificationSchema>;
export type SearchStandRequest = z.infer<typeof searchRequestSchema>;
export type StandLookupRequest = z.infer<typeof lookupRequestSchema>;

/**
 * The classifier's result.
 *
 * **There is deliberately no fallback category.** `customer-message-intent` used
 * `farm_stand_question` as both a real answer and its refusal value, which made a provider
 * outage indistinguishable from a genuine classification — the customer got a confident
 * "no current listing" for a corpus nothing had searched. Here a failure is `ok: false` and
 * the caller renders an outage reply that blames nobody's wording (B-049's precedent).
 */
export type RequestClassification =
  | ({ ok: true; topic?: "viga_bucks" } & RequestClassificationValue)
  | { ok: false };

export interface RequestClassificationModel {
  classify(input: { taskText: string }): Promise<RequestClassification>;
}

/** Build the first-pass request classifier over the configured provider. */
export function createRequestClassificationModel(
  provider: LLMProvider,
): RequestClassificationModel {
  return {
    async classify(input) {
      /*
        TWO CODE-OWNED FAST PATHS, most specific first. Both sit HERE, inside the seam, rather
        than in deterministic routing steps 1–10: those steps take the message body and nothing
        else, which is what makes "no stored state can reinterpret a STOP" structural rather
        than conventional (Golden Rule #2). Adding pattern rules up there would weaken that
        property for no benefit.

        Each is classifier-local and can only ever produce a category the MODEL could also
        produce — a shortcut to a classification, never a route to a consequence the model's own
        output could not reach. Downstream cannot tell which path answered.
      */

      /*
        1. VIGA Bucks — the service's own currency program, recognised in code because "VIGA" is
        an organisation name a general model has no context for. It claims three question
        shapes and nothing else; a statement merely containing the phrase falls through.
        See `farm-bucks-intent.ts`.

        `stand_scoped` becomes `stand_lookup` whether or not the named stand exists (max,
        2026-08-13): the classification question is whether ONE SPECIFIC stand is being asked
        about, and entity resolution is the downstream no-match path's concern.

        `unsupported_statement` is the domain OVERRIDE: "no viga bucks left" is grammatically
        identical to "no eggs left", so the model returns `inventory_report` for it — correctly
        following a rule we need for real reports. VIGA Bucks are not stand inventory, the
        application knows that and the model cannot, and routing an allocation statement into
        farm inventory handling is the outcome this prevents.
      */
      const farmBucks = farmBucksIntent(input.taskText);
      if (farmBucks !== null) {
        const kind =
          farmBucks === "about"
            ? "system_inquiry"
            : farmBucks === "stand_scoped"
              ? "stand_lookup"
              : farmBucks === "unsupported_statement"
                ? "unclear"
                : "search_stands";
        if (kind === "search_stands" || kind === "stand_lookup") {
          return {
            ok: true,
            kind,
            request: { operation: "payment" },
            topic: "viga_bucks",
          };
        }
        return { ok: true, kind, topic: "viga_bucks" };
      }

      /*
        2. The generic acceptance question — "who takes cash", "does anyone accept cards". Runs
        AFTER the VIGA Bucks resolver, which is the more specific rule: this path would classify
        "who takes VIGA Bucks?" correctly but could never produce `stand_lookup` or
        `system_inquiry` for the other two shapes. See `acceptance-question.ts`.
      */
      if (isAcceptanceQuestion(input.taskText)) {
        return { ok: true, kind: "search_stands", request: { operation: "payment" } };
      }

      const result = await generateValidated(
        provider,
        projectRequestClassification({ taskText: input.taskText }),
        requestClassificationSchema,
      );
      // Both failure reasons collapse to one outcome ON PURPOSE. `provider_error` and
      // `invalid_output` differ in cause but not in what the sender is owed: we could not
      // classify their message, and saying so honestly is the whole of the response.
      if (!result.ok) return { ok: false };
      return { ok: true, ...result.value };
    },
  };
}
