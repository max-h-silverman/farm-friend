import { describe, expect, it } from "vitest";

import {
  EmailNormalizationError,
  hashEmail,
  maskEmail,
  normalizeEmail,
} from "./email";

describe("normalizeEmail", () => {
  it("lowercases and trims so one address has exactly one spelling", () => {
    expect(normalizeEmail("  Cathy@Example.COM ")).toBe("cathy@example.com");
  });

  it("strips the whitespace `btrim` misses, matching the database index", () => {
    // The unique index normalizes with `btrim(email, E' \t\r\n')`. If this disagreed, the
    // ingest would insert a value the index collapses onto another and the failure would
    // name a constraint rather than anything an operator could see.
    expect(normalizeEmail("\t\r\n cathy@example.com \t\r\n")).toBe("cathy@example.com");
  });

  it("refuses a value that is not one address", () => {
    for (const bad of ["", "   ", "cathy", "cathy@", "@example.com", "cathy@example"]) {
      expect(() => normalizeEmail(bad)).toThrow(EmailNormalizationError);
    }
  });

  it("refuses two addresses in one value rather than silently taking the first", () => {
    // The parser splits multi-address cells. Anything reaching here with a separator in it
    // skipped that step, and storing `a@x.com and b@x.com` as one address is unverifiable.
    expect(() => normalizeEmail("a@x.com b@x.com")).toThrow(EmailNormalizationError);
    expect(() => normalizeEmail("a@x.com,b@x.com")).toThrow(EmailNormalizationError);
  });
});

describe("hashEmail", () => {
  it("is deterministic, so the same address always finds the same rows", () => {
    expect(hashEmail("cathy@example.com", "salt")).toBe(
      hashEmail("cathy@example.com", "salt"),
    );
  });

  it("produces the 64-char hex digest the CHECK constraint requires", () => {
    // `farm_emails_hash_is_digest` refuses anything else, so a hash of the wrong shape is a
    // row that can never be written rather than one that silently never matches.
    expect(hashEmail("cathy@example.com", "salt")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes the NORMALIZED address, so case and padding still match", () => {
    expect(hashEmail("  Cathy@Example.COM  ", "salt")).toBe(
      hashEmail("cathy@example.com", "salt"),
    );
  });

  it("separates addresses under one salt", () => {
    expect(hashEmail("a@example.com", "salt")).not.toBe(
      hashEmail("b@example.com", "salt"),
    );
  });

  it("separates the same address under different salts", () => {
    expect(hashEmail("cathy@example.com", "one")).not.toBe(
      hashEmail("cathy@example.com", "two"),
    );
  });

  it("never returns the address itself", () => {
    const digest = hashEmail("cathy@example.com", "salt");
    expect(digest).not.toContain("cathy");
    expect(digest).not.toContain("@");
  });

  it("refuses to hash something that is not an address", () => {
    expect(() => hashEmail("not-an-address", "salt")).toThrow(EmailNormalizationError);
  });
});

describe("maskEmail", () => {
  it("shows enough for an operator to recognize the address, never the whole thing", () => {
    expect(maskEmail("cathy@example.com")).toBe("c•••@example.com");
  });

  it("keeps the domain, which is what makes two farmers distinguishable", () => {
    expect(maskEmail("info@lavenderhill.com")).toBe("i•••@lavenderhill.com");
    expect(maskEmail("info@example.com")).toBe("i•••@example.com");
  });

  it("masks a single-character local part without revealing that it is short", () => {
    // A mask whose length tracked the local part would leak it for short addresses.
    expect(maskEmail("a@example.com")).toBe("a•••@example.com");
  });

  it("reports an absent address rather than fabricating a mask", () => {
    expect(maskEmail(null)).toBe("(no email on file)");
  });

  it("refuses a value that is not an address, rather than masking a bug", () => {
    expect(() => maskEmail("not-an-address")).toThrow(EmailNormalizationError);
  });
});
