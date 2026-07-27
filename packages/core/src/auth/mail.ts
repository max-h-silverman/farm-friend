// The mail seam (F-032). One narrow capability: send one already-rendered message.
//
// The interface is deliberately this small. It takes a recipient and a rendered subject/body
// — never a template name, never a variable bag, never HTML the provider would assemble. All
// wording lives in `renderSignInEmail`, so swapping vendors cannot change what Farm Friend
// says, and a vendor-side template cannot become an unreviewed second copy of the copy.
//
// It is also the whole provider boundary. F-031 implements this interface against a real
// vendor once one is chosen and its data-handling terms have been READ — never inferred, the
// same rule as the model provider's attestation (docs/AI_ARCHITECTURE.md §provider privacy
// gate). Until then the composition root wires the unconfigured sender below.

export interface MailMessage {
  /** A single recipient. There is no bcc, no list, and no multi-recipient send at launch. */
  to: string;
  subject: string;
  /** Plain text, already rendered by code. */
  text: string;
}

export interface MailSender {
  /**
   * Deliver one message, or throw. A sender must never resolve on a failure it did not
   * perform: the caller's only signal that an operator can sign in is this promise.
   */
  send(message: MailMessage): Promise<void>;
}

/** Thrown when a send is attempted with no mail provider configured. */
export class MailNotConfiguredError extends Error {
  constructor() {
    // Deliberately says nothing about the message: no recipient, no subject, no body. This
    // error is the most likely thing on this path to reach a log, and the body it would be
    // describing contains a live sign-in link.
    super(
      "no mail provider is configured; set one in the composition root (F-031) before sending",
    );
    this.name = "MailNotConfiguredError";
  }
}

/**
 * The sender used when no provider is configured. It FAILS CLOSED — it throws rather than
 * returning success, because a silent no-op would present as a healthy system that never
 * delivers, which is the hardest possible version of this bug to diagnose.
 */
export function createUnconfiguredMailSender(): MailSender {
  return {
    send() {
      return Promise.reject(new MailNotConfiguredError());
    },
  };
}
