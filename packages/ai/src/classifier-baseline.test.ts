import { describe, expect, it } from "vitest";
import { ADVISORY_CLASSIFIER_CASES, isAdvisoryClassifierMiss } from "./classifier-baseline";

describe("advisory classifier baseline", () => {
  it("treats the recorded baseline misses as advisory", () => {
    expect(isAdvisoryClassifierMiss("what is viga")).toBe(true);
    expect(isAdvisoryClassifierMiss("when do you open")).toBe(true);
  });

  /*
    The live-operation fixture writes the phrase with a question mark and the corpus without one.
    They are the same case, and a baseline that recognises only one spelling would let the same
    phrase be advisory in one fixture and fatal in another — which is the B-089 defect itself.
  */
  it("recognises the same case regardless of punctuation or casing", () => {
    expect(isAdvisoryClassifierMiss("when do you open?")).toBe(true);
    expect(isAdvisoryClassifierMiss("  When Do You Open?  ")).toBe(true);
    expect(isAdvisoryClassifierMiss("What Is VIGA")).toBe(true);
  });

  it("does not excuse a case that was never in the baseline", () => {
    expect(isAdvisoryClassifierMiss("who has eggs?")).toBe(false);
    expect(isAdvisoryClassifierMiss("sold out of tomatoes")).toBe(false);
    expect(isAdvisoryClassifierMiss("")).toBe(false);
  });

  it("does not excuse a case merely for containing a baseline phrase", () => {
    expect(isAdvisoryClassifierMiss("when do you open the plum forest stand?")).toBe(false);
  });

  it("keeps the baseline small and explicitly listed", () => {
    expect(ADVISORY_CLASSIFIER_CASES).toEqual(["what is viga", "when do you open"]);
  });
});
