import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bypassesModel,
  parseCommand,
  REGISTERED_HELP_KEYWORDS,
  REGISTERED_OPT_IN_KEYWORDS,
  REGISTERED_OPT_OUT_KEYWORDS,
} from "./commands";

/*
  B-091 — `YES <email>` confirms an issue report AND asks for a reply.

  An argument grammar on a commitment token needs more care than most parsing here, because
  `YES` is also the INVENTORY PUBLICATION token: a farmer with an open proposal texts it to
  publish. So the grammar is admitted only when the remainder is a single valid address, and
  the bare token is left exactly as it was. Anything else — `YES please`, `YES two words` —
  stays free text rather than silently publishing or silently confirming.

  This mirrors the reason `JOIN <token>` was REMOVED (max, 2026-08-07): that grammar failed
  identically and silently on a mistyped argument. An address is different in the one way that
  matters — code can tell a valid one from prose, so a typo falls through to free text and is
  answered, instead of being consumed by a token that then does nothing visible.
*/
describe("YES with an email argument (B-091)", () => {
  it("carries the address on the commitment", () => {
    const parsed = parseCommand("YES cathy@example.com");
    expect(parsed).toEqual({
      kind: "commitment",
      token: "YES",
      contextBound: true,
      email: "cathy@example.com",
    });
  });

  it("normalizes the address it carries", () => {
    // One spelling per address, the same rule `normalizeEmail` applies everywhere else.
    expect(parseCommand("  YES   Cathy@Example.COM ")).toMatchObject({
      email: "cathy@example.com",
    });
  });

  it("accepts a + between the token and the address, as the copy offers it", () => {
    expect(parseCommand("YES + cathy@example.com")).toMatchObject({
      kind: "commitment",
      token: "YES",
      email: "cathy@example.com",
    });
  });

  it("leaves a bare YES exactly as it was, carrying no address", () => {
    const parsed = parseCommand("YES");
    expect(parsed).toEqual({ kind: "commitment", token: "YES", contextBound: true });
    expect(parsed).not.toHaveProperty("email");
  });

  it("refuses to read anything that is not one address as a commitment", () => {
    // Each of these would be a publication if the grammar were loose about its argument.
    for (const body of [
      "YES please",
      "YES i have eggs and kale",
      "YES cathy@example.com bob@example.com",
      "YES notanemail",
      "YES @example.com",
    ]) {
      expect(parseCommand(body).kind, body).toBe("none");
    }
  });

  it("never lets an argument attach to NO", () => {
    // A declining sender is not asking to be contacted, so there is nothing for an address to
    // mean here — and admitting one would widen the grammar for no reader.
    expect(parseCommand("NO cathy@example.com").kind).toBe("none");
  });

  it("cannot be used to shadow STOP", () => {
    // The guarantee the ordering exists for: an argument grammar must not create a spelling of
    // an opt-out that stops opting out.
    expect(parseCommand("STOP cathy@example.com").kind).toBe("none");
    expect(parseCommand("STOP")).toMatchObject({ keyword: "STOP", global: true });
  });
});

describe("deterministic command parsing (Golden Rule #2)", () => {
  it("compliance + commitment tokens all bypass the model", () => {
    for (const tok of ["STOP", "STOPALL", "START", "VIGA", "JOIN", "HELP", "INFO", "FLAG", "YES", "NO"]) {
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

  it("treats VIGA as the exact onboarding opt-in keyword, never free text", () => {
    expect(parseCommand(" viga. ")).toEqual({
      kind: "compliance",
      keyword: "VIGA",
      global: false,
    });
  });
});

describe("the SAME scheduled-confirmation keyword (F-052)", () => {
  it("is exact, context-bound, and always bypasses the model", () => {
    for (const body of ["SAME", "same", "  Same  ", "SAME."]) {
      expect(parseCommand(body)).toEqual({ kind: "scheduled_same", contextBound: true });
      expect(bypassesModel(body)).toBe(true);
    }
  });

  it("leaves near-miss text for ordinary interpretation", () => {
    for (const body of ["Same eggs?", "same as yesterday please", "mostly same"]) {
      expect(parseCommand(body)).toEqual({ kind: "none" });
      expect(bypassesModel(body)).toBe(false);
    }
  });

  it("cannot shadow STOP or ordinary YES/NO commitment tokens", () => {
    expect(parseCommand("STOP")).toEqual({ kind: "compliance", keyword: "STOP", global: true });
    expect(parseCommand("YES").kind).toBe("commitment");
    expect(parseCommand("NO").kind).toBe("commitment");
  });
});

describe("the MAP keyword (F-057)", () => {
  it("is an exact deterministic command that bypasses the model", () => {
    for (const body of ["MAP", "map", "  Map  ", "MAP."]) {
      expect(parseCommand(body)).toEqual({ kind: "map" });
      expect(bypassesModel(body)).toBe(true);
    }
  });

  it("leaves sentences mentioning a map for ordinary interpretation", () => {
    for (const body of ["can you map the closest stand?", "map of farm stands", "MAP please"]) {
      expect(parseCommand(body)).toEqual({ kind: "none" });
      expect(bypassesModel(body)).toBe(false);
    }
  });

  it("cannot shadow compliance or commitment commands", () => {
    expect(parseCommand("STOP")).toEqual({ kind: "compliance", keyword: "STOP", global: true });
    expect(parseCommand("START").kind).toBe("compliance");
    expect(parseCommand("YES").kind).toBe("commitment");
  });

  it("is not a carrier-registered keyword", () => {
    const registered = [
      ...REGISTERED_OPT_OUT_KEYWORDS,
      ...REGISTERED_OPT_IN_KEYWORDS,
      ...REGISTERED_HELP_KEYWORDS,
    ] as readonly string[];
    expect(registered).not.toContain("MAP");
  });
});

// The registered keyword lists are a live external artifact: they were submitted to the
// carrier and are promised on VIGA's public pages. These tests read that file so the two
// cannot drift apart silently in EITHER direction — a keyword registered but unparsed is a
// broken public promise (the STOPALL defect), and a keyword parsed but unregistered means
// live behavior exceeds what was disclosed.
// F-046 — MORE is a paging keyword, parsed deterministically like every other keyword.
// It is a Farm Friend PRODUCT keyword, never a carrier compliance keyword, and it is
// context-bound: it means nothing without a pending list.
describe("the MORE paging keyword (F-046)", () => {
  it("parses MORE as a paging command that bypasses the model", () => {
    const parsed = parseCommand("MORE");
    expect(parsed.kind).toBe("paging");
    expect(bypassesModel("MORE")).toBe(true);
  });

  it("is context-bound, never global — like a commitment token, unlike STOP", () => {
    // Paging is meaningless without a pending list. Marking it global would make it a
    // standing instruction, which is what STOP is and what this must never be.
    const parsed = parseCommand("more");
    expect(parsed.kind).toBe("paging");
    if (parsed.kind !== "paging") return;
    expect(parsed).not.toHaveProperty("global", true);
  });

  it("uses the same normalization as every other keyword", () => {
    for (const body of ["more", "  More  ", "MORE.", "More!"]) {
      expect(parseCommand(body).kind, body).toBe("paging");
    }
  });

  it("must be the whole message, so a sentence mentioning more is free text", () => {
    // "any more eggs?" is a QUESTION, not a paging request. Treating it as paging would
    // silently swallow a real inquiry.
    for (const body of ["any more eggs?", "do you have more lamb", "more or less"]) {
      expect(parseCommand(body).kind, body).toBe("none");
    }
  });

  it("can never shadow an opt-out, whatever it is spelled", () => {
    // The ordering guarantee, asserted rather than assumed: every registered opt-out word
    // still parses as a global STOP with the paging branch present.
    for (const word of REGISTERED_OPT_OUT_KEYWORDS) {
      const parsed = parseCommand(word);
      expect(parsed.kind, word).toBe("compliance");
      if (parsed.kind !== "compliance") continue;
      expect(parsed.keyword, word).toBe("STOP");
      expect(parsed.global, word).toBe(true);
    }
  });

  it("does not collide with a commitment token, so a farmer can still confirm", () => {
    // max, 2026-07-31: BOTH work. YES/NO and MORE are different words; paging must not
    // consume a confirmation and a confirmation must not swallow a page request.
    expect(parseCommand("YES").kind).toBe("commitment");
    expect(parseCommand("NO").kind).toBe("commitment");
    expect(parseCommand("MORE").kind).toBe("paging");
  });

  it("is not a registered carrier keyword", () => {
    // Same rule as FLAG: a Farm Friend product keyword must never be registered as a
    // carrier compliance keyword.
    const registered = [
      ...REGISTERED_OPT_OUT_KEYWORDS,
      ...REGISTERED_OPT_IN_KEYWORDS,
      ...REGISTERED_HELP_KEYWORDS,
    ] as readonly string[];
    expect(registered).not.toContain("MORE");
  });
});

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
