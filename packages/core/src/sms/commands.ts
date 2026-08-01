// Deterministic compliance + commitment parsing — runs by CODE before any model call.
// See docs/ARCHITECTURE.md §routing and docs/SMS_COMPLIANCE.md. This is Golden Rule #2:
// STOP is always global and can never be reinterpreted by conversation state; YES/NO are
// context-bound, never global.

export type ComplianceKeyword =
  | "STOP"
  | "START"
  | "JOIN"
  | "HELP"
  | "INFO"
  | "FLAG";

export type CommitmentToken = "YES" | "NO";

/**
 * The farmer-facing product keywords (F-040).
 *
 * `SIGNUP` asks VIGA to set the farmer up; `LINK` asks for the web form link. Like `FLAG`,
 * these are **Farm Friend product keywords, never carrier compliance keywords**, and they must
 * never be registered as such — `farmer-keywords.test.ts` asserts both directions.
 *
 * They are parsed deterministically for the same reason everything else here is: a farmer
 * asking to be set up must not depend on a model being available, correct, or affordable.
 * Neither one grants anything by itself — `SIGNUP` opens a queue entry VIGA acts on, and
 * `LINK` is refused unless the sender is already an authorized farmer.
 */
export type FarmerKeyword = "SIGNUP" | "LINK" | "STAND" | "SETTINGS";

export type ParsedCommand =
  | { kind: "compliance"; keyword: ComplianceKeyword; global: boolean }
  | { kind: "commitment"; token: CommitmentToken; contextBound: true }
  | { kind: "farmer"; keyword: FarmerKeyword }
  /**
   * `MORE` — the next page of a customer's result list (F-046).
   *
   * A Farm Friend **product** keyword, never a carrier compliance keyword, and
   * **context-bound** like a commitment token: it means nothing without a pending list, and
   * the paging state — not this parser — decides what it refers to. Parsed here for the same
   * reason everything else is: reading the next three stands must not depend on a model being
   * available, correct, or affordable.
   *
   * It is deliberately INDEPENDENT of the commitment tokens (max, 2026-07-31). A farmer with
   * an open inventory confirmation who texts MORE gets their next page and keeps the
   * confirmation open — the words do not overlap, so blocking one for the other would solve a
   * collision that does not exist.
   */
  | { kind: "paging"; contextBound: true }
  /** A numbered choice from the sender's current server-issued STAND menu. */
  | { kind: "stand_selection"; optionNumber: number; contextBound: true }
  | { kind: "none" };

// The keywords registered with the carrier in docs/TELNYX_10DLC_FIELD_VALUES.txt and promised
// on VIGA's public pages. They are stated ONCE, here, and the parser tables below are derived
// from them, so a keyword cannot be advertised without being honored. commands.test.ts reads
// the registered file and asserts both directions of that agreement.
//
// FLAG is deliberately absent: it is a Farm Friend product safety feature, not a
// carrier-mandated keyword, and must never be registered as one.
export const REGISTERED_OPT_OUT_KEYWORDS = [
  "STOP",
  "STOPALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
] as const;
export const REGISTERED_OPT_IN_KEYWORDS = ["JOIN", "START"] as const;
export const REGISTERED_HELP_KEYWORDS = ["HELP", "INFO"] as const;

// Every registered opt-out keyword maps to the single global opt-out.
const STOP_WORDS: ReadonlySet<string> = new Set(REGISTERED_OPT_OUT_KEYWORDS);

const COMPLIANCE_WORDS: Record<string, ComplianceKeyword> = {
  ...Object.fromEntries(REGISTERED_OPT_IN_KEYWORDS.map((word) => [word, word])),
  ...Object.fromEntries(REGISTERED_HELP_KEYWORDS.map((word) => [word, word])),
  FLAG: "FLAG",
};

// The only two commitment tokens. `OUT`/`IGNORE` are NOT tokens: a stock-out alert asks the
// farmer for current inventory, and that reply uses the ordinary proposal + YES/NO flow.
// Leaving them in would let a farmer who texts "out" publish something they never reviewed.
const COMMITMENT_WORDS: Record<string, CommitmentToken> = {
  YES: "YES",
  Y: "YES",
  YEP: "YES",
  YEA: "YES",
  SURE: "YES",
  NO: "NO",
  N: "NO",
  NOPE: "NO",
  NAH: "NO",
  "NO THANKS": "NO",
  "NO THANK YOU": "NO",
};

/**
 * The farmer product keywords and the spellings a farmer actually sends.
 *
 * "SIGN UP" as two words is here because that is how people write it — and because the
 * normalizer below collapses internal whitespace, so it arrives as one string to match. This
 * table stays deliberately small: it is a fixed keyword list, not a vocabulary the system
 * tries to understand. Anything not listed is free text, which is the honest default.
 */
const FARMER_WORDS: Record<string, FarmerKeyword> = {
  SIGNUP: "SIGNUP",
  "SIGN UP": "SIGNUP",
  LINK: "LINK",
  STAND: "STAND",
  SETTINGS: "SETTINGS",
};

/**
 * The paging words (F-046). Deliberately tiny — "NEXT" is the only synonym, because both are
 * words a person actually sends for "show me the rest" and neither means anything else on its
 * own. A message must match ENTIRELY, so "any more eggs?" stays a question and reaches the
 * model as free text rather than being swallowed as a page request.
 */
const PAGING_WORDS: ReadonlySet<string> = new Set(["MORE", "NEXT"]);

function normalizeCommandMessage(body: string): string {
  return body
    .trim()
    .replace(/[.!?,;:]+$/g, "")
    .trim()
    // Internal runs of whitespace collapse to one space, so "sign  up" and "sign\nup" are the
    // same command. Every existing keyword is a single word and is unaffected.
    .replace(/\s+/g, " ")
    .toUpperCase();
}

/**
 * Parse a raw inbound SMS body into a deterministic command, before any model call.
 * A command matches only when the entire normalized message is a fixed code-listed keyword,
 * token, or variant.
 */
export function parseCommand(body: string): ParsedCommand {
  const normalized = normalizeCommandMessage(body);

  if (STOP_WORDS.has(normalized)) {
    // STOP is ALWAYS global — never context-bound, never overridable by state. This branch
    // takes no conversation state, so no state can reinterpret it.
    return { kind: "compliance", keyword: "STOP", global: true };
  }
  const compliance = COMPLIANCE_WORDS[normalized];
  if (compliance) {
    return { kind: "compliance", keyword: compliance, global: false };
  }
  const commitment = COMMITMENT_WORDS[normalized];
  if (commitment) {
    return { kind: "commitment", token: commitment, contextBound: true };
  }
  // LAST among the keyword branches, deliberately. A farmer product keyword must never be
  // able to shadow a compliance keyword or a commitment token: if `SIGNUP` were checked
  // first and someone added a synonym that collided with `STOP`, an opt-out would stop
  // working. Ordering makes that impossible rather than merely unlikely.
  const farmer = FARMER_WORDS[normalized];
  if (farmer) {
    return { kind: "farmer", keyword: farmer };
  }
  // Also last, for the same reason as the farmer keywords: a paging word must never shadow a
  // compliance keyword or a commitment token. Reaching here means the message matched none of
  // them.
  if (PAGING_WORDS.has(normalized)) {
    return { kind: "paging", contextBound: true };
  }
  // A number is meaningful only against the sender's current server-issued stand menu.
  // Leading zeroes are refused so the reply has one canonical spelling and cannot become a
  // second command grammar. The menu repository — not this parser — decides whether the
  // number is bound, current, and authorized.
  if (/^[1-9]\d*$/.test(normalized)) {
    const optionNumber = Number(normalized);
    if (Number.isSafeInteger(optionNumber)) {
      return { kind: "stand_selection", optionNumber, contextBound: true };
    }
  }
  return { kind: "none" };
}

/** True if this message must bypass the LLM (any deterministic keyword/token). */
export function bypassesModel(body: string): boolean {
  return parseCommand(body).kind !== "none";
}
