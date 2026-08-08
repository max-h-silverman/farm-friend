import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  bypassesModel,
  parseCommand,
  REGISTERED_HELP_KEYWORDS,
  REGISTERED_OPT_IN_KEYWORDS,
  REGISTERED_OPT_OUT_KEYWORDS,
} from "./commands";

const registeredFieldValues = resolve(
  __dirname,
  "../../../../docs/TELNYX_10DLC_FIELD_VALUES.txt",
);
const workersSource = resolve(
  __dirname,
  "../../../../apps/web/lib/workers.ts",
);

function executableSource(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/^import[\s\S]*?;$/gm, "");
}

describe("deterministic stand targeting keywords (F-051)", () => {
  it("parses STAND and SETTINGS as whole-message farmer commands that bypass the model", () => {
    for (const keyword of ["STAND", "SETTINGS"] as const) {
      expect(parseCommand(keyword)).toEqual({ kind: "farmer", keyword });
      expect(bypassesModel(keyword)).toBe(true);
      expect(parseCommand(`open ${keyword.toLowerCase()}`)).toEqual({ kind: "none" });
    }
  });

  it("parses a whole positive number as a context-bound stand choice", () => {
    expect(parseCommand(" 2. ")).toEqual({
      kind: "stand_selection",
      optionNumber: 2,
      contextBound: true,
    });
    for (const body of ["0", "-1", "2 stands", "1.5", "01"]) {
      expect(parseCommand(body), body).toEqual({ kind: "none" });
    }
  });

  it("keeps the full fixed precedence: compliance, commitment, farmer, paging, stand choice", () => {
    for (const keyword of [
      ...REGISTERED_OPT_OUT_KEYWORDS,
      ...REGISTERED_OPT_IN_KEYWORDS,
      ...REGISTERED_HELP_KEYWORDS,
      "FLAG",
    ]) {
      expect(parseCommand(keyword).kind, keyword).toBe("compliance");
    }
    for (const token of ["YES", "NO", "Y", "N"]) {
      expect(parseCommand(token).kind, token).toBe("commitment");
    }
    for (const keyword of ["LINK", "STAND", "SETTINGS"]) {
      expect(parseCommand(keyword).kind, keyword).toBe("farmer");
    }
    // `JOIN` belongs in this list for ONE reason now: the bare word is compliance, and it must
    // stay in that tier. Its argument form was removed (max 2026-08-07) — onboarding completes
    // with a bare START matched by phone — so a well-formed token is free text, asserted here
    // so a re-added grammar cannot slip back in unnoticed.
    expect(parseCommand("JOIN").kind).toBe("compliance");
    expect(parseCommand(`JOIN ${"a".repeat(64)}`).kind).toBe("none");
    for (const keyword of ["MORE", "NEXT"]) {
      expect(parseCommand(keyword).kind, keyword).toBe("paging");
    }
    expect(parseCommand("1").kind).toBe("stand_selection");
  });

  it("never represents product targeting words as carrier-registered keywords", () => {
    const registeredWords: readonly string[] = [
      ...REGISTERED_OPT_OUT_KEYWORDS,
      ...REGISTERED_OPT_IN_KEYWORDS,
      ...REGISTERED_HELP_KEYWORDS,
    ];
    const registered = readFileSync(registeredFieldValues, "utf8");
    const keywordBlock = registered.slice(registered.indexOf("KEYWORDS"));
    for (const keyword of ["STAND", "SETTINGS"]) {
      expect(registeredWords).not.toContain(keyword);
      expect(keywordBlock).not.toMatch(new RegExp(`\\b${keyword}\\b`));
    }
  });

  it("wires each targeting call site with database and configured origin but no model", () => {
    const workers = executableSource(workersSource);
    expect(workers).toMatch(
      /handleFarmerTarget\(\s*\{\s*db:\s*deps\.db,\s*publicBaseUrl:\s*deps\.publicBaseUrl\s*\},\s*input,?\s*\)/,
    );
    expect(workers).toMatch(
      /handleStandSelection\(\s*\{\s*db:\s*deps\.db,\s*publicBaseUrl:\s*deps\.publicBaseUrl\s*\},\s*input,?\s*\)/,
    );
  });
});

describe("deterministic scheduled SAME wiring (F-052)", () => {
  it("anchors the live handler call to database and clock only", () => {
    const workers = executableSource(workersSource);
    expect(workers).toMatch(
      /handleScheduledSame\(\s*\{\s*db:\s*deps\.db,\s*clock:\s*deps\.clock\s*\},\s*input,?\s*\)/,
    );
  });
});
