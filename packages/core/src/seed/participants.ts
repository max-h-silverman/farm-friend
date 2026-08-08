// F-064 — host farms stated in VIGA's records.
//
// A stand often hosts other sellers: a bakery, a neighbour's eggs, another grower's flowers. The
// public card renders these under "Also selling here" and the admin table under "Other sellers
// here"; both readers have existed since F-050, and both were dead because nothing ever wrote a
// participant row.
//
// TWO SOURCES, ONE SHAPE. The map states it as prose the volunteer typed — "Hosting: Kareli
// Farm", sometimes without the colon — and the weekly form asks it as its own column, where the
// answer is a bare list. One parser reads both: strip the label if present, split the list, and
// refuse anything that is not a name.
//
// WHAT MAKES THIS SAFE TO PUBLISH DETERMINISTICALLY. These strings go straight onto a public
// card, so the risk is not a missed name but an invented one — a farm called "No", a blank
// bullet, or a sentence fragment presented as a seller. Every rule below is a refusal measured
// against the real 2026 answers, and the parser keeps only what looks like a name.
//
// These are display strings, never identities. There is deliberately no matching against seeded
// farms: F-050 has no confirmed linking flow, and resolving "Kareli Farm" to a Farm Friend
// account would fabricate a relationship neither party agreed to.

/**
 * The label the volunteer used, with or without its colon.
 *
 * Anchored to the start, because "hosting" also appears mid-sentence in prose that names no
 * farm, and stripping it there would leave a fragment that then reads as a name.
 */
const HOSTING_LABEL = /^\s*hosting\s*:?\s*/i;

/**
 * An answer that responds to the question rather than naming a seller.
 *
 * Real 2026 answers include "No", "no", and "N/A". Published verbatim, each becomes a farm on a
 * customer's card.
 */
const NON_ANSWER = /^(?:no|none|n\/?a|nope|not\s+at\s+this\s+time|n\/a\.?)$/i;

/**
 * A link is not a seller's name. One real answer glues one on with a colon separator:
 * "Rainy Day Bakes :  www.instagram.com/rainydaybakesvashon/".
 */
const URL_LIKE = /\b(?:https?:\/\/|www\.)\S*|\b\S+\.(?:com|org|net|co)\b\S*/gi;

/**
 * A parenthetical says what they sell, not what they are called: "Handpicked Homestead
 * (flowers)".
 */
const PARENTHETICAL = /\([^)]*\)/g;

/**
 * The longest a real seller name runs, in words.
 *
 * The corpus's longest is "Vashon Island Honey Co." at four. The limit exists to keep an
 * unforeseen sentence off the public card — a farmer's prose answer describing an arrangement
 * ("A second growers plants are being introduced weekly…") splits into clauses that are each
 * grammatical and none of which is a name. Six allows genuine headroom over the real maximum
 * while still refusing a sentence.
 */
const MAX_NAME_WORDS = 6;

/**
 * A name has to contain a letter, and cannot be a bare fragment of punctuation.
 *
 * Checked on the ORIGINAL string rather than a lowercased one: a seller name in this corpus is
 * capitalized, and requiring an initial capital is what separates "Kareli Farm" from the tail of
 * a sentence. `Co.` and `King's` must survive, so the rule is about the FIRST character only.
 */
const LOOKS_LIKE_A_NAME = /^[A-Z0-9]/;

/** One seller name, cleaned of the things that are not part of it. */
function cleanName(raw: string): string {
  return raw
    .replace(URL_LIKE, "")
    .replace(PARENTHETICAL, "")
    // A trailing separator left behind by a stripped URL — "Rainy Day Bakes :" — or the
    // farmer's own trailing punctuation.
    //
    // A trailing PERIOD is deliberately kept: "Vashon Island Honey Co." is how that seller
    // writes its name, and trimming it renames them. The list split already handled the only
    // period that ends a list, because that one is followed by a space.
    .replace(/[\s:;,–—-]+$/, "")
    .replace(/^[\s:;,]+/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Read the host farms a stand states, from either export's phrasing.
 *
 * Returns display strings in the order stated, without duplicates. Returns EMPTY rather than
 * guessing whenever the answer names no farm — a blank label, a non-answer, or prose.
 */
export function parseHostedParticipants(text: string): string[] {
  const withoutLabel = text.replace(HOSTING_LABEL, "").trim();
  if (withoutLabel === "" || NON_ANSWER.test(withoutLabel)) return [];

  // A full stop ends the list, exactly as it does for the weekly form's item list: farmers write
  // the names and then a sentence about the arrangement. Only a stop FOLLOWED BY A SPACE counts,
  // so "Vashon Island Honey Co." survives intact.
  const listPart = withoutLabel.split(/\.\s+/)[0] ?? "";

  const names: string[] = [];
  const seen = new Set<string>();

  for (const piece of listPart.split(/,|;|\s+and\s+|\s+&\s+/i)) {
    const name = cleanName(piece);
    if (name === "") continue;
    if (NON_ANSWER.test(name)) continue;
    if (!LOOKS_LIKE_A_NAME.test(name)) continue;
    if (name.split(/\s+/).length > MAX_NAME_WORDS) continue;

    // Case- and whitespace-insensitive, matching the partial unique index the database enforces
    // on an active participant name.
    const key = name.toLocaleLowerCase("en");
    if (seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }

  return names;
}
