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

export type ParsedCommand =
  | { kind: "compliance"; keyword: ComplianceKeyword; global: boolean }
  | { kind: "commitment"; token: CommitmentToken; contextBound: true }
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

function normalizeCommandMessage(body: string): string {
  return body.trim().replace(/[.!?,;:]+$/g, "").trim().toUpperCase();
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
  return { kind: "none" };
}

/** True if this message must bypass the LLM (any deterministic keyword/token). */
export function bypassesModel(body: string): boolean {
  return parseCommand(body).kind !== "none";
}
