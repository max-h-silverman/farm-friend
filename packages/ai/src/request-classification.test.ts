import { describe, expect, it } from "vitest";
import {
  createRequestClassificationModel,
  REQUEST_CATEGORIES,
  requestClassificationSchema,
  type LLMProvider,
  type ModelSafeContext,
} from "./index";

class RecordingProvider implements LLMProvider {
  readonly seen: ModelSafeContext[] = [];

  constructor(private readonly response: string) {}

  async generateJson(ctx: ModelSafeContext): Promise<string> {
    this.seen.push(ctx);
    return this.response;
  }
}

class FailingProvider implements LLMProvider {
  async generateJson(): Promise<string> {
    throw new Error("provider unreachable");
  }
}

describe("request-classification seam", () => {
  it.each([
    ["search_stands", "who has eggs?"],
    ["stand_lookup", "does Pinecone Gardens have eggs?"],
    ["inventory_report", "no eggs left at Pinecone Gardens"],
    ["system_inquiry", "where's the farm stand map?"],
    ["chitchat", "thanks!"],
    ["unclear", "what's the weather going to be tomorrow"],
  ])("returns the %s category", async (kind, taskText) => {
    const provider = new RecordingProvider(JSON.stringify({ kind }));

    const result = await createRequestClassificationModel(provider).classify({ taskText });

    expect(result).toEqual({ ok: true, kind });
    expect(provider.seen).toHaveLength(1);
    expect(provider.seen[0]?.seam).toBe("request-classification");
  });

  /**
   * The projection carries the sender's message and NOTHING else.
   *
   * No stand roster (measured WORSE, twice, on two taxonomies), no sender type (access is a
   * downstream code decision), no service name (measured out — it earned its place only under
   * the harness framing), no sender hash. A model that cannot see the corpus cannot be wrong
   * about it, and one that cannot see authority cannot route around it.
   */
  it("projects the message text and nothing else", async () => {
    const provider = new RecordingProvider(JSON.stringify({ kind: "search_stands" }));

    await createRequestClassificationModel(provider).classify({ taskText: "who has kale" });

    expect(provider.seen[0]?.fields).toEqual({ message: "who has kale" });
    // The framing is DECLARED by the projection, not inferred by the adapter (F-111).
    expect(provider.seen[0]?.framing).toBe("classification");
  });

  /**
   * There is NO fallback category. A refused or unreachable model produces `ok: false`, and
   * the caller renders an outage reply that blames nobody's wording.
   *
   * This is the departure from `customer-message-intent`, which used one value as both an
   * answer and a fallback — so an outage was indistinguishable from a real classification.
   */
  it("reports provider failure rather than inventing a category", async () => {
    await expect(
      createRequestClassificationModel(new FailingProvider()).classify({ taskText: "hi" }),
    ).resolves.toEqual({ ok: false });
  });

  it("reports invalid output rather than inventing a category", async () => {
    const provider = new RecordingProvider(JSON.stringify({ kind: "not_a_category" }));

    await expect(
      createRequestClassificationModel(provider).classify({ taskText: "hi" }),
    ).resolves.toEqual({ ok: false });
  });

  /**
   * The seam has ONE field. A classification cannot carry a stand, a recipient, an attribute,
   * or prose — there is no channel for any of it, so containment is structural rather than
   * dependent on the model declining.
   */
  it("refuses a classification carrying any extra field", async () => {
    for (const extra of [
      { stand: "Plum Forest" },
      { salesLocationId: "loc-1" },
      { attribute: "hours" },
      { reply: "We have eggs!" },
    ]) {
      const provider = new RecordingProvider(
        JSON.stringify({ kind: "inventory_report", ...extra }),
      );

      await expect(
        createRequestClassificationModel(provider).classify({ taskText: "sold out" }),
      ).resolves.toEqual({ ok: false });
    }
  });

  /**
   * The acceptance-question fast path (F-111).
   *
   * A question asking WHICH stands accept something is `search_stands` by its syntax, so code
   * answers it and the model is never called — no latency, no cost, and no chance of the
   * organisation-name misread that two instruction rewrites failed to fix.
   */
  it("answers an acceptance question without calling the model at all", async () => {
    const provider = new RecordingProvider(JSON.stringify({ kind: "system_inquiry" }));

    const result = await createRequestClassificationModel(provider).classify({
      taskText: "who takes viga bucks?",
    });

    expect(result).toEqual({ ok: true, kind: "search_stands" });
    // The provider was scripted to return the WRONG answer; the fast path means it never ran.
    expect(provider.seen).toHaveLength(0);
  });

  /**
   * The VIGA Bucks resolver, wired ahead of the generic acceptance path (F-111).
   *
   * Three question shapes, three categories, no model call. "VIGA" is an organisation name a
   * general model has no context for, so these drifted unpredictably: "does Pinecone take VIGA
   * Bucks?" returned `system_inquiry` despite naming a stand.
   */
  it.each([
    ["who takes viga bucks?", "search_stands"],
    ["where can I spend viga bucks", "search_stands"],
    ["what are viga bucks", "system_inquiry"],
    ["how do I get viga bucks", "system_inquiry"],
    ["does Pinecone take viga bucks?", "stand_lookup"],
    // A stand that does not exist is STILL a question about one specific stand. Entity
    // resolution is the downstream no-match path's job, never a classification input.
    ["does Blahblah take viga bucks", "stand_lookup"],
    /*
      The domain OVERRIDE. "no viga bucks left" is grammatically identical to "no eggs left",
      so the model returns `inventory_report` — correctly following a rule we need for real
      reports. VIGA Bucks are not stand inventory; the application knows that and the model
      cannot. `unclear` is honest; `inventory_report` would route an allocation statement into
      farm inventory handling.
    */
    ["no viga bucks left", "unclear"],
    ["out of viga bucks", "unclear"],
    ["my viga bucks expired", "unclear"],
  ])("routes the VIGA Bucks message %j to %s without a model call", async (taskText, kind) => {
    const provider = new RecordingProvider(JSON.stringify({ kind: "unclear" }));

    const result = await createRequestClassificationModel(provider).classify({ taskText });

    expect(result).toEqual({ ok: true, kind });
    expect(provider.seen).toHaveLength(0);
  });

  it("still calls the model when no fast path claims the message", async () => {
    for (const taskText of [
      // Bare VIGA is not the currency concept — deliberately left to the model.
      "what is viga",
      // A mention carrying no claim about the concept: chitchat is the right answer, and this
      // module has no better knowledge to contribute.
      "thanks for the viga bucks",
      "the viga bucks program is great",
      // Ordinary traffic.
      "who has eggs?",
    ]) {
      const provider = new RecordingProvider(JSON.stringify({ kind: "unclear" }));
      await createRequestClassificationModel(provider).classify({ taskText });
      expect(provider.seen, `"${taskText}" must reach the model`).toHaveLength(1);
    }
  });

  /**
   * The fast path is a SHORTCUT to a category the model could also produce — never a way to
   * reach a consequence the model's own output could not. It returns the same shape as any
   * other classification, so nothing downstream can tell which produced it.
   */
  it("returns the fast-path category in the same shape as a model answer", async () => {
    const fast = await createRequestClassificationModel(
      new RecordingProvider("unused"),
    ).classify({ taskText: "who accepts cash" });
    const viaModel = await createRequestClassificationModel(
      new RecordingProvider(JSON.stringify({ kind: "search_stands" })),
    ).classify({ taskText: "who has eggs?" });

    expect(fast).toEqual(viaModel);
  });

  it("exposes exactly the six settled categories", () => {
    expect([...REQUEST_CATEGORIES]).toEqual([
      "search_stands",
      "stand_lookup",
      "inventory_report",
      "system_inquiry",
      "chitchat",
      "unclear",
    ]);
  });

  /**
   * The taxonomy deliberately has no update-vs-report split: that distinction was measured
   * and it FAILED (a farmer's report of another stand read as their own update, 3/3). Access
   * is decided downstream from `farmer_authorizations`, never here.
   */
  it("has no sender-dependent category", () => {
    for (const gone of ["stock_out_report", "inventory_update", "farm_stand_question"]) {
      expect(requestClassificationSchema.safeParse({ kind: gone }).success).toBe(false);
    }
  });
});
