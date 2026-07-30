"use client";

import { useEffect } from "react";

// F-043 — making the embed fit VIGA's page.
//
// THE PROBLEM THIS SOLVES. An iframe has a FIXED height that the embedding page chooses; the
// embedded document cannot resize its own frame. So VIGA's page today either guesses too
// short (the map gets its own inner scrollbar, and a customer scrolls a small box inside a
// long page — the "bolted-on widget" feel this item was filed to fix) or guesses too tall
// (a slab of dead space under the content). Neither is fixable from inside the frame alone.
//
// The fix is a HANDSHAKE: this posts the document's real height to the parent whenever it
// changes, and VIGA's page sets the iframe to that height. One `postMessage` listener on
// their side, pasted once into a Squarespace code block, and the embed reads as part of the
// page rather than a window onto another one.
//
// WHAT THIS DELIBERATELY DOES NOT DO:
//
//   - It does not read anything from the parent. A cross-origin frame cannot, and asking
//     would be the beginning of a tracking surface. The message travels one way, outward.
//   - It carries NO customer data — one integer, the document height in pixels. It is not a
//     channel and must never become one.
//   - It targets `"*"` rather than a configured origin. That is safe HERE precisely because
//     the payload is a page height and nothing else: there is no secret to leak to a wrong
//     listener, and pinning an origin would mean a config value that breaks the embed
//     silently the day VIGA moves domains.

/** The message VIGA's page listens for. Namespaced so it cannot collide with another embed. */
export const EMBED_HEIGHT_MESSAGE = "farm-friend:height";

/**
 * Tell the embedding page how tall this document is, and keep telling it.
 *
 * Renders nothing. It is a component rather than a bare effect so it can sit in the page
 * tree and be removed by deleting one line.
 */
export function EmbedHeightReporter() {
  useEffect(() => {
    // Not embedded — nothing to report, and no parent to hear it.
    if (window.parent === window) return;

    const post = () => {
      // `scrollHeight` on the documentElement, not `body`: body height collapses when the
      // page uses grid/flex layout, which this one does, and the frame would be sized to a
      // fraction of the content.
      const height = Math.ceil(document.documentElement.scrollHeight);
      window.parent.postMessage(
        { type: EMBED_HEIGHT_MESSAGE, height },
        "*",
      );
    };

    post();

    // The height changes when filters narrow the list, when a card is selected, and when the
    // viewport rotates. A ResizeObserver catches all three without polling — a timer here
    // would either lag the layout visibly or burn battery on a phone held outdoors.
    const observer = new ResizeObserver(post);
    observer.observe(document.documentElement);
    window.addEventListener("resize", post);

    return () => {
      observer.disconnect();
      window.removeEventListener("resize", post);
    };
  }, []);

  return null;
}
