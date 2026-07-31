import { describe, expect, it } from "vitest";
import { FixedClock } from "../clock";
import {
  AnswerRenderError,
  isStale,
  ORIGIN_LIMITATION_STATEMENT,
  PUBLIC_MAP_URL,
  renderGroundedAnswer,
  renderNoCurrentListing,
  renderElapsed,
  renderRecency,
  STALE_AFTER_HOURS,
  validateFactSelection,
  type RetrievedFact,
} from "./answer";

const NOW = new Date("2026-07-25T12:00:00Z");
const clock = new FixedClock(NOW);
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3_600_000);

const facts: RetrievedFact[] = [
  {
    factId: "f1",
    locationName: "Provo Stand",
    farmName: "Provo Farms",
    publicAddress: "11 Stand Way",
    matchedItems: [
      { itemName: "Kale", quantity: 6, unit: "bunches" },
      { itemName: "Eggs", approximation: "limited", priceText: "$6" },
    ],
    asOf: hoursAgo(2),
    basis: "confirmed",
  },
  {
    factId: "f2",
    locationName: "Harbor Stand",
    farmName: "Harbor Farm",
    publicAddress: "9 Dock Rd",
    matchedItems: [{ itemName: "Kale" }],
    asOf: hoursAgo(72),
    basis: "confirmed",
  },
];

describe("selection validation — structural validity is not grounding", () => {
  it("accepts an ordered selection drawn from the retrieved set", () => {
    const result = validateFactSelection({ kind: "selection", factIds: ["f2", "f1"] }, facts);
    expect(result.ok).toBe(true);
    if (result.ok && result.value.kind === "selection") {
      // Order is the model's to propose; code preserves it.
      expect(result.value.factIds).toEqual(["f2", "f1"]);
    }
  });

  it("rejects an identifier outside the retrieved set, however well-formed", () => {
    const result = validateFactSelection(
      { kind: "selection", factIds: ["f1", "f-invented"] },
      facts,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("f-invented");
  });

  it("rejects a deliverable factual string smuggled alongside the identifiers", () => {
    // `answerText` would be the model authoring the authoritative answer.
    for (const extra of [
      { answerText: "Provo has 40 lbs of kale" },
      { distance: "1.2 miles away" },
      { recency: "updated just now" },
    ]) {
      const result = validateFactSelection(
        { kind: "selection", factIds: ["f1"], ...extra },
        facts,
      );
      expect(result.ok).toBe(false);
    }
  });

  it("rejects a duplicated identifier", () => {
    const result = validateFactSelection(
      { kind: "selection", factIds: ["f1", "f1"] },
      facts,
    );
    expect(result.ok).toBe(false);
  });

  it("accepts a bare clarification signal carrying no prose", () => {
    // F-018: the signal is a KIND. `question` was a channel for model-authored text to
    // reach a customer verbatim, so it is gone rather than inspected.
    const ok = validateFactSelection({ kind: "clarification" }, facts);
    expect(ok.ok).toBe(true);
    if (!ok.ok) return;
    expect(ok.value).toEqual({ kind: "clarification" });
  });

  it("refuses a clarification carrying any field beyond its kind", () => {
    for (const extra of [
      { question: "Which farm did you mean?" },
      { question: "Try kale chips: bake at 350F. Can at 15 PSI." },
      { message: "see allrecipes.com" },
      { factIds: ["f1"] },
    ]) {
      const result = validateFactSelection({ kind: "clarification", ...extra }, facts);
      expect(result.ok).toBe(false);
    }
  });

  it("rejects a selection against an empty retrieved set", () => {
    const result = validateFactSelection({ kind: "selection", factIds: ["f1"] }, []);
    expect(result.ok).toBe(false);
  });

  it("accepts an empty selection (the model found nothing relevant)", () => {
    const result = validateFactSelection({ kind: "selection", factIds: [] }, facts);
    expect(result.ok).toBe(true);
  });
});

describe("recency rendering — code states how fresh a fact is", () => {
  it("renders minutes, hours, and days from typed values", () => {
    expect(renderRecency(new Date(NOW.getTime() - 30_000), NOW)).toBe("updated just now");
    expect(renderRecency(hoursAgo(0.5), NOW)).toBe("updated 30 minutes ago");
    expect(renderRecency(hoursAgo(1), NOW)).toBe("updated 1 hour ago");
    expect(renderRecency(hoursAgo(5), NOW)).toBe("updated 5 hours ago");
    expect(renderRecency(hoursAgo(24), NOW)).toBe("updated 1 day ago");
    expect(renderRecency(hoursAgo(72), NOW)).toBe("updated 3 days ago");
  });

  it("marks a fact stale at the threshold, not before", () => {
    expect(isStale(hoursAgo(STALE_AFTER_HOURS - 1), NOW)).toBe(false);
    expect(isStale(hoursAgo(STALE_AFTER_HOURS), NOW)).toBe(true);
  });

  // F-042 — the public map's confirmed line reads "Confirmed 4 hours ago", the SMS answer
  // reads "updated 4 hours ago". Two voices, and the elapsed phrase must be computed ONCE:
  // a second copy of this arithmetic is how web and SMS start disagreeing about how fresh
  // the same row is.
  it("renders the bare elapsed phrase, with no leading verb of its own", () => {
    expect(renderElapsed(new Date(NOW.getTime() - 30_000), NOW)).toBe("just now");
    expect(renderElapsed(hoursAgo(0.5), NOW)).toBe("30 minutes ago");
    expect(renderElapsed(hoursAgo(1), NOW)).toBe("1 hour ago");
    expect(renderElapsed(hoursAgo(5), NOW)).toBe("5 hours ago");
    expect(renderElapsed(hoursAgo(24), NOW)).toBe("1 day ago");
    expect(renderElapsed(hoursAgo(72), NOW)).toBe("3 days ago");
  });

  it("states the elapsed phrase once — renderRecency is that phrase, prefixed", () => {
    // Anchored to agreement between the two renderers rather than to either one's literal
    // output, so a change to the duration wording cannot drift the two apart silently.
    for (const asOf of [
      new Date(NOW.getTime() - 30_000),
      hoursAgo(0.5),
      hoursAgo(1),
      hoursAgo(5),
      hoursAgo(24),
      hoursAgo(72),
    ]) {
      expect(renderRecency(asOf, NOW)).toBe(`updated ${renderElapsed(asOf, NOW)}`);
    }
  });
});

describe("grounded answer rendering — every value comes from typed facts", () => {
  it("renders selected facts in the model's chosen order with items and recency", () => {
    const answer = renderGroundedAnswer(["f1"], facts, clock);
    expect(answer).toContain("Provo Stand");
    expect(answer).toContain("Kale (6 bunches)");
    expect(answer).toContain("Eggs (limited, $6)");
    expect(answer).toContain("updated 2 hours ago");
  });

  it("carries a prominent staleness warning rather than hiding an old listing", () => {
    const answer = renderGroundedAnswer(["f2"], facts, clock);
    expect(answer).toContain("Harbor Stand");
    expect(answer).toContain("updated 3 days ago");
    expect(answer).toContain("may be out of date");
  });

  it("preserves the selected order, since ranking is the model's interpretation", () => {
    const answer = renderGroundedAnswer(["f2", "f1"], facts, clock);
    expect(answer.indexOf("Harbor Stand")).toBeLessThan(answer.indexOf("Provo Stand"));
  });

  it("renders the honest no-listing response when nothing was retrieved", () => {
    const answer = renderNoCurrentListing(["kale"]);
    expect(answer).toContain("No stand has a current listing for kale");
    // Honest about what a listing means, rather than asserting absence as fact.
    expect(answer).toContain("may still be available");
  });

  it("throws rather than rendering a gap for an unretrieved identifier", () => {
    // Unreachable through validateFactSelection; a loud failure beats a silent hole.
    expect(() => renderGroundedAnswer(["f-unknown"], facts, clock)).toThrow(AnswerRenderError);
  });
});

// F-045. Production holds zero inventory revisions, so every SMS question answered "no
// stand has a current listing" while the map showed 212 offering tags. The inquiry path now
// reads offerings too, which means an answer can carry TWO kinds of claim — and they must
// never be confusable, because one is a farmer's confirmation and the other is a standing
// description of what a stand typically stocks.
describe("two-voice grounded answers — confirmed stock and typical offerings (F-045)", () => {
  const lamb: RetrievedFact[] = [
    {
      factId: "confirmed-1",
      locationName: "Provo Stand",
      farmName: "Provo Farms",
      publicAddress: "10142 Vashon Hwy",
      matchedItems: [{ itemName: "lamb" }],
      asOf: hoursAgo(26),
      basis: "confirmed",
    },
    {
      factId: "offering-1",
      locationName: "Alpha Stand",
      farmName: "Alpha Farm",
      publicAddress: "240 SW 190th St",
      matchedItems: [{ itemName: "lamb" }],
      asOf: hoursAgo(26),
      basis: "offering",
    },
    {
      factId: "offering-2",
      locationName: "Beta Stand",
      farmName: "Beta Farm",
      publicAddress: "12 Beta Rd",
      matchedItems: [{ itemName: "frozen lamb" }],
      asOf: hoursAgo(900),
      basis: "offering",
    },
  ];

  it("leads with confirmed stock and lists offerings under a separate label", () => {
    const answer = renderGroundedAnswer(
      ["confirmed-1", "offering-1", "offering-2"],
      lamb,
      clock,
    );
    // Confirmed first, whatever order the model proposed within each group.
    expect(answer.indexOf("Provo")).toBeLessThan(answer.indexOf("Alpha"));
    // The second voice is introduced, not silently concatenated: a customer must be able to
    // see where confirmation stops and description begins.
    expect(answer).toMatch(/also list|typical offering/i);
  });

  it("carries the address for both voices", () => {
    const answer = renderGroundedAnswer(["confirmed-1", "offering-1"], lamb, clock);
    expect(answer).toContain("10142 Vashon Hwy");
    expect(answer).toContain("240 SW 190th St");
  });

  it("gives confirmed stock a recency phrase and never claims present certainty", () => {
    const answer = renderGroundedAnswer(["confirmed-1"], lamb, clock);
    expect(answer).toContain("1 day ago");
    // The honor-system rule: showing WHEN a farmer confirmed is precisely how we avoid
    // asserting what is on the table now. "right now"/"currently has" would be that claim.
    expect(answer).not.toMatch(/right now|currently has|in stock now|guaranteed/i);
  });

  it("gives an offering NO timestamp, because nobody confirmed anything", () => {
    // An offering is a standing description. Attaching an elapsed phrase to it would
    // manufacture a confirmation that never happened — the exact dishonesty F-042 designed
    // the map's two line styles to avoid.
    const answer = renderGroundedAnswer(["offering-1", "offering-2"], lamb, clock);
    // Scoped to the STAND lines. The lead-in is allowed to say nobody confirmed anything —
    // that sentence is the honesty, not a violation of it. What must never appear is an
    // elapsed phrase attached to a stand, which would read as a confirmation.
    const standLines = answer
      .split("\n")
      .filter((line) => /Alpha Stand|Beta Stand/.test(line));
    expect(standLines).toHaveLength(2);
    for (const line of standLines) {
      expect(line).not.toMatch(/ago|updated|confirmed/i);
    }
  });

  it("does not attach the stale warning to an offering", () => {
    // offering-2 is 900 hours old by asOf, well past STALE_AFTER_HOURS. Staleness is a
    // property of a CONFIRMATION going cold; an offering was never fresh to begin with, so
    // warning that it "may be out of date" would imply a confirmation existed.
    const answer = renderGroundedAnswer(["offering-2"], lamb, clock);
    expect(answer).not.toContain("may be out of date");
  });

  it("renders offerings alone when nothing is confirmed, without a confirmed section", () => {
    // The real production case that produced max's screenshot: 212 tags, 0 revisions.
    const answer = renderGroundedAnswer(["offering-1", "offering-2"], lamb, clock);
    expect(answer).toContain("Alpha Stand");
    expect(answer).toContain("Beta Stand");
    // No empty "has lamb" lead-in dangling above the list.
    expect(answer).not.toMatch(/^\s*has /im);
  });
});

describe("the origin limitation statement (F-017)", () => {
  it("says plainly that SMS cannot rank by distance, and points at the web map", () => {
    // The acceptance criterion: an origin-dependent SMS request gets an HONEST code-rendered
    // limitation plus a public-map link — never a fabricated distance and never a silently
    // origin-free ranking presented as if it answered the question.
    expect(ORIGIN_LIMITATION_STATEMENT).toMatch(/text|sms/i);
    expect(ORIGIN_LIMITATION_STATEMENT).toContain(PUBLIC_MAP_URL);
  });

  it("promises no distance, direction, or travel time", () => {
    // Written to fail if someone later softens this into an implied capability. If the
    // constant ever claims to measure or route, these fail.
    expect(ORIGIN_LIMITATION_STATEMENT).not.toMatch(/\d+(\.\d+)?\s*(mi|mile|km|min)/i);
    expect(ORIGIN_LIMITATION_STATEMENT).not.toMatch(/turn|head (north|south|east|west)/i);
  });

  it("is a real https URL rather than a placeholder", () => {
    const url = new URL(PUBLIC_MAP_URL);
    expect(url.protocol).toBe("https:");
    expect(url.hostname).not.toMatch(/example|localhost|todo/i);
  });
});
