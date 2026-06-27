export type SmsCommand =
  | { kind: "join" }
  | { kind: "start" }
  | { kind: "stop" }
  | { kind: "help" }
  | { kind: "flag" }
  | { kind: "yes" }
  | { kind: "no" }
  | { kind: "none" };

const OPT_OUT = new Set(["STOP", "UNSUBSCRIBE", "END", "QUIT"]);
const HELP = new Set(["HELP", "INFO"]);

export function parseSmsCommand(rawBody: string): SmsCommand {
  const trimmed = normalizeLeadingKeywordInput(rawBody);
  if (trimmed === "") return { kind: "none" };

  const match = trimmed.match(/^(\S+)(?:\s+.*)?$/s);
  if (!match) return { kind: "none" };

  const firstToken = stripOuterPunctuation(match[1] ?? "").toUpperCase();
  if (firstToken === "JOIN") return { kind: "join" };
  if (firstToken === "START") return { kind: "start" };
  if (OPT_OUT.has(firstToken)) return { kind: "stop" };
  if (HELP.has(firstToken)) return { kind: "help" };
  if (firstToken === "FLAG") return { kind: "flag" };
  if (firstToken === "YES") return { kind: "yes" };
  if (firstToken === "NO") return { kind: "no" };

  return { kind: "none" };
}

export function isDeterministicSmsCommand(rawBody: string): boolean {
  return parseSmsCommand(rawBody).kind !== "none";
}

function normalizeLeadingKeywordInput(rawBody: string): string {
  return rawBody
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim();
}

function stripOuterPunctuation(token: string): string {
  return token
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N}]+$/u, "");
}
