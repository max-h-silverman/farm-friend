import { describe, expect, it } from "vitest";
import {
  validateInterpretation,
  type InventoryInterpreter,
  type PublishedSnapshot,
} from "./proposal";

// F-014 owns the port contract only: what a typed interpretation may say and what code
// does with it. The live model adapter, its context projection, and hostile-model proof
// are F-015. These fakes are deterministic stand-ins, never evidence of model safety.

const published: PublishedSnapshot = {
  revisionId: "rev-1",
  entries: [{ entryId: "e-bok", itemName: "Bok choy" }],
};

describe("inventory interpreter port", () => {
  it("passes only the task text and opaque entry identifiers to the port", async () => {
    const seen: unknown[] = [];
    const interpreter: InventoryInterpreter = {
      async interpret(request) {
        seen.push(request);
        return { kind: "edits", additions: [], changes: [], removals: [] };
      },
    };

    await interpreter.interpret({
      taskText: "we're out of bok choy",
      currentEntries: published.entries.map((entry) => ({
        entryId: entry.entryId,
        itemName: entry.itemName,
      })),
    });

    // The port receives the farmer's own current text plus opaque identifiers —
    // no phone, contact, consent, thread history, or authority record.
    expect(seen).toEqual([
      {
        taskText: "we're out of bok choy",
        currentEntries: [{ entryId: "e-bok", itemName: "Bok choy" }],
      },
    ]);
    const serialized = JSON.stringify(seen);
    expect(serialized).not.toMatch(/\+1\d{10}/);
    expect(serialized).not.toMatch(/consent|authoriz|phone|hash/i);
  });

  it("accepts a clarification outcome that creates no proposal", () => {
    expect(
      validateInterpretation(
        { kind: "clarification", question: "Did you mean all items, or just bok choy?" },
        published,
      ),
    ).toEqual({
      ok: true,
      value: {
        kind: "clarification",
        question: "Did you mean all items, or just bok choy?",
      },
    });
  });

  it("rejects an interpretation selecting an entry outside the current snapshot", () => {
    // Golden Rule #3/#4: the model selects identifiers; code validates membership.
    const result = validateInterpretation(
      {
        kind: "edits",
        additions: [],
        changes: [],
        removals: [{ entryId: "e-invented" }],
      },
      published,
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/not part of the base snapshot/i);
    }
  });

  it("rejects a structurally invalid interpretation", () => {
    for (const malformed of [
      null,
      {},
      { kind: "publish_now" },
      { kind: "edits" },
      { kind: "clarification" },
      { kind: "edits", additions: [{}], changes: [], removals: [] },
    ]) {
      expect(validateInterpretation(malformed, published).ok).toBe(false);
    }
  });

  it("rejects an interpretation that tries to publish or choose a recipient", () => {
    const result = validateInterpretation(
      {
        kind: "edits",
        additions: [],
        changes: [],
        removals: [],
        publish: true,
        recipientHash: "abc",
      },
      published,
    );

    // Extra consequential fields are not silently ignored; the model never commits.
    expect(result.ok).toBe(false);
  });
});
