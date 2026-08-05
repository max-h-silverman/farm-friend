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

/** A dated statement of what a stand had, read from VIGA's sheet rather than sent by a farmer. */
export interface StockUpdate {
  /** The day the sheet states, at UTC midnight. Never a time — the sheet records only a date. */
  statedOn: Date;
  /** The items named on that line, in stated order, uninterpreted. */
  items: string[];
}

const DATED_UPDATE = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*update\s*:\s*(.*)$/i;

/**
 * Read the most recent dated stock update from a description.
 *
 * WHY THIS IS A PARSE AND NOT A DISPLAY CONCERN. VIGA's sheet carries lines like
 * "5/26/2026 Update: Salad, spinach, kale". Left in the description they rendered as prose
 * directly beneath the card's code-rendered "Nothing confirmed recently" — two statements
 * contradicting each other on screen, with the dated one looking the more specific. Parsing the
 * date is what lets the card state one thing.
 *
 * THE CLOSURE FORM IS NOT OURS. "7/9/2026 Update: Closed" is the same shape and already has a
 * consumer in `closureNote`; reading it here would publish a closed stand as carrying one item
 * called "Closed". It is deliberately excluded rather than left to the item splitter.
 *
 * AN IMPOSSIBLE DATE IS REFUSED, not rolled forward. `new Date(2026, 1, 31)` silently becomes
 * 3 March, which would date a confirmation to a day nobody wrote down — the same class of
 * quiet-wrong the seeder's other refusals exist to prevent.
 */
export function extractStockUpdate(description: string): StockUpdate | undefined {
  let latest: StockUpdate | undefined;

  for (const line of description.split(/\r?\n/)) {
    const match = DATED_UPDATE.exec(line);
    if (match === null) continue;

    // A dated closure is a different fact with a different consumer.
    if (CLOSURE.test(match[4]!)) continue;

    const month = Number(match[1]);
    const day = Number(match[2]);
    const year = Number(match[3]);
    const statedOn = new Date(Date.UTC(year, month - 1, day));
    // Round-trip the parts: anything Date silently normalized comes back different.
    if (
      statedOn.getUTCFullYear() !== year ||
      statedOn.getUTCMonth() !== month - 1 ||
      statedOn.getUTCDate() !== day
    ) {
      continue;
    }

    const items = match[4]!
      // The corpus writes these as sentences — "…, plant starts and flowers".
      .split(/\s*,\s*|\s+and\s+/i)
      .map((item) => item.trim())
      .filter((item) => item !== "");
    if (items.length === 0) continue;

    // Latest wins. Descriptions accumulate notes across a season, and only the most recent
    // could describe what is there now; document order is not reliably chronological.
    if (latest === undefined || statedOn > latest.statedOn) {
      latest = { statedOn, items };
    }
  }

  return latest;
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
