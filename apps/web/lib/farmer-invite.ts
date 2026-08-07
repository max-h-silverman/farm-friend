export type FarmerInviteChannel = "sms" | "email";

export function normalizeInvitePhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return null;
}

export function inviteMessage(input: { farmName: string | null; link: string }): string {
  const opening =
    input.farmName === null
      ? "You are invited to start farmer onboarding."
      : `${input.farmName} invited you to start farmer onboarding.`;
  return (
    `VIGA Farm Friend: ${opening} ` +
    `Open this link and follow the steps: ${input.link}`
  );
}

export function buildInviteDeliveryUrl(
  channel: FarmerInviteChannel,
  destination: string,
  message: string,
): string {
  if (channel === "sms") {
    return `sms:${destination}?body=${encodeURIComponent(message)}`;
  }
  return (
    `mailto:${destination}?subject=${encodeURIComponent("Join VIGA Farm Friend")}` +
    `&body=${encodeURIComponent(message)}`
  );
}

/**
 * The prepared text that redeems an invitation (F-080 — `JOIN`, replacing `SIGNUP`).
 *
 * The body must match `parseCommand`'s `JOIN <64-hex>` grammar exactly. Anything else — a
 * greeting prepended, the token wrapped in punctuation — is free text that reaches the model
 * and leaves the invitation unspent, with nothing to tell the farmer why.
 */
export function buildInviteSmsUrl(fromNumber: string, invitationToken: string): string {
  return buildKeywordSmsUrl(fromNumber, `JOIN ${invitationToken}`);
}

/**
 * A tap-to-text link that composes an exact message to Farm Friend's own number.
 *
 * One builder rather than a hand-written `sms:` string per surface. The stray `?&body=` that a
 * hand-rolled version produced is the reason: a malformed link silently opens the composer with
 * an EMPTY body on some handsets, so the farmer sends a blank message, nothing matches the
 * deterministic keyword grammar, and there is nothing to tell them why setup did not finish.
 *
 * The body must match `parseCommand`'s grammar exactly — anything else is free text.
 */
export function buildKeywordSmsUrl(fromNumber: string, message: string): string {
  return `sms:${fromNumber}?body=${encodeURIComponent(message)}`;
}
