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
  isStale,
  PUBLIC_MAP_URL,
  renderItem,
  renderRecency,
  type RetrievedFact,
} from "./answer";

/**
 * How many stands one page carries.
 *
 * Measured, not chosen by taste. Against the real corpus a stand's name plus address runs
 * 22-57 characters (median 35); at three per page the worst case still fits inside TWO
 * billed segments, which is the whole point of the feature. Raising this silently raises the
 * cost of every answer — `packages/sms/src/result-page-segments.test.ts` fails if it stops
 * fitting, and that test is the authority, since segment arithmetic lives in that package.
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

function renderAddress(fact: PageableFact): string {
  const address = fact.publicAddress?.trim() ?? "";
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
 * Confirmed stock leads within the page and carries its recency; an offering carries no
 * timestamp and no staleness warning, because nobody confirmed it (F-045's two voices).
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

  const confirmed = facts.filter((fact) => fact.basis === "confirmed");
  const offerings = facts.filter((fact) => fact.basis === "offering");

  const subject = input.itemsRequested.join(", ");
  const lines: string[] = [];

  // B-049 — the heading is a CLAIM, and it may only name what the rows can support.
  //
  // `matchedItems` is not always the requested item. When no published name matches the
  // request, the caller deliberately falls back to the stand's whole list, because a
  // category request ("leafy greens" answered by "butter lettuce") is a relationship only
  // the model can see and listing nothing would render an empty claim. That fallback is
  // right; naming the customer's word above it was not. Against the production corpus this
  // rendered `Confirmed mangoes:` over a stand selling eggs and basil, and `Confirmed
  // dairy:` over a creamery in reply to a dairy-allergy question — code fabricating a
  // factual claim no retrieved row supports.
  //
  // So the item is named only where a row bears it out, per voice: the two headings make
  // separate claims about separate stands and one must not borrow the other's evidence. Any
  // single row is enough, because the heading covers the whole section rather than each line.
  const wanted = new Set(
    input.itemsRequested.map((item) => item.trim().toLowerCase()),
  );
  const namesRequestedItem = (group: PageableFact[]): boolean =>
    group.some((fact) =>
      fact.matchedItems.some((item) => wanted.has(item.itemName.trim().toLowerCase())),
    );

  // The generic subject keeps the sentence honest AND useful: the customer knows what they
  // asked, and every stand line below still names exactly what that stand publishes.
  const confirmedSubject = namesRequestedItem(confirmed) ? subject : "stock";
  const offeringSubject = namesRequestedItem(offerings) ? subject : "these";

  // The heading states what was asked about and, only when it matters, where this page sits.
  // A result set that fits gets no count: it is noise when the customer can see everything.
  const range = hasMore || offset > 0 ? ` (${offset + 1}-${offset + facts.length} of ${total})` : "";

  if (confirmed.length > 0) {
    lines.push(`Confirmed ${confirmedSubject}${offerings.length === 0 ? range : ""}:`);
    for (const fact of confirmed) {
      const items = fact.matchedItems.map(renderItem).join(", ");
      const stale = isStale(fact.asOf, now) ? " - may be out of date" : "";
      lines.push("");
      lines.push(`${fact.locationName} - ${items} (${renderRecency(fact.asOf, now)}${stale})`);
      lines.push(renderAddress(fact));
    }
  }

  if (offerings.length > 0) {
    if (confirmed.length > 0) lines.push("");
    // The full explanation is worth a line ONCE. On a later page the customer already knows
    // why they are reading typical offerings, and restating it costs characters on the page
    // that can least afford them — the closing page also carries the map URL, and the two
    // together pushed the worst case to a third billed segment.
    lines.push(
      confirmed.length > 0
        ? `Also list ${offeringSubject} as a typical offering${range}:`
        : offset > 0
          ? `More stands that usually have ${offeringSubject}${range}:`
          : `Nobody has confirmed ${offeringSubject} recently. Stands that usually have it${range}:`,
    );
    for (const fact of offerings) {
      lines.push("");
      lines.push(fact.locationName);
      lines.push(renderAddress(fact));
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
