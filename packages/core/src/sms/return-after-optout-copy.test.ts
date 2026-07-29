import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ALREADY_JOINED_RESPONSE } from "./auto-responses";

// GL-034. B-011 established a rule the CODE now enforces: `JOIN` enrolls only a first-time
// sender, and once a consent record exists only `START` restores consent — because Telnyx
// keeps its own opt-out list, `START` is the carrier keyword that clears it, and `JOIN` means
// nothing to that layer.
//
// The failure this file exists to prevent is not a code failure. It is a WORDS failure: a
// farmer who opted out, reads "text JOIN to come back", texts JOIN, is refused, and stays
// blocked with no idea why. The code is right and the instructions are wrong, so the person
// is stuck. Every place a human is told how to resume messaging must name START.
//
// Two artifacts carry that instruction and neither was asserted before:
//
//  1. `ALREADY_JOINED_RESPONSE` — the reply a returning sender actually receives. It is NOT
//     registered 10DLC copy (see the doc comment where it is defined) and is NOT pinned to
//     docs/TELNYX_10DLC_FIELD_VALUES.txt, so it is freely editable — which also means nothing
//     stopped it from drifting to name the wrong word.
//  2. docs/VIGA_10DLC_WEBSITE_COPY.md — the paste-ready public Squarespace copy. This is what
//     a farmer or customer actually READS before they ever text anything, and no test policed
//     it at all.
//
// Deliberately NOT asserted here: docs/TELNYX_10DLC_FIELD_VALUES.txt. That file is a
// transcript of live carrier console state, changed only by changing the console first. A
// test that demanded new wording there would push a future editor into falsifying the
// transcript, which is the one thing that file must never contain.

describe("the reply to a returning sender names START (GL-034, B-011)", () => {
  it("tells a returning sender to reply START", () => {
    // Anchored to START as an instruction the recipient can act on, not to the bare word
    // appearing anywhere in the body.
    expect(ALREADY_JOINED_RESPONSE).toMatch(/\bReply START\b/);
  });

  it("does not tell a returning sender to reply JOIN", () => {
    // The whole defect class in one assertion: JOIN is the word that will NOT work for this
    // recipient, so instructing it here would send them back into the same refusal.
    expect(ALREADY_JOINED_RESPONSE).not.toMatch(/\b(?:reply|text|send)\s+JOIN\b/i);
  });

  it("still carries opt-out and help routes, like every reply we originate", () => {
    expect(ALREADY_JOINED_RESPONSE).toMatch(/\bSTOP\b/);
    expect(ALREADY_JOINED_RESPONSE).toMatch(/\bHELP\b/);
  });

  // The campaign declares `Embedded Phone Number: No`. This body is not registered copy, but
  // it is still copy this code sends, so the declaration has to stay true of it too.
  it("embeds no phone number", () => {
    expect(ALREADY_JOINED_RESPONSE).not.toMatch(
      /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/,
    );
  });
});

describe("public website copy tells a returning user to text START (GL-034)", () => {
  const websiteCopy = readFileSync(
    new URL("../../../../docs/VIGA_10DLC_WEBSITE_COPY.md", import.meta.url),
    "utf8",
  );

  /** The "Opt Out" section of the public SMS Terms page — where returning is explained. */
  function optOutSection(): string {
    const start = websiteCopy.indexOf("## Opt Out");
    expect(start).toBeGreaterThan(-1);
    const rest = websiteCopy.slice(start + "## Opt Out".length);
    const end = rest.indexOf("\n## ");
    return end === -1 ? rest : rest.slice(0, end);
  }

  // THE ASSERTION. The opt-out section is the one place on the public pages that speaks to
  // someone who has already unsubscribed. Before GL-034 it said they would receive no further
  // messages "unless you request to rejoin" — naming no word at all, which leaves the reader
  // to reach for JOIN, the word the carrier will not honour for them.
  it("names START as the word that resumes messaging after an opt-out", () => {
    expect(optOutSection()).toMatch(/\bSTART\b/);
  });

  it("does not tell an opted-out reader to text JOIN to come back", () => {
    // Scoped to the opt-out section on purpose: JOIN is correct elsewhere on the page as the
    // FIRST-TIME call to action, and a whole-document ban would be wrong.
    expect(optOutSection()).not.toMatch(/\bJOIN\b/);
  });

  // The first-time call to action must survive this change. START restores, but JOIN is still
  // the published opt-in keyword and the one the registered campaign advertises — removing it
  // would break the registration rather than fix the copy.
  it("keeps JOIN as the published first-time opt-in call to action", () => {
    expect(websiteCopy).toMatch(/text JOIN to \+1 206-864-5326/i);
  });
});
