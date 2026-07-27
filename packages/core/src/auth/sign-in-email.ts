// The sign-in link email — code-rendered, framework-agnostic (F-032).
//
// This is deliberately a pure function in `packages/core` rather than a template the mail
// provider renders. Two reasons, and both are architectural:
//
//   - **No model is reachable from this path.** The body is a function of a link and a
//     duration; there is no parameter through which a requester's text could reach it, so
//     "the sign-in email cannot contain attacker prose" is a property of the signature, not
//     a rule someone has to remember. The requester's address is not interpolated either.
//   - **The provider renders nothing.** A vendor-side template would put the wording — and
//     any tracking a vendor adds by default — outside the repository and outside review.
//     What we send is what is written here.
//
// The link itself is a bearer credential. It is never logged and never returned in an HTTP
// response body; it exists in exactly two places, this message and the recipient's mailbox.

/**
 * How long a sign-in link stays valid. Decided 2026-07-26 (F-032): short, because a link
 * sitting in a mailbox is a live credential, and the durable session it mints carries its
 * own much longer TTL — so a short link costs a real operator nothing but a second request.
 */
export const SIGN_IN_LINK_TTL_MS = 15 * 60_000;

export interface SignInEmail {
  subject: string;
  /**
   * Plain text only. No HTML part: this message needs no formatting, and a text/plain body
   * cannot carry a tracking pixel or a mis-rendered link.
   */
  text: string;
}

export interface SignInEmailInput {
  /** The fully-formed callback URL, built by the caller. Never assembled from user input. */
  link: string;
  /** The link's lifetime, rendered for the reader so a stale link is explicable. */
  ttlMs: number;
}

/** Render the one transactional message Farm Friend sends to an operator. */
export function renderSignInEmail(input: SignInEmailInput): SignInEmail {
  const minutes = Math.round(input.ttlMs / 60_000);

  return {
    subject: "Your Farm Friend sign-in link",
    // The wording says what the link does, how long it lasts, and what to do if it was not
    // requested. Nothing else — no branding, no footer, no second URL.
    text: [
      "Open this link to sign in to Farm Friend admin:",
      "",
      input.link,
      "",
      `The link expires in ${minutes} minutes and can be used once.`,
      "",
      "If you did not request it, you can ignore this message. Nothing has changed on your",
      "account, and no one can sign in without opening the link.",
    ].join("\n"),
  };
}
