// B-002 — locating the labelled facts inside a stand's free-text description.
//
// VIGA's descriptions are prose with informal labels: "Open: March-November. 7 days a week",
// "Stocking Days: Daily", plus dated update notes. This module finds those labels. It does not
// interpret what they say — `availability.ts` does that, and keeps the fact/defect distinction.
//
// WHY THE LABEL MATCH IS STRICT. The first draft matched `open` anywhere in a line and read
// 3 Brothers Outpost's "OPEN has: eggs" as opening hours, which would have fed "has: eggs" to
// the season parser and raised a spurious defect flag for a stand that simply never stated a
// season. Running it over the real 31 rather than reasoning about it is what exposed that.

/** The labelled facts a description states, unresolved and uninterpreted. */
export interface StandFields {
  /** Every `Open:` line found, in document order. */
  openTexts: string[];
  /** The first stated opening text, the one the parser reads. */
  openText?: string;
  stockingText?: string;
  /** A dated note saying the stand is closed — contradicts any stated hours. */
  closureNote?: string;
}

/**
 * Labels that terminate a preceding field's text.
 *
 * Load-bearing for Plum Forest Farm, whose "Open year round, everyday 9am-8pm" is followed
 * directly by "Stocking Days:". Without this the hours text swallows the stocking line and
 * both facts are lost.
 */
const NEXT_LABEL =
  /^\s*(?:open|stocking\s*days?|stocking|generally\s+(?:offers|available)|general\s+information|hosting|hosts|accepts?|website|instagram|facebook|email|phone)\b/i;

/**
 * An opening-hours label: `Open:` or a bare `Open` that begins a statement about being open.
 *
 * `OPEN has:` is deliberately excluded — "has" introduces stock, not hours.
 */
const OPEN_LABEL = /^\s*open\b(?!\s+has\b)\s*:?\s*(.*)$/i;

const STOCKING_LABEL = /^\s*stocking\s*days?\s*:?\s*(.*)$/i;

/**
 * A closure note. Requires the word to stand as a statement about the stand, so
 * "Closed loop farm" (Littlest Bird's description of its practices) does not match.
 */
const CLOSURE = /\bclosed\b(?!\s*loop)/i;

export function extractStandFields(description: string): StandFields {
  const lines = description.split(/\r?\n/);
  const openTexts: string[] = [];
  let stockingText: string | undefined;
  let closureNote: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    const stocking = STOCKING_LABEL.exec(line);
    if (stocking) {
      const value = stocking[1]!.trim();
      if (value !== "" && stockingText === undefined) stockingText = value;
      continue;
    }

    const open = OPEN_LABEL.exec(line);
    if (open) {
      const value = open[1]!.trim();
      if (value !== "") openTexts.push(value);
      continue;
    }

    // A dated update that reports the stand closed. Kept separate from hours because it
    // CONTRADICTS them rather than refining them: the seeder raises a flag instead of
    // choosing which statement to believe.
    if (CLOSURE.test(line)) {
      closureNote = line.trim();
    }
  }

  return {
    openTexts,
    ...(openTexts[0] !== undefined ? { openText: openTexts[0] } : {}),
    ...(stockingText !== undefined ? { stockingText } : {}),
    ...(closureNote !== undefined ? { closureNote } : {}),
  };
}

/** True when a line begins a new labelled field. Exported for the loader's own segmentation. */
export function beginsLabelledField(line: string): boolean {
  return NEXT_LABEL.test(line);
}

export interface FarmBucksPolicy {
  accepted: boolean;
  eligible: true;
}

const VIGA_BUCKS = /\bVIGA\s*(?:Farm\s*)?Bucks?\b|\bFarm\s+Bucks?\b/i;
const ACCEPTS_VIGA_BUCKS = /\baccept(?:s|ed|ing)?\b[^\n]{0,80}/i;
const REFUSES_VIGA_BUCKS =
  /\b(?:does\s+not|do\s+not|cannot|can't|will\s+not|won't)\s+accept\b[^\n]{0,80}|\bnot\s+accepted\b[^\n]{0,80}/i;

/**
 * Read a VIGA Bucks policy from farmer/source prose without treating missing policy as refusal.
 *
 * A listing can contain multiple dated notes. If those notes contradict one another, returning
 * `undefined` keeps the map from presenting either one as current fact until an operator reviews
 * it.
 */
export function parseFarmBucksPolicy(text: string): FarmBucksPolicy | undefined {
  const clauses = text.split(/\r?\n|;/);
  const refused = clauses.some(
    (clause) => VIGA_BUCKS.test(clause) && REFUSES_VIGA_BUCKS.test(clause),
  );
  const accepted = clauses.some(
    (line) =>
      VIGA_BUCKS.test(line) &&
      ACCEPTS_VIGA_BUCKS.test(line) &&
      !REFUSES_VIGA_BUCKS.test(line),
  );

  if (accepted === refused) return undefined;
  return { accepted: !refused, eligible: true };
}
