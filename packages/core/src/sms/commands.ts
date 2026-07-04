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
  NO: "NO",
  N: "NO",
  OUT: "OUT",
  IGNORE: "IGNORE",
};

/**
 * Parse a raw inbound SMS body into a deterministic command, before any model call.
 * Only the FIRST token is considered a keyword — a message that merely contains "stop" in a
 * sentence is not an opt-out, but a bare "STOP" always is.
 */
export function parseCommand(body: string): ParsedCommand {
  const first = body.trim().split(/\s+/)[0]?.toUpperCase() ?? "";

  if (STOP_WORDS.has(first)) {
    // STOP is ALWAYS global — never context-bound, never overridable by state.
    return { kind: "compliance", keyword: "STOP", global: true };
  }
  const compliance = COMPLIANCE_WORDS[first];
  if (compliance) {
    return { kind: "compliance", keyword: compliance, global: false };
  }
  const commitment = COMMITMENT_WORDS[first];
  if (commitment) {
    return { kind: "commitment", token: commitment, contextBound: true };
  }
  return { kind: "none" };
}

/** True if this message must bypass the LLM (any deterministic keyword/token). */
export function bypassesModel(body: string): boolean {
  return parseCommand(body).kind !== "none";
}
