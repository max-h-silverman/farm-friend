import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// F-079 — the map's loading fallback must stay OUT of the app root.
//
// ## The defect this exists to prevent, which shipped once and was found by running the server
//
// `loading.tsx` at `app/` is a Suspense boundary wrapping EVERY route. Next commits an HTTP
// **200** as soon as that shell streams — so a page that later calls `notFound()` renders 404
// markup under a 200 status. The secret door did exactly this: `curl` returned `200` with the
// 404 page in the body, while a genuinely missing route returned a real `404` from the same
// server. Proven by moving the file and watching the same request become a 404.
//
// A 200 carrying 404 text is indexable, cached as success by intermediaries, and — the whole
// point of the door — tells a prober the path is LIVE, which is the one fact the obscurity
// depends on hiding.
//
// This is a BUILD-SHAPE property: no unit test of the page can see it, because it is about
// where a file sits in the route tree. So the assertion is about the file layout, and the
// status itself was verified against the real standalone server (the one the container runs).

describe("the map's loading boundary is scoped, not global", () => {
  const app = (path: string) => resolve(__dirname, "..", "app", path);

  it("has NO loading.tsx at the app root", () => {
    // The single assertion that keeps every non-map route's HTTP status its own.
    expect(existsSync(app("loading.tsx"))).toBe(false);
  });

  it("keeps the map's own fallback inside the (map) group", () => {
    // The control: without this, deleting the spinner entirely would satisfy the test above
    // while silently removing the public map's loading state.
    expect(existsSync(app("(map)/loading.tsx"))).toBe(true);
    expect(existsSync(app("(map)/page.tsx"))).toBe(true);
  });

  it("keeps the farmer surface outside that group, so it inherits no fallback", () => {
    expect(existsSync(app("farmer/start/[secret]/page.tsx"))).toBe(true);
    expect(existsSync(app("farmer/loading.tsx"))).toBe(false);
  });
});
