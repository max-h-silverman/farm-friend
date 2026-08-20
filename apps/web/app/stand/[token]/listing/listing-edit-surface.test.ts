import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * B-037 — the edit page must thread the WHOLE listing into the form's defaults.
 *
 * `listing-step.test.tsx` proves the component round-trips whatever it is given. That is the
 * other half of the same guarantee and cannot see this one: the component test constructs its
 * own `defaults` object, so a page that reads a full listing and passes eight of its fields
 * satisfies every component assertion while erasing four columns per save.
 *
 * Comments are stripped for the reason `farmer-onboarding-surface.test.ts` gives — a comment
 * naming `availability` would otherwise satisfy an assertion the call site had stopped
 * meeting — and each assertion anchors to the PROP ASSIGNMENT, never to the import that makes
 * the name available.
 */
const page = readFileSync(
  resolve(process.cwd(), "apps/web/app/stand/[token]/listing/page.tsx"),
  "utf8",
)
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, " ")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/^\s*\/\/.*$/gm, " ")
  .replace(/\s+/g, " ");

const tabbedPage = readFileSync(
  resolve(process.cwd(), "apps/web/app/stand/[token]/page.tsx"),
  "utf8",
)
  .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, " ")
  .replace(/\/\*[\s\S]*?\*\//g, " ")
  .replace(/^\s*\/\/.*$/gm, " ")
  .replace(/\s+/g, " ");

describe("the farmer's listing edit surface", () => {
  it("renders the listing form under the stand-link credential", () => {
    expect(page).toContain("<ListingStep");
    expect(page).toContain('credential={{ kind: "stand_link", token: params.token }}');
  });

  it("threads the stand's structured availability into the form's defaults", () => {
    // THE assertion this file exists for. Every other listing field was already passed; the
    // twelve availability columns were not, and `updateStand` writes all twelve on every
    // save. Anchored to the assignment so deleting it fails even though `listing` stays in
    // scope and every other reference to it survives.
    expect(page).toContain("availability: listing.availability");
  });

  it("prefills the farm's own name from the FARM, not from the stand", () => {
    // The two are different records. This was a real defect once: the field labelled for the
    // farm was filled with the stand's name, so a farmer renaming their farm was shown the
    // wrong starting value.
    expect(page).toContain("farmName={listing.farmName}");
    expect(page).toContain("standName: listing.standName");
  });

  it("threads VIGA Bucks acceptance into every edit form, and no eligibility flag", () => {
    // The writer changes acceptance, so a form that cannot see the stored value would quietly
    // turn it off on the next unrelated save. Both the bookmarked route and the primary tab
    // compose `ListingStep` by hand, so both need it.
    for (const source of [page, tabbedPage]) {
      expect(source).toContain("farmBucksAccepted: listing.farmBucksAccepted");
      // F-125 — the eligibility grant is deleted, not merely unset. Asserting its ABSENCE is
      // what stops it being threaded back in by a future edit; the positive assertion above
      // cannot notice a second, stale field riding alongside it.
      expect(source).not.toContain("farmBucksEligible");
    }
  });
});
