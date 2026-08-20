/**
 * What "the same item" means, in one place.
 *
 * Case and surrounding whitespace ONLY — never singular/plural, never synonyms.
 *
 * MUST agree exactly with `stand_items_one_per_location_name`, which is
 * `lower(btrim(display_name, E' \t\r\n'))`. If the two disagree they disagree about what
 * "same item" means, and every in-memory dedupe silently stops matching the index that
 * arbitrates. Lives in core rather than db because the draft snapshot path (B-092) needs
 * the same rule with no database in reach.
 *
 * Exported so it can be asserted DIRECTLY. A sabotage proved that testing this through the
 * stored rows is not enough: a normalizer that mangles a word without colliding with another
 * ("tomatoes" -> "tomatoe") corrupts the key while every row-count assertion stays green,
 * because the database index applies the correct rule independently. The key itself has to be
 * the thing under test.
 */

/** The whitespace `stand_items`' index and CHECK name explicitly. Must match exactly. */
const ITEM_WHITESPACE = " \t\r\n";

export function standItemKey(name: string): string {
  return trimItem(name).toLowerCase();
}

export function trimItem(name: string): string {
  let start = 0;
  let end = name.length;
  while (start < end && ITEM_WHITESPACE.includes(name[start]!)) start += 1;
  while (end > start && ITEM_WHITESPACE.includes(name[end - 1]!)) end -= 1;
  return name.slice(start, end);
}
