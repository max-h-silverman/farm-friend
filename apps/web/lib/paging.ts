import {
  PAGE_SIZE,
  openNow,
  renderNoPendingList,
  renderResultPage,
  renderStandFactPage,
  timeZoneOffsetMinutes,
  VASHON_TIME_ZONE,
  type Clock,
} from "@farm-friend/core";
import { isPrivilegedSender, takeNextResultPage, type Db } from "@farm-friend/db";
import { dereferenceFacts, parsePagedStandFactId, standKeyOfFactId } from "./inquiry";
import { listPublicStands } from "./public-listing";

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
  // F-074 — the sender's privilege is re-read on every MORE rather than saved with the list.
  // A saved list holds identifiers, not entitlement: if the number was removed from the
  // administrator phone list between the question and this MORE, the test farms drop out of
  // the remaining pages.
  const scope = {
    includeTestFarms: await isPrivilegedSender(deps.db, { senderHash: input.senderHash }),
  };


  // A page is claimed and the offset advanced in one locked transaction, so two MOREs racing
  // cannot both be served the same stands. The loop below re-enters that claim; it never
  // re-reads a position it already consumed.
  for (;;) {
    // A page is PAGE_SIZE STANDS, and one stand can hold two identifiers — a confirmed row and
    // a standing offering. Taking a flat count of identifiers split those rows across two
    // messages and printed the stand twice (B-062).
    //
    // The identifier itself says which stand it belongs to: an offering id is DERIVED from the
    // confirmed one, so normalizing recovers the pair with no database round trip inside the
    // lock.
    const claimed = await takeNextResultPage(deps.db, {
      senderHash: input.senderHash,
      occurredAt: input.occurredAt,
      pageSize: PAGE_SIZE,
      measurePage: (remaining, stands) => {
        const seen = new Set<string>();
        let factCount = 0;
        for (const factId of remaining) {
          const key = standKeyOfFactId(factId);
          if (!seen.has(key)) {
            if (seen.size === stands) break;
            seen.add(key);
          }
          factCount += 1;
        }
        return { factCount, standCount: seen.size };
      },
    });
    if (claimed === null) {
      return { body: renderNoPendingList(), status: "no_pending_list" };
    }

    const standFacts = claimed.factIds.map(parsePagedStandFactId);
    if (standFacts.every((fact) => fact !== undefined)) {
      const kind = standFacts[0]!.kind;
      if (!standFacts.every((fact) => fact!.kind === kind)) {
        continue;
      }
      const publicStands = await listPublicStands(
        { db: deps.db, clock: deps.clock },
        scope,
      );
      const byId = new Map(publicStands.map((stand) => [stand.factId, stand]));
      const selected = new Set(claimed.itemsRequested.map((value) => value.toLowerCase()));
      const now = deps.clock.now();
      const utcOffsetMinutes = timeZoneOffsetMinutes(now, VASHON_TIME_ZONE);
      const stands = standFacts
        .map((fact) => byId.get(fact!.standId))
        .filter((stand) => stand !== undefined)
        .filter((stand) =>
          kind === "payment"
            ? stand.paymentMethods.some((method) => selected.has(method.toLowerCase()))
            : kind === "farm_bucks"
              ? stand.farmBucksAccepted === true
              : openNow({
                  availability: stand.availability,
                  ...(stand.closure !== undefined ? { closure: stand.closure } : {}),
                  at: now,
                  utcOffsetMinutes,
                  ...(stand.latitude !== undefined ? { latitude: stand.latitude } : {}),
                  ...(stand.longitude !== undefined ? { longitude: stand.longitude } : {}),
                }).state === "open",
        );
      if (stands.length === 0) continue;

      const page = renderStandFactPage({
        entries: stands.map((stand) => ({
          locationName: stand.locationName,
          ...(stand.publicAddress !== undefined ? { publicAddress: stand.publicAddress } : {}),
          detailLines:
            kind === "open_now"
              ? ["Open now"]
              : kind === "farm_bucks"
              ? ["Accepts VIGA Farm Bucks"]
              : [
                  `Payment listed: ${stand.paymentMethods
                    .filter((method) => selected.has(method.toLowerCase()))
                    .join(", ")}`,
                ],
        })),
        offset: claimed.offset,
        total: claimed.total,
      });
      return { body: page.body, status: "paged" };
    }

    // The `facts.length === 0` branch below handles a page that empties out, so a sender whose
    // privilege was revoked mid-list walks off the end honestly rather than erroring.
    const facts = (await dereferenceFacts(deps.db, {
      factIds: claimed.factIds,
      itemsRequested: claimed.itemsRequested,
      at: deps.clock.now(),
      scope,
    })).filter((fact) => fact.matchedItems.length > 0);

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
