import { describe, expect, it } from "vitest";
import { parseStandCsv, stripContactDetails } from "./stand-csv";

// B-002 — reading VIGA's export.
//
// The file is NOT well-formed CSV and no standard parser reads it correctly. Each stand's
// `description` is UNQUOTED and runs across raw newlines until the next `"POINT (` line, so a
// conventional reader treats every one of those lines as a new record: a naive parse of this
// exact file yields 285 "rows" for 31 stands, silently misattributing every address, email and
// `Open:` line to the wrong farm. That is the failure this module exists to prevent, and it is
// why the record boundary is anchored to the POINT literal rather than to line count.

const SAMPLE = [
  "WKT,name,description",
  '"POINT (-122.45 47.46)",First Farm,Jane Grower',
  "123 Example Rd SW",
  "Email: jane@example.com",
  "Open: March to December",
  "Stocking Days: Daily",
  "",
  '"POINT (-122.51 47.40)",Second Farm,Sam Grower',
  "Phone: (206) 555-0100",
  "Open: Year Round",
].join("\n");

describe("parsing the VIGA stand export", () => {
  it("anchors records to the POINT line, not to line breaks", () => {
    const result = parseStandCsv(SAMPLE);
    expect(result.stands).toHaveLength(2);
    expect(result.stands[0]!.name).toBe("First Farm");
    expect(result.stands[1]!.name).toBe("Second Farm");
  });

  it("keeps every continuation line with the stand it belongs to", () => {
    const [first] = parseStandCsv(SAMPLE).stands;
    // The defect this guards: "Open: March to December" being attributed to Second Farm.
    expect(first!.description).toContain("Open: March to December");
    expect(first!.description).toContain("123 Example Rd SW");
    expect(first!.description).not.toContain("Year Round");
  });

  it("reads real coordinates from the WKT point", () => {
    const [first] = parseStandCsv(SAMPLE).stands;
    expect(first!.longitude).toBeCloseTo(-122.45, 6);
    expect(first!.latitude).toBeCloseTo(47.46, 6);
  });

  it("carries the first description segment that follows the name", () => {
    const [first] = parseStandCsv(SAMPLE).stands;
    expect(first!.description).toContain("Jane Grower");
  });

  it("normalizes non-breaking spaces, which the export uses throughout", () => {
    // VIGA's export is full of U+00A0 (written as an escape below, since the character
    // is invisible in a diff). Treating it as ordinary text fails every `Open:` prefix
    // match downstream, on most of the corpus, for no visible reason.
    const withNbsp = [
      "WKT,name,description",
      '"POINT (-122.45 47.46)",Nbsp Farm,Owner',
      "Open:\u00a0March to December",
    ].join("\n");
    const [stand] = parseStandCsv(withNbsp).stands;
    expect(stand!.description).toContain("Open: March to December");
    expect(stand!.description).not.toContain("\u00a0");
  });

  it("refuses a malformed coordinate rather than seeding a wrong location", () => {
    // A stand placed at the wrong coordinate sends a customer to a stranger's driveway.
    // Seeding nothing is recoverable; seeding a plausible wrong point is not.
    const bad = [
      "WKT,name,description",
      '"POINT (not-a-number 47.46)",Broken Farm,Owner',
    ].join("\n");
    expect(parseStandCsv(bad).stands).toHaveLength(0);
  });

  it("rejects coordinates outside the plausible Vashon envelope", () => {
    // A transposed lat/long parses fine as numbers and lands in the Indian Ocean.
    const swapped = [
      "WKT,name,description",
      '"POINT (47.46 -122.45)",Swapped Farm,Owner',
    ].join("\n");
    const result = parseStandCsv(swapped);
    expect(result.stands).toHaveLength(0);
    expect(result.rejected[0]!.reason).toMatch(/outside/i);
  });
});

describe("stripping contact details (B-002 privacy)", () => {
  // The export carries 22 unique farmer email addresses and 4 phone numbers. None may be
  // seeded: Farm Friend publishes stand facts, and the product contract states plainly that
  // direct farmer phone numbers and email addresses are NOT public. A farmer's number enters
  // the system only through verified onboarding, into the single hashed-lookup column.

  it("removes an email address", () => {
    expect(stripContactDetails("Email: jane@example.com here")).not.toContain("@");
  });

  it("removes phone numbers in every shape the export uses", () => {
    for (const phone of [
      "707-380-7411",
      "(206) 707-1693",
      "(206) 329-8642",
      "206-755-9419",
    ]) {
      const stripped = stripContactDetails(`Phone: ${phone}`);
      expect(stripped).not.toContain(phone);
      // Also assert no digit run survives that could be reassembled into the number.
      expect(stripped.replace(/\D/g, "")).not.toContain(phone.replace(/\D/g, ""));
    }
  });

  it("keeps the surrounding prose, removing only the contact detail", () => {
    const stripped = stripContactDetails(
      "Open: March to December. Email: a@b.com. Stocking Days: Daily",
    );
    expect(stripped).toContain("Open: March to December");
    expect(stripped).toContain("Stocking Days: Daily");
  });

  it("leaves a website or social handle intact — those ARE publishable", () => {
    // The contract publishes farmer-selected web and social links; only direct phone and
    // email are private. Over-stripping would delete facts VIGA intends to show.
    const stripped = stripContactDetails(
      "Website: https://example.farm Instagram: @examplefarm",
    );
    expect(stripped).toContain("example.farm");
    expect(stripped).toContain("@examplefarm");
  });

  it("does not mistake a street address for a phone number", () => {
    const stripped = stripContactDetails("15324 Vermontville Road SW");
    expect(stripped).toContain("15324 Vermontville Road SW");
  });
});
