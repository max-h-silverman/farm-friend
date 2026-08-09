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
  /^\s*(?:hours|season|days)\s*:/i,
  // NOTE: `Generally Offers`, `Stocking Days` and `Hosting` are deliberately NOT here. They are
  // handled by `LABELLED_LIST_LINE`, which drops them only when the body reads as a plain list.
  // 10 lines in the real corpus carry a tail no column holds, and a blanket pattern here would
  // delete it. One mechanism for those labels, not two.
  // A bare "Open …" line with no colon — Green Ears' "Open Thursday - Sunday / 9am - Dusk",
  // Plum Forest's "Open year round, everyday 9am-8pm". Both printed beside "Hours not listed".
  //
  // NARROW ON PURPOSE. The line must be ONLY hours: days, clock times, "dawn"/"dusk", and the
  // punctuation that joins them. Breathing Meadows writes "Open only by appointment – We have a
  // place for learning about herbs…", where the opening words restate the hours and the rest is
  // the only thing that farm says about itself. A greedy `^open\b` would delete that farm's
  // entire voice, so anything containing a word outside this vocabulary survives.
  /^\s*open\s+(?:(?:year\s*round|all\s*year|daily|everyday|every\s*day|dawn|dusk|to|through|thru|and|until|til|till|am|pm|noon|mon(?:day)?|tues(?:day)?|tue|wed(?:nesday)?|thur(?:sday)?|thurs|thu|fri(?:day)?|sat(?:urday)?|sun(?:day)?|weekends?|weekdays?|spring|summer|fall|autumn|winter)|[\d\s:.,;/&()-]|[–—])+\s*$/i,
  // "Website: …", "Instagram: @x", "Facebook: …"
  /^\s*(?:web\s*site|website|site|instagram|insta|facebook|fb|social(?:\s+media)?|twitter|x)\s*:/i,
  // "Accepts Cash, Check, Venmo, VIGA Farm Bucks"
  /^\s*accepts?\b/i,
  // "5/26/2026 Update: salad, kale" — a confirmation, parsed by `extractStockUpdate`.
  // The corpus writes the separator as a colon OR a dash (5 of 18 use a dash, including an
  // en-dash), so matching only the colon leaves a dated line printed as prose beneath the
  // card's own "Nothing confirmed recently" — the exact contradiction this removes.
  // The year is written both ways — "7/22/2026 Update:" and "7/9/25 update:" — because the
  // sheet is hand-typed.
  //
  // Three more spellings measured on the real corpus, each of which escaped the pattern above:
  // Plum Forest's "4/21/2026: Update:" puts a colon after the DATE as well; Northbourne's
  // "7/9/2025 No Update." is a dated NON-answer, which is still a confirmation line and still
  // not a description; and a trailing full stop rather than a separator.
  //
  // The leading MONTH is optional, which is not defensive coding — the production data has a
  // row beginning literally "/22/2026 Update:", its month lost upstream in the hand-editing
  // that produced the sheet. Found by the dry run against real rows, never by a fixture. The
  // line is recognized by the SHAPE that remains rather than repaired, since supplying a month
  // nobody wrote would be inventing a confirmation date.
  //
  // `update` stays REQUIRED after the date, which is what keeps this narrow: ordinary prose
  // like "open Tue/Thu" or "salad w/ herbs" carries slashes and must survive.
  /^\s*(?:\d{1,2})?\/\d{1,2}\/(?:\d{4}|\d{2})\s*:?\s*(?:no\s+)?update\b\s*[-–—:.]?/i,
  // A bare URL or handle on its own line is a link, not a description.
  /^\s*(?:https?:\/\/|www\.)[^\s]+\s*$/i,
  /^\s*@[^\s]+\s*$/,
  // A sentinel non-answer transcribed as description text — Vashon Garlic's row reads "Nope!".
  /^\s*(?:none|nope|no|n\/?a|nil|not applicable)\s*[!.]?\s*$/i,
  BARE_ADDRESS,
];

/**
 * A labelled line whose body is a plain LIST — the case where dropping the whole line loses
 * nothing, because every word of it restates the column.
 *
 * Measured on the real corpus: 10 labelled lines carry a genuine TAIL instead, where the label's
 * own fact is followed by something no column holds — "Stocking Days: Stocking daily. Harvest
 * days are Tuesday and Friday. Best selection on those days by late afternoon." The first
 * sentence is the column; the rest is the farm's voice, and no punctuation rule separates them
 * reliably (Littlest Bird's offerings line ends "…Organic practices and rotational grazing for
 * chickens, sheep and pigs", which is a farming practice, not an offering).
 *
 * So the strip is deliberately CONSERVATIVE: a labelled line is removed only when its body reads
 * as a list — short, and carrying no sentence break. Anything richer is KEPT WHOLE and reaches
 * the farmer's own edit box, where the person who wrote it decides what survives. Deleting it
 * here would be the quieter failure this file was written to avoid: the farm's voice derived
 * away by a rule that could not tell a list from a sentence.
 */
function isPlainList(body: string): boolean {
  const text = body.trim();
  if (text === "") return true;
  // A sentence break followed by more words is the tell: "Stocking daily. Harvest days are…"
  if (/[.!?]\s+\S/.test(text)) return false;
  // Long bodies are prose in practice, whatever their punctuation.
  return text.length <= 60;
}

/** Labels whose body must be a plain list before the line may be dropped. */
const LABELLED_LIST_LINE = [
  /^\s*generally\s+offers?\b\s*[:;]?\s*(.*)$/i,
  /^\s*open\s+has\b\s*[:;]?\s*(.*)$/i,
  /^\s*stocking(?:\s+days?)?\s*[:;]?\s*(.*)$/i,
  /^\s*hosting\b\s*:?\s*(.*)$/i,
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

  // A labelled line survives when its body is more than a list — see `isPlainList`. Checked
  // BEFORE the blanket patterns below, which would otherwise drop it whole.
  for (const pattern of LABELLED_LIST_LINE) {
    const match = pattern.exec(text);
    if (match !== null) return isPlainList(match[1] ?? "");
  }

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
