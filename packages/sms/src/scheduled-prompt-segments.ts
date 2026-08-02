import { estimateSmsSegments } from "./segments";

/** Scheduled inventory prompts may use at most two carrier-billable SMS segments. */
export const MAX_SCHEDULED_PROMPT_SEGMENTS = 2;

/** The one authoritative safety decision for offering SAME with a visible full snapshot. */
export function scheduledPromptFitsSms(body: string): boolean {
  return estimateSmsSegments(body).segmentCount <= MAX_SCHEDULED_PROMPT_SEGMENTS;
}
