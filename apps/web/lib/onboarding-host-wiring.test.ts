import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/*
  F-117'S QUESTION HAS TO REACH THE PAGE (max, 2026-08-17).

  Every piece of "do you sell at someone else's stand?" shipped and was tested: the component
  renders the picker, the API parses `hostStandId`, `saveOnboardingListing` writes the provider
  row, and `listHostStandChoices` returns the stands she may pick. The suite was green.

  The page never called the query and never passed the prop. `hostStandChoices` defaults to
  `[]`, and the component asks the question only when the list is non-empty — so on the real
  onboarding door the question did not exist. A seller could not say she sells at someone
  else's stand, and nothing failed anywhere.

  No behavioural test could catch it: the component suite supplies the prop itself, which is
  precisely how a prop that nobody supplies in production stays green. What is missing is a
  CALL, and the absence of a call is a shape — so it is asserted against the page's source,
  the same tripwire `kick-wiring.test.ts` uses.
*/

const pageSource = readFileSync(
  resolve(process.cwd(), "apps/web/app/farmer/onboarding/[token]/page.tsx"),
  "utf8",
);

/**
 * The page with imports and comments stripped.
 *
 * Both, and for the reason `kick-wiring.test.ts` records: `listHostStandChoices` appears on
 * the import line, so a bare search for the name is satisfied by the import and survives the
 * call site being deleted. The prose above mentions it too. Only code counts.
 */
const pageBody = pageSource
  .replace(/^\s*import\s[\s\S]*?;\s*$/gm, "")
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/^\s*\/\/.*$/gm, "");

describe("the onboarding page asks F-117's question", () => {
  it("proves the search can match, before trusting an empty result", () => {
    // The guard the CLAUDE.md verification note demands: a pattern that cannot span this
    // file's real formatting comes back empty against text sitting right there. This anchors
    // to a call the page has always made, so an empty result below means absence, not a
    // broken regex.
    expect(pageBody).toMatch(/readFarmListingForOnboarding\s*\(/);
    // And the stripping actually removed the import line it appears on.
    expect(pageBody).not.toMatch(/^\s*import\s/m);
  });

  it("calls listHostStandChoices, not merely imports it", () => {
    expect(pageBody).toMatch(/listHostStandChoices\s*\(/);
  });

  it("hands the result to the form", () => {
    // Anchored to the JSX attribute, which is the thing that actually reaches the component.
    // Asserting only that the query is called would pass with its result thrown away.
    expect(pageBody).toMatch(/hostStandChoices=\{/);
  });

  it("awaits the read, so the form never receives a promise", () => {
    // `listHostStandChoices` is async. Passing the unawaited promise would render the
    // question never — `.length > 0` on a Promise is `undefined > 0` — which is the exact
    // silent failure this whole suite exists to catch.
    expect(pageBody).toMatch(/(await\s+listHostStandChoices\s*\()|(listHostStandChoices\(db\)[\s\S]{0,80}?\]\s*=\s*await)/);
  });
});
