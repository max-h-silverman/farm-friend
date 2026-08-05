import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const page = readFileSync(
  resolve(process.cwd(), "apps/web/app/farmer/onboarding/[token]/page.tsx"),
  "utf8",
).replace(/\s+/g, " ");

describe("farmer invitation onboarding surface", () => {
  // The farmer's obligation is ONE action — tick, then send the prepared text. What follows is
  // VIGA's review, which the farmer waits for rather than performs. These assert the promises
  // the page must keep, not the sentences that keep them: copy is free to improve, but a
  // rewrite that drops the waiting state or the publication boundary is a farmer left
  // wondering whether their stand just went public.
  it("tells the farmer they are done after sending, and that nothing is public yet", () => {
    expect(page).toMatch(/done|nothing (?:more|else)|wait/i);
    expect(page).toContain("Nothing is public yet.");
  });

  it("names VIGA's review as what happens next, so the wait is expected", () => {
    expect(page).toMatch(/VIGA reviews/i);
  });

  // "Step 1 of 3" told the farmer two more screens were coming when there are none — the
  // remaining steps were VIGA's. A step counter here is a promise the flow cannot keep.
  it("does not present the farmer's single action as one step of a numbered sequence", () => {
    expect(page).not.toMatch(/Step \d+ of \d+/i);
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
