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
 * Farm Friend's own number, formatted for a farmer to READ (max 2026-08-07).
 *
 * `206-868-5323`, not `+120658685323`. The stored value is E.164 because that is what the send
 * path dials and what `normalizePhone` produces, but E.164 is a dialing format, not a reading
 * one: a farmer checking a number against their phone's keypad should see the shape they would
 * write down.
 *
 * The country code is dropped rather than rendered as `+1`. Every Farm Friend number is US, so
 * `+1` is a constant that carries no information and only makes the string harder to scan.
 *
 * **Falls back to the input unchanged** when it is not a US E.164 number. A short-code, a
 * non-US number, or an already-formatted string is returned as-is rather than mangled — this is
 * a display helper, and a helper that silently produced a WRONG number would be worse than one
 * that produced an ugly one. `buildInviteSmsUrl` used to live here; it was deleted with the
 * agreement card that was its only caller.
 */
export function formatSmsNumberForDisplay(fromNumber: string): string {
  const match = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(fromNumber.trim());
  if (match === null) return fromNumber;
  return `${match[1]}-${match[2]}-${match[3]}`;
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
