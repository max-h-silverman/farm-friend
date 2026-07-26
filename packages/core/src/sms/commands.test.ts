import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bypassesModel,
  parseCommand,
  REGISTERED_HELP_KEYWORDS,
  REGISTERED_OPT_IN_KEYWORDS,
  REGISTERED_OPT_OUT_KEYWORDS,
} from "./commands";

describe("deterministic command parsing (Golden Rule #2)", () => {
  it("compliance + commitment tokens all bypass the model", () => {
    for (const tok of ["STOP", "STOPALL", "START", "JOIN", "HELP", "INFO", "FLAG", "YES", "NO"]) {
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

  // Every opt-out keyword VIGA registered with the carrier and promised publicly must
  // unsubscribe globally. A registered opt-out that parses as free text is a Golden Rule #2
  // violation, not copy drift — see REGISTERED_OPT_OUT_KEYWORDS.
  it("every registered opt-out keyword unsubscribes globally", () => {
    for (const w of REGISTERED_OPT_OUT_KEYWORDS) {
      const parsed = parseCommand(w);
      expect(parsed).toEqual({ kind: "compliance", keyword: "STOP", global: true });
    }
  });

  it("STOPALL unsubscribes globally regardless of conversation state", () => {
    // parseCommand takes only the body: there is NO state parameter it could consult,
    // and the same normalization applies as to every other opt-out.
    for (const w of ["STOPALL", "stopall", "  StopAll  ", "STOPALL."]) {
      expect(parseCommand(w)).toEqual({ kind: "compliance", keyword: "STOP", global: true });
    }
    expect(bypassesModel("STOPALL")).toBe(true);
  });

  it("YES/NO are context-bound, never global", () => {
    for (const tok of ["YES", "NO"]) {
      const parsed = parseCommand(tok);
      expect(parsed.kind).toBe("commitment");
      if (parsed.kind === "commitment") expect(parsed.contextBound).toBe(true);
    }
  });

  // The approved launch set has exactly two commitment tokens. OUT and IGNORE were removed
  // with the superseded stock-out commitment path: a stock-out alert asks the farmer for
  // current inventory, which uses the ordinary proposal + YES/NO flow. A farmer texting
  // "OUT" must reach the model as ordinary inventory language, never commit anything.
  it("OUT and IGNORE are not tokens — they are free text", () => {
    for (const word of ["OUT", "out", "IGNORE", "ignore"]) {
      expect(parseCommand(word)).toEqual({ kind: "none" });
      expect(bypassesModel(word)).toBe(false);
    }
  });

  it("commitment tokens use the same trim, case, and trailing-punctuation normalization", () => {
    expect(parseCommand(" yes. ")).toEqual({ kind: "commitment", token: "YES", contextBound: true });
    expect(parseCommand("Y")).toEqual({ kind: "commitment", token: "YES", contextBound: true });
    expect(parseCommand("Yep")).toEqual({ kind: "commitment", token: "YES", contextBound: true });
    expect(parseCommand("YEA!")).toEqual({ kind: "commitment", token: "YES", contextBound: true });
    expect(parseCommand("sure")).toEqual({ kind: "commitment", token: "YES", contextBound: true });

    expect(parseCommand(" no. ")).toEqual({ kind: "commitment", token: "NO", contextBound: true });
    expect(parseCommand("n")).toEqual({ kind: "commitment", token: "NO", contextBound: true });
    expect(parseCommand("Nope")).toEqual({ kind: "commitment", token: "NO", contextBound: true });
    expect(parseCommand("NAH!")).toEqual({ kind: "commitment", token: "NO", contextBound: true });
    expect(parseCommand("no thanks")).toEqual({ kind: "commitment", token: "NO", contextBound: true });
    expect(parseCommand("No Thank You.")).toEqual({ kind: "commitment", token: "NO", contextBound: true });
  });

  it("tokens must be the whole normalized message", () => {
    expect(parseCommand("please don't stop the alerts").kind).toBe("none");
    expect(bypassesModel("we are out of tomatoes at the moment")).toBe(false);
    expect(parseCommand("yes, still right").kind).toBe("none");
    expect(parseCommand("no thanks, but change it").kind).toBe("none");
    expect(parseCommand("y still right").kind).toBe("none");
    expect(parseCommand("n but change it").kind).toBe("none");
  });

  it("a free-text farmer message is not a command (goes to the model)", () => {
    expect(parseCommand("tomatoes, kale, a lot of eggs").kind).toBe("none");
    expect(bypassesModel("tomatoes, kale, a lot of eggs")).toBe(false);
  });

  it("every registered opt-in and help keyword is parsed as that keyword", () => {
    for (const w of REGISTERED_OPT_IN_KEYWORDS) {
      const parsed = parseCommand(w);
      expect(parsed).toEqual({ kind: "compliance", keyword: w, global: false });
    }
    for (const w of REGISTERED_HELP_KEYWORDS) {
      const parsed = parseCommand(w);
      expect(parsed).toEqual({ kind: "compliance", keyword: w, global: false });
    }
  });
});

// The registered keyword lists are a live external artifact: they were submitted to the
// carrier and are promised on VIGA's public pages. These tests read that file so the two
// cannot drift apart silently in EITHER direction — a keyword registered but unparsed is a
// broken public promise (the STOPALL defect), and a keyword parsed but unregistered means
// live behavior exceeds what was disclosed.
describe("registered 10DLC keywords match the parser (both directions)", () => {
  const registered = readFileSync(
    new URL("../../../../docs/TELNYX_10DLC_FIELD_VALUES.txt", import.meta.url),
    "utf8",
  );

  function registeredField(label: string): string[] {
    const match = registered.match(new RegExp(`^${label}\\n(.+)$`, "m"));
    if (!match) throw new Error(`registered field not found: ${label}`);
    return match[1]!.split(",").map((word) => word.trim());
  }

  it("the registered opt-out keywords are exactly the ones code treats as global STOP", () => {
    expect(registeredField("Opt out keywords").sort()).toEqual(
      [...REGISTERED_OPT_OUT_KEYWORDS].sort(),
    );
  });

  it("the registered opt-in keywords are exactly the ones code accepts", () => {
    expect(registeredField("Opt in keywords").sort()).toEqual(
      [...REGISTERED_OPT_IN_KEYWORDS].sort(),
    );
  });

  it("the registered help keywords are exactly the ones code accepts", () => {
    expect(registeredField("Help keywords").sort()).toEqual(
      [...REGISTERED_HELP_KEYWORDS].sort(),
    );
  });

  it("no registered field or sample message advertises a token code does not honor", () => {
    // OUT and IGNORE were removed from the launch set; the registered artifact must not
    // promise them. FLAG is a Farm Friend product safety feature and must never appear in
    // a registered KEYWORDS field as though the carrier mandated it.
    expect(registered).not.toMatch(/\bReply OUT\b/);
    expect(registered).not.toMatch(/\bIGNORE\b/);
    for (const label of ["Opt in keywords", "Opt out keywords", "Help keywords"]) {
      expect(registeredField(label)).not.toContain("FLAG");
    }
  });

  // Every sample message is copy a carrier reviewer reads as representative of live traffic.
  // A sample that omits opt-out language understates what the service actually sends, so the
  // recorded artifact must not drift below the compliant form now live in the console.
  it("every sample message carries opt-out language", () => {
    const samples = registered.match(/^VIGA Farm Friend: .+$/gm) ?? [];
    const sampleBlock = registered.slice(registered.indexOf("SAMPLE MESSAGES"));
    const sampleLines = sampleBlock.match(/^VIGA Farm Friend: .+$/gm) ?? [];

    expect(samples.length).toBeGreaterThan(0);
    expect(sampleLines.length).toBeGreaterThan(0);
    for (const line of sampleLines) {
      expect(line).toMatch(/\bSTOP\b/);
    }
  });

  // The declared campaign attributes must stay true of the recorded copy. `Embedded Phone
  // Number: No` was contradicted by a HELP auto-response containing a support number; the
  // console now directs help to email, so the declaration and the copy agree.
  it("declares no embedded phone number and contains none in its auto-responses", () => {
    expect(registered).toMatch(/^Embedded Phone Number\nNo$/m);

    const autoResponses = registered.slice(
      registered.indexOf("AUTO-RESPONSES"),
      registered.indexOf("SAMPLE MESSAGES"),
    );
    // Any North-American style number in copy a carrier reads as an embedded phone number.
    expect(autoResponses).not.toMatch(/(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  });
});
