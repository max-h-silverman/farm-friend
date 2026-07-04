import { describe, expect, it } from "vitest";
import { bypassesModel, parseCommand } from "./commands";

describe("deterministic command parsing (Golden Rule #2)", () => {
  it("compliance + commitment tokens all bypass the model", () => {
    for (const tok of ["STOP", "START", "JOIN", "HELP", "INFO", "FLAG", "YES", "NO", "OUT", "IGNORE"]) {
      expect(bypassesModel(tok)).toBe(true);
    }
  });

  it("STOP is always global and never context-bound", () => {
    const parsed = parseCommand("STOP");
    expect(parsed).toEqual({ kind: "compliance", keyword: "STOP", global: true });
  });

  it("STOP synonyms all map to a global opt-out", () => {
    for (const w of ["UNSUBSCRIBE", "END", "QUIT", "CANCEL", "stop", "  Stop  "]) {
      const parsed = parseCommand(w);
      expect(parsed.kind).toBe("compliance");
      if (parsed.kind === "compliance") {
        expect(parsed.keyword).toBe("STOP");
        expect(parsed.global).toBe(true);
      }
    }
  });

  it("YES/NO/OUT/IGNORE are context-bound, never global", () => {
    for (const tok of ["YES", "NO", "OUT", "IGNORE"]) {
      const parsed = parseCommand(tok);
      expect(parsed.kind).toBe("commitment");
      if (parsed.kind === "commitment") expect(parsed.contextBound).toBe(true);
    }
  });

  it("only the first token is a keyword — prose containing a keyword mid-sentence is not a command", () => {
    expect(parseCommand("please don't stop the alerts").kind).toBe("none");
    // "out" appears mid-sentence, not as the first token → not the OUT commitment token.
    expect(bypassesModel("we are out of tomatoes at the moment")).toBe(false);
    // but a bare leading token IS the command.
    expect(parseCommand("OUT").kind).toBe("commitment");
  });

  it("a free-text farmer message is not a command (goes to the model)", () => {
    expect(parseCommand("tomatoes, kale, a lot of eggs").kind).toBe("none");
    expect(bypassesModel("tomatoes, kale, a lot of eggs")).toBe(false);
  });
});
