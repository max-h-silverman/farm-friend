import { describe, expect, it } from "vitest";
import { hashPhone, normalizePhone, PhoneNormalizationError } from "./phone";

describe("phone privacy (Golden Rule #5)", () => {
  it("normalizes US/CA numbers to +1XXXXXXXXXX", () => {
    expect(normalizePhone("(206) 555-1234")).toBe("+12065551234");
    expect(normalizePhone("206.555.1234")).toBe("+12065551234");
    expect(normalizePhone("12065551234")).toBe("+12065551234");
    expect(normalizePhone("+1 206 555 1234")).toBe("+12065551234");
  });

  it("throws on non-phone input rather than guessing", () => {
    expect(() => normalizePhone("hello")).toThrow(PhoneNormalizationError);
    expect(() => normalizePhone("12345")).toThrow(PhoneNormalizationError);
  });

  it("hash is deterministic and never returns the raw number", () => {
    const salt = "test-salt";
    const h1 = hashPhone("(206) 555-1234", salt);
    const h2 = hashPhone("206-555-1234", salt);
    expect(h1).toBe(h2); // same normalized number → same hash
    expect(h1).not.toContain("2065551234");
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("different salts produce different hashes (no cross-tenant correlation)", () => {
    expect(hashPhone("2065551234", "salt-a")).not.toBe(hashPhone("2065551234", "salt-b"));
  });
});
