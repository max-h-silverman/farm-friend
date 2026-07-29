import { describe, expect, it } from "vitest";
import { parseFormResponses } from "./form-responses";

// B-002 / F-038 — reading the 2026 farmer-submitted form export.
//
// A SECOND source, and the better one. `stand-csv.ts` reads VIGA's Google My Maps export, which
// is malformed (unquoted descriptions across raw newlines) and carries hours, season, and
// stocking conflated into one prose blob. This file is the Google Forms responses: well-formed,
// one row per farm, 2026-current, with hours / season / stocking / website / social as SEPARATE
// COLUMNS. That is what the availability parser wanted all along.
//
// The two sources are COMPLEMENTARY, not competing (max, 2026-07-29):
//   form responses  →  details (hours, season, stocking, contact, offerings prose)
//   map export      →  COORDINATES, which the form has none of, and farms that did not submit
//
// So this parser's job is narrow: turn the form file into records, decide `visitability` from
// what the farmer actually stated, and refuse rather than coerce. Coordinates are joined in
// later, from the map export.
//
// Fixtures below are VERBATIM from the real file, including its defects. That is deliberate —
// a hand-idealized fixture is how the availability parser came to flag ten farms spuriously.

const HEADER =
  "Timestamp,Email Address,Farm Name,Address,Contact Name(s),Email Address(es)," +
  "Social Media,Website,Open Season,Open Hours & Days,Stocking Days," +
  "General Information (keep short and only text)," +
  "Include contact name and email on printed map?,Anything else we need to know?";

/** An ordinary visitable stand, verbatim from the corpus. */
const AEGGY =
  '4/21/2026 12:12:59,aeggysfarmstand@gmail.com,Aeggy\'s Farm,13609 SW 220th St ,' +
  '"Zena McCoy,  Aaron McCoy",aeggysfarmstand@gmail.com,Instagram:  @aeggysfarm,' +
  "www.aeggys.com,All year,Dawn to Dusk," +
  '"Everyday, but mostly on Tuesdays and Saturdays ",,Yes,';

/** Delivery only — no place to visit. The F-038 `contact_only` case. */
const OPEN_GATE =
  "4/24/2026 9:43:08,john.rettmann@gmail.com,Open Gate Lamb and Grazing," +
  "On island delivery for orders over $50,John Rettmann,John.rettmann@gmail.com,,," +
  "Butchering in July and November,," +
  '"USDA cuts available through the year, whole and half shares reservations open a month before butcher",' +
  '"100% forage fed New Zealand style lamb. Born and raised on Vashon pasture.",Yes,' +
  '"Send an email to order meat, hire the flock, or receive newsletters about Vashon shepherding"';

/** "(same info as last year)" in the timestamp column, and nothing else but a name. */
const FOREST_GARDEN = "(same info as last year),,Forest Garden Farm,,,,,,,,,,,";

function parse(...rows: string[]) {
  return parseFormResponses([HEADER, ...rows].join("\n"));
}

describe("parseFormResponses", () => {
  it("reads an ordinary stand, keeping the farmer's own words", () => {
    const { stands, rejected } = parse(AEGGY);

    expect(rejected).toEqual([]);
    expect(stands).toHaveLength(1);

    const aeggy = stands[0]!;
    expect(aeggy.name).toBe("Aeggy's Farm");
    expect(aeggy.publicAddress).toBe("13609 SW 220th St");
    expect(aeggy.visitability).toBe("visitable");
    // The three availability columns arrive SEPARATE — the whole reason to prefer this file.
    expect(aeggy.openSeasonText).toBe("All year");
    expect(aeggy.openHoursText).toBe("Dawn to Dusk");
    expect(aeggy.stockingText).toBe(
      "Everyday, but mostly on Tuesdays and Saturdays",
    );
    expect(aeggy.website).toBe("www.aeggys.com");
    expect(aeggy.socialMedia).toBe("Instagram: @aeggysfarm");
  });

  it("handles the quoted field containing a comma", () => {
    // '"Zena McCoy,  Aaron McCoy"' is one field, not two. A naive split on comma shifts every
    // subsequent column by one and silently reads the season out of the wrong cell.
    const { stands } = parse(AEGGY);
    expect(stands[0]!.contactNames).toBe("Zena McCoy, Aaron McCoy");
  });

  it("classifies a delivery-only farm as contact_only with NO address", () => {
    // Open Gate Lamb states its address as "On island delivery for orders over $50". That is
    // not a missing address to chase — it is a farmer saying there is nowhere to visit. The
    // seeder must not store that sentence in `public_address`.
    const { stands, rejected } = parse(OPEN_GATE);

    expect(rejected).toEqual([]);
    const gate = stands[0]!;
    expect(gate.name).toBe("Open Gate Lamb and Grazing");
    expect(gate.visitability).toBe("contact_only");
    expect(gate.publicAddress).toBeUndefined();
    // The prose is not lost — it is a fact about how to buy, kept for display.
    expect(gate.accessNote).toContain("On island delivery");
    // Availability is still real for a by-order farm: F-038 settled that any farm may publish.
    expect(gate.openSeasonText).toBe("Butchering in July and November");
  });

  it("REFUSES a row carrying only a name, rather than seeding an empty farm", () => {
    // Forest Garden Farm's entire submission is "(same info as last year)" plus a name. That
    // is resolvable — the MAP export has their address — but not from this file, and inventing
    // one is forbidden (F-017). It becomes a reported refusal, never a silent skip.
    const { stands, rejected } = parse(FOREST_GARDEN);

    expect(stands).toEqual([]);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]!.name).toBe("Forest Garden Farm");
    expect(rejected[0]!.reason).toMatch(/no address|refers to last year/i);
  });

  it("does not mistake a real address for prose because of an unusual abbreviation", () => {
    // Littlest Bird Farm: "15624 115th AV SW". A hand-written address pattern that did not know
    // "AV" flagged this as address-less during the 2026-07-29 survey — spuriously, and in the
    // dangerous direction: it would have demoted a visitable stand to contact_only and dropped
    // it off the map. The corpus decides, not a guessed regex.
    const littlestBird =
      "4/12/2026 10:00:00,a@b.test,Littlest Bird Farm,15624 115th AV SW," +
      "Someone,a@b.test,,,Spring-fall,24/7,Variable,,Yes,";

    const { stands } = parse(littlestBird);
    expect(stands[0]!.visitability).toBe("visitable");
    expect(stands[0]!.publicAddress).toBe("15624 115th AV SW");
  });

  it("prefers the FARMSTAND address when the farmer states two", () => {
    // Pacific Crest Farm: "7316 SW 240th St (mailing) 23720 Dockton Rd SW (farmstand)".
    // Storing the whole string would put a MAILING address on the map as the place to visit —
    // wrong, and wrong in a way a customer discovers by driving there. The farmer labelled
    // which is which, so the label is honoured rather than guessed at.
    const pacificCrest =
      "4/15/2026 8:00:00,a@b.test,Pacific Crest Farm," +
      '"7316 SW 240th St (mailing) 23720 Dockton Rd SW (farmstand)",' +
      "Someone,a@b.test,,,May-Oct,10-6,Weekends,,Yes,";

    const { stands } = parse(pacificCrest);
    expect(stands[0]!.visitability).toBe("visitable");
    expect(stands[0]!.publicAddress).toBe("23720 Dockton Rd SW");
    // The mailing address is not a public fact about where to shop, so it is not kept.
    expect(stands[0]!.publicAddress).not.toContain("7316");
    expect(stands[0]!.publicAddress).not.toContain("mailing");
  });

  it("flags an address a human must resolve, rather than guessing a point", () => {
    // Two real cases that are visitable but not precisely locatable:
    //   Sweet Alyssum — "Bank Road, East of Town" (a road, no number)
    //   Peak Moon     — "300' north of 28815 Vashon Hwy SW" (relative to another address)
    // Both are genuine addresses a person can follow, so they stay VISITABLE and keep the
    // farmer's words. But neither yields a coordinate, and inventing one is forbidden (F-017),
    // so each becomes an operator task — the same `unresolved` treatment the availability
    // parser gives text it cannot parse.
    const { stands } = parse(
      "4/1/2026 8:00:00,a@b.test,Sweet Alyssum Farm,\"Bank Road, East of Town\"," +
        "Someone,a@b.test,,,All year,24/7,Daily,,Yes,",
      "4/2/2026 8:00:00,a@b.test,Peak Moon Nursery," +
        "300' north of 28815 Vashon Hwy SW,Someone,a@b.test,,,All year,24/7,Daily,,Yes,",
    );

    for (const stand of stands) {
      expect(stand.visitability).toBe("visitable");
      expect(stand.addressNeedsReview).toBe(true);
    }
    // The farmer's own words survive — they are what a person actually follows.
    expect(stands[0]!.publicAddress).toBe("Bank Road, East of Town");
    expect(stands[1]!.publicAddress).toBe("300' north of 28815 Vashon Hwy SW");
  });

  it("does not flag an ordinary address for review", () => {
    // Guards the flag from becoming meaningless. If every address needed review the operator
    // queue would be noise, which is exactly how the availability parser's ten spurious flags
    // made its one real flag invisible.
    const { stands } = parse(AEGGY);
    expect(stands[0]!.addressNeedsReview).toBeUndefined();
  });

  it("keeps every farm distinct across the whole file", () => {
    const { stands } = parse(AEGGY, OPEN_GATE);
    expect(stands.map((s) => s.name)).toEqual([
      "Aeggy's Farm",
      "Open Gate Lamb and Grazing",
    ]);
  });

  it("strips contact PII from free text but keeps websites and handles", () => {
    // The seeder's existing contract: emails and phone numbers out of published prose;
    // farmer-chosen websites and social handles stay, because the product publishes those.
    const withPii =
      "4/1/2026 9:00:00,a@b.test,PII Farm,1 Test Rd,Someone,a@b.test,@piifarm," +
      "www.pii.test,All year,24/7,Daily," +
      '"Call 206-555-0142 or email us@pii.test for orders",Yes,';

    const { stands } = parse(withPii);
    const blob = JSON.stringify(stands[0]);
    expect(blob).not.toContain("206-555-0142");
    expect(blob).not.toContain("us@pii.test");
    expect(stands[0]!.website).toBe("www.pii.test");
    expect(stands[0]!.socialMedia).toBe("@piifarm");
  });

  it("ignores a blank trailing line without reporting a refusal", () => {
    const { stands, rejected } = parseFormResponses(
      [HEADER, AEGGY, "", "   ", ""].join("\n"),
    );
    expect(stands).toHaveLength(1);
    expect(rejected).toEqual([]);
  });

  it("refuses the whole file when the header is not the expected one", () => {
    // A wrong file — the map export, say — must fail loudly rather than yield zero stands,
    // which is indistinguishable from an empty corpus.
    expect(() => parseFormResponses("a,b,c\n1,2,3")).toThrow(/header/i);
  });
});
