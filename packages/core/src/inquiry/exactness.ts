/*
  B-086 — WHICH MATCHED VALUES ANSWER THE QUESTION THAT WAS ASKED, and which merely relate to it.

  ## The reply this exists to fix

  max texted "who has kale?" and got eleven stands. The matcher had expanded the request to
  `kale`, `bok choy`, `Baby bok choy`, `a choy`, `leafy greens`, `greens`, `salad greens`,
  `veggies`, `vegetables`, `seasonal vegetables`, `produce` — a generality ladder, then that
  ladder's other rungs. Only the first is kale, and the reply presented all of them identically,
  so a stand whose listing said "vegetables" read as an answer about kale.

  ## Why the fix is here rather than in the prompt

  Broad recall is CORRECT and F-045 exists to guarantee it: a customer asking for leafy greens
  must reach a stand listing butter lettuce. Constraining the matcher to literal matches would
  trade this bug for that one. max's call (2026-08-18): keep the recall, fix the presentation —
  exact matches first, then the rest under "Other stands with <category>:".

  So the seam keeps proposing and CODE decides what gets claimed, which is Golden Rule #3's line
  in the place it belongs. Nothing here calls a model or could be influenced by one.

  ## What "exact" means, precisely

  A matched value is EXACT when it contains the customer's own product word — "kale" is exact for
  `kale` and `kale florets`, because a customer asking for kale is answered by both. It is
  RELATED otherwise: `leafy greens` is a category that contains kale, not a listing of it.

  Word-boundary matching, never substring: `eggs` must not make `eggplant` exact, and `a choy`
  must not be found inside `bok choy`. The corpus has both traps.
*/

/** A matched catalog value, sorted by whether it answers the question or merely relates to it. */
export interface SortedMatches {
  /** Values containing a word the customer typed. These answer the question. */
  exact: string[];
  /** Everything else the matcher selected — broader categories and their other members. */
  related: string[];
}

/*
  Words that carry no product meaning, so they cannot make a match "exact". Without this,
  "who has eggs?" would treat `has` as a product word and any value containing it would qualify.

  This is a STOP LIST for English question grammar, not a food vocabulary — it names no produce
  and grows only with question words. The project permits exactly one food-vocabulary branch and
  it is spoken for (`map-view.ts` §the flower vocabulary exception).
*/
const QUESTION_WORDS = new Set([
  "a", "an", "and", "any", "anybody", "anyone", "anything", "are", "at", "buy", "can",
  "carry", "carrying", "do", "does", "for", "from", "get", "got", "has", "have", "having",
  "here", "how", "i", "in", "is", "it", "know", "me", "much", "near", "now", "of", "on",
  "or", "please", "right", "sell", "selling", "sells", "some", "stand", "stands", "the",
  "there", "they", "this", "to", "today", "want", "what", "whats", "where", "which", "who",
  "whos", "with", "you", "your",
]);

/** The product words a customer's message contributes, lowercased and stripped of grammar. */
function productWords(taskText: string): string[] {
  return taskText
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 1 && !QUESTION_WORDS.has(word));
}

/**
 * Does `value` contain `word` as a whole word?
 *
 * Whole-word, because substring matching is wrong in both directions on the real corpus:
 * `eggs` appears inside `eggplant`, and `a choy` appears inside `bok choy`. Either would
 * promote a related match to an exact one and re-create the bug in a narrower form.
 *
 * A trailing `s` is tolerated in either direction so `egg` and `eggs` are one word — the corpus
 * holds both spellings of most items, and a customer types whichever they think of.
 */
function containsWord(value: string, word: string): boolean {
  const singular = (term: string): string => term.replace(/s$/, "");
  const target = singular(word);
  return value
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((part) => singular(part) === target);
}

/**
 * Split the matcher's selection into what answers the question and what merely relates to it.
 *
 * Order is preserved within each group, so the caller's ranking survives.
 *
 * **When nothing is exact, everything is exact.** A customer who asked for "leafy greens" and
 * got `butter lettuce` and `chard` typed no word that appears in either — and splitting there
 * would file every result under "Other stands with…", which is a worse answer than the one this
 * replaces. The distinction only earns its place when the customer's own word actually appears.
 */
export function sortMatchesByExactness(
  taskText: string,
  matches: readonly string[],
): SortedMatches {
  const words = productWords(taskText);
  if (words.length === 0) return { exact: [...matches], related: [] };

  /*
    EVERY product word must appear, not merely one of them. "a choy" contributes only `choy`
    once grammar is stripped, and `bok choy` contains it — so an `some` test made bok choy an
    exact answer to a question about a choy. They are different vegetables, and the corpus holds
    both. Requiring all of the customer's product words keeps a multi-word request honest, and
    costs nothing on the single-word requests that are the common case.
  */
  const exact = matches.filter((value) => words.every((word) => containsWord(value, word)));
  if (exact.length === 0) return { exact: [...matches], related: [] };

  const exactSet = new Set(exact);
  return { exact, related: matches.filter((value) => !exactSet.has(value)) };
}

/**
 * The label for the related group — the broadest category the matcher chose.
 *
 * Taken from the matched VALUES themselves rather than any taxonomy: these are catalog names
 * farmers typed, and the broadest of them is the honest description of what the other stands
 * share. Inventing a category word here would be a food vocabulary in a behavioural branch,
 * which the architecture permits exactly once and not here.
 *
 * "Broadest" is the shortest value, tie-broken by the matcher's own order — a category name is
 * shorter than the things under it (`greens` before `salad greens` before `baby bok choy`), and
 * that is a property of the words rather than a judgment about food.
 */
export function relatedCategoryLabel(related: readonly string[]): string | undefined {
  if (related.length === 0) return undefined;
  return [...related].sort((a, b) => a.length - b.length)[0];
}
