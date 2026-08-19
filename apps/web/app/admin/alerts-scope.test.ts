import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
  WHAT ALERTS IS FOR (max, 2026-08-19): messages a person sent that need a human to read them.
  That is the `flags` table and nothing else — `sender_flagged` from the FLAG rail, and
  `issue_reported` from the HELP issue-report path B-091 added. Both are somebody writing to
  VIGA in words.

  Two sections left with it, each for its own reason rather than as a blanket sweep:

  **Stock-outs** are not a message, they are a signal about a listing, and the farmer is the one
  who acts on them (Golden Rule #1). Customers still report them and farmers are still told —
  max chose "keep collecting, drop the screen" (2026-08-19) — so what goes is VIGA's queue, not
  the feature. Measured in production first: 8 open reports nobody had reviewed.

  **"Questions about our records"** were never a product surface at all. `stand_data_flags` is
  written by the SEEDER (`packages/db/src/seed.ts`) when the original VIGA spreadsheet carried
  availability text a human should look at. Production holds 4, all resolved, from the initial
  load; nothing in the running product creates one. A queue fed only by a one-time import is a
  screen an operator learns to ignore.

  This is a source assertion, so it is anchored to the CALL SITE and to the file's existence —
  never to an import line, which survives the thing it imports being deleted (DEVELOPMENT.md
  §gotchas).
*/

const admin = resolve(process.cwd(), "apps/web/app/admin");
const api = resolve(process.cwd(), "apps/web/app/api/admin");

function read(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

describe("Alerts carries messages needing review, and nothing else", () => {
  const page = read(resolve(admin, "messages/page.tsx"));

  it("still renders the flag queue", () => {
    // The anchor that proves the assertions below are about a REMOVAL rather than about a file
    // that failed to load. Without it, an empty read would pass every test here.
    expect(page).not.toBe("");
    expect(page).toMatch(/<FlagQueue\b/);
    expect(page).toMatch(/listFlagsForReview\(/);
  });

  it("renders neither the stock-out queue nor the records queue", () => {
    expect(page, "a stock-out is the farmer's to act on, not VIGA's").not.toMatch(
      /<ReportQueue\b/,
    );
    expect(page, "nothing in the product writes a stand-data flag").not.toMatch(
      /<StandDataQueue\b/,
    );
  });

  it("does not read the two queues it no longer shows", () => {
    // A query whose result reaches no reader is work done for nobody, and it would keep the
    // removed surface looking alive to the next person who greps for it.
    expect(page).not.toMatch(/listStockOutReports\(/);
    expect(page).not.toMatch(/listStandDataFlags\(/);
  });

  it("leaves no component behind with nothing to render it", () => {
    expect(read(resolve(admin, "reports/report-queue.tsx"))).toBe("");
    expect(read(resolve(admin, "stand-data/stand-data-queue.tsx"))).toBe("");
  });

  it("leaves no admin route behind with no caller", () => {
    // Each route's only caller was the component above. A guarded write nobody can reach is
    // surface to keep secure for no benefit.
    expect(read(resolve(api, "stock-out-reports/route.ts"))).toBe("");
    expect(read(resolve(api, "stand-data-flags/route.ts"))).toBe("");
  });
});
