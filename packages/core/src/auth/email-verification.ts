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
}

export interface RenderedEmail {
  subject: string;
  text: string;
  /** Styled version for mail clients that support HTML, alongside the plain-text fallback. */
  html: string;
}

/**
 * Render the verification email.
 *
 * The plain-text fallback remains the exact same message. HTML-capable mail clients receive an
 * alternative where the code is visually prominent, without excluding clients that do not
 * render markup.
 */
export function renderVerificationEmail(input: VerificationEmailInput): RenderedEmail {
  if (normalizeSubmittedCode(input.code) !== input.code) {
    throw new Error("renderVerificationEmail requires an exact verification code");
  }

  const subject = `${input.code} is your Farm Friend verification code`;

  const text = [
    `Hi there,`,
    ``,
    `Here’s your Farm Friend verification code:`,
    ``,
    `${input.code}`,
    ``,
    `This code is valid for ${CODE_TTL_MINUTES} minutes.`,
    ``,
    `If you didn’t request this, no worries. You can safely ignore this email.`,
    ``,
    `Thanks,`,
    `VIGA Farm Friend`,
  ].join("\n");

  const html = [
    "<p>Hi there,</p>",
    "<p>Here’s your Farm Friend verification code:</p>",
    `<p style="margin: 24px 0; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 32px; font-weight: 700; letter-spacing: 0.12em; line-height: 1;">${input.code}</p>`,
    `<p>This code is valid for ${CODE_TTL_MINUTES} minutes.</p>`,
    "<p>If you didn’t request this, no worries. You can safely ignore this email.</p>",
    "<p>Thanks,<br>VIGA Farm Friend</p>",
  ].join("");

  return { subject, text, html };
}
