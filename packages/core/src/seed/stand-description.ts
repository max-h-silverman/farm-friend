import { stripContactDetails } from "./stand-csv";

// F-061 — the public description, rebuilt from the profile form's own columns.
//
// THE ONE LINE THIS REPLACES lived in `seed-stands.ts`:
//
//   const publicDescription = mapDescription || [ ...form fields... ].join("\n");
//
// With a map row present — 27 of 35 stands — the transcription's prose won and the form's clean
// columns were discarded FOR DISPLAY while still being parsed for the structured fields. That is
// the whole cause of both on-screen contradictions: the "Hours not listed" badge read the
// structured column while the prose beside it stated the hours, and "Nothing confirmed recently"
// printed directly above a farmer-dated update line.
//
// THE RULE: a fact with its own column never appears in the prose. Hours, season, stocking,
// links, payment methods, Farm Bucks, and dated stock updates each have a home and a renderer.
// A description that repeats one is how the two get to disagree on screen.
//
// THE REMAINDER IS REAL AND IS KEPT. The audit disconfirmed "the description is mostly
// duplication" — measured over the corpus, the leftover is a land acknowledgement, WSDA
// licensing, "we place a sign at the bottom of the driveway". That is the farm's voice, and
// deriving it away would be the quieter failure.

export interface StandDescriptionSource {
  /** The profile form's own prose columns — the farm speaking for itself. */
  generalInformation?: string;
  extraNotes?: string;
  /** Structured answers, supplied so a line that only restates one can be recognized. */
  openSeasonText?: string;
  openHoursText?: string;
  stockingText?: string;
  website?: string;
  socialMedia?: string;
  /**
   * The map transcription, used ONLY when the farm submitted no form.
   *
   * Four stands are map-only, so retiring `mapDescription ||` must not leave them blank.
   */
  mapDescription?: string;
}

/**
 * A bare street address on its own line.
 *
 * It has its own column and renders as a destination link; repeated in the prose it is both
 * duplication and, for a stand whose farmer refused one (B-024), a leak of the very fact we
 * agreed not to publish.
 */
const BARE_ADDRESS =
  /^\s*\d+\s+[NSEW]{0,2}\s*\w[\w\s.'-]*\s(?:st|street|ave|avenue|rd|road|hwy|highway|ln|lane|dr|drive|way|ct|court|pl|place|blvd|ter|terrace)\b\.?(?:\s*(?:sw|se|nw|ne))?\s*(?:,.*)?$/i;

/** Lines that restate a fact already held in a column of its own. */
const STRUCTURED_LINE = [
  // "Open: Year Round", "Open Hours: 9-5", "Hours: dawn to dusk"
  /^\s*open(?:\s+(?:hours|season|days))?\s*:/i,
  /^\s*(?:hours|season|stocking(?:\s+days)?|days)\s*:/i,
  // "Website: …", "Instagram: @x", "Facebook: …"
  /^\s*(?:web\s*site|website|site|instagram|insta|facebook|fb|social(?:\s+media)?|twitter|x)\s*:/i,
  // "Accepts Cash, Check, Venmo, VIGA Farm Bucks"
  /^\s*accepts?\b/i,
  // "5/26/2026 Update: salad, kale" — a confirmation, parsed by `extractStockUpdate`.
  // The corpus writes the separator as a colon OR a dash (5 of 18 use a dash, including an
  // en-dash), so matching only the colon leaves a dated line printed as prose beneath the
  // card's own "Nothing confirmed recently" — the exact contradiction this removes.
  /^\s*\d{1,2}\/\d{1,2}\/\d{4}\s*update\s*[-–—:]/i,
  // A bare URL or handle on its own line is a link, not a description.
  /^\s*(?:https?:\/\/|www\.)[^\s]+\s*$/i,
  /^\s*@[^\s]+\s*$/,
  // A sentinel non-answer transcribed as description text — Vashon Garlic's row reads "Nope!".
  /^\s*(?:none|nope|no|n\/?a|nil|not applicable)\s*[!.]?\s*$/i,
  BARE_ADDRESS,
];

/**
 * True when a line adds nothing a structured column does not already state.
 *
 * Deliberately NOT "the line mentions hours". A sentence carrying real information survives even
 * when it names a structured fact — "we are open year round, but the greenhouse closes in
 * January" is the farm telling a customer something no column holds. The test is whether the
 * line is *only* a restatement: a labelled field, or a bare echo of the stated answer.
 */
function restatesStructuredFact(line: string, source: StandDescriptionSource): boolean {
  const text = line.trim();
  if (text === "") return true;
  if (STRUCTURED_LINE.some((pattern) => pattern.test(text))) return true;

  // A line that is exactly the structured answer, give or take punctuation and case.
  const normalize = (value: string) =>
    value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const bare = normalize(text);
  if (bare === "") return true;
  for (const stated of [
    source.openSeasonText,
    source.openHoursText,
    source.stockingText,
    source.website,
    source.socialMedia,
  ]) {
    if (stated !== undefined && normalize(stated) === bare) return true;
  }
  return false;
}

/**
 * Build the description a customer reads, from the farm's own prose.
 *
 * The form outranks the map: the form is the farm speaking for itself, the map export is a
 * hand-typed derivative — which is where `WA, WA 98070` and the wrong-row website came from.
 */
export function buildStandDescription(
  source: StandDescriptionSource,
): string | undefined {
  const own = [source.generalInformation, source.extraNotes]
    .filter((text): text is string => text !== undefined && text.trim() !== "")
    .join("\n");

  // A map-only farm has nothing else; a farm that filled the form has said its piece.
  const prose = own !== "" ? own : (source.mapDescription ?? "");
  if (prose.trim() === "") return undefined;

  const lines = stripContactDetails(prose)
    .split(/\r?\n/)
    .map((line) => line.trim());

  // The map transcription opens with the farmer's NAME then their ADDRESS, each on its own
  // line — "Milo" / "12919 SW Cemetery Rd", "Sarah Herridge" / "15324 Vermontville Road SW".
  // A person is not a description, and printing it reads as though the stand were called that.
  //
  // Recognized by the PAIR, not by the name alone. A name cannot be identified from its own
  // content — "Fresh Flowers" and "Milo" are equally plausible as either a name or prose — so
  // the signal is the address line that follows it. That is what makes this safe: a first line
  // followed by anything else is left exactly where the farm put it.
  const looksLikeName = /^[A-Z][\p{L}'’-]*(?:\s+(?:and\s+)?[A-Z][\p{L}'’-]*){0,3}$/u;
  if (
    own === "" &&
    lines.length > 1 &&
    looksLikeName.test(lines[0] ?? "") &&
    BARE_ADDRESS.test(lines[1] ?? "")
  ) {
    lines.shift();
  }

  const kept: string[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (restatesStructuredFact(line, source)) continue;
    // The transcription repeats itself — Forest Garden Farm states its certification twice.
    const key = line.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(line);
  }

  const description = kept.join("\n").trim();
  return description === "" ? undefined : description;
}

/**
 * A refusal must name the ADDRESS. "Do not publish my phone number" is a different request,
 * already handled by `stripContactDetails`, and treating it as an address refusal would hide a
 * visitable stand from the map — the opposite failure, and just as bad for a farmer who wants
 * customers.
 */
const ADDRESS_REFUSAL = [
  /\b(?:do\s+not|don'?t|please\s+do\s+not|please\s+don'?t)\s+(?:add|publish|list|share|post|include|show|use)\b[^.\n]{0,40}\baddress\b/i,
  /\bno\s+address\b[^.\n]{0,30}\b(?:please|thanks?)\b/i,
  /\baddress\b[^.\n]{0,30}\b(?:private|not\s+public|do\s+not\s+publish)\b/i,
];

/**
 * True when a farmer asked, in their own words, that their address not be published (B-024).
 *
 * THE FAILURE THIS PREVENTS. Handpicked Homestead's form says "I don't have my own farmstand -
 * please add me under Plum Forest's location, do not add my address." Production published her
 * HOME as a `visitable` farm stand with a correct map pin, against that written request. It is
 * F-038's misdirecting pin made worse: the coordinate is right, it is someone's house, and she
 * asked us not to.
 *
 * Read as a GENERAL rule from the farmer's own text — no farm is named in code, so a farmer who
 * writes the same sentence next season is covered by the same mechanism. A stand that refuses
 * becomes contact-only: no address, no coordinate, still listed and still findable.
 */
export function refusesPublicAddress(text: string): boolean {
  return ADDRESS_REFUSAL.some((pattern) => pattern.test(text));
}
