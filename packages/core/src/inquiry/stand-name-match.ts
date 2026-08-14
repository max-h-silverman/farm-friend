// The fuzzy tier of stand-name resolution (B-065).
//
// **This is reachable ONLY from an open clarification.** Farm Friend has already asked
// "Which stand are you at?", so the next message is presumed to be an attempt at that answer
// rather than a new topic (max, 2026-08-12). A cold message keeps the exact-only behavior
// F-106 built, and max's 2026-08-11 ruling against fuzzy matching there still stands.
//
// That context is what makes a threshold defensible here and not there. Cold, a wrong guess
// silently routes a stranger's report to an unrelated farmer. Inside a clarification the
// candidate set is already narrowed by the question, a tie asks again rather than guessing,
// and the alternative is the dead end B-065 filed.
//
// No farm or food vocabulary lives here — this compares arbitrary strings and knows nothing
// about what they name.

/**
 * How many edits a word of this length may absorb before it stops being the same word.
 *
 * Scaled to length, and that is the whole correctness argument. Measured against all 36 live
 * stands 2026-08-12: at a FLAT allowance of 2, "barts" — a correctly spelled partial that
 * resolves exactly today — became a three-way tie with "Bananas Barn" and "Green Ears",
 * because barn/barts/ears/bird/bear/cart all sit within two edits of one another. Short
 * distinctive words are exactly where unrelated stand names collide, so they get no slack.
 *
 * Under 5 characters: exact only. 5-7: one edit. 8 or more: two.
 */
export function fuzzyNameAllowance(word: string): number {
  if (word.length < 5) return 0;
  if (word.length < 8) return 1;
  return 2;
}

/**
 * Whether two words are within `budget` edits of each other (Levenshtein).
 *
 * Returns a boolean rather than the distance because no caller needs the number, and one that
 * did would be ranking near-misses — a similarity score, which is the guess this design
 * avoids. Bounded early: a length difference alone can exceed the budget.
 */
export function editDistanceWithin(a: string, b: string, budget: number): boolean {
  if (a === b) return true;
  // An empty side is never "nearly" a real word, whatever the budget: every character is an
  // insertion, and treating "" as close to a short name would match it against everything.
  if (a === "" || b === "") return false;
  if (Math.abs(a.length - b.length) > budget) return false;

  // Two rows rather than a full matrix: only the previous row is ever read.
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    previous = current;
  }
  return previous[b.length]! <= budget;
}

/**
 * Whether a typed word is a plausible attempt at a stand's word.
 *
 * The allowance is the MINIMUM of the two sides, so a long typed word cannot spend its own
 * generous budget reaching across a short stand word — "pinecone" must not reach "barn".
 */
export function isFuzzyNameMatch(typed: string, standWord: string): boolean {
  const budget = Math.min(fuzzyNameAllowance(typed), fuzzyNameAllowance(standWord));
  return editDistanceWithin(typed, standWord, budget);
}

/**
 * Whether a distinctive-word score is enough to call a stand IDENTIFIED (F-111 Phase 2b).
 *
 * **The bug this closes.** A score of 1 used to count. "Open Gate Lamb and Grazing" contributes
 * the distinctive word `open`, so every message containing that ordinary English word bound to
 * that farm — "when do you open", "what stands are open today" — and was handled as a report
 * about it. `GENERIC_NAME_WORDS` cannot prevent this: it strips words common across STAND
 * NAMES, and `open` is common in English, not in the corpus. Any future stand named "Fresh …",
 * "Sunny …" or "Corner …" would reintroduce it for a different word.
 *
 * **The rule: matched words must be at least HALF the stand's distinctive words.** It asks how
 * much of the name the sender actually typed, which is the question a coincidence fails and a
 * partial name passes. One word of four is a coincidence; one word of two is half a short name.
 *
 * Measured against the real 34-stand corpus (`maps/offerings-proposals.json`) plus the two live
 * stands the F-106/B-065 cases name, 2026-08-13 — 14/14 required cases, where three other
 * candidate rules each failed at least one:
 *
 *   - "require 2 matched words for a multi-word name" breaks `barts` → Bart's Cart.
 *   - "keep a score of 1 when the word is unique corpus-wide" does nothing at all: `open` IS
 *     unique to one stand, which is precisely the defect.
 *   - a minimum matched-word LENGTH on top of this rule costs nine further real partials at 5
 *     characters and breaks `barts` at 6.
 *
 * **Known and accepted cost** (max, 2026-08-13): 33 single-word partials of longer names stop
 * resolving — "morgan" no longer reaches Morgan Hill Community Farm Stand. Those senders are
 * asked which stand they mean, which is recoverable; binding a stranger's report to the wrong
 * farmer is not.
 *
 * Takes counts rather than the words themselves: the rule is about coverage, and passing the
 * strings would invite a caller to add vocabulary to a comparison that must stay about shape.
 */
export function meetsDistinctiveWordBar(
  matchedWords: number,
  standDistinctiveWords: number,
): boolean {
  // A stand that matched nothing is never a candidate — asserted here as well as at the call
  // site so the rule is true standing alone, and so a name with no distinctive words at all
  // (0 of 0) cannot pass by vacuous arithmetic.
  if (matchedWords <= 0) return false;
  return matchedWords * 2 >= standDistinctiveWords;
}

const GENERIC_NAME_WORDS: ReadonlySet<string> = new Set([
  "farm",
  "farms",
  "farmstand",
  "stand",
  "garden",
  "gardens",
  "the",
  "and",
]);

/** The one spelling used for both a customer's text and public stand names. */
export function foldStandName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

export type StandNameResolution =
  | { kind: "match"; id: string }
  | { kind: "none" }
  | { kind: "ambiguous" };

/**
 * Resolve one cold-message stand name without guessing.
 *
 * Complete-name containment wins. Otherwise the single candidate whose distinctive words
 * cover at least half its name wins. Zero matches and ties remain separate so a lookup can say
 * "not found" while a report can ask the same clarification for either.
 */
export function resolveStandName(
  text: string,
  stands: readonly { id: string; name: string }[],
): StandNameResolution {
  const foldedText = foldStandName(text);
  if (foldedText === "") return { kind: "none" };

  const names = stands.map((stand) => ({ ...stand, folded: foldStandName(stand.name) }));
  const complete = names.filter(
    (stand) => stand.folded !== "" && foldedText.includes(stand.folded),
  );
  if (complete.length === 1) return { kind: "match", id: complete[0]!.id };
  if (complete.length > 1) return { kind: "ambiguous" };

  const messageWords = new Set(foldedText.split(" ").filter((word) => word !== ""));
  let best: { id: string; score: number } | undefined;
  let tied = false;
  for (const stand of names) {
    const words = stand.folded
      .split(" ")
      .filter((word) => word !== "" && !GENERIC_NAME_WORDS.has(word));
    const score = words.filter((word) => messageWords.has(word)).length;
    if (!meetsDistinctiveWordBar(score, words.length)) continue;
    if (best === undefined || score > best.score) {
      best = { id: stand.id, score };
      tied = false;
    } else if (score === best.score) {
      tied = true;
    }
  }

  if (best === undefined) return { kind: "none" };
  return tied ? { kind: "ambiguous" } : { kind: "match", id: best.id };
}
