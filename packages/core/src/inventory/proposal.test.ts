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


  /*
    B-092 — an addition naming an item the stand already lists.

    FOUND LIVE (max, 2026-08-19). Josie's Farm listed Eggs, Kale and Tomatoes; the farmer
    texted "We have kale" and the confirmation came back listing Kale TWICE. Reproduced
    against the real model 8 runs out of 8: every single one returned Kale as an ADDITION
    despite `currentEntries` naming it, so this is not variance to be tuned away.

    The seam note already says "additions are items not currently listed" and the model
    ignores it, which is the argument for settling it here — Golden Rule #6. Code holds the
    base snapshot and the addition's name, so it can answer "same item" with certainty.

    The arbiter is `standItemKey`, the same rule `stand_items_one_per_location_name` applies
    in the database. Two places must not disagree about what "same item" means.
  */
  describe("an addition naming an already-listed item reaffirms it, never duplicates it", () => {
    it("merges the addition onto the surviving entry instead of appending a second row", () => {
      const proposed = applyInventoryEdits(
        published,
        {
          kind: "edits",
          additions: [{ itemName: "Potatoes" }],
          changes: [],
          removals: [],
        },
        issueDraftId,
      );

      // One Potatoes, keeping its published entry ID and its published position.
      expect(proposed.entries).toEqual([
        { entryId: "e-potato", itemName: "Potatoes", approximation: "plentiful" },
        { entryId: "e-bok", itemName: "Bok choy", approximation: "limited" },
        { entryId: "e-jam", itemName: "Strawberry preserves", priceText: "$8" },
      ]);
    });

    it("matches on case and surrounding whitespace only, exactly as the database does", () => {
      const proposed = applyInventoryEdits(
        published,
        {
          kind: "edits",
          additions: [{ itemName: "  bOK CHOY \t" }],
          changes: [],
          removals: [],
        },
        issueDraftId,
      );

      expect(proposed.entries).toHaveLength(3);
      // The farmer's published spelling wins — VIGA's listing is not restyled by an SMS.
      expect(proposed.entries[1]).toEqual({
        entryId: "e-bok",
        itemName: "Bok choy",
        approximation: "limited",
      });
    });

    it("lets the addition's stated details update the entry it reaffirms", () => {
      // "we have plenty of bok choy at $3" about an item already listed is a real update,
      // not a no-op. The merge is what carries it.
      const proposed = applyInventoryEdits(
        published,
        {
          kind: "edits",
          additions: [{ itemName: "Bok choy", priceText: "$3" }],
          changes: [],
          removals: [],
        },
        issueDraftId,
      );

      expect(proposed.entries[1]).toEqual({
        entryId: "e-bok",
        itemName: "Bok choy",
        approximation: "limited",
        priceText: "$3",
      });
    });

    it("still appends an addition that genuinely is not listed", () => {
      // The mirror. A merge that swallowed real additions would be its own defect.
      const proposed = applyInventoryEdits(
        published,
        {
          kind: "edits",
          additions: [{ itemName: "Green beans" }],
          changes: [],
          removals: [],
        },
        issueDraftId,
      );

      expect(proposed.entries).toHaveLength(4);
      expect(proposed.entries[3]).toEqual({
        entryId: "draft_test",
        itemName: "Green beans",
      });
    });

    it("does not reaffirm an entry the same message is removing", () => {
      // Removal wins: the entry is gone, so an addition of that name is a genuinely new
      // item and must take a fresh draft entry rather than resurrect the removed row.
      const proposed = applyInventoryEdits(
        published,
        {
          kind: "edits",
          additions: [{ itemName: "Potatoes", priceText: "$4" }],
          changes: [],
          removals: [{ entryId: "e-potato" }],
        },
        issueDraftId,
      );

      expect(proposed.entries.map((e) => e.itemName)).toEqual([
        "Bok choy",
        "Strawberry preserves",
        "Potatoes",
      ]);
      expect(proposed.entries[2]).toEqual({
        entryId: "draft_test",
        itemName: "Potatoes",
        priceText: "$4",
      });
    });

    it("collapses two additions of the same item to one entry", () => {
      // Nothing in the snapshot to merge onto, so the first addition creates the entry and
      // the second must find it. Without this the same duplicate reaches a first listing.
      const ids = ["draft_a", "draft_b"];
      const proposed = applyInventoryEdits(
        null,
        {
          kind: "edits",
          additions: [{ itemName: "Kale" }, { itemName: "kale", priceText: "$2" }],
          changes: [],
          removals: [],
        },
        () => ids.shift() ?? "exhausted",
      );

      expect(proposed.entries).toEqual([
        { entryId: "draft_a", itemName: "Kale", priceText: "$2" },
      ]);
    });
  });

  /*
    B-092, second defect — a quantity the farmer's message never stated.

    "We have kale" carries no number, and the real model supplied one in 6 of 8 runs:
    `12` three times and `1` three times. `12` is the dangerous one — it publishes a
    specific false claim about a farmer's stand; `1` is merely unreadable as "Kale (1)".

    Same class as the unauthorized removal above, and settled the same way: the message is
    the authority, code holds both it and the output, and a number the farmer did not type
    is not a fact. Dropped rather than refused, for the same reason — everything the farmer
    genuinely said still publishes.
  */
  describe("a quantity absent from the farmer's message is not a fact", () => {
    it("drops an invented quantity from an addition", () => {
      const validated = validateInterpretation(
        {
          kind: "edits",
          additions: [{ itemName: "Kale", quantity: 12 }],
          changes: [],
          removals: [],
        },
        published,
        "We have kale",
      );

      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      if (validated.value.kind !== "edits") throw new Error("expected edits");
      expect(validated.value.additions).toEqual([{ itemName: "Kale" }]);
    });

    it("drops an invented quantity from a change", () => {
      const validated = validateInterpretation(
        {
          kind: "edits",
          additions: [],
          changes: [{ entryId: "e-potato", quantity: 1 }],
          removals: [],
        },
        published,
        "still got potatoes",
      );

      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      if (validated.value.kind !== "edits") throw new Error("expected edits");
      expect(validated.value.changes).toEqual([{ entryId: "e-potato" }]);
    });

    it("keeps a quantity the message states as digits", () => {
      const validated = validateInterpretation(
        {
          kind: "edits",
          additions: [{ itemName: "Eggs", quantity: 6, unit: "dozen" }],
          changes: [],
          removals: [],
        },
        published,
        "6 dozen eggs today",
      );

      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      if (validated.value.kind !== "edits") throw new Error("expected edits");
      expect(validated.value.additions).toEqual([
        { itemName: "Eggs", quantity: 6, unit: "dozen" },
      ]);
    });

    it("keeps a quantity the model derived by arithmetic from the farmer's words", () => {
      // FOUND BY THE LIVE MIRROR FIXTURE (2026-08-19). The real model read "6 dozen eggs
      // today" as quantity 72 — correct arithmetic over the farmer's own words — and an
      // earlier guard that checked whether the message stated THAT NUMBER threw it away.
      //
      // The guard asks about PRESENCE, never the value. Reading "6 dozen" as 72 or as 6 is
      // interpretation, which the model owns; code re-deriving it would be a second
      // interpreter. What code can settle with certainty is whether the message contained a
      // number at all.
      const validated = validateInterpretation(
        {
          kind: "edits",
          additions: [{ itemName: "Eggs", quantity: 72, unit: "dozen" }],
          changes: [],
          removals: [],
        },
        published,
        "6 dozen eggs today",
      );

      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      if (validated.value.kind !== "edits") throw new Error("expected edits");
      expect(validated.value.additions[0]?.quantity).toBe(72);
    });

    it("does not let a price's digits authorize a quantity", () => {
      // The other half of presence-only: "$3" is a PRICE, and price is its own field. Without
      // excluding it, a message stating no quantity would carry a number and re-admit exactly
      // the invention this guard drops.
      const validated = validateInterpretation(
        {
          kind: "edits",
          additions: [{ itemName: "Kale", quantity: 3, priceText: "$3" }],
          changes: [],
          removals: [],
        },
        published,
        "kale, $3",
      );

      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      if (validated.value.kind !== "edits") throw new Error("expected edits");
      expect(validated.value.additions).toEqual([{ itemName: "Kale", priceText: "$3" }]);
    });

    it("keeps a quantity the message states as a word the model converted", () => {
      // The seam note tells the model to write "a dozen" as 12, and that is a reading of
      // the farmer's own words rather than an invention. A guard that dropped it would
      // break the documented path.
      const validated = validateInterpretation(
        {
          kind: "edits",
          additions: [{ itemName: "Eggs", quantity: 12, unit: "eggs" }],
          changes: [],
          removals: [],
        },
        published,
        "a dozen eggs",
      );

      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      if (validated.value.kind !== "edits") throw new Error("expected edits");
      expect(validated.value.additions[0]?.quantity).toBe(12);
    });

    it("keeps the unit and price when only the quantity is invented", () => {
      // Dropping the whole detail set would lose facts the farmer did state.
      const validated = validateInterpretation(
        {
          kind: "edits",
          additions: [{ itemName: "Kale", quantity: 1, unit: "bunch", priceText: "$3" }],
          changes: [],
          removals: [],
        },
        published,
        "kale by the bunch, $3",
      );

      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      if (validated.value.kind !== "edits") throw new Error("expected edits");
      expect(validated.value.additions).toEqual([
        { itemName: "Kale", unit: "bunch", priceText: "$3" },
      ]);
    });

    it("leaves the structured direct editor's quantities alone", () => {
      // A farmer typing 4 into a web form has stated it as plainly as a farmer texting it.
      // There is no message to check, so the guard must not reach this path at all.
      const validated = validateStructuredInventoryEdit(
        {
          kind: "edits",
          additions: [{ itemName: "Kale", quantity: 4 }],
          changes: [],
          removals: [],
        },
        published,
      );

      expect(validated.ok).toBe(true);
      if (!validated.ok) return;
      if (validated.value.kind !== "edits") throw new Error("expected edits");
      // The VALUE, not just the verdict: the guard drops silently rather than refusing, so
      // an `ok: true` assertion alone cannot see a quantity going missing.
      //
      // The exemption is doubly held and this test pins the OUTCOME rather than either
      // mechanism: `withoutInventedQuantity` no-ops on an absent `taskText`, AND
      // `validateStructuredInventoryEdit` returns the candidate it was given rather than the
      // validator's rewritten value. Breaking either one alone leaves this green, which is
      // the point — a farmer typing 4 into a form has stated it, whichever path carries it.
      expect(validated.value.additions).toEqual([{ itemName: "Kale", quantity: 4 }]);
    });
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
