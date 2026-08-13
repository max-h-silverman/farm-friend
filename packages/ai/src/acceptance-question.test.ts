import { describe, expect, it } from "vitest";
import { isAcceptanceQuestion } from "./acceptance-question";

/*
  F-111 — the acceptance-question fast path.

  "who takes viga bucks?" is a real customer question that the classifier stably misroutes to
  `system_inquiry`: VIGA is an organisation name, so the model reads the message as being about
  the organisation. Two attempts to fix it with instruction wording BOTH regressed other cases
  ("what are viga bucks" flipped to search_stands, and an unrelated case destabilised), because
  a prompt rule mentioning payment gets applied to any message containing the payment word
  regardless of what is being asked.

  The distinction is SYNTACTIC, so code owns it. These cases pin the shape.
*/
describe("the acceptance-question matcher", () => {
  it.each([
    ["who takes viga bucks?", "the production query"],
    ["who accepts viga bucks", "accepts"],
    ["which stands take viga bucks", "which stands"],
    ["which stands accept farm bucks?", "which stands accept"],
    ["does anyone take viga bucks", "does anyone"],
    ["does anyone accept farm bucks", "already in the fixture"],
    ["who takes cash?", "generic payment"],
    ["who accepts cards", "generic payment"],
    ["Who Takes VIGA Bucks?", "case-insensitive"],
    ["  who takes venmo  ", "surrounding whitespace"],
    ["hi, who takes viga bucks?", "politeness prefix"],
    ["does anybody take checks", "anybody"],
    ["who still takes farm bucks", "an adverb between subject and verb"],
    ["what stands take viga bucks", "what stands"],
    ["which farms accept farm bucks", "which farms"],
    ["who honors viga bucks", "honors"],
    ["is anyone taking viga bucks", "gerund WITH its auxiliary"],
    ["are any stands accepting farm bucks", "gerund WITH its auxiliary"],
  ])("matches %j — %s", (text) => {
    expect(isAcceptanceQuestion(text)).toBe(true);
  });

  /**
   * A SPECIFIC stand makes it a lookup about that stand, not a search across stands. The
   * matcher must stay silent so the model classifies it — this is the boundary that would
   * otherwise send a single-stand question down the search path.
   */
  it.each([
    ["does Pinecone take viga bucks?", "named stand"],
    ["does Plum Forest take cash", "named stand"],
    ["does Misty Isle accept farm bucks", "named stand"],
    ["Pinecone Gardens takes viga bucks", "a statement about a stand"],
  ])("stays silent on %j — %s", (text) => {
    expect(isAcceptanceQuestion(text)).toBe(false);
  });

  /** "What IS x" asks about the thing itself; only "who accepts x" asks about stands. */
  it.each([
    ["what are viga bucks", "asks what the currency is"],
    ["what is viga", "asks what the organisation is"],
    ["what are farm bucks?", "asks what the currency is"],
    ["how do viga bucks work", "asks how it works"],
  ])("stays silent on %j — %s", (text) => {
    expect(isAcceptanceQuestion(text)).toBe(false);
  });

  it.each([
    ["who has eggs?", "inventory search, not acceptance"],
    ["who has strawberries in season", "inventory search"],
    ["no eggs left at Pinecone Gardens", "inventory report"],
    ["sold out of tomatoes", "inventory report"],
    ["we have kale and eggs today", "farmer update"],
    ["who's open Sunday", "hours search, not acceptance"],
    ["which stands are open right now?", "hours search"],
    ["where's the farm stand map?", "system"],
    ["hi", "chitchat"],
    ["thanks!", "chitchat"],
    ["are you a robot", "system"],
    ["what's the weather going to be tomorrow", "unclear"],
    ["can you give me a recipe for zucchini bread", "unclear"],
    ["tomatoes?", "bare product"],
    ["Pinecone Gardens", "bare stand name"],
  ])("stays silent on %j — %s", (text) => {
    expect(isAcceptanceQuestion(text)).toBe(false);
  });

  /**
   * The near-misses. Each is one small edit from a real acceptance question, and each is why
   * the pattern is anchored, requires an object, and splits finite verbs from gerunds.
   */
  it.each([
    ["I know who takes viga bucks", "a statement, not a question"],
    ["tell me who takes viga bucks", "subject buried mid-sentence"],
    ["the stand that takes viga bucks is closed", "a relative clause"],
    ["who took my eggs", "past tense, and not about acceptance"],
    ["anyone taking donations", "a gerund with no auxiliary"],
    ["stands accepting cash today", "a bare gerund phrase"],
    ["who takes", "no object"],
    ["whose stand accepts cash", "'whose', not 'who'"],
  ])("rejects the near-miss %j — %s", (text) => {
    expect(isAcceptanceQuestion(text)).toBe(false);
  });

  it("is not tied to any organisation, currency, or payment vocabulary", () => {
    // The matcher recognises a SHAPE. Nothing in it knows what the object is, so a VIGA
    // rename cannot break it and an unrelated object still matches.
    expect(isAcceptanceQuestion("who takes bottle caps")).toBe(true);
    expect(isAcceptanceQuestion("who takes zlotys")).toBe(true);
    // And a payment word alone never triggers it — only the question shape does.
    expect(isAcceptanceQuestion("viga bucks")).toBe(false);
    expect(isAcceptanceQuestion("I have viga bucks")).toBe(false);
  });
});
