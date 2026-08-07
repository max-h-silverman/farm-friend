import { describe, expect, it } from "vitest";
import { parseFarmEmails, splitEmailCell } from "./farm-emails";

// F-078 — pulling the email roster out of VIGA's farm-stand form.
//
// The two columns (`Email Address`, `Email Address(es)`) are already validated by
// `EXPECTED_COLUMNS` in `form-responses.ts` and were, until now, discarded.
//
// ## What the real corpus taught, and why these cases are these cases
//
// Every shape below was taken from the actual 2026 responses rather than imagined. The
// measurement is repeated against the real file in `farm-emails-corpus.test.ts`; this file
// pins the BEHAVIOUR so it can be reasoned about without the personal data present.
//
//   * **The two columns must be UNIONED, not chosen between.** They disagree for 5 of 32 farms.
//     Lavender Hill's three addresses are `cathy@` in one column and `info@` + `shop@` in the
//     other — picking either column alone loses real addresses, and locks that farmer out of
//     verifying with an address VIGA genuinely holds.
//   * **Separators are mixed.** Holmestead writes `"a@x.com and b@x.com"`; Lavender Hill writes
//     `"a@x.com, b@x.com"`. Splitting on commas alone turns Holmestead's cell into ONE
//     malformed address rather than two good ones — and it would be stored, because
//     "and" is not a character any validation rejects on sight.

describe("splitting one form cell into addresses", () => {
  it("splits on a comma — Lavender Hill's real shape", () => {
    expect(splitEmailCell("info@lavenderhillvashon.com, shop@lavenderhillvashon.com")).toEqual([
      "info@lavenderhillvashon.com",
      "shop@lavenderhillvashon.com",
    ]);
  });

  it("splits on the WORD 'and' — Holmestead's real shape", () => {
    // The case a comma-only splitter silently corrupts.
    expect(splitEmailCell("abholmes@gmail.com and holmesteadfarms@gmail.com")).toEqual([
      "abholmes@gmail.com",
      "holmesteadfarms@gmail.com",
    ]);
  });

  it("splits on semicolons and slashes too", () => {
    expect(splitEmailCell("a@x.org; b@x.org / c@x.org")).toEqual([
      "a@x.org",
      "b@x.org",
      "c@x.org",
    ]);
  });

  it("does NOT split an address that merely contains the letters 'and'", () => {
    // `alexander@` and `sandy@` both contain "and". Splitting on the bare substring would
    // shred real addresses into fragments — so the separator is the standalone WORD.
    expect(splitEmailCell("alexander@example.org")).toEqual(["alexander@example.org"]);
    expect(splitEmailCell("sandy@island.farm")).toEqual(["sandy@island.farm"]);
  });

  it("lowercases and trims, so one address has one spelling", () => {
    // The database's unique index normalizes the same way. If this did not, the ingest would
    // insert "Info@..." and the index would collapse it against "info@..." — an insert that
    // fails for a reason the operator cannot see in their data.
    expect(splitEmailCell("  Info@Example.ORG  ")).toEqual(["info@example.org"]);
  });

  it("drops blanks rather than producing empty addresses", () => {
    // A trailing comma is someone typing. It must not become a blank row the not-blank CHECK
    // then refuses, aborting an ingest over a stray keystroke.
    expect(splitEmailCell("a@x.org,")).toEqual(["a@x.org"]);
    expect(splitEmailCell(" , ; / ")).toEqual([]);
    expect(splitEmailCell("")).toEqual([]);
    expect(splitEmailCell(null)).toEqual([]);
  });

  it("refuses a fragment that is not an address shape", () => {
    // "call me" in an email column is a human answering a different question. Storing it would
    // give that farm a roster entry nobody can ever verify against.
    expect(splitEmailCell("call me, a@x.org")).toEqual(["a@x.org"]);
    expect(splitEmailCell("none")).toEqual([]);
    expect(splitEmailCell("n/a")).toEqual([]);
  });
});

describe("parsing a farm's roster from both columns", () => {
  const row = (primary: string, listed: string) => ({
    farmName: "Test Farm",
    primaryEmail: primary,
    listedEmails: listed,
  });

  it("UNIONS the two columns — the case that loses data if either is chosen", () => {
    // Lavender Hill, exactly. Three addresses, from two columns.
    const parsed = parseFarmEmails([
      row("cathy@lavenderhillvashon.com", "info@lavenderhillvashon.com, shop@lavenderhillvashon.com"),
    ]);

    expect(parsed[0]?.emails).toEqual([
      "cathy@lavenderhillvashon.com",
      "info@lavenderhillvashon.com",
      "shop@lavenderhillvashon.com",
    ]);
  });

  it("keeps the primary address FIRST, so the roster has a stable order", () => {
    const parsed = parseFarmEmails([row("primary@x.org", "second@x.org")]);
    expect(parsed[0]?.emails[0]).toBe("primary@x.org");
  });

  it("de-duplicates across the columns — 27 of 32 farms repeat the same address", () => {
    // The common case: both columns hold the one address. Two rows for it would violate the
    // farm-scoped unique index and abort the ingest.
    const parsed = parseFarmEmails([row("same@x.org", "  SAME@X.ORG ")]);
    expect(parsed[0]?.emails).toEqual(["same@x.org"]);
  });

  it("reports a farm with NO usable address rather than dropping it silently", () => {
    // ~3 of the 35 seeded farms have no email on file. They are told to contact VIGA, which is
    // only possible if the ingest SAYS which farms they are. A silent skip would leave an
    // operator wondering why a farmer cannot onboard.
    const parsed = parseFarmEmails([
      { farmName: "No Email Farm", primaryEmail: "", listedEmails: "" },
    ]);

    expect(parsed[0]?.emails).toEqual([]);
    expect(parsed[0]?.farmName).toBe("No Email Farm");
  });
});
