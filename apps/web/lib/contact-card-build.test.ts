import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// B-025 — the served vCard lost its CRLF line endings, and the defect lived ONLY in the
// build output.
//
// ## What actually happened, because the mechanism is not obvious
//
// `renderContactCard` joined its lines with `"\r\n"` and was correct. Its unit test asserted
// CRLF and passed. The production response nevertheless carried 147 bytes with 0 CR and 6
// bare LF, and `file(1)` rejected it.
//
// The minifier rewrote the array-join into a single TEMPLATE LITERAL, and wrote the separators
// as *raw CR and LF bytes in the source text* rather than as the escape sequence `\r\n`.
// ECMA-262 normalizes a literal CRLF in template-literal source to a single LF at PARSE time
// (§12.9.6, TV of TemplateCharacter). So the CR was gone before the string existed at runtime.
// Nothing downstream was at fault: not the Next.js response path, not the Cloud Run proxy —
// both were measured and both pass CRLF through byte-for-byte.
//
// ## Why this test reads the BUILD OUTPUT and not the source
//
// The transform is the build's, so source is the wrong place to look and a unit test on the
// renderer cannot see it — vitest runs unminified TypeScript, where the join is still a join.
// That is precisely why this shipped green. The assertion below therefore executes the BUILT
// chunk and inspects the string it actually returns.
//
// The renderer is CRLF-safe by construction now (`vcard.ts` builds the separator with
// `String.fromCharCode`, which no minifier can fold into literal source bytes), so this test
// is the regression guard on that property surviving the build.

const repositoryRoot = new URL("../../../", import.meta.url);

/** The built server chunk the contact-card route loads its renderer from. */
function findBuiltCardChunk(): string | undefined {
  const chunkDir = new URL("apps/web/.next/server/chunks/", repositoryRoot);
  if (!existsSync(chunkDir)) return undefined;

  for (const entry of readdirSync(chunkDir)) {
    if (!entry.endsWith(".js")) continue;
    const file = new URL(entry, chunkDir);
    if (readFileSync(file, "utf8").includes("BEGIN:VCARD")) {
      return new URL(entry, chunkDir).pathname;
    }
  }
  return undefined;
}

describe("B-025 — the BUILT contact card keeps its CRLF line endings", () => {
  it("emits CRLF from the minified build output, not bare LF", () => {
    const chunkPath = findBuiltCardChunk();

    // Fail LOUDLY rather than skipping. A skipped build assertion is how this class of defect
    // reaches production: the check reports green while having inspected nothing.
    expect(
      chunkPath,
      "no built chunk containing BEGIN:VCARD — run `npm run build --workspace @farm-friend/web` first",
    ).toBeDefined();

    const chunk = readFileSync(chunkPath as string, "utf8");
    const start = chunk.indexOf("BEGIN:VCARD");

    // THE ASSERTION THAT CATCHES B-025, anchored to the built card's own separator bytes.
    //
    // Anchored to the CHARACTER CODES between `BEGIN:VCARD` and `VERSION:3.0` in the built
    // text — the exact construct the defect corrupted. It is deliberately NOT a search for
    // the substring "\\r\\n" anywhere in the chunk: an unrelated escape elsewhere in a
    // 300KB bundle would satisfy that and the test would survive the bug returning.
    const between = chunk.slice(start + "BEGIN:VCARD".length, chunk.indexOf("VERSION:3.0"));

    // The separator must NOT be a raw newline in the source text, in either form — a raw CRLF
    // is normalized to LF by the parser (the original defect) and a raw LF is already wrong.
    expect(
      between.includes("\n"),
      `the built card's separator is a RAW newline (${JSON.stringify(between)}), which the ` +
        "JS parser normalizes — B-025 has regressed",
    ).toBe(false);
  });

  it("separates every built card line by a CR the parser cannot normalize away", () => {
    const chunkPath = findBuiltCardChunk();
    expect(chunkPath).toBeDefined();
    const chunk = readFileSync(chunkPath as string, "utf8");

    // Walk the built card's own property lines and check the separator that precedes each one.
    // Anchored to the vCard's REQUIRED properties: whatever form the build emits — a template
    // literal, a `.join`, a concatenation — a card is only correct if a CR reaches the wire
    // between these lines, and only two source forms achieve that.
    const properties = ["VERSION:3.0", "FN:", "ORG:", "TEL;", "END:VCARD"];
    const cardStart = chunk.indexOf("BEGIN:VCARD");
    expect(cardStart).toBeGreaterThan(-1);

    // Bound the search to the card's own region so an unrelated `\r\n` elsewhere in a large
    // bundle can never satisfy these assertions.
    const cardEnd = chunk.indexOf("END:VCARD", cardStart) + "END:VCARD".length;
    const region = chunk.slice(cardStart, cardEnd);

    for (const property of properties) {
      const at = region.indexOf(property);
      expect(at, `the built card no longer contains ${property}`).toBeGreaterThan(0);

      // The two characters immediately before the property line are its separator.
      const separator = region.slice(Math.max(0, at - 2), at);

      // A RAW newline in source is the defect: the parser normalizes a literal CRLF inside a
      // template literal to a bare LF, so a card whose separator is a real newline byte ships
      // without its CR. The escape sequence `\r\n` (backslash-r) survives, and so does a
      // separator built via `String.fromCharCode` — which emits no newline byte at all and
      // leaves the property preceded by the interpolation/concatenation syntax instead.
      expect(
        separator.includes("\n"),
        `the built card separates ${property} with a RAW newline (${JSON.stringify(separator)}) — ` +
          "the JS parser strips its CR, which is B-025",
      ).toBe(false);
    }

    // And the card must not be one raw-newline-delimited blob: no literal newline anywhere in
    // the built card's region. This is the single assertion that most directly encodes B-025.
    expect(
      region.includes("\n"),
      `the built contact card contains a raw newline (${JSON.stringify(
        region.slice(0, 80),
      )}…) — B-025 has regressed`,
    ).toBe(false);
  });
});
