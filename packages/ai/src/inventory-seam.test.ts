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
