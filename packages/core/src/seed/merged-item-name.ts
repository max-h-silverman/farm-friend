// Detect a `stand_items.display_name` that holds a comma-joined LIST rather than one item, and
// split it.
//
// Found on a handset 2026-08-13: one row held a stand's entire offerings list as a single string,
// so a customer asking for one thing was told the stand "may have" all nine of them on one line.
// The renderer was faithful; the row was wrong.
//
// **This decides SHAPE, never meaning.** It holds no farm or food vocabulary — a crop word here
// would be policy hiding in a parser, and a test asserts its absence against this file's own
// source. It answers one question: is this string several short names separated by commas?
//
// **It declines everything it cannot prove.** Returning `null` costs nothing — the caller skips
// the row and the data stays as it is. Splitting wrongly invents items a farmer never listed and
// publishes them as what their stand carries, so every threshold below fails toward `null`.

/**
 * How many comma-separated parts before a string is believed to be a list.
 *
 * Two is not enough: "eggs, dozen" is one item with a qualifier, and a rule that split it would
 * manufacture an item called "dozen". Three or more short parts is a list — measured against the
 * production corpus, where the one real case has nine and nothing else has a comma at all.
 */
const MINIMUM_PARTS = 3;

/**
 * The longest a part may be and still read as an item name.
 *
 * The longest legitimate name in the live corpus is 23 characters. The ceiling sits above that
 * with room to spare, and exists to refuse PROSE: a sentence with commas in it must not become a
 * row of "items", because each fragment would then be published as something the stand carries.
 */
const MAXIMUM_PART_LENGTH = 40;

/**
 * Split a display name that holds a list, or return `null` when it does not.
 *
 * `null` means "leave this row alone" and is the answer for every ordinary item name, so the
 * caller can run this over an entire table and act only where it fires.
 */
export function splitMergedItemName(displayName: string): string[] | null {
  if (!displayName.includes(",")) return null;

  const parts = displayName
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "");

  if (parts.length < MINIMUM_PARTS) return null;
  // One long part is enough to make the whole string prose rather than a list. Checked across
  // every part, not on average: an average would let one sentence hide among short fragments.
  if (parts.some((part) => part.length > MAXIMUM_PART_LENGTH)) return null;

  return parts;
}
