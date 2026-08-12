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


/**
 * Render one page of results.
 *
 * `facts` is exactly what this page shows — the caller has already sliced. `offset` and
 * `total` describe where that slice sits, so the page can say "4-6 of 9" without the renderer
 * needing the whole set.
 *
 * One entry per stand (F-107): its name, its street address, an IN STOCK line stamped with the
 * age of the confirmation, and a MAYBE line for what it typically carries. A stand with a
 * confirmation outranks one without. An offering carries no timestamp, because nobody
 * confirmed it (F-045's two voices).
 */
export function renderResultPage(input: {
  itemsRequested: string[];
  facts: PageableFact[];
  offset: number;
  total: number;
  clock: Clock;
}): RenderedPage {
  const { facts, offset, total, clock } = input;
  const now = clock.now();
  const hasMore = offset + facts.length < total;

  const lines: string[] = [];

  // F-107 — one entry per STAND, carrying both of its claims.
  //
  // The old layout grouped by claim type, under headings that named the customer's item. That
  // heading was a claim about every stand beneath it, and B-049 and B-061 were the same failure
  // twice: `Confirmed eggs:` printed over stands that sell no eggs. Scoping each claim to the
  // stand it describes removes the heading's job rather than making it more careful — a neutral
  // lead-in cannot be false, so there is no longer a guard here to get wrong.
  //
  // Two facts can describe ONE stand: a confirmed revision and a standing offering, retrieved
  // separately and carrying distinct ids. They merge here, at render time, so the fact ids the
  // model selected and the MORE pending list still refer to exactly what retrieval produced.
  const entries: {
    locationName: string;
    address: string;
    confirmed?: PageableFact;
    offering?: PageableFact;
  }[] = [];
  const byLocation = new Map<string, (typeof entries)[number]>();
  for (const fact of facts) {
    let entry = byLocation.get(fact.locationName);
    if (entry === undefined) {
      entry = { locationName: fact.locationName, address: renderAddress(fact) };
      byLocation.set(fact.locationName, entry);
      entries.push(entry);
    }
    // A fact with no matched items makes no claim, so it contributes no line. Keeping it
    // would print a stand name and address under a question they do not answer.
    if (fact.matchedItems.length === 0) continue;
    if (fact.basis === "confirmed") entry.confirmed ??= fact;
    else entry.offering ??= fact;
  }

  // A confirmed stand outranks one that only lists what it typically carries: the customer
  // asked what is there NOW, and only a confirmation speaks to that. Stable within each group,
  // so the caller's ordering survives.
  // An entry that ended up with neither claim is dropped entirely (F-107). Found live: a
  // selected stand whose matched items were all filtered away rendered as a bare name and
  // address, telling the customer nothing about what they asked.
  const claiming = entries.filter(
    (entry) => entry.confirmed !== undefined || entry.offering !== undefined,
  );
  const ordered = [
    ...claiming.filter((entry) => entry.confirmed !== undefined),
    ...claiming.filter((entry) => entry.confirmed === undefined),
  ];

  // Every stand was dropped, so there is nothing to lead in to. Returning the honest
  // no-listing reply beats a heading standing over an empty list.
  if (ordered.length === 0) {
    return { body: renderNoCurrentListing(input.itemsRequested), hasMore: false };
  }

  // Where this page sits, stated only when there is more than one page to sit in.
  const range =
    hasMore || offset > 0 ? ` (${offset + 1}-${offset + ordered.length} of ${total})` : "";
  lines.push(`Here are matching stands${range}:`);

  for (const entry of ordered) {
    lines.push("");
    lines.push(entry.locationName);
    // Street address directly under the name, where a reader looks for it. City/state/zip are
    // omitted: every stand is on Vashon, so they are 16 characters of nothing per line.
    lines.push(entry.address);
    if (entry.confirmed !== undefined) {
      const items = entry.confirmed.matchedItems.map(renderItem).join(", ");
      // The elapsed phrase sits INSIDE this line on purpose: it is true of these items and of
      // nothing else in the entry. The MAY line below carries no time because nobody confirmed
      // it, and one timestamp above both would silently vouch for both.
      //
      // F-107 — no separate staleness warning on this surface (max, 2026-08-11). The elapsed
      // phrase IS the warning: "(3d ago)" tells a customer what "- may be out of date" told
      // them, in four characters instead of twenty, and the twenty were what pushed an
      // all-stale page past its segment ceiling. Nothing is hidden — a stale listing still
      // appears, still ranked, still stamped with its age, which is the honor-system
      // commitment. **The public map keeps its own explicit warning**; a browsed card has room
      // for words a text message pays for.
      lines.push(`IN STOCK (${renderShortElapsed(entry.confirmed.asOf, now)}): ${items}`);
    }
    if (entry.offering !== undefined) {
      const items = entry.offering.matchedItems.map(renderItem).join(", ");
      // One label for both cases. "MAYBE" reads the same whether or not an IN STOCK line sits
      // above it, and the shorter word buys back segment budget on every entry.
      lines.push(`MAYBE: ${items}`);
    }
  }

  lines.push("");
  lines.push(
    hasMore
      ? `Reply MORE for the next ${Math.min(PAGE_SIZE, total - offset - facts.length)}.`
      : // The last page closes rather than dead-ending: the map is where the whole picture
        // lives, and browsing belongs there rather than in a text thread.
        `All of them. Map: ${PUBLIC_MAP_URL}`,
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
