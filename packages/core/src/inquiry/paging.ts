// Customer inquiry: turning a result set into SMS-sized pages (F-046).
//
// F-045 made answers correct; it did not make them readable. A question about leafy greens
// listed 9 stands in one message — 488 characters, FOUR billed segments — with each address
// in parentheses, so names and addresses wrapped into each other and split mid-entry.
//
// Two fixes, both here:
//   - a page is at most PAGE_SIZE stands, and the rest are offered via MORE
//   - a stand's name and address occupy separate LINES, so neither can wrap into the other
//
// This module renders; it holds no state. The pending list that MORE refers to is durable
// state owned by the caller — see docs/DATA_ARCHITECTURE.md. Keeping the renderer pure is
// what lets the segment ceiling be asserted directly against its output.

import type { Clock } from "../clock";
import {
  isConfirmationExpired,
  isStale,
  PUBLIC_MAP_URL,
  renderItem,
  renderNoCurrentListing,
  renderShortElapsed,
  type RetrievedFact,
} from "./answer";

/**
 * How many stands one page carries.
 *
 * Measured, not chosen by taste. Against the real corpus a stand's name plus address runs
 * 22-57 characters (median 35). F-107's two claim lines per stand raised the worst case from
 * two billed segments to THREE — the extra information is the point of the format, and the
 * cost was bought back by trimming the city/state/ZIP off each address (max, 2026-08-11).
 * Raising this silently raises the cost of every answer —
 * `packages/sms/src/result-page-segments.test.ts` fails if it stops fitting, and that test is
 * the authority, since segment arithmetic lives in that package.
 */
export const PAGE_SIZE = 3;

/**
 * A retrieved fact as the pager sees it — the same `RetrievedFact` the selection seam
 * validates against, not a second near-identical shape (F-046).
 */
export type PageableFact = RetrievedFact;

export interface RenderedPage {
  body: string;
  /** True when a MORE reply would return further results. */
  hasMore: boolean;
}

/**
 * Drop the ", Vashon, WA 98070" tail a few stands store (F-107).
 *
 * Every stand is on Vashon, so the city/state/zip is ~16 characters of nothing on the one
 * surface that pays per character. Measured against the live corpus 2026-08-11: most rows are
 * already bare street addresses, and the handful that are not carry the tail with or without
 * commas.
 *
 * **Anchored to the ZIP or the state, never to the word "Vashon" alone.** "Vashon Hwy SW" is a
 * real road carrying several stands, and stripping the word wherever it appeared would mangle
 * their addresses. The match therefore requires the city token to be followed by the state or
 * ZIP that makes it a city.
 */
function stripIslandSuffix(address: string): string {
  return address
    .replace(/[,\s]+Vashon[,\s]+WA(\s+\d{5}(-\d{4})?)?\s*$/i, "")
    .replace(/[,\s]+WA\s+\d{5}(-\d{4})?\s*$/i, "")
    .trim();
}

function renderAddress(fact: PageableFact): string {
  const address = stripIslandSuffix(fact.publicAddress?.trim() ?? "");
  // Never the literal "null", and never a dropped stand: a farm with no public address is
  // still a real answer to "who has lamb?", it just cannot be navigated to.
  return address === "" ? "address not listed" : address;
}

/** What the header says when there is nothing to show. */
const GENERAL_INVENTORY_SUBJECT = "Recently reported inventory";

/**
 * The header: what was asked, how many stands answer it, and which of them this page holds.
 *
 * Replaces "Here are matching stands:" (max, 2026-08-11), which was read on a handset and
 * says nothing — it neither confirms what we understood nor connects the count to the
 * question. Naming the query back to the customer is the only acknowledgement they get that
 * we read it correctly, and it is free: the words are already in hand.
 *
 * `count` is the number of STANDS, never the number of retrieved facts. One stand can be
 * retrieved on both bases and merge into a single entry, so a fact count would over-state
 * what the customer is being offered (B-062).
 *
 * A general availability request has no term to name, so it gets a subject describing what
 * the list IS. The placeholder item code substitutes for such a request must never surface as
 * though the customer had typed it.
 */
function renderHeader(input: {
  itemsRequested: string[];
  broad: boolean;
  shown: number;
  offset: number;
  total: number;
}): string {
  const { broad, shown, offset, total } = input;
  // Stated only when this page is a window onto something larger. On a single-page answer the
  // range is a restatement of the count, and the count is already right there.
  const window =
    shown < total || offset > 0 ? ` (${offset + 1}-${offset + shown} of ${total})` : "";

  if (broad) return `${GENERAL_INVENTORY_SUBJECT}${window}`;

  const count = `${total} matching stand${total === 1 ? "" : "s"}`;
  const items = input.itemsRequested
    .map((item) => item.trim())
    .filter((item) => item !== "");
  // Nothing to name — say what is true and no more, rather than inventing a subject.
  if (items.length === 0) return `${count}${window}`;

  // Sentence case on the customer's own words: they arrive lowercase from interpretation, and
  // a header that opens mid-sentence reads as a fragment. Only the first word is touched —
  // "Eggs + kale", never "Eggs + Kale", because the rest are the same words they typed.
  const subject = items.join(" + ");
  const titled = subject.charAt(0).toUpperCase() + subject.slice(1);
  return `${titled}: ${count}${window}`;
}


/** One stand as the customer reads it, carrying whichever of its two claims exist. */
export interface StandEntry {
  locationName: string;
  address: string;
  confirmed?: PageableFact;
  offering?: PageableFact;
}

/**
 * Collapse retrieved facts into one entry per STAND (F-107).
 *
 * The old layout grouped by claim type, under headings that named the customer's item. That
 * heading was a claim about every stand beneath it, and B-049 and B-061 were the same failure
 * twice: `Confirmed eggs:` printed over stands that sell no eggs. Scoping each claim to the
 * stand it describes removes the heading's job rather than making it more careful — a neutral
 * header cannot be false, so there is no longer a guard here to get wrong.
 *
 * Two facts can describe ONE stand: a confirmed revision and a standing offering, retrieved
 * separately and carrying distinct ids. They merge HERE, at render time, so the fact ids the
 * model selected and the MORE pending list still refer to exactly what retrieval produced.
 *
 * **Exported because the count must agree with the list (B-062).** The first live reply said
 * "1-3 of 45" over an island with 35 stands: the total counted facts while the page showed
 * merged stands, so the customer was promised more than exists and a dual-basis stand could
 * reappear after a MORE. Callers size their answer with this function, so one rule decides
 * both what is printed and what is counted.
 *
 * A fact with no matched items makes no claim and contributes no line; an entry left with
 * neither claim is dropped entirely. Found live: a selected stand whose matched items were all
 * filtered away rendered as a bare name and address, telling the customer nothing.
 *
 * Ordering: a confirmed stand outranks one that only lists what it typically carries, since
 * the customer asked what is there NOW. Stable within each group, so the caller's order
 * survives.
 */
export function mergeIntoStandEntries(
  facts: readonly PageableFact[],
  now: Date,
): StandEntry[] {
  const entries: StandEntry[] = [];
  const byLocation = new Map<string, StandEntry>();
  for (const fact of facts) {
    let entry = byLocation.get(fact.locationName);
    if (entry === undefined) {
      entry = { locationName: fact.locationName, address: renderAddress(fact) };
      byLocation.set(fact.locationName, entry);
      entries.push(entry);
    }
    if (fact.matchedItems.length === 0) continue;
    if (fact.basis === "confirmed") {
      // B-063 — past the expiry the confirmation stops being evidence of anything, so it makes
      // no claim at all rather than a hedged one. Same rule and same function as the public
      // map, which drops its stock claim here and falls back to what the stand usually sells.
      if (isConfirmationExpired(fact.asOf, now)) continue;
      entry.confirmed ??= fact;
    } else entry.offering ??= fact;
  }

  const claiming = entries.filter(
    (entry) => entry.confirmed !== undefined || entry.offering !== undefined,
  );
  // Three tiers, not two (B-063). A fresh confirmation is the only thing that speaks to what
  // is there NOW, so it leads. Below it, a stand's standing description of what it sells beats
  // somebody else's fortnight-old snapshot: neither is a promise, but the description is at
  // least current AS a description. Stable within each tier, so the caller's order survives.
  const fresh = claiming.filter(
    (entry) => entry.confirmed !== undefined && !isStale(entry.confirmed.asOf, now),
  );
  const stale = claiming.filter(
    (entry) => entry.confirmed !== undefined && isStale(entry.confirmed.asOf, now),
  );
  const offeringOnly = claiming.filter((entry) => entry.confirmed === undefined);
  return [...fresh, ...offeringOnly, ...stale];
}

/**
 * Order facts so that one stand's two rows sit together, and report how many STANDS there are.
 *
 * This is what makes paging by stand possible (B-062). A saved pending list is a flat array of
 * fact ids sliced `PAGE_SIZE` at a time; if a stand's confirmed row lands at the end of one
 * page and its offering row at the start of the next, the stand prints TWICE across two
 * messages — the second time as a bare "May also have" the customer already has better
 * information about. Grouping the ids at save time makes that split unreachable, rather than
 * merely unlikely.
 *
 * The returned `factIds` are the same identifiers in a different order, so grounding, the
 * model's selection, and dereferencing are all untouched: this reorders, it never invents,
 * drops, or rewrites an id.
 *
 * `standCount` is what the header must state. It counts entries that actually make a claim,
 * which is what the customer will be shown — never the raw fact count.
 */
export function groupFactsByStand(
  facts: readonly PageableFact[],
  now: Date,
): {
  factIds: string[];
  standCount: number;
} {
  const entries = mergeIntoStandEntries(facts, now);
  const factIds: string[] = [];
  for (const entry of entries) {
    if (entry.confirmed !== undefined) factIds.push(entry.confirmed.factId);
    if (entry.offering !== undefined) factIds.push(entry.offering.factId);
  }
  return { factIds, standCount: entries.length };
}

/**
 * How many stands one page of already-grouped facts covers.
 *
 * A page is `PAGE_SIZE` STANDS, and a stand can carry two facts, so a fixed fact-count slice
 * would show two or three stands depending on the corpus. This walks the grouped list and
 * returns the fact count that lands exactly on a stand boundary.
 */
export function factsPerPage(facts: readonly PageableFact[], standsPerPage: number): number {
  const seen = new Set<string>();
  let taken = 0;
  for (const fact of facts) {
    if (!seen.has(fact.locationName)) {
      if (seen.size === standsPerPage) break;
      seen.add(fact.locationName);
    }
    taken += 1;
  }
  return taken;
}

/**
 * Render one page of results.
 *
 * `facts` is exactly what this page shows — the caller has already sliced. `offset` and
 * `total` are counted in STANDS, so the page can say "4-6 of 9" without the renderer needing
 * the whole set, and so the number the customer reads matches the entries they can see.
 *
 * One entry per stand (F-107): its name, an "In stock" line stamped with the age of the
 * confirmation, a "May also have" line for what it typically carries, then its street address.
 * A stand with a confirmation outranks one without. An offering carries no timestamp, because
 * nobody confirmed it (F-045's two voices).
 */
export function renderResultPage(input: {
  itemsRequested: string[];
  /**
   * A general availability request ("what do you have"), which named no item.
   *
   * It changes the header only — there is no search term to state, so the page says what the
   * list IS instead. Carried in rather than inferred from `itemsRequested`, because the
   * placeholder code substitutes for such a request is an ordinary word a customer could also
   * type as a real search.
   */
  broad?: boolean;
  facts: PageableFact[];
  offset: number;
  total: number;
  clock: Clock;
}): RenderedPage {
  const { facts, offset, total, clock } = input;
  const now = clock.now();

  const lines: string[] = [];

  const ordered = mergeIntoStandEntries(facts, now);

  // Every stand was dropped, so there is nothing to lead in to. Returning the honest
  // no-listing reply beats a header standing over an empty list.
  if (ordered.length === 0) {
    return { body: renderNoCurrentListing(input.itemsRequested), hasMore: false };
  }

  // Counted in STANDS, matching what `total` means and what the customer can see. Counting the
  // facts behind them promised more than existed (B-062).
  const hasMore = offset + ordered.length < total;

  lines.push(
    renderHeader({
      itemsRequested: input.itemsRequested,
      broad: input.broad === true,
      shown: ordered.length,
      offset,
      total,
    }),
  );

  for (const entry of ordered) {
    lines.push("");
    lines.push(entry.locationName);

    // Field order: name, what it has, where it is (max, 2026-08-11).
    //
    // A customer scans for a farm name, then for whether it has the thing; the address only
    // matters once they have decided to go. The first live reply led with the address, so
    // every entry opened with a house number and the answer sat below it.
    let confirmedNames: Set<string> = new Set();
    if (entry.confirmed !== undefined) {
      confirmedNames = new Set(
        entry.confirmed.matchedItems.map((item) => item.itemName.trim().toLowerCase()),
      );
      const items = entry.confirmed.matchedItems.map(renderItem).join(", ");
      // The elapsed phrase sits INSIDE this line on purpose: it is true of these items and of
      // nothing else in the entry. The "May also have" line below carries no time because
      // nobody confirmed it, and one timestamp above both would silently vouch for both.
      //
      // B-063 — the LABEL carries the staleness, not a suffix. Found on a handset:
      // "IN STOCK (16d ago)" put a present-tense claim and a fortnight-old timestamp in one
      // line, and the label is what a customer reads first. F-107 had dropped the explicit
      // "- may be out of date" because twenty characters per entry pushed an all-stale page
      // over its segment ceiling; swapping the label instead costs nothing, because it
      // REPLACES rather than appends. "Last seen" is honest at any age.
      //
      // The threshold is the map's own `isStale`, from the same function, so one row cannot
      // read as current stock over SMS and as stale on the web.
      const label = isStale(entry.confirmed.asOf, now) ? "Last seen" : "In stock";
      lines.push(`${label} (${renderShortElapsed(entry.confirmed.asOf, now)}): ${items}`);
    }
    if (entry.offering !== undefined) {
      // A confirmation outranks a standing description of the SAME item. Both rows exist for
      // several corpus stands — a farmer publishes the thing they also list as usually
      // carried — and printing it under both labels tells the customer we are unsure which is
      // true. It is in stock; that is the stronger and more useful claim.
      const items = entry.offering.matchedItems
        .filter((item) => !confirmedNames.has(item.itemName.trim().toLowerCase()))
        .map(renderItem)
        .join(", ");
      // Only when something survives: a label over nothing is worse than no label.
      if (items !== "") lines.push(`May also have: ${items}`);
    }

    lines.push(entry.address);
  }

  lines.push("");
  lines.push(
    hasMore
      ? `Reply MORE for the next ${Math.min(PAGE_SIZE, total - offset - ordered.length)}.`
      : // The last page closes rather than dead-ending: the map is where the whole picture
        // lives, and browsing belongs there rather than in a text thread.
        //
        // Bare, since the header already states the range and the total. The previous "All of
        // them. Map:" answered a question the header had already answered, and read as a
        // fragment doing it (max, 2026-08-11).
        `Map: ${PUBLIC_MAP_URL}`,
  );

  return { body: lines.join("\n"), hasMore };
}

/**
 * The reply to MORE when there is no pending list — expired, never started, or already
 * exhausted.
 *
 * It never fails silently and never errors: a customer who texts MORE has asked a reasonable
 * question, and the honest answer is that there is no list, plus what to do instead.
 */
export function renderNoPendingList(): string {
  return "I don't have a list going right now. What are you looking for?";
}
