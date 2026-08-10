import { describe, expect, it, vi } from "vitest";
import {
  createDeepInfraProvider,
  MAX_RESPONSE_TOKENS,
  REQUEST_TIMEOUT_MS,
} from "./deepinfra";
import { generateValidated } from "./index";
import { projectOfferingExtraction } from "./projections";
import { z } from "zod";

// F-024. These tests exercise the adapter against a fake transport rather than the network:
// the point is the REQUEST it builds and how it treats the response, which is exactly what
// CLAUDE.md's "an unexported seam is an untested seam" rule says must be covered. B-010's
// discarded error detail survived precisely because the real-I/O parsing path had no test.

function fakeFetch(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return vi.fn(
    async (_url: string | URL | Request, _init?: RequestInit) =>
      ({
        ok: init.ok ?? true,
        status: init.status ?? 200,
        json: async () => body,
      }) as unknown as Response,
  );
}

/** The request body the adapter sent on its first call, parsed. */
function sentBody(fetchImpl: ReturnType<typeof fakeFetch>): string {
  const init = fetchImpl.mock.calls[0]?.[1];
  if (init?.body === undefined || init.body === null) {
    throw new Error("the adapter sent no request body");
  }
  return String(init.body);
}

function completion(content: string) {
  return { choices: [{ message: { content } }] };
}

const context = projectOfferingExtraction({ sourceText: "eggs and plant starts" });

describe("the DeepInfra adapter", () => {
  it("sends the projected context and returns the model's JSON", async () => {
    const fetchImpl = fakeFetch(completion('{"items":["eggs"]}'));
    const provider = createDeepInfraProvider({
      apiKey: "secret-key",
      model: "some-instruct-model",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const raw = await provider.generateJson(context);
    expect(JSON.parse(raw)).toEqual({ items: ["eggs"] });

    expect(String(fetchImpl.mock.calls[0]![0])).toContain("/chat/completions");
    const sent = JSON.parse(sentBody(fetchImpl));
    expect(sent.model).toBe("some-instruct-model");
    // Deterministic decoding: evals are only meaningful against a stable decode.
    expect(sent.temperature).toBe(0);
  });

  it("bounds the response length so a looping model fails fast (B-049)", () => {
    // Measured against the live model and the production corpus: asked "who has eggs" over
    // 48 candidates, the selection call sometimes ran away and emitted 62 identifiers from a
    // set of 48 — repeating itself until it hit the 20-second abort. The customer got the
    // timeout reply on the single commonest question, deterministically.
    //
    // Validation already rejects a duplicate identifier, so a runaway response was never
    // going to be RENDERED. What it did was consume the whole request budget before that
    // check could run. A token ceiling turns a 20-second wall into a prompt failure, and
    // every legitimate response is far below it.
    const fetchImpl = fakeFetch(completion('{"items":["eggs"]}'));
    const provider = createDeepInfraProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    return provider.generateJson(context).then(() => {
      const sent = JSON.parse(sentBody(fetchImpl));
      expect(typeof sent.max_tokens).toBe("number");
      // Above the widest legitimate selection so a real answer is never truncated into
      // invalid JSON, and low enough to cut a loop off. Sized from how uuids TOKENIZE
      // (~18 tokens each, not the ~11 a chars/3.2 estimate gives): 60 identifiers is ~1100
      // tokens. A first pass at 1024 came from the bad estimate and clipped real answers to
      // a broad question, turning them into rejections.
      expect(sent.max_tokens).toBeGreaterThanOrEqual(1500);
      expect(sent.max_tokens).toBeLessThanOrEqual(4096);
    });
  });

  it("gives the response ceiling enough time to be generated (B-049)", () => {
    // The two budgets have to agree, and the original pair did not: 20 seconds at the
    // configured model's ~30 tokens/second is about 600 tokens, so a longer answer could
    // never finish and always became a timeout. Whichever bound is hit first must be the
    // TOKEN one — that fails fast and visibly, where a timeout tells the customer we are
    // broken. Both real constants are read here, so raising one without the other fails.
    const OBSERVED_TOKENS_PER_SECOND = 30;
    const msToGenerateCeiling =
      (MAX_RESPONSE_TOKENS / OBSERVED_TOKENS_PER_SECOND) * 1000;
    expect(msToGenerateCeiling).toBeLessThan(REQUEST_TIMEOUT_MS);
    // And with real headroom, not by a hair: connection setup and prompt processing come
    // out of the same budget before the first token is emitted.
    expect(msToGenerateCeiling).toBeLessThan(REQUEST_TIMEOUT_MS * 0.8);
  });

  it("admits the widest legitimate selection without truncating it (B-049)", () => {
    // The check the first fix was missing, and the reason it shipped broken. A ceiling below
    // the widest honest answer does not fail safely: the array is cut off mid-identifier, the
    // JSON no longer parses, the repair retry is spent on nonsense, and a good answer becomes
    // a refusal. Observed in production on "what's available today?", which selects nearly
    // every stand.
    //
    // Sized from how uuids TOKENIZE rather than their length. 36 characters looks like ~11
    // tokens at the usual chars/3.2 rule, but hex splits far more finely — measured nearer 18
    // — and using the optimistic figure is exactly what set the ceiling too low.
    const MAX_CANDIDATES = 60; // MAX_INQUIRY_CANDIDATES, the retrieval cap
    const TOKENS_PER_UUID = 18;
    const ENVELOPE_TOKENS = 16; // {"kind":"selection","factIds":[ … ]}
    const widestHonestResponse = MAX_CANDIDATES * TOKENS_PER_UUID + ENVELOPE_TOKENS;

    expect(MAX_RESPONSE_TOKENS).toBeGreaterThan(widestHonestResponse);
  });

  it("sends NO conversation, thread, or session identifier — calls are stateless", async () => {
    const fetchImpl = fakeFetch(completion("{}"));
    const provider = createDeepInfraProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.generateJson(context);

    const sent = JSON.parse(sentBody(fetchImpl));
    // `statefulStorage: false` is attested to the gate; nothing here may quietly rely on
    // provider-side state, so no key that would create it may be sent.
    for (const forbidden of [
      "conversation_id",
      "thread_id",
      "session_id",
      "user",
      "store",
      "previous_response_id",
    ]) {
      expect(sent).not.toHaveProperty(forbidden);
    }
    // Exactly one system turn and one user turn — no prior conversation replayed.
    expect(sent.messages).toHaveLength(2);
  });

  it("sends only what the projection carried, never a wider record", async () => {
    const fetchImpl = fakeFetch(completion("{}"));
    const provider = createDeepInfraProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.generateJson(
      projectOfferingExtraction({ sourceText: "eggs" }),
    );

    const body = sentBody(fetchImpl);
    expect(body).toContain("eggs");
    // The projection is the only source of model input; nothing else can ride along.
    expect(body).not.toContain("phone");
    expect(body).not.toContain("contact_hash");
  });

  it("never puts the API key anywhere but the authorization header", async () => {
    const fetchImpl = fakeFetch(completion("{}"));
    const provider = createDeepInfraProvider({
      apiKey: "super-secret-key",
      model: "m",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await provider.generateJson(context);

    expect(String(fetchImpl.mock.calls[0]![0])).not.toContain("super-secret-key");
    expect(sentBody(fetchImpl)).not.toContain("super-secret-key");
  });

  it("strips a markdown fence, a near-universal instruct-model habit", async () => {
    const fetchImpl = fakeFetch(
      completion('```json\n{"items":["eggs"]}\n```'),
    );
    const provider = createDeepInfraProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(JSON.parse(await provider.generateJson(context))).toEqual({
      items: ["eggs"],
    });
  });

  it("throws WITHOUT echoing the response body, which may carry sender text", async () => {
    const fetchImpl = fakeFetch(
      { error: "context included: my number is 206-555-0100" },
      { ok: false, status: 400 },
    );
    const provider = createDeepInfraProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(provider.generateJson(context)).rejects.toThrow(
      /deepinfra responded 400/,
    );
    // The thrown message must not become a log line carrying a sender's phone number.
    await provider
      .generateJson(context)
      .catch((error: Error) => {
        expect(error.message).not.toContain("206-555-0100");
      });
  });

  it("surfaces a provider failure as provider_error, never as a guessed value", async () => {
    const fetchImpl = fakeFetch({}, { ok: false, status: 500 });
    const provider = createDeepInfraProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const result = await generateValidated(
      provider,
      context,
      z.object({ items: z.array(z.string()) }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("provider_error");
  });

  it("treats a missing message content as a failure rather than empty output", async () => {
    const fetchImpl = fakeFetch({ choices: [{}] });
    const provider = createDeepInfraProvider({
      apiKey: "k",
      model: "m",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(provider.generateJson(context)).rejects.toThrow(
      /no message content/,
    );
  });
});
