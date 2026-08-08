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
  it("does NOT warn about link expiry on the page the link just worked on", () => {
    // max removed the note (2026-08-07). It was true — the link is one-use and does expire —
    // but it warned about the very page the farmer had just successfully opened, which is the
    // one moment the fact cannot act on anything. The `status !== "active"` branch above states
    // it where it applies and says what to do, and that branch is asserted separately.
    expect(page).not.toContain("expires after seven days");
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
    // The token reaches the form inside its CREDENTIAL, which is the shape `ListingCredential`
    // requires — it was `token={params.token}` while the deleted `AgreementStep` took it as a
    // bare prop, and that spelling no longer appears anywhere on this page.
    expect(page).toContain('kind: "invitation", token: params.token');
    expect(page).toContain('farmName={invitation.farmName ?? ""}');
  });

  // "Step 1 of 3" told the farmer two more screens were coming when there are none — the
  // remaining steps were VIGA's. A step counter here is a promise the flow cannot keep.
  it("does not present the farmer's single action as one step of a numbered sequence", () => {
    expect(page).not.toMatch(/Step \d+ of \d+/i);
  });

  it("routes the whole prepared-text affordance through the agreement step", () => {
    // The launch blocker's structural half, PRESERVED THROUGH THE MOVE (max 2026-08-07).
    //
    // The property has never changed: the page must own no path by which a farmer sends the
    // redemption text without having agreed. What changed is where the gate lives — the
    // agreement is now a field inside `ListingStep`, above its Submit button, rather than a
    // separate card below the whole form. `AgreementStep` is deleted.
    //
    // So this asserts the page renders the form and NOTHING else that could text on its own.
    // Anchored to the call site and to the absence of the affordance, not to an import: an
    // import line alone would satisfy a name check while the component went unrendered.
    expect(page).toContain("<ListingStep");
    expect(page).not.toContain("farmer-primary-link");
    expect(page).not.toContain("AgreementStep");
    // The prepared-text affordance is gone from this page entirely. Asserted against a string
    // that genuinely EXISTS somewhere (see the test below), so this is a real claim rather than
    // a tautology over retired copy.
    expect(page).not.toContain("Text START to verify this phone");
  });

  it("the agreement it must render is a real, gating field on the form", () => {
    // Guards the failure the assertion above could have. A `not.toContain` is only meaningful
    // while the thing it forbids is genuinely reachable somewhere — and the wider property here
    // is that the agreement did not simply VANISH when its card was deleted.
    //
    // So: read the component that now owns it and require both halves — the tick, and the
    // registered disclosure copy the carrier receipt claims was shown. If either is dropped, a
    // farmer publishes a listing having agreed to nothing and the redemption authorizes nobody.
    const listingStep = readFileSync(
      resolve(process.cwd(), "apps/web/app/farmer/onboarding/[token]/listing-step.tsx"),
      "utf8",
    );
    expect(listingStep).toContain("I agree to receive texts from VIGA Farm Friend.");
    expect(listingStep).toContain("Message frequency varies.");
    // It POSTs the stamp, which is what gates authorization at redemption.
    expect(listingStep).toContain("/api/farmer/onboarding");
  });
});
