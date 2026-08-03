import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(
  resolve(process.cwd(), "apps/web/app/farmer/onboarding/[token]/page.tsx"),
  "utf8",
).replace(/\s+/g, " ");

describe("farmer invitation onboarding surface", () => {
  it("makes the phone-verification task, waiting state, and publication boundary explicit", () => {
    expect(page).toContain("Step 1 of 3: verify your phone");
    expect(page).toContain("After you send it, you are done for now.");
    expect(page).toContain("Nothing is public yet.");
    expect(page).toContain("does not approve your farm");
  });
});
