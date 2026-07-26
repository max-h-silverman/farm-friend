import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  REGISTERED_HELP_AUTO_RESPONSE,
  REGISTERED_OPT_IN_AUTO_RESPONSE,
  REGISTERED_OPT_OUT_AUTO_RESPONSE,
} from "./auto-responses";

// The auto-response bodies are a live external artifact, like the keyword lists: they were
// submitted to the carrier and a recipient reads them verbatim. These tests read the
// registered transcript so code and registration cannot drift apart silently in EITHER
// direction — copy registered but unsent is a broken promise to the carrier, and copy sent
// but unregistered means live traffic exceeds what was approved.
//
// F-023 added the code side. Before it, this copy existed nowhere in TypeScript at all: the
// campaign advertised a HELP response that no code path could produce.

describe("registered 10DLC auto-responses match the registered transcript", () => {
  const registered = readFileSync(
    new URL("../../../../docs/TELNYX_10DLC_FIELD_VALUES.txt", import.meta.url),
    "utf8",
  );

  /**
   * Read one labelled single-line field out of the AUTO-RESPONSES block. Scoped to that
   * block so a same-named line elsewhere in the file cannot satisfy the assertion.
   */
  function registeredAutoResponse(label: string): string {
    const block = registered.slice(
      registered.indexOf("AUTO-RESPONSES"),
      registered.indexOf("SAMPLE MESSAGES"),
    );
    const match = block.match(new RegExp(`^${label}\\n(.+)$`, "m"));
    if (!match) throw new Error(`registered auto-response not found: ${label}`);
    return match[1]!.trim();
  }

  it("sends exactly the registered opt-in message", () => {
    expect(REGISTERED_OPT_IN_AUTO_RESPONSE).toBe(
      registeredAutoResponse("Opt in message"),
    );
  });

  it("sends exactly the registered opt-out message", () => {
    expect(REGISTERED_OPT_OUT_AUTO_RESPONSE).toBe(
      registeredAutoResponse("Opt out message"),
    );
  });

  it("sends exactly the registered help message", () => {
    expect(REGISTERED_HELP_AUTO_RESPONSE).toBe(
      registeredAutoResponse("Help message"),
    );
  });

  // The carrier requirements these bodies exist to satisfy. Asserted on the CODE constants,
  // so weakening the copy fails here even if someone weakens the transcript to match.
  it("the opt-out confirmation states that messaging has ended", () => {
    expect(REGISTERED_OPT_OUT_AUTO_RESPONSE).toMatch(/unsubscribed/i);
  });

  it("the help response carries a contact route and opt-out instruction", () => {
    expect(REGISTERED_HELP_AUTO_RESPONSE).toMatch(/board@vigavashon\.org/);
    expect(REGISTERED_HELP_AUTO_RESPONSE).toMatch(/\bSTOP\b/);
  });

  it("the opt-in confirmation carries rate and opt-out language", () => {
    expect(REGISTERED_OPT_IN_AUTO_RESPONSE).toMatch(/rates apply/i);
    expect(REGISTERED_OPT_IN_AUTO_RESPONSE).toMatch(/\bSTOP\b/);
  });

  // The campaign declares `Embedded Phone Number: No`. Copy this code actually sends must
  // keep that declaration truthful, not just the transcript.
  it("embeds no phone number in any auto-response body", () => {
    for (const body of [
      REGISTERED_OPT_IN_AUTO_RESPONSE,
      REGISTERED_OPT_OUT_AUTO_RESPONSE,
      REGISTERED_HELP_AUTO_RESPONSE,
    ]) {
      expect(body).not.toMatch(
        /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/,
      );
    }
  });
});
