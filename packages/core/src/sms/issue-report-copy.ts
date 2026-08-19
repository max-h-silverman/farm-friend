// The two things Farm Friend says about a reported issue (B-091).
//
// Ordinary code-rendered copy, NOT a carrier-registered auto-response — the distinction
// `auto-responses.ts` states applies here too: nothing in this file is transcribed from the
// Telnyx console, and nothing here may be transcribed into it.
//
// They live in core rather than beside the classifier arm that asks the question, because
// BOTH halves of the exchange need them and they sit on opposite sides of a dependency edge:
// the question is asked on the free-text path, and the confirmation is committed in
// deterministic routing, which free-text already imports from. One shared home instead of a
// cycle.

/**
 * The question asked when a message looks like a report that OUR information is wrong (B-091).
 *
 * **It asks rather than files, and that is the whole design.** Recognising an issue report is
 * a model judgement, and a model judgement may not create durable state (Golden Rule #3). So
 * the classification produces a QUESTION; the sender's YES is what commits, and code does the
 * filing. A false positive costs one question instead of a false report in VIGA's queue.
 *
 * It offers the sender the other exit in the same breath — "or tell us more" — because the
 * classification may simply be wrong, and a question with only one answer is a trap. Anything
 * that is not YES lands as an ordinary message and is classified afresh.
 */
export const ISSUE_REPORT_CONFIRMATION =
  "Do you want to let VIGA know about this issue? Reply YES to confirm. " +
  "Reply YES + your email to confirm and get updates on the issue.";

/**
 * What the sender reads once VIGA holds their report.
 *
 * It promises a person will look and claims no timeline — the same promise `FLAG` makes, in
 * the same words, because it is the same queue and a second vocabulary for one outcome is how
 * two outcomes get invented later.
 */
export const ISSUE_REPORT_FILED =
  "Thanks - a VIGA coordinator will review this. Reply STOP to opt out at any time.";

/**
 * What a reporter who left an address reads instead.
 *
 * It says the address was kept, because that is the half they cannot otherwise verify — a
 * reporter told only that someone will look has no way to know whether the part they added
 * landed. It promises a person will look, and still claims no timeline.
 */
export const ISSUE_REPORT_FILED_WITH_REPLY =
  "Thanks - a VIGA coordinator will review this and reply to the email you gave. " +
  "Reply STOP to opt out at any time.";
