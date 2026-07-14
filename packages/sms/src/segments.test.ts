import { describe, expect, it, vi } from "vitest";
import {
  estimateSmsSegments,
  normalizeAvoidableSmsUnicode,
  redactOutbound,
  SmsSimulator,
} from "./index";

describe("SMS segment estimation", () => {
  it("estimates a basic GSM-7 message under 160 characters as one segment", () => {
    expect(estimateSmsSegments("VIGA Farm Friend: Reply YES to publish.")).toEqual({
      encoding: "GSM-7",
      characterCount: 39,
      encodingUnitCount: 39,
      segmentCount: 1,
    });
  });

  it("uses concatenated GSM-7 limits for a message over 160 characters", () => {
    expect(estimateSmsSegments("a".repeat(161))).toEqual({
      encoding: "GSM-7",
      characterCount: 161,
      encodingUnitCount: 161,
      segmentCount: 2,
    });
  });

  it("estimates a message containing an emoji as UCS-2", () => {
    expect(estimateSmsSegments("Farm update 🌱")).toEqual({
      encoding: "UCS-2",
      characterCount: 13,
      encodingUnitCount: 14,
      segmentCount: 1,
    });
  });

  it("normalizes curly quotes, dashes, non-breaking spaces, and ellipses", () => {
    const original = "“Kale” isn’t ready—try again tomorrow…\u00a0Thanks";
    const normalized = normalizeAvoidableSmsUnicode(original);

    expect(normalized).toBe('"Kale" isn\'t ready-try again tomorrow... Thanks');
    expect(estimateSmsSegments(original).encoding).toBe("UCS-2");
    expect(estimateSmsSegments(normalized).encoding).toBe("GSM-7");
    expect(redactOutbound(original)).toBe(normalized);
  });

  it("does not destructively alter meaningful user-provided Unicode", () => {
    const original = "Pickup at José’s Café, 12 Ångström Rd. 🌱";
    const normalized = normalizeAvoidableSmsUnicode(original);

    expect(normalized).toBe("Pickup at José's Café, 12 Ångström Rd. 🌱");
    expect(normalized).toContain("José");
    expect(normalized).toContain("Café");
    expect(normalized).toContain("Ångström");
    expect(normalized).toContain("🌱");
  });

  it("logs cost metrics without logging message content", async () => {
    const logger = vi.fn();
    const simulator = new SmsSimulator(logger);

    await simulator.send({
      toPhoneHash: "recipient-hash",
      body: redactOutbound("Reply YES to publish."),
    });

    expect(logger).toHaveBeenCalledWith({
      toPhoneHash: "recipient-hash",
      encoding: "GSM-7",
      characterCount: 21,
      encodingUnitCount: 21,
      segmentCount: 1,
    });
  });
});
