import { describe, expect, it } from "vitest";
import { FixedClock } from "../clock";
import {
  applyInventoryEdits,
  confirmationEligibility,
  renderProposedSnapshot,
  validateInterpretation,
  validateStructuredInventoryEdit,
  type InventoryInterpretation,
  type PublishedSnapshot,
} from "./proposal";

// F-014 — the inventory proposal is one complete snapshot bound to its base revision.
// Farmer language supplies patch-like edits; omission preserves an item. The model
// interprets; these pure functions decide nothing about authority, consent, or delivery.

const t0 = new Date("2026-07-25T12:00:00Z");
const issueDraftId = () => "draft_test";

const published: PublishedSnapshot = {
  revisionId: "rev-1",
  entries: [
    { entryId: "e-potato", itemName: "Potatoes", approximation: "plentiful" },
    { entryId: "e-bok", itemName: "Bok choy", approximation: "limited" },
    { entryId: "e-jam", itemName: "Strawberry preserves", priceText: "$8" },
  ],
};

describe("inventory proposal — patch-like edits over a complete snapshot", () => {
  it("preserves every omitted item", () => {
    const interpretation: InventoryInterpretation = {
      kind: "edits",
      additions: [{ itemName: "Green beans" }],
      changes: [],
      removals: [],
    };

    const proposed = applyInventoryEdits(published, interpretation, issueDraftId);

    // Omission is not deletion: the three existing items survive untouched.
    expect(proposed.entries.map((entry) => entry.itemName)).toEqual([
      "Potatoes",
      "Bok choy",
      "Strawberry preserves",
      "Green beans",
    ]);
    expect(proposed.baseRevisionId).toBe("rev-1");
    expect(proposed.isFirstPublication).toBe(false);
  });

  it("applies changes and removals by stable entry ID", () => {
    const interpretation: InventoryInterpretation = {
      kind: "edits",
      additions: [],
      changes: [{ entryId: "e-bok", approximation: "plentiful" }],
      removals: [{ entryId: "e-potato" }],
    };

    const proposed = applyInventoryEdits(published, interpretation, issueDraftId);

    expect(proposed.entries).toEqual([
      { entryId: "e-bok", itemName: "Bok choy", approximation: "plentiful" },
      { entryId: "e-jam", itemName: "Strawberry preserves", priceText: "$8" },
    ]);
  });

  it("clears optional details when a direct editor explicitly sends null", () => {
    const proposed = applyInventoryEdits(
      published,
      {
        kind: "edits",
        additions: [],
        changes: [{ entryId: "e-jam", priceText: null }],
        removals: [],
      },
      issueDraftId,
    );

    expect(proposed.entries[2]).toEqual({
      entryId: "e-jam",
      itemName: "Strawberry preserves",
    });
  });

  it("reserves explicit clears for the model-free direct editor", () => {
    const edit = {
      kind: "edits" as const,
      additions: [],
      changes: [{ entryId: "e-jam", priceText: null }],
      removals: [],
    };

    expect(validateStructuredInventoryEdit(edit, published).ok).toBe(true);
    expect(validateInterpretation(edit, published).ok).toBe(false);
  });

  it("rejects an edit naming an entry outside the base snapshot", () => {
    const interpretation: InventoryInterpretation = {
      kind: "edits",
      additions: [],
      changes: [],
      removals: [{ entryId: "e-not-listed" }],
    };

    // The model selects identifiers; code validates membership before any consequence.
    expect(() => applyInventoryEdits(published, interpretation, issueDraftId)).toThrow(
      /not part of the base snapshot/i,
    );
  });

  /*
    A REMOVAL MUST NAME A LISTED ITEM (max, 2026-08-10). Found live: "no eggs left at Pinecone
    Gardens" proposed "Taking off: kale." — eggs were not on the listing, and the model reached
    for the nearest entry instead.

    The prompt was given an explicit rule and STILL failed the exact live sentence against the
    real model, which is the whole argument for putting this in code: a removal deletes a
    farmer's published produce, so the entry's own name must appear in the message authorizing
    it. Code holds both the snapshot and the text, so it can decide this with certainty and
    without a model — and the guarantee survives the brain being swapped for a weaker one.

    Dropped SILENTLY rather than refused (max, 2026-08-10): the farmer confirms every proposal
    before it publishes, so an unauthorized removal simply never reaches "Taking off:". What
    must never happen is the deletion surviving to that line.
  */
  describe("a removal must name a listed item in the farmer's own message", () => {
    it("drops a removal whose item the message never names", () => {
      const validated = validateInterpretation(
        {
          kind: "edits",
          additions: [{ itemName: "Green beans" }],
          changes: [],
          // The live failure shape: a real entry ID for an item the text never mentions.
          removals: [{ entryId: "e-potato" }],
        },
        published,
        "no eggs left, adding green beans",
      );

      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      if (validated.value.kind !== "edits") throw new Error("expected edits");
      // The unauthorized removal is gone; everything the farmer DID say survives.
      expect(validated.value.removals).toEqual([]);
      expect(validated.value.additions).toEqual([{ itemName: "Green beans" }]);
    });

    it("keeps a removal the message does name", () => {
      // The mirror. A guard that made removal unreachable would be its own defect — this is
      // the case the sold-out path depends on, and it must survive untouched.
      const validated = validateInterpretation(
        {
          kind: "edits",
          additions: [],
          changes: [],
          removals: [{ entryId: "e-potato" }],
        },
        published,
        "potatoes are all gone",
      );

      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      if (validated.value.kind !== "edits") throw new Error("expected edits");
      expect(validated.value.removals).toEqual([{ entryId: "e-potato" }]);
    });

    it("matches the item name case-insensitively and inside a longer word run", () => {
      // The listing says "Bok choy"; a farmer types "bok choy is done". Nothing normalizes
      // casing between a farmer's SMS and VIGA's form text, so a case-sensitive check would
      // silently drop legitimate removals — the failure mode in the other direction.
      const validated = validateInterpretation(
        {
          kind: "edits",
          additions: [],
          changes: [],
          removals: [{ entryId: "e-bok" }, { entryId: "e-jam" }],
        },
        published,
        "bok choy is done and the strawberry preserves sold out",
      );

      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      if (validated.value.kind !== "edits") throw new Error("expected edits");
      expect(validated.value.removals).toEqual([
        { entryId: "e-bok" },
        { entryId: "e-jam" },
      ]);
    });

    it("drops only the unnamed removal, keeping the named one beside it", () => {
      // A mixed message must not be all-or-nothing: the farmer said one true thing and the
      // model added one it invented.
      const validated = validateInterpretation(
        {
          kind: "edits",
          additions: [],
          changes: [],
          removals: [{ entryId: "e-potato" }, { entryId: "e-bok" }],
        },
        published,
        "potatoes are gone",
      );

      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      if (validated.value.kind !== "edits") throw new Error("expected edits");
      expect(validated.value.removals).toEqual([{ entryId: "e-potato" }]);
    });

    it("still validates entry membership — a dropped removal is not a bypass", () => {
      // The existing snapshot check must not be weakened by the new one. An ID outside the
      // base is a different failure (a hallucinated identifier) and stays a hard rejection.
      const validated = validateInterpretation(
        {
          kind: "edits",
          additions: [],
          changes: [],
          removals: [{ entryId: "e-not-listed" }],
        },
        published,
        "the mystery item is gone",
      );

      expect(validated.ok).toBe(false);
    });
  });

  it("clear-all intent produces an empty snapshot rather than preserving items", () => {
    const proposed = applyInventoryEdits(
      published,
      { kind: "clear_all" },
      issueDraftId,
    );
    expect(proposed.entries).toEqual([]);
    expect(proposed.baseRevisionId).toBe("rev-1");
  });

  it("builds a first-publication proposal from the absence of a base revision", () => {
    const proposed = applyInventoryEdits(
      null,
      {
        kind: "edits",
        additions: [{ itemName: "Potatoes" }],
        changes: [],
        removals: [],
      },
      issueDraftId,
    );

    expect(proposed.isFirstPublication).toBe(true);
    expect(proposed.baseRevisionId).toBeNull();
    expect(proposed.entries.map((entry) => entry.itemName)).toEqual(["Potatoes"]);
  });

  it("issues draft IDs so a later unconfirmed edit can target an addition", () => {
    const proposed = applyInventoryEdits(
      null,
      {
        kind: "edits",
        additions: [{ itemName: "Winter squash" }],
        changes: [],
        removals: [],
      },
      () => "draft_opaque_1",
    );

    expect(proposed.entries).toEqual([
      { entryId: "draft_opaque_1", itemName: "Winter squash" },
    ]);
  });

  it("renders the complete resulting snapshot, never a delta", () => {
    const proposed = applyInventoryEdits(
      published,
      {
        kind: "edits",
        additions: [{ itemName: "Green beans" }],
        changes: [],
        removals: [{ entryId: "e-potato" }],
      },
      issueDraftId,
    );

    const rendered = renderProposedSnapshot(proposed);

    // What the farmer confirms is exactly what publishes: every surviving item is
    // shown, including the ones they never mentioned.
    expect(rendered).toContain("Bok choy");
    expect(rendered).toContain("Strawberry preserves");
    expect(rendered).toContain("Green beans");
    // The result is the authority: a dropped item never appears in the listing itself.
    expect(rendered.split("Taking off")[0]).not.toContain("Potatoes");
    // Still never a delta description of what was ADDED or CHANGED — those items are
    // already visible in the result, so naming them would restate the same fact twice.
    expect(rendered).not.toMatch(/\badded\b|\bchanged\b/i);
  });

  // A farmer who texts "we have eggs and bok choy" when the stand lists eggs and kale is
  // dropping kale. The complete-result rendering is honest but easy to skim: the kale is
  // gone by ABSENCE, and absence is exactly what a person scanning an SMS does not notice.
  // Naming the loss is the difference between a farmer confirming a deletion and a farmer
  // confirming a list that happens to be missing something.
  it("names what is leaving the stand, so a removal is never silent", () => {
    const proposed = applyInventoryEdits(
      published,
      {
        kind: "edits",
        additions: [],
        changes: [],
        removals: [{ entryId: "e-potato" }, { entryId: "e-jam" }],
      },
      issueDraftId,
    );

    const rendered = renderProposedSnapshot(proposed);

    expect(rendered).toContain("Bok choy");
    expect(rendered).toMatch(/Taking off.*Potatoes/s);
    expect(rendered).toContain("Strawberry preserves");
  });

  it("says nothing about removals when nothing is being removed", () => {
    const proposed = applyInventoryEdits(
      published,
      { kind: "edits", additions: [{ itemName: "Green beans" }], changes: [], removals: [] },
      issueDraftId,
    );

    expect(renderProposedSnapshot(proposed)).not.toMatch(/taking off/i);
  });

  // Clearing everything is the largest possible removal and the one most worth stating
  // plainly. The empty-stand sentence already says the result, so the items are named
  // rather than left to "no items currently available".
  it("names the items when a clear-all empties the stand", () => {
    const proposed = applyInventoryEdits(published, { kind: "clear_all" }, issueDraftId);

    const rendered = renderProposedSnapshot(proposed);

    expect(rendered).toMatch(/no items/i);
    expect(rendered).toMatch(/Taking off.*Bok choy/s);
  });
});

describe("confirmation eligibility — context-, version-, and base-bound", () => {
  const activated = {
    proposalVersion: 2,
    activatedVersion: 2,
    activatedAt: new Date("2026-07-25T10:00:00Z"),
    expiresAt: new Date("2026-07-25T22:00:00Z"),
    baseRevisionId: "rev-1" as string | null,
  };

  it("accepts a token inside the activation window against a current base", () => {
    const clock = new FixedClock(t0);
    expect(
      confirmationEligibility(activated, {
        occurredAt: new Date("2026-07-25T11:00:00Z"),
        currentRevisionId: "rev-1",
        clock,
      }),
    ).toEqual({ status: "eligible" });
  });

  it("refuses a token that predates its current prompt activation", () => {
    const clock = new FixedClock(t0);
    expect(
      confirmationEligibility(activated, {
        occurredAt: new Date("2026-07-25T09:59:00Z"),
        currentRevisionId: "rev-1",
        clock,
      }),
    ).toEqual({ status: "predates_activation" });
  });

  it("refuses a token whose proposal version was revised after activation", () => {
    const clock = new FixedClock(t0);
    expect(
      confirmationEligibility(
        { ...activated, proposalVersion: 3 },
        {
          occurredAt: new Date("2026-07-25T11:00:00Z"),
          currentRevisionId: "rev-1",
          clock,
        },
      ),
    ).toEqual({ status: "awaiting_new_prompt" });
  });

  it("expires 12 hours after provider acceptance of the current prompt", () => {
    const clock = new FixedClock(new Date("2026-07-25T22:00:01Z"));
    expect(
      confirmationEligibility(activated, {
        occurredAt: new Date("2026-07-25T22:00:01Z"),
        currentRevisionId: "rev-1",
        clock,
      }),
    ).toEqual({ status: "expired" });
  });

  it("refuses to publish over a base that is no longer current", () => {
    const clock = new FixedClock(t0);
    // A newer revision landed: publishing this snapshot would silently overwrite it.
    expect(
      confirmationEligibility(activated, {
        occurredAt: new Date("2026-07-25T11:00:00Z"),
        currentRevisionId: "rev-2",
        clock,
      }),
    ).toEqual({ status: "base_conflict" });
  });

  it("treats a first-publication proposal as conflicted once a revision exists", () => {
    const clock = new FixedClock(t0);
    expect(
      confirmationEligibility(
        { ...activated, baseRevisionId: null },
        {
          occurredAt: new Date("2026-07-25T11:00:00Z"),
          currentRevisionId: "rev-1",
          clock,
        },
      ),
    ).toEqual({ status: "base_conflict" });
  });

  it("accepts a first-publication proposal when no revision exists yet", () => {
    const clock = new FixedClock(t0);
    expect(
      confirmationEligibility(
        { ...activated, baseRevisionId: null },
        {
          occurredAt: new Date("2026-07-25T11:00:00Z"),
          currentRevisionId: null,
          clock,
        },
      ),
    ).toEqual({ status: "eligible" });
  });

  it("refuses a proposal whose current prompt has not been accepted", () => {
    const clock = new FixedClock(t0);
    expect(
      confirmationEligibility(
        {
          proposalVersion: 1,
          activatedVersion: null,
          activatedAt: null,
          expiresAt: null,
          baseRevisionId: "rev-1",
        },
        {
          occurredAt: new Date("2026-07-25T11:00:00Z"),
          currentRevisionId: "rev-1",
          clock,
        },
      ),
    ).toEqual({ status: "not_activated" });
  });
});
