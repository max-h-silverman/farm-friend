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

export function buildSignupSmsUrl(fromNumber: string, invitationToken: string): string {
  return `sms:${fromNumber}?body=${encodeURIComponent(`SIGNUP ${invitationToken}`)}`;
}
