import { randomInt } from "node:crypto";

// F-078 — the emailed verification code.
//
// WHY EMAIL AND NOT SMS. A texted code to an unconsented number is forbidden both by the
// consent architecture and by the registered 10DLC campaign: Farm Friend may not send first.
// Email carries no such restriction, and VIGA already holds a roster, so an emailed code
// proves something real — *you control the address VIGA has on file for this farm*.

/** Digits in a verification code. Six is the length people already expect from this pattern. */
export const CODE_LENGTH = 6;

/**
 * How long a code stays valid.
 *
 * Long enough that a farmer who checks mail on a phone, walks inside, and types it on a laptop
 * still succeeds; short enough that a code left sitting in an inbox is not a standing key. The
 * number is stated ONCE here and rendered into the email from this constant, so the message can
 * never promise a window the code does not actually have.
 */
export const CODE_TTL_MINUTES = 30;

/**
 * A fresh code.
 *
 * `randomInt` is the CRYPTO random source, not `Math.random`. This is a credential: it is the
 * only thing standing between someone who knows a farm's email address and control of that
 * farm's public listing.
 *
 * **Returned as a STRING, and it stays one everywhere.** Codes have leading zeros; a code that
 * becomes a number anywhere in its life turns `012345` into `12345`, and the farmer's correct
 * code is then refused with no way for them to tell why.
 */
export function generateVerificationCode(): string {
  return String(randomInt(0, 10 ** CODE_LENGTH)).padStart(CODE_LENGTH, "0");
}

/**
 * Read a code the way a farmer actually submits it.
 *
 * Copy-pasting from an email brings spaces, and people space or hyphenate the groups
 * themselves. Accepting those is not laxity — the alternative is refusing a farmer who typed
 * the right code, which sends them to the reply button. Anything that is not exactly the
 * right count of digits is rejected outright; there is no partial match.
 */
export function normalizeSubmittedCode(submitted: string): string | null {
  const digits = submitted.replace(/[\s-]/g, "");
  return new RegExp(`^[0-9]{${CODE_LENGTH}}$`).test(digits) ? digits : null;
}

/**
 * Whether a code issued at `issuedAt` is expired at `now`.
 *
 * Takes the clock as an argument rather than reading it, so expiry is testable at the
 * boundary. **The boundary itself is expired**, not valid — an off-by-one here is a code that
 * outlives its stated window, and the honest direction to round is toward refusing.
 *
 * A `now` BEFORE `issuedAt` is also expired. A clock that ran backwards must never produce a
 * code that is valid indefinitely.
 */
export function isCodeExpired(issuedAt: Date, now: Date): boolean {
  const elapsedMs = now.getTime() - issuedAt.getTime();
  return elapsedMs < 0 || elapsedMs >= CODE_TTL_MINUTES * 60_000;
}

export interface VerificationEmailInput {
  code: string;
  /** The farm this code is for. Named in the body so the farmer knows what it concerns. */
  farmName: string;
  /** The monitored address a confused farmer can reply to. Configuration, never hard-coded. */
  replyToAddress: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
}

/**
 * Render the verification email.
 *
 * **Written to minimize replies** (max, 2026-08-06), which is a real cost: replies land in
 * VIGA's board mailbox and a volunteer answers them by hand. Every choice below removes a
 * reason someone would write back:
 *
 *   - **The code is in the SUBJECT.** The single biggest one. A farmer who sees the code in
 *     their phone's notification never opens the mail, never interprets it, never replies.
 *   - **The subject names VIGA and the farm stand map**, so it does not read as spam from an
 *     unknown sender — "is this real?" is the second most likely reply.
 *   - **The farm is named in the first sentence.** A farmer with a code and no idea which
 *     listing it concerns has to ask.
 *   - **The code sits alone on its own line**, so it survives every mail client's wrapping and
 *     can be read aloud or copied cleanly.
 *   - **The expiry is stated in the same words as the rule**, rendered from `CODE_TTL_MINUTES`,
 *     so the promise cannot drift from the behavior.
 *   - **A recipient who did not ask for it is told to ignore it** — otherwise their only
 *     reasonable move is to reply and ask what it is.
 *   - **NO LINK.** A code plus a link is the exact shape of a phishing mail, and a cautious
 *     farmer replies to check rather than clicking. The farmer is already on the page that
 *     asked for the code.
 *   - **Nothing is requested back.** No password, no confirmation, no personal detail.
 *   - **Plain text, no markup.** Nothing for a mail client to mangle into something that looks
 *     broken, and broken-looking mail gets replied to.
 *
 * Replies are still welcome and the address is given — the goal is fewer CONFUSED replies, not
 * a farmer who cannot reach a person.
 */
export function renderVerificationEmail(input: VerificationEmailInput): RenderedEmail {
  if (normalizeSubmittedCode(input.code) !== input.code) {
    throw new Error("renderVerificationEmail requires an exact verification code");
  }
  const farmName = input.farmName.trim();
  if (farmName === "") {
    // A sentence with a hole where the farm name goes is worse than no mail: it is precisely
    // the kind of broken-looking message that produces a reply.
    throw new Error("renderVerificationEmail requires a farm name");
  }

  const subject = `${input.code} is your VIGA Farm Stand Map code`;

  const text = [
    `Hello,`,
    ``,
    `Someone asked to update the farm stand listing for ${farmName} on the VIGA`,
    `Farm Stand Map. If that was you, here is your code:`,
    ``,
    `${input.code}`,
    ``,
    `Type it on the page that asked for it. It works for ${CODE_TTL_MINUTES} minutes,`,
    `then you can request a new one.`,
    ``,
    `We will never ask you for a password. There is nothing to click in this email.`,
    ``,
    `If you were not expecting this, you can safely ignore it. Nothing changes on`,
    `the map unless the code is used.`,
    ``,
    `Questions? Just reply to this email and a VIGA volunteer will help.`,
    ``,
    `— VIGA Farm Stand Map`,
    `${input.replyToAddress}`,
  ].join("\n");

  return { subject, text };
}
