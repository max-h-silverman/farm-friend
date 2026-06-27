import { describe, expect, it } from "vitest";
import { hashPhone, normalizePhone, redactPhone } from "./phone.js";

describe("phone privacy helpers", () => {
  it("normalizes common US phone forms to E.164", () => {
    expect(normalizePhone("(206) 555-0100")).toBe("+12065550100");
    expect(normalizePhone("12065550100")).toBe("+12065550100");
    expect(normalizePhone("+12065550100")).toBe("+12065550100");
  });

  it("hashes phones with a required salt for stable non-raw lookup", () => {
    const a = hashPhone("+12065550100", "test-salt");
    const b = hashPhone("(206) 555-0100", "test-salt");
    const c = hashPhone("+12065550100", "other-salt");

    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain("206");
  });

  it("redacts phone numbers for admin display", () => {
    expect(redactPhone("+12065550100")).toBe("+1206****00");
  });
});
