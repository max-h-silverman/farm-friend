import {
  PAGE_SIZE,
  renderNoPendingList,
  renderResultPage,
  type Clock,
} from "@farm-friend/core";
import { takeNextResultPage, type Db } from "@farm-friend/db";
import { dereferenceFacts } from "./inquiry";

// The MORE branch of inbound routing (F-046 part 3).
//
// **This module takes no model dependency, and that is the point.** `MORE` is a deterministic
// keyword parsed before any seam is reachable, and paging reaching a model is prevented by
// this function having nothing to reach — a property of the signature rather than of a seam
// that happens not to be called.
//
// What a page IS, and what an empty pending list reads as, are both `packages/core`'s
// (`renderResultPage`, `renderNoPendingList`). What is left to page is `packages/db`'s
// (`takeNextResultPage`). This composes the two and dereferences the identifiers between
// them; it renders no words of its own.
//
// ## Replay, not re-retrieval (max, 2026-07-31)
//
// The saved list fixes WHICH stands answer the question and in what order. Values are read
// fresh at page time, because the list stores identifiers and no copy of the answer. So a
// stand that confirms stock mid-paging does not appear until the customer asks again — the
// accepted tradeoff, bounded by the list's expiry — while a stand that has gone unpublished
// is silently dropped rather than rendered from something stale.

export interface PagingDeps {
  db: Db;
  clock: Clock;
}

export type PagingStatus = "paged" | "no_pending_list";

export interface PagedReply {
  /** The code-rendered body for the outbox. */
  body: string;
  status: PagingStatus;
}

/**
 * Answer a `MORE` with the sender's next page, or honestly with the fact that there is none.
 *
 * `no_pending_list` covers every way there is nothing to page — never asked, expired,
 * exhausted, or every stand on the remaining pages withdrawn. They are deliberately one
 * reply: all four mean the same thing to the customer, and three shades of "no" would be
 * three chances to say something subtly untrue.
 */
export async function handleNextPage(
  deps: PagingDeps,
  input: { senderHash: string; occurredAt: Date },
): Promise<PagedReply> {
  // A page is claimed and the offset advanced in one locked transaction, so two MOREs racing
  // cannot both be served the same stands. The loop below re-enters that claim; it never
  // re-reads a position it already consumed.
  for (;;) {
    const claimed = await takeNextResultPage(deps.db, {
      senderHash: input.senderHash,
      occurredAt: input.occurredAt,
      pageSize: PAGE_SIZE,
    });
    if (claimed === null) {
      return { body: renderNoPendingList(), status: "no_pending_list" };
    }

    const facts = await dereferenceFacts(deps.db, {
      factIds: claimed.factIds,
      itemsRequested: claimed.itemsRequested,
      at: deps.clock.now(),
    });

    if (facts.length === 0) {
      // Every stand on this page has gone unpublished since the question. Rendering the page
      // would show a heading over nothing, which reads as "no results" — a false claim while
      // later pages still hold real answers. Take the next page instead; an exhausted list
      // resolves to `null` above and gets the honest reply.
      continue;
    }

    const page = renderResultPage({
      itemsRequested: claimed.itemsRequested,
      facts,
      offset: claimed.offset,
      total: claimed.total,
      clock: deps.clock,
    });
    return { body: page.body, status: "paged" };
  }
}
