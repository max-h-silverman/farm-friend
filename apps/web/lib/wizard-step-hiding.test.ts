import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * B-042 — a wizard step the `hidden` attribute does not hide.
 *
 * **This defect is invisible to every component test in the suite.** jsdom does not apply the
 * real stylesheet, so `hidden` there means "not rendered" and the four-step wizard tests all
 * passed while the deployed page showed every step at once, one below the next — the phone
 * number and the SMS agreement, which belong to the last step, sitting in the middle of step one.
 * Measured in a real browser (max, 2026-08-08): all four fieldsets reported `offsetParent`
 * non-null with `display: grid`, three of them carrying `hidden`.
 *
 * The cause is the cascade, not the markup. HTML's `hidden` attribute is nothing but a
 * `display: none` rule in the browser's OWN stylesheet, and any author rule setting `display`
 * outranks it. `.farmer-listing-step { display: grid }` therefore silently un-hid every step.
 *
 * So this asserts a property of the STYLESHEET, which is the only place it lives. It parses the
 * rule rather than grepping for vocabulary: a regex for "hidden" would be satisfied by the
 * comment above the rule and would survive the declaration being deleted.
 */

const css = readFileSync(
  resolve(__dirname, "../app/globals.css"),
  "utf8",
);

/** The stylesheet with comments stripped, so prose above a rule can never satisfy a match. */
const source = css.replace(/\/\*[\s\S]*?\*\//g, "");

/** Declarations of the rule whose selector is exactly `selector`. */
function declarationsFor(selector: string): string {
  // Every regex metacharacter escaped — `.`, `[` and `]` all appear in these selectors, and
  // escaping only some of them is how this helper matched nothing against a rule sitting right
  // there in the file.
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(^|[,}])\\s*${escaped}\\s*\\{([^}]*)\\}`, "m");
  const found = source.match(pattern);
  expect(
    found,
    `no rule found for ${selector} — the stylesheet has been restructured`,
  ).not.toBeNull();
  return (found?.[2] ?? "").trim();
}

describe("the onboarding wizard shows ONE step at a time (B-042)", () => {
  it("gives .farmer-listing-step a display the hidden attribute can beat", () => {
    // The rule may set `display` — the step is a grid when shown. What it must not do is set it
    // in a way that outranks `[hidden]`, which means the stylesheet has to say so itself.
    const declarations = declarationsFor(".farmer-listing-step");
    expect(declarations).toMatch(/display\s*:/);
  });

  it("hides a step carrying the hidden attribute, with a rule that outranks the display", () => {
    // The fix's actual shape: an author rule for the hidden case. Without one, `display: grid`
    // beats the user-agent `display: none` and the attribute does nothing at all.
    const hiddenRule = declarationsFor(".farmer-listing-step[hidden]");
    expect(
      hiddenRule,
      "the hidden step rule must set display: none — the attribute alone cannot win against an author display",
    ).toMatch(/display\s*:\s*none/);
  });

  it("keeps the hidden rule at least as specific as the rule it must beat", () => {
    // `.farmer-listing-step[hidden]` is a class plus an attribute; the rule it overrides is a
    // bare class. Equal or greater specificity AND later in the file is what makes it win —
    // asserting the order here because a future edit that moves it up would silently undo this.
    const base = source.indexOf(".farmer-listing-step {");
    const hidden = source.indexOf(".farmer-listing-step[hidden]");
    expect(base, "base rule not found").toBeGreaterThan(-1);
    expect(hidden, "hidden rule not found").toBeGreaterThan(-1);
    expect(
      hidden,
      "the [hidden] rule must come after the base rule to win the cascade",
    ).toBeGreaterThan(base);
  });
});
