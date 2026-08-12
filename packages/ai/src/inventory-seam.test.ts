import { describe, expect, it } from "vitest";
import {
  createInventoryInterpreter,
  StubLLMProvider,
  type LLMProvider,
  type ModelSafeContext,
} from "./index";

const CURRENT_LOCAL_DATE = "2026-08-06";

/** A provider that records what it was shown and returns whatever it is told to. */
class RecordingProvider implements LLMProvider {
  readonly seen: ModelSafeContext[] = [];
  constructor(private readonly payload: string) {}
  async generateJson(ctx: ModelSafeContext): Promise<string> {
    this.seen.push(ctx);
    return this.payload;
  }
}

describe("inventory-extraction seam — the live interpreter over a provider", () => {
  it("projects deterministic explicit-date evidence instead of asking the model to calculate it", async () => {
    const provider = new RecordingProvider(
      JSON.stringify({
        kind: "closure",
        closure: {
          result: "close",
          closureKind: "temporary",
          startsOn: "2026-08-08",
          closedThrough: "2026-08-10",
        },
      }),
    );
    await createInventoryInterpreter(provider).interpret({
      taskText: "Closed August 8 through August 10.",
      currentEntries: [],
      currentLocalDate: CURRENT_LOCAL_DATE,
    });

    expect(provider.seen[0]!.fields).toMatchObject({
      closureTiming: {
        kind: "close",
        closureKind: "temporary",
        startsOn: "2026-08-08",
        closedThrough: "2026-08-10",
      },
    });
    expect(provider.seen[0]!.outputInstructions).not.toMatch(/2026-08-0[234]/);
  });

  it("resolves this weekend deterministically before the model call", async () => {
    const provider = new RecordingProvider(
      JSON.stringify({
        kind: "closure",
        closure: {
          result: "close",
          closureKind: "temporary",
          startsOn: "2026-08-08",
          closedThrough: "2026-08-09",
        },
      }),
    );
    await createInventoryInterpreter(provider).interpret({
      taskText: "Closed this weekend.",
      currentEntries: [],
      currentLocalDate: CURRENT_LOCAL_DATE,
    });

    expect(provider.seen[0]!.fields).toMatchObject({
      closureTiming: {
        kind: "close",
        closureKind: "temporary",
        startsOn: "2026-08-08",
        closedThrough: "2026-08-09",
      },
    });
  });

  it.each([
    ["vague timing", "We will be closed for a while."],
    ["sub-operation conflict", "The egg fridge is closed this weekend, but the stand is open."],
    ["multiple windows", "Closed August 8-10 and again August 20-22."],
  ])("clarifies %s without calling a model", async (_label, taskText) => {
    const provider = new RecordingProvider(
      JSON.stringify({ kind: "closure", closure: { result: "reopen" } }),
    );
    const result = await createInventoryInterpreter(provider).interpret({
      taskText,
      currentEntries: [],
      currentLocalDate: CURRENT_LOCAL_DATE,
    });

    expect(result.kind).toBe("clarification");
    expect(provider.seen).toHaveLength(0);
  });

  it("rejects model dates that contradict deterministic timing evidence", async () => {
    const provider = new RecordingProvider(
      JSON.stringify({
        kind: "closure",
        closure: {
          result: "close",
          closureKind: "temporary",
          startsOn: "2026-08-02",
          closedThrough: "2026-08-04",
        },
      }),
    );
    const result = await createInventoryInterpreter(provider).interpret({
      taskText: "Closed this weekend.",
      currentEntries: [],
      currentLocalDate: CURRENT_LOCAL_DATE,
    });

    expect(result.kind).toBe("clarification");
  });

  it("rejects a hallucinated reopen on an inventory-only message", async () => {
    const provider = new RecordingProvider(
      JSON.stringify({ kind: "closure", closure: { result: "reopen" } }),
    );
    const result = await createInventoryInterpreter(provider).interpret({
      taskText: "Still have eggs.",
      currentEntries: [],
      currentLocalDate: CURRENT_LOCAL_DATE,
    });

    expect(result.kind).toBe("clarification");
  });

  /*
    B-058. MEASURED against the real model (2026-08-12): on "no eggs left at Pinecone Gardens"
    the model attached `closure: {"result":"close","closureKind":"none"}` to an otherwise
    correct `edits` result in 5 of 12 runs — and 0 of 12 on the same sentence without the
    trailing stand name. It is told `closureTiming is {"kind":"none"}` in the projection and
    ignores it, which is exactly why this cannot be a prompt promise.

    A spurious closure beside real inventory work is NOISE, not grounds to discard the work.
    Code already owns closure timing outright, so the model's closure field carries no
    authority: drop it and keep the edits. The farmer's eggs report must not be silently
    converted into a question about dates they never raised.
  */
  it("keeps the inventory edits when the model attaches a closure code did not evidence", async () => {
    const provider = new RecordingProvider(
      JSON.stringify({
        kind: "edits",
        additions: [],
        changes: [],
        removals: [{ entryId: "e1" }],
        closure: { result: "reopen" },
      }),
    );
    const result = await createInventoryInterpreter(provider).interpret({
      taskText: "no eggs left at Pinecone Gardens",
      currentEntries: [{ entryId: "e1", itemName: "tomatoes" }],
      currentLocalDate: CURRENT_LOCAL_DATE,
    });

    expect(result.kind).toBe("edits");
    // The unevidenced closure is dropped, not carried forward.
    expect(result.kind === "edits" && result.closure).toBeUndefined();
    // ...and the edits themselves survive intact.
    expect(result.kind === "edits" && result.removals).toEqual([{ entryId: "e1" }]);
  });

  it("keeps a clear_all when the model attaches a closure code did not evidence", async () => {
    const provider = new RecordingProvider(
      JSON.stringify({ kind: "clear_all", closure: { result: "reopen" } }),
    );
    const result = await createInventoryInterpreter(provider).interpret({
      taskText: "everything is gone for today",
      currentEntries: [{ entryId: "e1", itemName: "tomatoes" }],
      currentLocalDate: CURRENT_LOCAL_DATE,
    });

    expect(result.kind).toBe("clear_all");
    expect(result.kind === "clear_all" && result.closure).toBeUndefined();
  });

  /*
    The mirror, and the reason this is a drop rather than a blanket "ignore closure": when the
    message DOES carry closure evidence, a model closure that contradicts it is still a real
    disagreement about a consequential fact. Dropping it there would silently publish inventory
    while discarding a closure the farmer actually asked for, so that case still clarifies.
  */
  /*
    B-058, the residual half. On the same live sentence the model also emits
    `closure: {"result":"close","closureKind":"none"}` — echoing back the `closureTiming is
    {"kind":"none"}` it was shown — in 3 of 13 runs. "none" is not a legal closureKind, so the
    STRICT schema rejects the whole output, the one repair attempt returns the same thing, and
    the seam falls through to its provider-error clarification. The farmer's stock report is
    discarded over a field that could not have been admissible in the first place.

    When code found no closure evidence, no closure value is readable — so the key is stripped
    BEFORE parsing rather than being allowed to fail the parse. The schema itself is untouched:
    on a message that does carry closure evidence, a malformed closure is still a refusal.
  */
  it("keeps the edits when the model returns a closure whose shape is not even legal", async () => {
    const provider = new RecordingProvider(
      JSON.stringify({
        kind: "edits",
        additions: [],
        changes: [],
        removals: [{ entryId: "e1" }],
        closure: { result: "close", closureKind: "none" },
      }),
    );
    const result = await createInventoryInterpreter(provider).interpret({
      taskText: "no eggs left at Pinecone Gardens",
      currentEntries: [{ entryId: "e1", itemName: "tomatoes" }],
      currentLocalDate: CURRENT_LOCAL_DATE,
    });

    expect(result.kind).toBe("edits");
    expect(result.kind === "edits" && result.removals).toEqual([{ entryId: "e1" }]);
    expect(result.kind === "edits" && result.closure).toBeUndefined();
  });

  /*
    B-058, third measured mode. In 2 of 15 live runs on the same sentence the model returned
    `{"kind":"edits","removals":[...],"closure":...}` — omitting `additions` and `changes`
    entirely. The seam note tells it all three arrays are REQUIRED, each possibly empty; it
    drops them anyway, so the strict schema fails the whole output and the farmer's report
    becomes "Sorry, I could not read that."

    An omitted edit array is unambiguous — there is exactly one thing it can mean, and it is
    the empty list. Defaulting it invents nothing: it cannot manufacture a removal, an addition,
    or a change, and every entryId that does arrive is still membership-checked downstream.
  */
  it("reads an edits result that omits the arrays it had nothing to put in", async () => {
    const provider = new RecordingProvider(
      JSON.stringify({ kind: "edits", removals: [{ entryId: "e1" }] }),
    );
    const result = await createInventoryInterpreter(provider).interpret({
      taskText: "no eggs left at Pinecone Gardens",
      currentEntries: [{ entryId: "e1", itemName: "tomatoes" }],
      currentLocalDate: CURRENT_LOCAL_DATE,
    });

    expect(result.kind).toBe("edits");
    expect(result.kind === "edits" && result.removals).toEqual([{ entryId: "e1" }]);
    expect(result.kind === "edits" && result.additions).toEqual([]);
    expect(result.kind === "edits" && result.changes).toEqual([]);
  });

  it("still refuses a malformed closure when the message really does evidence one", async () => {
    const provider = new RecordingProvider(
      JSON.stringify({
        kind: "edits",
        additions: [],
        changes: [],
        removals: [],
        closure: { result: "close", closureKind: "none" },
      }),
    );
    const result = await createInventoryInterpreter(provider).interpret({
      taskText: "Closed this weekend, but we still have eggs.",
      currentEntries: [],
      currentLocalDate: CURRENT_LOCAL_DATE,
    });

    expect(result.kind).toBe("clarification");
  });

  /*
    The other half of the same boundary: with `kind: "closure"` the closure IS the payload, so
    "drop the unevidenced closure and keep the rest" would return a closure result with no
    closure in it. That case must still clarify even though the message carries no evidence —
    which is what the hallucinated-reopen test above depends on.
  */
  it("clarifies rather than emptying a closure-only result the message did not evidence", async () => {
    const provider = new RecordingProvider(
      JSON.stringify({
        kind: "closure",
        closure: { result: "close", closureKind: "seasonal", startsOn: "2026-08-06" },
      }),
    );
    const result = await createInventoryInterpreter(provider).interpret({
      taskText: "no eggs left at Pinecone Gardens",
      currentEntries: [{ entryId: "e1", itemName: "tomatoes" }],
      currentLocalDate: CURRENT_LOCAL_DATE,
    });

    expect(result.kind).toBe("clarification");
  });

  it("still clarifies when edits carry a closure that contradicts real timing evidence", async () => {
    const provider = new RecordingProvider(
      JSON.stringify({
        kind: "edits",
        additions: [],
        changes: [],
        removals: [],
        closure: {
          result: "close",
          closureKind: "temporary",
          startsOn: "2026-08-02",
          closedThrough: "2026-08-04",
        },
      }),
    );
    const result = await createInventoryInterpreter(provider).interpret({
      taskText: "Closed this weekend, but we still have eggs.",
      currentEntries: [],
      currentLocalDate: CURRENT_LOCAL_DATE,
    });

    expect(result.kind).toBe("clarification");
  });

  it("accepts an explicit reopen while rejecting implicit model invention", async () => {
    const provider = new RecordingProvider(
      JSON.stringify({ kind: "closure", closure: { result: "reopen" } }),
    );
    const result = await createInventoryInterpreter(provider).interpret({
      taskText: "The stand is open again.",
      currentEntries: [],
      currentLocalDate: CURRENT_LOCAL_DATE,
    });

    expect(result.kind).toBe("closure");
    expect(result.kind === "closure" && result.closure).toEqual({ result: "reopen" });
  });

  it("clarifies a reversed explicit range without calling a model", async () => {
    const provider = new RecordingProvider(
      JSON.stringify({
        kind: "closure",
        closure: {
          result: "close",
          closureKind: "temporary",
          startsOn: "2026-08-12",
          closedThrough: "2026-08-10",
        },
      }),
    );
    const result = await createInventoryInterpreter(provider).interpret({
      taskText: "Closed August 12 through August 10.",
      currentEntries: [],
      currentLocalDate: CURRENT_LOCAL_DATE,
    });

    expect(result.kind).toBe("clarification");
    expect(provider.seen).toHaveLength(0);
  });

  it("shows the provider only the seam's projection", async () => {
    const provider = new RecordingProvider(
      JSON.stringify({ kind: "edits", additions: [], changes: [], removals: [] }),
    );
    await createInventoryInterpreter(provider).interpret({
      taskText: "kale is out",
      currentEntries: [{ entryId: "e1", itemName: "kale" }],
      currentLocalDate: CURRENT_LOCAL_DATE,
    });

    expect(provider.seen).toHaveLength(1);
    expect(provider.seen[0]!.seam).toBe("inventory-extraction");
    expect(Object.keys(provider.seen[0]!.fields as object).sort()).toEqual([
      "closureTiming",
      "currentClosure",
      "currentEntries",
      "currentLocalDate",
      "taskText",
    ]);
  });

  it("returns typed edits for well-formed output", async () => {
    const provider = new StubLLMProvider({
      "inventory-extraction": JSON.stringify({
        kind: "edits",
        additions: [{ itemName: "eggs", quantity: 4, unit: "dozen" }],
        changes: [{ entryId: "e1", approximation: "limited" }],
        removals: [{ entryId: "e2" }],
      }),
    });
    const result = await createInventoryInterpreter(provider).interpret({
      taskText: "4 dozen eggs, low on kale, tomatoes gone",
      currentEntries: [
        { entryId: "e1", itemName: "kale" },
        { entryId: "e2", itemName: "tomatoes" },
      ],
      currentLocalDate: CURRENT_LOCAL_DATE,
    });

    expect(result.kind).toBe("edits");
    if (result.kind === "edits") {
      expect(result.additions[0]!.itemName).toBe("eggs");
      expect(result.removals[0]!.entryId).toBe("e2");
    }
  });

  it("treats explicit nulls in optional fields as absence, end to end", async () => {
    // What the real model actually returns for "tomatoes, kale, and a dozen eggs"
    // (F-024 live run, verbatim shape): nulls for every unstated optional field.
    const provider = new StubLLMProvider({
      "inventory-extraction": JSON.stringify({
        kind: "edits",
        additions: [
          {
            itemName: "tomatoes",
            quantity: null,
            unit: null,
            priceText: null,
            approximation: null,
          },
          { itemName: "eggs", quantity: 12, unit: "dozen", priceText: null, approximation: null },
        ],
        changes: [],
        removals: [],
      }),
    });
    const result = await createInventoryInterpreter(provider).interpret({
      taskText: "tomatoes and a dozen eggs",
      currentEntries: [],
      currentLocalDate: CURRENT_LOCAL_DATE,
    });
    expect(result.kind).toBe("edits");
    if (result.kind === "edits") {
      expect(result.additions).toHaveLength(2);
      expect(result.additions[0]!.quantity).toBeUndefined();
      expect(result.additions[1]!.quantity).toBe(12);
    }
  });

  it("rejects consequential fields the model tried to smuggle in", async () => {
    // A `publish` or `recipientHash` field is a consequence the model never owns. The
    // strict schema refuses it here; core's validator refuses it again against the snapshot.
    const provider = new StubLLMProvider({
      "inventory-extraction": JSON.stringify({
        kind: "edits",
        additions: [],
        changes: [],
        removals: [{ entryId: "e1", publish: true }],
      }),
    });
    const result = await createInventoryInterpreter(provider).interpret({
      taskText: "kale gone",
      currentEntries: [{ entryId: "e1", itemName: "kale" }],
      currentLocalDate: CURRENT_LOCAL_DATE,
    });

    // Never a silent guess: it asks rather than acting on a shape it does not accept.
    expect(result.kind).toBe("clarification");
  });

  it("asks rather than reporting an empty stand when the provider fails", async () => {
    // The dangerous failure mode is a provider error read as "the farmer has nothing."
    const provider = new StubLLMProvider({}); // throws: no canned response
    const result = await createInventoryInterpreter(provider).interpret({
      taskText: "we have plenty of everything",
      currentEntries: [{ entryId: "e1", itemName: "kale" }],
      currentLocalDate: CURRENT_LOCAL_DATE,
    });

    expect(result.kind).toBe("clarification");
    expect(result.kind === "clarification" && result.question).toContain("could not read");
  });

  it("asks rather than guessing when output is unrepairable", async () => {
    const provider = new StubLLMProvider({ "inventory-extraction": "}{ not json" });
    const result = await createInventoryInterpreter(provider).interpret({
      taskText: "x",
      currentEntries: [],
      currentLocalDate: CURRENT_LOCAL_DATE,
    });
    expect(result.kind).toBe("clarification");
  });

  it("passes a clarification the model legitimately asked for", async () => {
    const provider = new StubLLMProvider({
      "inventory-extraction": JSON.stringify({
        kind: "clarification",
        question: "Do you mean all the kale, or just the curly kale?",
      }),
    });
    const result = await createInventoryInterpreter(provider).interpret({
      taskText: "kale's done",
      currentEntries: [{ entryId: "e1", itemName: "kale" }],
      currentLocalDate: CURRENT_LOCAL_DATE,
    });

    expect(result.kind).toBe("clarification");
    if (result.kind === "clarification") {
      expect(result.question).toContain("curly kale");
    }
  });

  it("accepts an unambiguous clear-all", async () => {
    const provider = new StubLLMProvider({
      "inventory-extraction": JSON.stringify({ kind: "clear_all" }),
    });
    const result = await createInventoryInterpreter(provider).interpret({
      taskText: "everything is sold out",
      currentEntries: [{ entryId: "e1", itemName: "kale" }],
      currentLocalDate: CURRENT_LOCAL_DATE,
    });
    expect(result.kind).toBe("clear_all");
  });
});
