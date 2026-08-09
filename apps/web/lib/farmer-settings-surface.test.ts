import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
}

describe("F-051 farmer settings surface wiring", () => {
  it("routes the structured settings write through the deterministic handler without appContext", () => {
    const route = source("apps/web/app/api/farmer/settings/route.ts");
    expect(route).toMatch(
      /return\s+handleFarmerSettingsPost\(\s*\{\s*db:\s*context\.db,\s*clock:\s*context\.clock\s*\},\s*request,?\s*\)/,
    );
    expect(route).not.toMatch(/\bappContext\s*\(/);
  });

  it("re-resolves the path token for the page and posts the credential only in the request body", () => {
    const page = source("apps/web/app/stand/[token]/settings/page.tsx");
    const form = source("apps/web/app/stand/[token]/settings/settings-form.tsx");
    expect(page).toMatch(/await\s+loadFarmerSettings\(\s*db,\s*params\.token\s*\)/);
    /*
      THE CREDENTIAL TRAVELS IN THE BODY — the guarantee this assertion exists for, and the
      only part of it that is a guarantee.

      F-097 replaced the panel's three save buttons with one, so the body is now assembled by a
      shared `post(url, body, …)` helper rather than written out at each call. The old regex
      pinned the literal `JSON.stringify({ token, salesLocationId })` and would have failed for
      that refactor while the property it names stayed perfectly true.

      So it is anchored to the helper's own construction instead: `token` is spread into every
      request this component makes, which is a STRONGER statement than the old one — it covers
      all three writers rather than the one that happened to be spelled out.
    */
    expect(form).toMatch(
      /body:\s*JSON\.stringify\(\s*\{\s*token,\s*\.\.\.body\s*\}\s*\)/,
    );
    // Never a query string: a standing credential in a URL lands in proxy logs and history.
    expect(form).not.toMatch(/\/api\/farmer\/settings\?/);
    expect(form).not.toMatch(/\/api\/farmer\/stand\?/);

    /*
      THE SAME GUARANTEE for the reminder control, which F-098 moved to its own file on the
      stock tab. It posts to the same endpoint with the same credential, so the rule travels
      with it — a writer that escaped this assertion by moving is exactly how a token reaches
      a query string unnoticed.
    */
    const reminders = source("apps/web/app/stand/[token]/reminder-schedules.tsx");
    expect(reminders).toMatch(/body:\s*JSON\.stringify\(\s*\{\s*\n?\s*token,/);
    expect(reminders).not.toMatch(/\/api\/farmer\/settings\?/);
  });

  it("asks which stand the texts are about only when there are several", () => {
    const form = source("apps/web/app/stand/[token]/settings/settings-form.tsx");
    // The default-stand choice still exists — now behind `hasSeveralStands`, because a farmer
    // with one stand is being asked to choose between one option (F-097).
    expect(form).toMatch(/type=["']radio["']/);
    expect(form).toMatch(/hasSeveralStands/);
  });

  it("offers explicit per-stand cadence controls without presenting consent as schedule state", () => {
    // F-098 moved this control to the STOCK tab, under the widget that answers the reminder.
    // The guarantees are unchanged and follow the control to the file that now renders it.
    const form = source("apps/web/app/stand/[token]/reminder-schedules.tsx");
    // Every cadence the enum allows is offered, in order, and "paused" is presented as the
    // farmer's own words rather than as the column's value.
    expect(form).toMatch(
      /Every 2 days[\s\S]*Weekly[\s\S]*Every 2 weeks[\s\S]*Don&apos;t remind me/,
    );
    expect(form).toMatch(/value=["']paused["']/);
    // The cadence write still names ONE stand's id, never a farmer-supplied location.
    expect(form).toMatch(/salesLocationId:\s*location\.salesLocationId,\s*\n?\s*cadence:/);
    /*
      PAUSING IS NOT OPTING OUT, said in the farmer's own words.

      The sentence was reworded by F-097 ("does not stop your other texts or change your SMS
      consent"), so this asserts the two claims it has to make rather than the old string: that
      other texts keep coming, and that consent is untouched. A farmer who reads pausing as
      opting out either loses messages they wanted or believes they opted out when they did not.
    */
    expect(form).toMatch(/does\s+not\s+stop\s+your\s+other\s+texts/);
    expect(form).toMatch(/change\s+your\s+SMS\s+consent/);
    expect(form).not.toMatch(/opt out|stop texts/i);
  });

  it("saves the whole panel with one button, and never calls it Submit", () => {
    // F-097 (max, 2026-08-08). Three save buttons for one screen of settings, one of them
    // labelled with onboarding's word. Asserted against the source as well as the DOM because
    // the label is the thing that regressed: "Submit" is what a copied-in form control says.
    const form = source("apps/web/app/stand/[token]/settings/settings-form.tsx");
    expect(form).toMatch(/Save settings/);
    expect(form).not.toMatch(/>\s*Submit\s*</);
    expect(form).not.toMatch(/Save default stand|Save reminder|Save seller names/);
  });
});
