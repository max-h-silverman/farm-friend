import { describe, expect, it } from "vitest";
import { maskPhoneSuffix } from "./phone";

// F-030 — what an operator may see of a phone number.
//
// The flag-review surface has to identify a thread to a human without handing them a number
// they could call, text, or paste anywhere. Golden Rule #5 says the raw E.164 lives in exactly
// one column read only by the outbound send path; the operator surface is not that path.
//
// So the mask does NOT take a phone number. It takes the last four digits, which the admin
// query extracts in SQL (`right(phone_e164, 4)`) so the full number is never materialized in
// application memory in the first place. This function only renders what it is given, and it
// cannot render more than four digits even if a caller hands it more.
//
// The mask is deliberately LOSSY: two different numbers may share one, and that is correct —
// it exists to let a person say "this thread", not to identify a subscriber.

describe("maskPhoneSuffix", () => {
  it("renders the last four digits and nothing else", () => {
    expect(maskPhoneSuffix("0701")).toBe("(•••) •••-0701");
  });

  it("never emits anything matching a raw E.164", () => {
    // The specific pattern the admin-surface tests grep for. If the mask ever rendered enough
    // digits to match it, every "no phone in the response" assertion would silently stop
    // testing anything.
    const masked = maskPhoneSuffix("0701");
    expect(masked).not.toMatch(/\+?1?\d{10}/);
    expect(masked.replace(/\D/g, "")).toBe("0701");
  });

  it("masks different numbers sharing a suffix identically", () => {
    // Not a defect: the mask identifies a conversation, never a person. Making it
    // collision-free would mean carrying more of the number than an operator needs.
    expect(maskPhoneSuffix("0701")).toBe(maskPhoneSuffix("0701"));
  });

  it("refuses more than four digits rather than rendering them", () => {
    // The failure this guards is a caller passing the whole number by mistake. Echoing it
    // would turn the privacy helper into the leak. It throws instead of truncating, because
    // silently truncating would hide the bug at the call site.
    expect(() => maskPhoneSuffix("2065550701")).toThrow();
    expect(() => maskPhoneSuffix("+12065550701")).toThrow();
  });

  it("refuses a non-digit or short suffix rather than echoing it", () => {
    expect(() => maskPhoneSuffix("")).toThrow();
    expect(() => maskPhoneSuffix("07a1")).toThrow();
    expect(() => maskPhoneSuffix("071")).toThrow();
  });

  it("renders an unknown sender without inventing digits", () => {
    // A flag can carry a null contact hash, so the surface must have an honest rendering for
    // "no sender on this record" that is not a fabricated mask.
    expect(maskPhoneSuffix(null)).toBe("(unknown sender)");
  });
});
