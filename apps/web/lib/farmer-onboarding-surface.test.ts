import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(
  resolve(process.cwd(), "apps/web/app/farmer/onboarding/[token]/page.tsx"),
  "utf8",
).replace(/\s+/g, " ");

describe("farmer invitation onboarding surface", () => {
  it("makes the phone-verification task, waiting state, and publication boundary explicit", () => {
    expect(page).toContain("Step 1 of 3: agree and verify your phone");
    expect(page).toContain("After you send it, you are done for now.");
    expect(page).toContain("Nothing is public yet.");
    expect(page).toContain("does not approve your farm");
  });

  it("routes the whole prepared-text affordance through the agreement step", () => {
    // The launch blocker's structural half. If the page rendered the `sms:` link itself,
    // a farmer could send SIGNUP without agreeing, spend the one-use invitation, establish
    // no consent, and be authorized into permanent silence. `AgreementStep` is what gates
    // it, so the page must own no second path to the same link.
    //
    // Anchored to the CALL SITE and the absence of the affordance, not to the import: an
    // import line alone would satisfy a name check while the component went unrendered.
    expect(page).toContain("<AgreementStep token={params.token} signupUrl={signupUrl} />");
    expect(page).not.toContain("farmer-primary-link");
    expect(page).not.toContain("Text SIGNUP to verify this phone");
  });
});
