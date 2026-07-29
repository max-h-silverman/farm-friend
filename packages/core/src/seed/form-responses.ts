import { stripContactDetails } from "./stand-csv";
import type { RejectedStand } from "./stand-csv";

// B-002 / F-038 — reading the 2026 farmer-submitted form export.
//
// WHY A SECOND READER, AND WHY IT IS THE PRIMARY ONE NOW. `stand-csv.ts` reads VIGA's Google My
// Maps export: malformed (unquoted descriptions spanning raw newlines, hence the `"POINT (`
// anchor) and with hours, season, and stocking conflated into one prose blob that
// `availability.ts` has to pick apart. This file is the Google Forms responses — well-formed,
// one row per farm, 2026-current, and those three facts arrive as SEPARATE COLUMNS.
//
// The two sources are COMPLEMENTARY, not competing (max, 2026-07-29):
//
//   form responses  →  details: hours, season, stocking, website, social, offerings prose
//   map export      →  COORDINATES (this file has none) and farms that did not submit a 2026 form
//
// So this reader deliberately does NOT produce a seedable location on its own. Coordinates are
// joined from the map export afterwards, and a visitable stand without them is refused there.
//
// This is a ONE-TIME seed concern. Nothing here is reachable from a request.

/** One farm as the 2026 form export states it, before coordinates are joined in. */
export interface FormStand {
  name: string;
  /**
   * Present only when the farmer stated a real street address (F-038 `visitable`).
   *
   * Absent when they described how to reach them instead — Open Gate Lamb's Address cell reads
   * "On island delivery for orders over $50". That sentence must never land in
   * `public_address`: the database forbids it for a contact-only location, and a customer
   * cannot drive to it.
   */
  publicAddress?: string;
  visitability: "visitable" | "contact_only";
  /** What the farmer put in the Address cell when it was not an address. Kept for display. */
  accessNote?: string;
  /**
   * True when the address is real but yields no coordinate — an operator must resolve it.
   *
   * Two such cases in the corpus: "Bank Road, East of Town" (a road with no number) and
   * "300' north of 28815 Vashon Hwy SW" (relative to a different address). Both are directions
   * a person can follow, so the stand stays visitable and keeps the farmer's words; neither
   * produces a point, and inventing one is forbidden (F-017).
   *
   * Absent — not `false` — for an ordinary address, so the flag stays meaningful. Ten spurious
   * flags are what made the availability parser's one real flag invisible.
   */
  addressNeedsReview?: true;
  contactNames?: string;
  website?: string;
  socialMedia?: string;
  /** The three availability facts, each from its own column, farmer's words preserved. */
  openSeasonText?: string;
  openHoursText?: string;
  stockingText?: string;
  /** The farmer's own description of what they carry. Contact details stripped. */
  generalInformation?: string;
  extraNotes?: string;
}

export interface FormResponsesResult {
  stands: FormStand[];
  /** Rows the reader refused. Never silently dropped — the seeder reports them. */
  rejected: RejectedStand[];
}

/**
 * The exact header of the 2026 export.
 *
 * Checked rather than assumed: pointing the loader at the MAP export instead would otherwise
 * yield zero stands, which is indistinguishable from a genuinely empty corpus — and "seeded 0
 * farms" reads like success. Failing loudly is the only honest outcome for a wrong file.
 */
const EXPECTED_COLUMNS = [
  "Timestamp",
  "Email Address",
  "Farm Name",
  "Address",
  "Contact Name(s)",
  "Email Address(es)",
  "Social Media",
  "Website",
  "Open Season",
  "Open Hours & Days",
  "Stocking Days",
  "General Information (keep short and only text)",
  "Include contact name and email on printed map?",
  "Anything else we need to know?",
] as const;

/**
 * Split one CSV line, honouring double-quoted fields.
 *
 * Needed because real cells contain commas: `"Zena McCoy,  Aaron McCoy"` is ONE field. A naive
 * `split(",")` shifts every later column by one and silently reads the season out of the
 * stocking cell — the same class of misattribution that made the map export unreadable.
 */
function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (inQuotes) {
      if (char === '"') {
        // A doubled quote inside a quoted field is one literal quote.
        if (line[i + 1] === '"') {
          current += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      inQuotes = true;
    } else if (char === ",") {
      fields.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  fields.push(current);
  return fields;
}

/**
 * Collapse runs of whitespace and trim.
 *
 * The NBSP (U+00A0) is written as an ESCAPE, never as a literal character. Google's exports are
 * full of them, and a literal one here is invisible in every editor and diff — it lints as
 * `no-irregular-whitespace` precisely because a typo'd or editor-normalized literal would leave
 * this stripping nothing while still looking correct. `stand-csv.ts` escapes it for the same
 * reason.
 */
function tidy(value: string | undefined): string {
  return (value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Undefined rather than an empty string, so "not stated" is distinguishable from "". */
function optional(value: string | undefined): string | undefined {
  const cleaned = tidy(value);
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Does this Address cell state a place a customer can go?
 *
 * DELIBERATELY NOT a street-address pattern. A hand-written regex flagged Littlest Bird Farm's
 * "15624 115th AV SW" as address-less during the 2026-07-29 survey, because it did not know
 * "AV" — spurious, and in the dangerous direction: it would have demoted a visitable stand to
 * contact-only and dropped it off the map. The availability parser learned the same lesson by
 * flagging ten farms wrongly.
 *
 * So the test is inverted. Assume any stated address is real, and look only for the farmer
 * explicitly describing a NON-location: delivery, ordering, appointment. That fails safe in the
 * right direction — an unrecognized address format stays visitable and keeps its pin, and the
 * database's own `coherent_visitability` constraint catches a genuinely empty one.
 */
const NON_LOCATION = /\b(delivery|deliver|by appointment|appointment only|order|orders|pickup only|no stand|call first|email)\b/i;

/**
 * An address a person can follow but no geocoder can resolve to a point.
 *
 * Anchored to the two shapes the corpus actually contains — a relative offset ("300' north
 * of …") and a road named without a number ("Bank Road, East of Town") — rather than to a
 * general "looks vague" heuristic, which is how a flag becomes noise.
 */
const NEEDS_HUMAN_REVIEW = [
  // "300' north of 28815 Vashon Hwy SW" — positioned relative to a different address.
  /\b(north|south|east|west)\s+of\b/i,
  /\b\d+\s*['’]\s*(north|south|east|west)\b/i,
  // "Bank Road, East of Town" — a road with no street number leading it.
  /^(?![^,]*\d)\s*[A-Za-z][A-Za-z.\s]*\b(rd|road|st|street|ave|avenue|ln|lane|way|hwy|highway|dr|drive)\b/i,
];

/**
 * Pull the FARMSTAND address out of a cell stating more than one.
 *
 * Pacific Crest Farm: "7316 SW 240th St (mailing) 23720 Dockton Rd SW (farmstand)". The farmer
 * labelled which is which, so the label is honoured. Storing the whole string would publish a
 * MAILING address as the place to visit — wrong in the way a customer discovers by driving
 * there. Returns undefined when no such labelling is present, which is the common case.
 */
function farmstandAddress(stated: string): string | undefined {
  const labelled = /([^()]+?)\s*\((?:farm\s*stand|farmstand|stand)\)/i.exec(
    stated,
  );
  if (labelled === null) return undefined;

  // The captured run may still carry the preceding "(mailing)" clause; keep only what follows
  // the last parenthetical before the farmstand label.
  const candidate = labelled[1]!.split(/\)/).pop() ?? labelled[1]!;
  return tidy(candidate);
}

function classifyAddress(cell: string | undefined): {
  publicAddress?: string;
  accessNote?: string;
  addressNeedsReview?: true;
  visitability: "visitable" | "contact_only";
} {
  const stated = optional(cell);
  if (stated === undefined) {
    // No address at all. Not classifiable from this file — the caller refuses the row rather
    // than guessing, because the MAP export may still hold a real address (Forest Garden Farm).
    return { visitability: "contact_only" };
  }

  // A labelled farmstand address wins before anything else looks at the cell: the mailing
  // half of Pacific Crest's answer contains no non-location language and would otherwise be
  // published verbatim.
  const farmstand = farmstandAddress(stated);
  if (farmstand !== undefined) {
    return { visitability: "visitable", publicAddress: farmstand };
  }

  if (NON_LOCATION.test(stated)) {
    return { visitability: "contact_only", accessNote: stated };
  }

  if (NEEDS_HUMAN_REVIEW.some((pattern) => pattern.test(stated))) {
    return {
      visitability: "visitable",
      publicAddress: stated,
      addressNeedsReview: true,
    };
  }

  return { visitability: "visitable", publicAddress: stated };
}

/** Parse the 2026 form export into one record per farm. */
export function parseFormResponses(content: string): FormResponsesResult {
  const lines = content.split(/\r?\n/);
  const headerLine = lines.shift();
  if (headerLine === undefined) {
    throw new Error("form export is empty: no header row");
  }

  const header = splitCsvLine(headerLine).map((column) => tidy(column));
  const mismatch = EXPECTED_COLUMNS.filter(
    (expected, index) => header[index] !== expected,
  );
  if (mismatch.length > 0) {
    throw new Error(
      `unexpected form export header: missing or reordered ${mismatch
        .map((column) => `"${column}"`)
        .join(", ")}. Is this the 2026 form responses file?`,
    );
  }

  const column = (fields: string[], name: (typeof EXPECTED_COLUMNS)[number]) =>
    fields[EXPECTED_COLUMNS.indexOf(name)];

  const stands: FormStand[] = [];
  const rejected: RejectedStand[] = [];

  for (const line of lines) {
    // A blank trailing line is not a refusal — every spreadsheet export ends with one.
    if (tidy(line).length === 0) continue;

    const fields = splitCsvLine(line);
    const name = tidy(column(fields, "Farm Name"));
    if (name.length === 0) {
      rejected.push({
        name: "(unnamed row)",
        reason: "no farm name stated",
      });
      continue;
    }

    const timestamp = tidy(column(fields, "Timestamp"));
    const address = classifyAddress(column(fields, "Address"));

    // A row with no address AND no stated non-location tells us nothing about where or how to
    // buy. Forest Garden Farm's whole submission is "(same info as last year)" plus a name —
    // resolvable from the MAP export, but not from here. Refuse and report; never invent
    // (F-017), and never silently skip.
    if (
      address.publicAddress === undefined &&
      address.accessNote === undefined
    ) {
      rejected.push({
        name,
        reason: /last year/i.test(timestamp)
          ? `submission refers to last year's information and states no address ("${timestamp}")`
          : "no address stated, and no delivery or ordering note to classify it by",
      });
      continue;
    }

    stands.push({
      name,
      ...address,
      contactNames: optional(column(fields, "Contact Name(s)")),
      website: optional(column(fields, "Website")),
      socialMedia: optional(column(fields, "Social Media")),
      openSeasonText: optional(column(fields, "Open Season")),
      openHoursText: optional(column(fields, "Open Hours & Days")),
      stockingText: optional(column(fields, "Stocking Days")),
      // Free prose is the one place a farmer may have typed a phone number or an email. The
      // stripper is shared with the map-export reader rather than reimplemented, so the two
      // sources cannot disagree about what counts as publishable.
      generalInformation: optional(
        stripContactDetails(
          tidy(column(fields, "General Information (keep short and only text)")),
        ),
      ),
      extraNotes: optional(
        stripContactDetails(
          tidy(column(fields, "Anything else we need to know?")),
        ),
      ),
    });
  }

  return { stands, rejected };
}
