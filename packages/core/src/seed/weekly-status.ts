import { matchStandName } from "./match-stands";
import type { RejectedStand } from "./stand-csv";

// F-062 — VIGA's weekly stock form, the third CSV and the one nothing has ever read.
//
// WHAT IT IS. `Farm Stand Weekly Status (Responses) 2024 - Form Responses 1.csv`: 734 submissions
// from 49 sellers across four seasons (2020, 2024, 2025, 2026). One row per farm per week, filled
// in by the farmer. For 2026 the availability question is answered on all 70 rows.
//
// WHY IT BECOMES A CONFIRMATION. A farmer has been filling in this form for years and has not
// heard of Farm Friend. If their submission produces nothing on the map, the system replacing
// their old one is strictly worse for them on day one and silently discards work they really
// did. And a customer deciding whether to drive wants both facts: the standing one ("usually
// sells eggs") sets expectations, the dated one ("confirmed 3 days ago") says how much to trust
// it today. They work in concert — which is also what gives a sparse launch some slack while few
// farmers are texting yet.
//
// So a submission becomes a dated confirmation carrying `source = 'viga'` (F-063) — never an SMS
// one, because a Google Form is not a handset. Age needs no special handling: past
// `STALE_AFTER_HOURS` the card already shows its stale caution, which is exactly true. A farmer's own SMS supersedes
// their weekly row the moment they send one; that is the migration path off the legacy form.
//
// WHAT IT REFUSES. A closure ("Closed for the season") is not stock and has its own consumer. A
// form test ("test") is not a specialty. An availability cell reading "Yes" answers a different
// question and names nothing. An unreadable date leaves no honest "confirmed X ago" to render,
// and a fabricated one is worse than no row at all.

/** One farm's most recent weekly statement of what it has. */
export interface WeeklySubmission {
  /** The farm's name as the farmer typed it; joined by `matchStandName` downstream. */
  farmName: string;
  /** The day the farmer submitted, at UTC midnight. The form records a date, not an instant. */
  statedOn: Date;
  /** The items named, in stated order, uninterpreted. */
  items: string[];
}

/** A farm that reported itself CLOSED rather than stocked. */
export interface WeeklyClosure {
  farmName: string;
  statedOn: Date;
  /** The farmer's own words, so an operator sees what was meant. */
  statedAs: string;
}

export interface WeeklyStatusResult {
  /** Latest submission per farm, newest first. */
  submissions: WeeklySubmission[];
  closed: WeeklyClosure[];
  /** Rows the reader refused. Never silently dropped — the ingest reports them. */
  rejected: RejectedStand[];
}

export interface WeeklyStatusOptions {
  /**
   * Read only submissions from this calendar year.
   *
   * The file carries four seasons and a 2020 row describes a stand as it was six years ago.
   * Nothing in the product reads a past season (max, 2026-08-04), so ingesting them would be
   * data with no consumer.
   */
  season?: number;

  /**
   * Former farm name key → current farm name key, from `readFormerNames`.
   *
   * A farmer who renames mid-season keeps submitting under both names, and those rows are ONE
   * farm's timeline. Without this they are two, and the closure/stock race that decides whether
   * a stand is open never happens between them: Green Ears filed stock on 30 March as "Maggie's
   * Farm" and closed on 6 July under the new name, and the March stock published as current.
   *
   * The writer resolves renames too, but it cannot repair this — by the time it sees the rows
   * the parser has already resolved the timeline, and a closure is deliberately not written, so
   * there is nothing there to supersede the stale stock row.
   */
  formerNames?: ReadonlyMap<string, string>;
}

/**
 * The columns this reader needs, checked by name rather than by position.
 *
 * Checked at all because pointing the loader at the PROFILE form would otherwise yield zero
 * submissions, which is indistinguishable from a genuinely empty season — and "ingested 0 rows"
 * reads like success. Failing loudly is the only honest outcome for a wrong file.
 */
const REQUIRED_COLUMNS = [
  "Timestamp",
  "Farm Name",
  "Are you open this week",
  "What do you have available",
] as const;

/**
 * Split CSV text into rows, honouring quoted fields that contain commas AND newlines.
 *
 * Both occur in the real export: one availability cell spans lines mid-sentence. A line-based
 * reader shifts every later column by one and reads the availability answer out of the wrong
 * cell — the same misattribution that made the map export unreadable.
 */
function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else quoted = false;
      } else field += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(field);
      field = "";
    } else if (char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else if (char !== "\r") field += char;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * A cell that reports the stand shut, or empty, rather than listing stock.
 *
 * Three real shapes, all meaning the same thing to a customer deciding whether to drive:
 * "Closed", "We don't have anything available this week", and "Open mid June" (not open yet).
 * The middle one is a farmer stating a real fact, not a broken submission — refusing it would
 * silently discard an answer they took the trouble to give.
 */
const CLOSED =
  /^\s*(?:closed|closing|not open|we(?:'re| are) closed)\b|\b(?:do\s*n[o']t|don't|nothing)\b[^.]{0,40}\bavailable\b|^\s*(?:re-?)?open(?:ing|s)?\s+(?:on\s+)?(?:mid|early|late|in|next|[A-Z][a-z]+day|\d)/i;

/**
 * A cell that answers a different question, or no question.
 *
 * "Yes" is a real answer in the availability column — the farmer read it as "are you open". It
 * names no item, so there is nothing a customer could look for.
 */
const NON_ANSWER = /^\s*(?:yes|no|n\/?a|none|nothing|same|same as last week|-{1,2})\s*[.!]?\s*$/i;

/** A row that is plainly someone testing the form. */
const FORM_TEST = /^\s*(?:test|testing|asdf|xxx+)\s*[.!]?\s*$/i;

/** Trailing vagueness a customer cannot look for — "and more", "etc". */
const VAGUE_TAIL = /^(?:and\s+)?(?:more|etc\.?|others?|much more|lots more)\.?$/i;

/**
 * An entry that is a CLAUSE rather than a thing to buy.
 *
 * Real examples: "More starts coming out regularly (weather dependent)", "We also have vegetable
 * starts - squashes". A card prints each item as something a customer can look for, so a sentence
 * lands there as a very strange product.
 *
 * Recognized by sentence shape — a verb phrase or a leading connective — not by length. A real
 * item can be long ("Artisan Popsicles & Ice Cream Bars") and a clause can be short.
 */
const NOT_AN_ITEM =
  /\b(?:we|our|please|coming|available|call|order|open|closed)\b|^(?:also|plus|and\s+we)\b/i;

/**
 * Read the submission date as a UTC-midnight day.
 *
 * Round-tripped, because `new Date(2026, 1, 31)` silently becomes 3 March — which would date a
 * confirmation to a day nobody wrote down. A confirmation's whole value is its date.
 */
function readStatedOn(timestamp: string): Date | undefined {
  const match = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})/.exec(timestamp);
  if (match === null) return undefined;
  const month = Number(match[1]);
  const day = Number(match[2]);
  const year = Number(match[3]);
  const statedOn = new Date(Date.UTC(year, month - 1, day));
  if (
    statedOn.getUTCFullYear() !== year ||
    statedOn.getUTCMonth() !== month - 1 ||
    statedOn.getUTCDate() !== day
  ) {
    return undefined;
  }
  return statedOn;
}

/**
 * Split the farmer's sentence into items.
 *
 * A FULL STOP ENDS THE LIST. Farmers write the list first and then a sentence about something
 * else — restocking, or how to pay. Twisting Tree's real row is "Zucchini, Carrots, garlic and
 * potatoes. Cash, checks, Venmo and Viga bucks excepted": splitting on commas alone publishes
 * "Cash" and "Venmo" as produce, and payment methods already have their own column and their own
 * card line (F-061). So the list is whatever precedes the first sentence break, and any clause
 * that survives is dropped by `NOT_AN_ITEM`.
 */
function readItems(text: string): string[] {
  // Only a full stop followed by a space ends the list — "Honey. We also have…". A decimal or an
  // abbreviation inside an item ("No. 9") carries no following space in this corpus.
  const listPart = text.split(/\.\s+/)[0] ?? "";
  return listPart
    .split(/\r?\n|,|;|\s+and\s+/i)
    .map((item) => item.trim().replace(/[.;:]+$/, ""))
    .filter(
      (item) =>
        item !== "" && !VAGUE_TAIL.test(item) && !NOT_AN_ITEM.test(item),
    );
}

/**
 * Read VIGA's weekly stock form.
 *
 * Returns the LATEST submission per farm: a farm submits weekly all season, and only the most
 * recent could describe what is there now. Publishing every row would show one farm many times,
 * each with a different date.
 */
export function parseWeeklyStatus(
  csv: string,
  options: WeeklyStatusOptions = {},
): WeeklyStatusResult {
  const rows = parseCsv(csv);
  const header = rows[0];
  if (header === undefined) throw new Error("weekly status CSV is empty");

  const columnAt = new Map(header.map((name, index) => [name.trim(), index]));
  const missing = REQUIRED_COLUMNS.filter((name) => !columnAt.has(name));
  if (missing.length > 0) {
    throw new Error(
      `weekly status CSV header is not this form — missing: ${missing.join(", ")}`,
    );
  }
  const cell = (row: string[], name: (typeof REQUIRED_COLUMNS)[number]) =>
    (row[columnAt.get(name)!] ?? "").trim();

  const rejected: RejectedStand[] = [];
  const closed = new Map<string, WeeklyClosure>();
  const latest = new Map<string, WeeklySubmission>();

  /**
   * The key the latest-wins race runs on.
   *
   * NOT the raw string the farmer typed. One farmer really did submit as "Fruits Des Vignes
   * Farm" in April and "Fruits des Vignes Farm" in July, and a raw-string key makes those two
   * sellers — so an April row survives as current stock for a stand that does not exist. The same
   * normalization the join downstream uses is the one that has to run here, or "latest per farm"
   * is a claim about a key rather than about a farm.
   *
   * Falls back to the raw name when a name is entirely generic words: `matchStandName` throws
   * there by design, and one unusable name must not abort a 700-row file. Such a row then races
   * only against itself, which is the pre-existing behaviour for a name nothing can match.
   */
  const raceKey = (name: string): string => {
    let key: string;
    try {
      key = matchStandName(name);
    } catch {
      return name;
    }
    // A stated rename folds the old name's rows into the current farm's single timeline.
    return options.formerNames?.get(key) ?? key;
  };

  for (const row of rows.slice(1)) {
    if (row.every((value) => value.trim() === "")) continue;

    const farmName = cell(row, "Farm Name");
    const timestamp = cell(row, "Timestamp");
    const available = cell(row, "What do you have available");
    const openAnswer = cell(row, "Are you open this week");

    const statedOn = readStatedOn(timestamp);
    if (statedOn === undefined) {
      // Named by farm rather than by row number: the report is read by a person deciding what
      // to do about it, and "row 47" tells them nothing they can act on.
      rejected.push({
        name: farmName === "" ? "(no farm name)" : farmName,
        reason: `unreadable submission date: ${timestamp || "(empty)"}`,
      });
      continue;
    }
    if (options.season !== undefined && statedOn.getUTCFullYear() !== options.season) {
      continue;
    }
    if (farmName === "") {
      rejected.push({ name: "(no farm name)", reason: "submission names no farm" });
      continue;
    }

    // A closure is a different fact with a different consumer. Read as inventory it would
    // publish a closed stand carrying one item called "Closed".
    //
    // Recorded in the SAME latest-wins race as a stock row, not a separate one. Green Ears
    // really does both — stocked 18 May, closed 6 July — and two independent maps would list it
    // as stocked AND closed, letting the ingest publish a closed stand as open. One timeline per
    // farm: the newest row wins, whichever kind it is, so a farm that reopens is stocked again.
    const key = raceKey(farmName);

    if (CLOSED.test(available) || CLOSED.test(openAnswer)) {
      const priorClosure = closed.get(key);
      const priorStock = latest.get(key);
      if (priorClosure !== undefined && statedOn <= priorClosure.statedOn) continue;
      if (priorStock !== undefined && statedOn <= priorStock.statedOn) continue;
      latest.delete(key);
      closed.set(key, { farmName, statedOn, statedAs: available || openAnswer });
      continue;
    }

    if (FORM_TEST.test(available)) {
      rejected.push({ name: farmName, reason: `submission is a form test: "${available}"` });
      continue;
    }
    if (available === "" || NON_ANSWER.test(available)) {
      rejected.push({
        name: farmName,
        reason: `availability answer names nothing: "${available || "(empty)"}"`,
      });
      continue;
    }

    const items = readItems(available);
    if (items.length === 0) {
      rejected.push({ name: farmName, reason: `availability answer names nothing: "${available}"` });
      continue;
    }

    // Same one-timeline-per-farm race as the closure branch above: a stock row newer than a
    // recorded closure means the farm reopened and is stocked again.
    const priorStock = latest.get(key);
    const priorClosure = closed.get(key);
    if (priorStock !== undefined && statedOn <= priorStock.statedOn) continue;
    if (priorClosure !== undefined && statedOn <= priorClosure.statedOn) continue;
    closed.delete(key);
    latest.set(key, { farmName, statedOn, items });
  }

  return {
    submissions: [...latest.values()].sort(
      (a, b) => b.statedOn.getTime() - a.statedOn.getTime(),
    ),
    closed: [...closed.values()].sort((a, b) => b.statedOn.getTime() - a.statedOn.getTime()),
    rejected,
  };
}
