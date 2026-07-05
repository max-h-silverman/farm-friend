// Deterministic compliance + commitment parsing — runs by CODE before any model call.
// See docs/ARCHITECTURE.md §routing and docs/SMS_COMPLIANCE.md. This is Golden Rule #2:
// STOP is always global and can never be reinterpreted by conversation state; YES/NO/OUT/IGNORE
// are context-bound, never global.

export type ComplianceKeyword =
  | "STOP"
  | "START"
  | "JOIN"
  | "HELP"
  | "INFO"
  | "FLAG";

export type CommitmentToken = "YES" | "NO" | "OUT" | "IGNORE";

export type ParsedCommand =
  | { kind: "compliance"; keyword: ComplianceKeyword; global: boolean }
  | { kind: "commitment"; token: CommitmentToken; contextBound: true }
  | { kind: "none" };

// STOP synonyms all map to a single global opt-out (SMS_COMPLIANCE keyword table).
const STOP_WORDS = new Set(["STOP", "UNSUBSCRIBE", "END", "QUIT", "CANCEL"]);
const COMPLIANCE_WORDS: Record<string, ComplianceKeyword> = {
  START: "START",
  JOIN: "JOIN",
  HELP: "HELP",
  INFO: "INFO",
  FLAG: "FLAG",
};
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
  OUT: "OUT",
  IGNORE: "IGNORE",
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
    // STOP is ALWAYS global — never context-bound, never overridable by state.
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
