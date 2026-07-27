import { describe, expect, it } from "vitest";
import { summarizeProviderError } from "./provider-error";

// B-010 — dispatch stored only the provider's HTTP status and discarded its explanation.
//
// This cost hours twice on 2026-07-27. Both times the database held `error_code = '400'` or
// `'409'` — a number that names a category, never a cause — while Telnyx's own response body
// carried the exact sentence that ended the investigation:
//
//   400 → "The source phone number was deemed invalid by the carrier."   (TELNYX_FROM_NUMBER
//          was not in exact E.164 form; the sentence names the field outright)
//   409 → "Blocked due to STOP message"                                   (code 40300, the
//          carrier block rule behind B-011)
//
// Both were recovered by manually curling the Telnyx API, never from the database. Storing
// the detail is what makes the next such failure readable in one query instead of a session.
//
// THE PRIVACY CONSTRAINT THAT SHAPES THIS. The provider's message is untrusted third-party
// text, and the real 40300 body contains BOTH E.164 numbers:
//
//   "Messages cannot be sent from '+12068645326' to '+15163178228' due to an existing
//    block rule."
//
// Golden Rule #5 puts the raw E.164 in exactly one column, read only by the send path. So
// this detail can never be stored verbatim — a naive `error.detail` column would create a
// second raw-phone location, in the one table an operator reads while debugging. The phone
// class is masked before the string is returned, reusing the SAME detector the outbound
// guard already owns rather than inventing a second one.

describe("summarizing a provider error for storage", () => {
  it("keeps the provider's own explanation, which is the whole point", () => {
    const summary = summarizeProviderError({
      status: 400,
      body: {
        errors: [
          {
            code: "40001",
            title: "Invalid source number",
            detail: "The source phone number was deemed invalid by the carrier.",
          },
        ],
      },
    });

    // The sentence that would have ended the 2026-07-27 investigation immediately.
    expect(summary.detail).toContain("deemed invalid by the carrier");
    // The provider's own error code, distinct from the HTTP status.
    expect(summary.providerCode).toBe("40001");
  });

  it("captures the 40300 code B-011 turns on", () => {
    const summary = summarizeProviderError({
      status: 409,
      body: {
        errors: [{ code: "40300", title: "Blocked due to STOP message" }],
      },
    });

    // B-011's candidate rule keys on THIS value. It is unavailable today: `classify()` reads
    // only the HTTP status, so 409 arrives with no way to distinguish a carrier STOP block
    // from any other conflict. Storing it is the prerequisite for that decision.
    expect(summary.providerCode).toBe("40300");
    expect(summary.detail).toContain("Blocked due to STOP message");
  });

  it("masks raw phone numbers out of the provider's message", () => {
    // The real 40300 body. Storing this verbatim would put two raw E.164s into
    // `outbox_dispatch_attempts`, creating exactly the second raw-phone location Golden
    // Rule #5 forbids — in the table an operator reads while debugging, no less.
    const summary = summarizeProviderError({
      status: 409,
      body: {
        errors: [
          {
            code: "40300",
            title: "Blocked due to STOP message",
            detail:
              "Messages cannot be sent from '+12068645326' to '+15163178228' due to an existing block rule.",
          },
        ],
      },
    });

    expect(summary.detail).not.toContain("12068645326");
    expect(summary.detail).not.toContain("15163178228");
    expect(summary.detail).not.toMatch(/\+?1?\d{10}/);
    // Masked, not dropped: the sentence must stay diagnostic.
    expect(summary.detail).toContain("block rule");
    expect(summary.detail).toMatch(/\[redacted\]/);
  });

  it("bounds the stored length, since the body is third-party text", () => {
    const summary = summarizeProviderError({
      status: 500,
      body: { errors: [{ code: "x", detail: "y".repeat(5000) }] },
    });

    // An unbounded provider string is an unbounded write into our database.
    expect(summary.detail!.length).toBeLessThanOrEqual(500);
  });

  it("keeps no phone digits regardless of where the number falls in a long body", () => {
    // Sweeps the number across the 500-char truncation boundary — before it, straddling it,
    // and past it — because a phone's position is provider-controlled and must not matter.
    //
    // A NOTE ON WHAT THIS DOES *NOT* ASSERT, since the obvious stronger version is wrong.
    // An earlier draft tried to prove masking happens BEFORE truncation by requiring a
    // `[redacted]` token in the output. No fixture can distinguish the two orderings that
    // way: measured directly, wherever the number sits, truncate-then-mask also leaves no
    // digits — the number is either masked or cut off, and past ~495 chars BOTH orderings
    // drop the token entirely. The ordering is therefore a robustness choice, not a
    // separately observable guarantee, and asserting the token would have pinned an
    // implementation detail while claiming to prove a privacy property.
    //
    // What IS the guarantee, and what this asserts: no phone digits survive, ever.
    for (const repetitions of [10, 36, 37, 38, 45]) {
      const summary = summarizeProviderError({
        status: 409,
        body: {
          errors: [
            {
              code: "40300",
              detail: `${"padding text ".repeat(repetitions)}'+12068645326' onward.`,
            },
          ],
        },
      });

      expect(summary.detail!.length).toBeLessThanOrEqual(500);
      expect(summary.detail).not.toContain("12068645326");
      expect(summary.detail).not.toMatch(/\d{7}/);
    }
  });

  it("rejects a provider code that is not a machine token", () => {
    // `providerCode` is the value RULES key on (B-011 would branch on 40300), so it must
    // never carry free text. A provider returning a sentence in `code` — or an oversized
    // value — is treated as having supplied no code at all, and the sentence survives only
    // in `detail`, where nothing branches on it.
    for (const code of [
      "Blocked due to STOP message",
      "40300 ",
      "x".repeat(33),
      "",
    ]) {
      const summary = summarizeProviderError({
        status: 409,
        body: { errors: [{ code, detail: "Blocked due to STOP message" }] },
      });
      expect(summary.providerCode).toBeUndefined();
      expect(summary.detail).toContain("Blocked due to STOP message");
    }
  });

  it("survives a body that is not the documented shape", () => {
    // Fail soft, never throw: this runs inside the dispatch path, and losing the ability to
    // SEND because an error body was malformed would be a far worse defect than losing the
    // detail. A gateway 502 returning HTML is the realistic case.
    for (const body of [
      undefined,
      null,
      "<html>502 Bad Gateway</html>",
      {},
      { errors: [] },
      { errors: "not-an-array" },
      { errors: [{}] },
    ] as unknown[]) {
      expect(() => summarizeProviderError({ status: 502, body })).not.toThrow();
    }

    expect(summarizeProviderError({ status: 502, body: {} }).providerCode).toBeUndefined();
  });

  it("never lets the detail masquerade as the provider code", () => {
    // `error_code` stays the stable machine-readable value. Callers key rules on
    // `providerCode`; free text belongs only in `detail`.
    const summary = summarizeProviderError({
      status: 409,
      body: { errors: [{ code: "40300", detail: "Blocked due to STOP message" }] },
    });
    expect(summary.providerCode).toBe("40300");
    expect(summary.providerCode).not.toContain(" ");
  });
});
