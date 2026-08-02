import { describe, expect, it } from "vitest";
import {
  MAX_SCHEDULED_PROMPT_SEGMENTS,
  scheduledPromptFitsSms,
} from "./scheduled-prompt-segments";

describe("scheduled inventory prompt segment ceiling", () => {
  it("accepts the exact two-segment GSM-7 boundary and rejects the first third-segment unit", () => {
    expect(MAX_SCHEDULED_PROMPT_SEGMENTS).toBe(2);
    expect(scheduledPromptFitsSms("a".repeat(306))).toBe(true);
    expect(scheduledPromptFitsSms("a".repeat(307))).toBe(false);
  });

  it("uses the canonical UCS-2 calculation rather than a character-count shortcut", () => {
    expect(scheduledPromptFitsSms("🍅".repeat(67))).toBe(true);
    expect(scheduledPromptFitsSms("🍅".repeat(68))).toBe(false);
  });
});
