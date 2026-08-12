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
