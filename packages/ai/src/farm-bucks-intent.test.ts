import { describe, expect, it } from "vitest";
import { farmBucksIntent } from "./farm-bucks-intent";

/*
  F-111 — the VIGA Bucks domain resolver.

  The classifier misreads messages containing "VIGA" because it is an organisation name with no
  meaning to a general model: "does Pinecone take VIGA Bucks?" returned `system_inquiry` even
  though it names a stand, and "what is viga" returned `search_stands`. Two attempts to fix this
  with instruction wording each fixed one case and regressed another.

  VIGA Bucks is a FIXED PROGRAM OF THE SERVICE — one concept, already a column pair in the
  schema — so code recognises it, the way code recognises MAP or STOP.

  THE RESOLVER CLAIMS QUESTION SHAPES, NOT THE PHRASE (max, 2026-08-13). Containing "viga bucks"
  is necessary and never sufficient: only the three supported question shapes are claimed, and
  everything else falls through to the ordinary classifier.
*/
describe("the VIGA Bucks domain resolver", () => {
  describe("general acceptance or spending -> search", () => {
    it.each([
      "who takes VIGA Bucks?",
      "who accepts viga bucks",
      "which stands take viga bucks",
      "does anyone accept viga bucks",
      "where can I spend viga bucks",
      "where can I use my viga bucks",
      "who takes farm bucks?",
      "which sellers accept farm bucks",
      "anywhere I can spend farm bucks",
    ])("%j", (text) => {
      expect(farmBucksIntent(text)).toBe("search");
    });
  });

  describe("what they are, or how to get them -> about", () => {
    it.each([
      "what are VIGA Bucks?",
      "what are viga bucks",
      "what is a viga buck",
      "how do I get viga bucks",
      "where do I get viga bucks",
      "how do viga bucks work",
      "how can I buy farm bucks",
      "what are farm bucks",
      "where do I buy viga bucks",
    ])("%j", (text) => {
      expect(farmBucksIntent(text)).toBe("about");
    });
  });

  describe("acceptance at one specific stand -> stand_scoped", () => {
    // Maps straight to `stand_lookup`, whether or not the name resolves (max, 2026-08-13):
    // "does Blahblah take viga bucks" IS a question about one specific stand, and what happens
    // when that stand does not exist is the downstream no-match path's job, not a
    // classification input.
    it.each([
      "does Pinecone take VIGA Bucks?",
      "does Plum Forest accept viga bucks",
      "does Misty Isle take farm bucks",
      "will Pinecone Gardens take viga bucks",
      "does Blahblah take viga bucks",
    ])("%j", (text) => {
      expect(farmBucksIntent(text)).toBe("stand_scoped");
    });
  });

  /**
   * THE DOMAIN OVERRIDE (max, 2026-08-13).
   *
   * "no viga bucks left" means the VIGA Bucks ALLOCATION is exhausted — not that a farm stand
   * is out of something. Grammatically it is indistinguishable from "no eggs left", and the
   * general classifier returned `inventory_report` for it, correctly applying an instruction
   * rule we need for real reports ("an inventory statement with no stand named is still
   * inventory_report"). The model is not wrong; it simply lacks the domain fact that VIGA
   * Bucks are not stand inventory. The APPLICATION holds that fact, so the override belongs
   * here rather than in prose that would endanger "no eggs left".
   *
   * The system holds no data and promises no behaviour about VIGA Bucks distribution, so
   * `unclear` is the honest answer. What matters most is what it must NEVER be:
   * `inventory_report`, which routes it into farm inventory handling.
   */
  describe("unsupported statements about the concept -> unsupported_statement", () => {
    it.each([
      ["no viga bucks left", "allocation exhausted, NOT farm inventory"],
      ["out of viga bucks", "same shape"],
      ["my viga bucks expired", "a statement about the currency"],
      ["I earned viga bucks at the market", "a statement"],
      ["I have viga bucks", "a statement"],
      ["all out of farm bucks", "the schema's own name for them"],
    ])("%j — %s", (text) => {
      expect(farmBucksIntent(text)).toBe("unsupported_statement");
    });
  });

  /**
   * A mention that carries no semantic claim about the concept still falls through — the
   * resolver overrides where it holds domain knowledge, not wherever the words appear.
   */
  describe("non-semantic mentions still fall through -> null", () => {
    it.each([
      ["viga bucks", "the bare phrase, no statement"],
      ["thanks for the viga bucks", "gratitude — chitchat is the right answer"],
      ["the viga bucks program is great", "an opinion about the program"],
    ])("%j — %s", (text) => {
      expect(farmBucksIntent(text)).toBeNull();
    });
  });

  /**
   * The concept is `VIGA Bucks`, never `VIGA`. Bare organisation mentions stay with the
   * ordinary classifier — "what is viga" remains a known miss rather than being swept in here.
   */
  describe("bare VIGA is not the concept -> null", () => {
    it.each([
      "what is viga",
      "who is viga",
      "what does viga do",
      "is viga a nonprofit",
    ])("%j", (text) => {
      expect(farmBucksIntent(text)).toBeNull();
    });
  });

  /** Non-VIGA payment methods stay with the generic acceptance fast path. */
  describe("other payment methods are not this concept -> null", () => {
    it.each([
      "who takes cash",
      "who accepts cards",
      "does anyone take venmo",
      "where can I spend a gift card",
    ])("%j", (text) => {
      expect(farmBucksIntent(text)).toBeNull();
    });
  });

  describe("unrelated traffic -> null", () => {
    it.each([
      "who has eggs?",
      "does Pinecone have eggs",
      "no eggs left at Pinecone Gardens",
      "sold out of tomatoes",
      "hi",
      "where's the farm stand map?",
      "what's the weather going to be tomorrow",
    ])("%j", (text) => {
      expect(farmBucksIntent(text)).toBeNull();
    });
  });

  it("tolerates the spellings people actually type", () => {
    // Case, spacing and punctuation vary; the concept does not.
    expect(farmBucksIntent("WHO TAKES VIGA BUCKS")).toBe("search");
    expect(farmBucksIntent("who takes Viga  Bucks!")).toBe("search");
    expect(farmBucksIntent("who takes vigabucks")).toBe("search");
    expect(farmBucksIntent("what are Viga-Bucks?")).toBe("about");
    expect(farmBucksIntent("  who takes viga bucks  ")).toBe("search");
    // Singular reads the same as plural.
    expect(farmBucksIntent("who takes a viga buck")).toBe("search");
  });

  it("does not fire on a subject buried mid-sentence", () => {
    // The same anchoring the generic acceptance matcher uses: a question shape must LEAD.
    expect(farmBucksIntent("I know who takes viga bucks")).toBeNull();
    expect(farmBucksIntent("tell me who takes viga bucks")).toBeNull();
    expect(farmBucksIntent("the stand that takes viga bucks is closed")).toBeNull();
  });
});
