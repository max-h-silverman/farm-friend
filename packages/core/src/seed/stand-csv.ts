// B-002 — reading VIGA's farm-stand export.
//
// WHY THIS IS NOT `csv.parse`. The file is not well-formed CSV. Each stand's `description`
// field is UNQUOTED and spans raw newlines, running until the next record begins. A standard
// reader therefore sees each continuation line as its own record: parsing this exact export
// with a conventional parser produces 285 "rows" for 31 stands and silently attaches every
// address, `Open:` line and update note to the wrong farm. Nothing downstream would notice —
// the availability parser would happily read a season off the neighbouring stand's text.
//
// So the record boundary is anchored to the one unambiguous marker the file actually has: a
// line beginning with `"POINT (`. Everything until the next such line belongs to the current
// stand.
//
// This is a ONE-TIME seed concern. Nothing here is reachable from a request.

/** A stand as it appears in the export, before any interpretation. */
export interface RawStand {
  name: string;
  /** The full free-text description, newlines preserved, contact details still present. */
  description: string;
  longitude: number;
  latitude: number;
}

export interface RejectedStand {
  name: string;
  reason: string;
}

export interface StandCsvResult {
  stands: RawStand[];
  /** Records the loader refused. Never silently dropped — the seeder reports them. */
  rejected: RejectedStand[];
}

/**
 * The plausible envelope for Vashon-Maury Island, with generous margin.
 *
 * A transposed coordinate pair parses as two valid numbers and places a stand in the Indian
 * Ocean; a dropped minus sign puts it in China. Both are the "invented coordinate" failure
 * F-017 forbids, and neither is visible in a spreadsheet. Refusing here means a bad row
 * becomes an operator task rather than a customer driving to the wrong place.
 */
const VASHON_BOUNDS = {
  minLongitude: -122.6,
  maxLongitude: -122.3,
  minLatitude: 47.3,
  maxLatitude: 47.55,
} as const;

/**
 * Google's export uses U+00A0 (non-breaking space) throughout — "Open:<NBSP>March".
 *
 * Normalized at ingest, because every downstream prefix match ("Open:", "Stocking Days:")
 * would otherwise fail on the majority of the corpus for an invisible reason.
 */
function normalizeWhitespace(text: string): string {
  return text.replace(/\u00a0/g, " ").replace(/[ \t]+/g, " ");
}

const POINT_LINE = /^"POINT \(([-0-9.]+) ([-0-9.]+)\)",(.*)$/;

/** Parse the export into one record per stand. */
export function parseStandCsv(content: string): StandCsvResult {
  const lines = content.split(/\r?\n/);
  const stands: RawStand[] = [];
  const rejected: RejectedStand[] = [];

  let current: { name: string; longitude: string; latitude: string; body: string[] } | null =
    null;

  const finish = () => {
    if (current === null) return;

    const name = normalizeWhitespace(current.name).trim();
    const longitude = Number(current.longitude);
    const latitude = Number(current.latitude);

    if (!Number.isFinite(longitude) || !Number.isFinite(latitude)) {
      rejected.push({ name, reason: "coordinate is not a number" });
      current = null;
      return;
    }
    if (
      longitude < VASHON_BOUNDS.minLongitude ||
      longitude > VASHON_BOUNDS.maxLongitude ||
      latitude < VASHON_BOUNDS.minLatitude ||
      latitude > VASHON_BOUNDS.maxLatitude
    ) {
      rejected.push({
        name,
        reason: `coordinate (${longitude}, ${latitude}) is outside the Vashon envelope`,
      });
      current = null;
      return;
    }

    stands.push({
      name,
      description: current.body.map(normalizeWhitespace).join("\n").trim(),
      longitude,
      latitude,
    });
    current = null;
  };

  for (const line of lines) {
    const match = POINT_LINE.exec(line);
    if (match) {
      finish();
      // The remainder of the POINT line is `name,firstDescriptionSegment`. Only the FIRST
      // comma separates them; the description's own commas belong to the description.
      const rest = match[3]!;
      const comma = rest.indexOf(",");
      const name = comma === -1 ? rest : rest.slice(0, comma);
      const firstSegment = comma === -1 ? "" : rest.slice(comma + 1);
      current = {
        name,
        longitude: match[1]!,
        latitude: match[2]!,
        body: firstSegment === "" ? [] : [firstSegment],
      };
      continue;
    }
    if (current !== null) current.body.push(line);
  }
  finish();

  return { stands, rejected };
}

// Contact stripping.
//
// The export carries 22 unique farmer email addresses and 4 phone numbers. The product
// contract is explicit that direct farmer phone numbers and email addresses are NOT public,
// and a farmer's number legitimately enters Farm Friend only through verified onboarding,
// where it lands normalized in the single raw-E.164 column the send path reads. A seeded copy
// in a public description column would be a second home for the exact data the privacy design
// keeps in one place.
//
// Websites and social handles are deliberately KEPT: the contract publishes farmer-selected
// web and social links, so stripping them would delete facts VIGA intends to show.

/** An `@handle` is a social reference, not an address: no dot-suffixed domain follows it. */
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]{2,}/g;

/**
 * Phone shapes present in the corpus: `707-380-7411`, `(206) 707-1693`, `206-755-9419`.
 *
 * Requires a separator between the groups, so a bare 10-digit run inside a street address or
 * a zip+4 is not swallowed. `15324 Vermontville Road SW` must survive intact.
 */
const PHONE = /\(?\b\d{3}\)?[-.\s]\s*\d{3}[-.\s]\d{4}\b/g;

/** Remove direct contact details, keeping the surrounding prose and any public link. */
export function stripContactDetails(text: string): string {
  return text
    .replace(EMAIL, "")
    .replace(PHONE, "")
    // Tidy the label the value was removed from, so "Email:" does not linger alone.
    .replace(/\b(?:e-?mail|phone|tel|call)\s*:?\s*(?=$|\n|[.,])/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}
