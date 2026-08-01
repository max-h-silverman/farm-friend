// Public listing strings are untrusted even after model schema validation. A farmer can
// deliberately type contact details, and the model can place them in any free-form field,
// so content safety belongs at the shared publication boundary rather than at a model seam.
//
// This is deliberately narrow: launch forbids direct farmer contact. It is not a general PII
// detector, does not encode farm/food vocabulary, and does not silently rewrite farmer text.

export type ProhibitedPublicStringKind =
  | "phone_number"
  | "email_address"
  | "web_link"
  | "direct_contact_instruction";

export type PublicStringValidation =
  | { ok: true }
  | { ok: false; prohibited: ProhibitedPublicStringKind[] };

// Same North-American raw-number class as the outbound guard, bounded so a UUID's hex run
// cannot masquerade as a phone number (B-001). Core cannot import the SMS adapter: dependency
// direction is db/sms/ai -> core, never core -> an adapter package.
const PHONE_NUMBER =
  /(?<![0-9A-Za-z_])(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?![0-9A-Za-z_])/;

const EMAIL_ADDRESS = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
const EMAIL_ADDRESSES = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;

// Protocol links, www links, and ordinary bare domains. The naked-domain branch cannot
// start after @, a dot, or a word character, so an email is reported as an email rather than
// misleadingly reported as both an email and a nested web link.
const WEB_LINK =
  /(?:https?:\/\/|www\.)\S+|(?<![@.\w])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:\/\S*)?/i;

// Direct-contact instructions are consequences, not semantic inventory. Keep the pattern to
// explicit contact verbs plus an instruction target; words such as "callaloo" and ordinary
// prose containing "message" do not match merely because they share vocabulary.
const DIRECT_CONTACT_INSTRUCTION =
  /\b(?:call|text|email|message|contact|dm|reach)\s+(?:me|us|the\s+(?:farm(?:er)?|owner|seller|stand)|(?:for|to)\b)/i;

const checks: ReadonlyArray<{
  kind: ProhibitedPublicStringKind;
  matches(value: string): boolean;
}> = [
  { kind: "phone_number", matches: (value) => PHONE_NUMBER.test(value) },
  { kind: "email_address", matches: (value) => EMAIL_ADDRESS.test(value) },
  {
    kind: "web_link",
    // Strip the complete email first. A dotted local part such as `farm.team+stand` can
    // otherwise look like a bare domain even though the farmer needs to remove one thing.
    matches: (value) => WEB_LINK.test(value.replace(EMAIL_ADDRESSES, " ")),
  },
  {
    kind: "direct_contact_instruction",
    matches: (value) => DIRECT_CONTACT_INSTRUCTION.test(value),
  },
];

/** Validate a complete set of strings about to become public. */
export function validatePublicStrings(values: readonly string[]): PublicStringValidation {
  const prohibited = checks
    .filter(({ matches }) => values.some((value) => matches(value)))
    .map(({ kind }) => kind);

  return prohibited.length === 0 ? { ok: true } : { ok: false, prohibited };
}

const refusalLabels: Record<ProhibitedPublicStringKind, string> = {
  phone_number: "a phone number",
  email_address: "an email address",
  web_link: "a web link",
  direct_contact_instruction: "a direct-contact instruction",
};

function humanList(values: readonly string[]): string {
  if (values.length <= 1) return values[0] ?? "the contact detail";
  if (values.length === 2) return `${values[0]} and ${values[1]}`;
  return `${values.slice(0, -1).join(", ")}, and ${values.at(-1)}`;
}

/** Code-owned refusal copy shared by SMS and farmer web. */
export function renderPublicStringRefusal(
  prohibited: readonly ProhibitedPublicStringKind[],
): string {
  return (
    `I couldn't publish that. Remove ${humanList(prohibited.map((kind) => refusalLabels[kind]))}, ` +
    "then send the update again."
  );
}
