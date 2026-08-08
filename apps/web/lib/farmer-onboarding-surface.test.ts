import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The page's source with COMMENTS STRIPPED, then whitespace collapsed.
 *
 * Stripping is load-bearing, not tidiness. These assertions are about what the page SHOWS a
 * farmer, and a comment is not shown to anyone — so a comment mentioning a phrase can satisfy
 * an assertion that the phrase is present, and, worse, a comment EXPLAINING why a phrase was
 * removed will fail an assertion that it is absent. Both happened here: the note recording
 * that "VIGA reviews your request" was retired contains those very words.
 *
 * Anchoring to rendered text rather than to raw file bytes is the same rule CLAUDE.md states
 * for source assertions generally — a regex for a call site must not be satisfiable by an
 * import line.
 */
const page = readFileSync(
  resolve(process.cwd(), "apps/web/app/farmer/onboarding/[token]/page.tsx"),
  "utf8",
)
  // JSX block comments `{/* … */}` first, then ordinary block and line comments.
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, " ")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/^\s*\/\/.*$/gm, " ")
  .replace(/\s+/g, " ");

describe("farmer invitation onboarding surface", () => {
  // The farmer's obligation is ONE action — tick, then send the prepared text. What follows is
  // VIGA's review, which the farmer waits for rather than performs. These assert the promises
  // the page must keep, not the sentences that keep them: copy is free to improve, but a
  // rewrite that drops the waiting state or the publication boundary is a farmer left
  // wondering whether their stand just went public.
  it("tells the farmer what the link itself is worth, so a spent one is not a surprise", () => {
    expect(page).toContain("This link expires after seven days and works once.");
  });

  // F-067 — "VIGA reviews your request" was RETIRED, not reworded. Redeeming an agreed
  // invitation that names a farm now authorizes the farmer and approves the farm in one
  // transaction, with no administrator acting, and the listing publishes on submit. A page
  // promising a review describes a step nobody performs, which is worse than saying nothing:
  // the farmer waits for a text that already arrived.
  it("promises no VIGA review it cannot keep", () => {
    expect(page).not.toMatch(/VIGA reviews/i);
    expect(page).not.toContain("Nothing is public yet.");
  });

  // The "What happens next" section was REMOVED from this page (max, 2026-08-07), so the test
  // that asserted its copy is gone with it rather than left failing. The invitation page now
  // ends at the agreement and the link-expiry note; what happens after the text is explained by
  // the reply itself. The `/farmer/start` door keeps its own "What happens next" section, which
  // is a different page describing a different next step.

  // The listing form is the whole point of F-067: without it a farm reaches the public map
  // with a name and nothing else. Anchored to the CALL SITE, not the import — an import line
  // alone would satisfy a name check while the component went unrendered.
  it("renders the listing form, and passes it the invitation's own farm name", () => {
    expect(page).toContain("<ListingStep");
    expect(page).toContain("token={params.token}");
    expect(page).toContain('farmName={invitation.farmName ?? ""}');
  });

  // "Step 1 of 3" told the farmer two more screens were coming when there are none — the
  // remaining steps were VIGA's. A step counter here is a promise the flow cannot keep.
  it("does not present the farmer's single action as one step of a numbered sequence", () => {
    expect(page).not.toMatch(/Step \d+ of \d+/i);
  });

  it("routes the whole prepared-text affordance through the agreement step", () => {
    // The launch blocker's structural half. If the page rendered the `sms:` link itself,
    // a farmer could send the redemption text without agreeing, spend the one-use
    // invitation, establish no consent, and be authorized into permanent silence.
    // `AgreementStep` is what gates it, so the page must own no second path to the link.
    //
    // Anchored to the CALL SITE and the absence of the affordance, not to the import: an
    // import line alone would satisfy a name check while the component went unrendered.
    expect(page).toContain("<AgreementStep token={params.token} joinUrl={joinUrl} />");
    expect(page).not.toContain("farmer-primary-link");
    // F-080 — this asserted the absence of "Text SIGNUP to verify this phone". Once that
    // keyword was retired the string existed NOWHERE, so the assertion passed on every
    // possible page and proved nothing. It now names the string the affordance actually
    // uses, which is the only form in which "the page does not render it" is a real claim.
    expect(page).not.toContain("Text START to verify this phone");
  });

  it("the affordance it must not render is one that genuinely EXISTS", () => {
    // Guards the failure the assertion above just had. A `not.toContain` is only meaningful
    // while its subject is a string something really renders — otherwise retiring the copy
    // silently turns the guard into a tautology.
    //
    // So: read the component that owns the affordance and require the exact string there.
    // If it is reworded, this fails and forces the guard above to be updated with it.
    const agreementStep = readFileSync(
      resolve(process.cwd(), "apps/web/app/farmer/onboarding/[token]/agreement-step.tsx"),
      "utf8",
    );
    expect(agreementStep).toContain("Text START to verify this phone");
  });
});
