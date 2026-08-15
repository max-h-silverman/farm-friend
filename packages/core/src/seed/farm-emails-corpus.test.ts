import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseFarmEmails, splitEmailCell } from "./farm-emails";

// F-078 — the roster parser measured against THE REAL CORPUS, not against fixtures.
//
// **Why this file exists separately.** `farm-emails.test.ts` pins behaviour using invented rows.
// That proves the parser does what it was written to do; it cannot prove the parser survives
// VIGA's actual data. Parsers that look correct in the abstract fail on real data in minutes,
// and every shape this parser handles — the word "and" as a separator, two columns disagreeing,
// three addresses spread across both — was discovered by running it over the file rather than
// by reasoning about it.
//
// **The corpus is NOT in the repository, deliberately.** It is 32 farmers' personal email
// addresses. It is supplied by path:
//
//   FARM_STAND_RESPONSES_CSV="~/downloads/2026 Farm Stand Information (Responses)…csv" npm test
//
// **An absent corpus SKIPS these, and that is a deliberate exception to "a skipped run is not
// green".** The integration suites refuse to skip because `DATABASE_URL` is infrastructure every
// developer has. This file's input is personal data that must NOT be widely copied, so requiring
// it would either fail the suite for everyone or push people to commit the file. The measurement
// is recorded in the PM item and re-run whenever the corpus changes.
//
// So: this file skipping is normal. This file RUNNING and failing means the corpus moved out
// from under the parser, which is exactly the signal it exists to give.

const corpusPath = process.env.FARM_STAND_RESPONSES_CSV?.replace(
  /^~/,
  process.env.HOME ?? "~",
);
const haveCorpus = corpusPath !== undefined && existsSync(corpusPath);

/** Minimal CSV reader: quoted fields, embedded commas and newlines. */
function readCsv(text: string): Record<string, string>[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (ch !== "\r") field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  // Strip a UTF-8 BOM from the first header cell — Google Sheets exports one, and it would
  // otherwise make "Email Address" unfindable by name. Written as an escape rather than the
  // literal character, which lint forbids as irregular whitespace.
  const header = rows.shift()!.map((h) => h.replace(/^\uFEFF/, ""));
  return rows
    .filter((r) => r.some((c) => c.trim() !== ""))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

describe.skipIf(!haveCorpus)("the roster parser against VIGA's real 2026 responses", () => {
  // Read LAZILY, inside the helpers rather than in the describe body. `describe.skipIf` still
  // evaluates the body — it only skips the `it`s — so a top-level `readFileSync` throws and
  // FAILS the file for everyone without the corpus, which is the opposite of skipping.
  const load = () => readCsv(readFileSync(corpusPath!, "utf8"));
  const roster = () =>
    parseFarmEmails(
      load().map((r) => ({
        farmName: r["Farm Name"] ?? "",
        primaryEmail: r["Email Address"] ?? "",
        listedEmails: r["Email Address(es)"] ?? "",
      })),
    );

  it("reads the expected corpus, not some other file", () => {
    const rows = load();
    // Guards a vacuous pass. Pointed at the MAP export instead, every assertion below would be
    // trivially true over zero rows — and "0 sellers, 0 problems" reads like success.
    expect(rows.length).toBeGreaterThan(25);
    expect(Object.keys(rows[0]!)).toContain("Email Address");
    expect(Object.keys(rows[0]!)).toContain("Email Address(es)");
  });

  it("finds an address for EVERY farm — 32 of 32, zero gaps", () => {
    // The measurement the whole design rests on. If real sellers had no email, the secret-link
    // flow would strand them with no way in, and that would change the product decision rather
    // than being a parser bug.
    const without = roster().filter((f) => f.emails.length === 0);
    expect(without.map((f) => f.farmName)).toEqual([]);
  });

  it("finds the five multi-address sellers, and Lavender Hill's three", () => {
    // Five sellers list more than one address. A parser that took the first would silently lock
    // those farmers out of addresses VIGA genuinely holds for them.
    const multi = roster().filter((f) => f.emails.length > 1);
    expect(multi).toHaveLength(5);
    expect(Math.max(...multi.map((f) => f.emails.length))).toBe(3);
  });

  it("produces NO address shared between two different sellers", () => {
    // Why email → farm is unambiguous today. If this ever fails, the verification flow needs a
    // farm-disambiguation step — so it is a product signal, not only a test failure.
    const owners = new Map<string, Set<string>>();
    for (const farm of roster()) {
      for (const email of farm.emails) {
        const set = owners.get(email) ?? new Set<string>();
        set.add(farm.farmName);
        owners.set(email, set);
      }
    }
    const shared = [...owners].filter(([, sellers]) => sellers.size > 1);
    expect(shared.map(([email]) => email)).toEqual([]);
  });

  it("produces only well-formed addresses — nothing a human typed as prose", () => {
    const all = roster().flatMap((f) => f.emails);
    expect(all.length).toBeGreaterThan(30);
    const malformed = all.filter((e) => !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    expect(malformed).toEqual([]);
  });

  it("normalizes every address to one spelling, so the unique index cannot surprise it", () => {
    const parsed = roster();
    const all = parsed.flatMap((f) => f.emails);
    expect(all.filter((e) => e !== e.trim().toLowerCase())).toEqual([]);
    // And no farm carries the same address twice after the union of both columns.
    for (const farm of parsed) {
      expect(new Set(farm.emails).size, farm.farmName).toBe(farm.emails.length);
    }
  });

  it("splits every raw cell without losing an address", () => {
    // End-to-end over the file: the count of addresses the splitter produces must equal the
    // count the union produced, so nothing is dropped between the two steps.
    const fromCells = new Set(
      load().flatMap((r) => [
        ...splitEmailCell(r["Email Address"] ?? ""),
        ...splitEmailCell(r["Email Address(es)"] ?? ""),
      ]),
    );
    const fromParse = new Set(roster().flatMap((f) => f.emails));
    expect([...fromCells].sort()).toEqual([...fromParse].sort());
  });
});
