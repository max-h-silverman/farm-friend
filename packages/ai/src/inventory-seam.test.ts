import { describe, expect, it } from "vitest";
import {
  createInventoryInterpreter,
  StubLLMProvider,
  type LLMProvider,
  type ModelSafeContext,
} from "./index";

/** A provider that records what it was shown and returns whatever it is told to. */
class RecordingProvider implements LLMProvider {
  readonly name = "recording";
  readonly seen: ModelSafeContext[] = [];
  constructor(private readonly payload: string) {}
  async generateJson(ctx: ModelSafeContext): Promise<string> {
    this.seen.push(ctx);
    return this.payload;
  }
}

describe("inventory-extraction seam — the live interpreter over a provider", () => {
  it("shows the provider only the seam's projection", async () => {
    const provider = new RecordingProvider(
      JSON.stringify({ kind: "edits", additions: [], changes: [], removals: [] }),
    );
    await createInventoryInterpreter(provider).interpret({
      taskText: "kale is out",
      currentEntries: [{ entryId: "e1", itemName: "kale" }],
    });

    expect(provider.seen).toHaveLength(1);
    expect(provider.seen[0]!.seam).toBe("inventory-extraction");
    expect(Object.keys(provider.seen[0]!.fields as object).sort()).toEqual([
      "currentEntries",
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
    });

    expect(result.kind).toBe("edits");
    if (result.kind === "edits") {
      expect(result.additions[0]!.itemName).toBe("eggs");
      expect(result.removals[0]!.entryId).toBe("e2");
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
    });

    expect(result.kind).toBe("clarification");
    expect(result.kind === "clarification" && result.question).toContain("could not read");
  });

  it("asks rather than guessing when output is unrepairable", async () => {
    const provider = new StubLLMProvider({ "inventory-extraction": "}{ not json" });
    const result = await createInventoryInterpreter(provider).interpret({
      taskText: "x",
      currentEntries: [],
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
    });
    expect(result.kind).toBe("clear_all");
  });
});
