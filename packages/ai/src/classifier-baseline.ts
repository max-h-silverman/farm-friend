/**
 * The classifier's KNOWN, ACCEPTED misses — recorded so a live run can tell a standing baseline
 * from a new regression (B-089).
 *
 * This is a **record of what has already been measured and accepted**, never a place to file a
 * case the model started failing. DEVELOPMENT.md's standing rule holds: a fixture edited to match
 * whatever the model currently does has stopped being a guard. Adding an entry here is a product
 * decision about an ambiguous phrase, taken with production evidence — not a way to make a red
 * run green.
 *
 * WHY THIS EXISTS AS A SHARED LIST. `"when do you open"` was graded twice under two different
 * policies in the same required group: the top-level corpus fixture scored it as an advisory miss
 * (max relabelled it on 2026-08-13 — in an SMS thread with the service, "you" reads as the
 * service), while the second-person fixture failed the whole run on it. Identical code therefore
 * produced 4/5 or 5/5 across runs. The variance was real, but the reason it could stop a release
 * was the contradiction, not the model.
 *
 * Both entries are genuinely ambiguous English rather than model defects:
 *   - "what is viga"      — VIGA is an organisation name the model has no context for.
 *   - "when do you open"  — reads as either the service's hours or a question about stands.
 */
export const ADVISORY_CLASSIFIER_CASES = ["what is viga", "when do you open"] as const;

/** Normalise the spellings the fixtures use for one case: casing, surrounding space, final `?`. */
function normalise(text: string): string {
  return text.trim().toLowerCase().replace(/\?+$/, "").trim();
}

/**
 * True when a miss on `text` is the recorded baseline rather than a new regression.
 *
 * Matches the WHOLE message, never a substring: "when do you open the plum forest stand?" is a
 * stand question and a miss on it is a real defect.
 */
export function isAdvisoryClassifierMiss(text: string): boolean {
  const candidate = normalise(text);
  return ADVISORY_CLASSIFIER_CASES.some((known) => known === candidate);
}
