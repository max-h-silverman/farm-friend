import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// These are SOURCE assertions, and they are the weaker kind on purpose: every admin page is a
// server component that reads the database in its own body, so jsdom cannot render one. What
// they can honestly prove is that a given string is or is not present in the page source.
//
// So they are written to the shape that survives that limit: the per-page `<h1>` and its
// subtitle are asserted ABSENT (F-071), which a stray reintroduction fails, and the work
// items are asserted present. Anything that depends on rendered output — the nav reading
// "Home", the retire control behaving — is tested against the real DOM in admin-ui.test.tsx
// instead of here.

const page = (path: string) => readFileSync(resolve(process.cwd(), path), "utf8");

const ADMIN_PAGES = [
  "apps/web/app/admin/stands/page.tsx",
  "apps/web/app/admin/messages/page.tsx",
  "apps/web/app/admin/users/page.tsx",
] as const;

describe("the admin desk", () => {
  it("keeps /admin as a bookmarkable address with no screen of its own", () => {
    // max, 2026-08-10: the desk held nothing but counts pointing at the other tabs, so every
    // task cost two clicks. The URL stays valid — operators have it bookmarked — but it is a
    // redirect now. Anchored on the redirect CALL, not on the import, because an import line
    // survives the call site being deleted.
    const landing = page("apps/web/app/admin/page.tsx");
    expect(landing).toMatch(/redirect\(\s*["']\/admin\/stands["']\s*\)/);
    expect(landing).not.toContain("Needs attention");
  });

  it("counts pending work on the tab that owns it", () => {
    // The counts did not disappear with the desk; they moved above the rows they describe.
    // "Farms nobody can update" is the one that matters most: routinely NOT empty, and
    // previously countable only by navigating to a screen that never said it had work.
    // F-101 — the counts live in the component that renders the rows, not in the server page:
    // they are computed from the rows actually on screen, so a filtered list and its summary
    // cannot disagree. Asserted where they now are.
    const view = page("apps/web/app/admin/stands-and-sellers.tsx");
    expect(view).toContain("waiting for approval");
    expect(view).toContain("nobody who can update");
    expect(view).toContain("admin-attention-summary");
  });

  it("keeps browsable records off a queue screen", () => {
    // Reference records live on /admin/stands, inside the farm they belong to — never behind a
    // second disclosure on a different screen. Anchored on the disclosure CLASS, which is the
    // construct that used to carry them.
    for (const path of ADMIN_PAGES) {
      expect(page(path), `${path} must not hide records behind a disclosure`).not.toContain(
        "admin-secondary-disclosure",
      );
    }
  });

  it("repeats no page title or subtitle under the tabs (F-071)", () => {
    // max: "remove the section title in each section (and any subtitle if it exists). the tab
    // names are enough." The tab is the single statement of where you are; an <h1> under it
    // saying the same word twice is chrome.
    //
    // Anchored to the CONSTRUCT rather than to the words: an `<h1>` in an admin page body is
    // the thing being removed, so the test catches a reintroduction under any wording, not
    // just the four titles that happened to be there.
    for (const path of ADMIN_PAGES) {
      expect(page(path), `${path} must not repeat its tab name as a heading`).not.toMatch(
        /<h1>/,
      );
      expect(page(path), `${path} must not carry a page intro block`).not.toContain(
        "admin-page-intro",
      );
    }
  });
});
