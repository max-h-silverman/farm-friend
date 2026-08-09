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
  "apps/web/app/admin/page.tsx",
  "apps/web/app/admin/farms/page.tsx",
  "apps/web/app/admin/farmers/page.tsx",
  "apps/web/app/admin/messages/page.tsx",
] as const;

describe("the admin desk", () => {
  it("names every queue that can have pending work, and nothing else", () => {
    // The desk is the complete list of what needs deciding. "Farms nobody can update" is the
    // one that matters most here: it is routinely NOT empty and it used to be countable only
    // by navigating to a screen that never said it had work waiting.
    const dashboard = page("apps/web/app/admin/page.tsx");
    expect(dashboard).toContain("Needs attention");
    expect(dashboard).toContain("Farms waiting for approval");
    expect(dashboard).toContain("Farms nobody can update");
    expect(dashboard).toContain("Farmer access requests");
    expect(dashboard).toContain("Messages");
    expect(dashboard).toContain("Stock-outs");
  });

  it("keeps browsable records off the desk", () => {
    // Reference records moved to /admin/farms. The desk mixing "here is a decision" with
    // "here is a list you can browse" is what made an operator guess which disclosure hid
    // their task. Anchored on the disclosure CLASS, which is the construct that carried them.
    const dashboard = page("apps/web/app/admin/page.tsx");
    expect(dashboard).not.toContain("admin-secondary-disclosure");
    expect(dashboard).not.toContain("Stand records");
    expect(dashboard).not.toContain("Test farms");
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
