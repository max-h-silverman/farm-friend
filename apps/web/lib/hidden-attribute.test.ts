import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * B-042 — every element the code hides with `hidden` must actually be hidden.
 *
 * **The trap, stated once for the whole app.** HTML's `hidden` attribute is not a primitive: it
 * is a `display: none` rule in the browser's OWN stylesheet, and ANY author rule that sets
 * `display` on the same element outranks it. So `.thing { display: grid }` silently un-hides
 * every `<div class="thing" hidden>` in the app.
 *
 * **No component test can see this.** jsdom applies no stylesheet, so `hidden` there means "not
 * rendered" and every test passes against a page where nothing is hidden at all. It shipped
 * twice before this test existed: the four-step onboarding wizard rendered all four steps as one
 * long page, and the farmer's own stand page rendered both tab panels stacked.
 *
 * So this is a SWEEP, not two fixes. It reads the JSX for classes that carry `hidden`, then
 * checks the stylesheet for each: a class that sets `display` must also state the hidden case.
 * A new hideable panel added next month is covered without anyone remembering this note.
 */

const webRoot = resolve(__dirname, "..");
const css = readFileSync(resolve(webRoot, "app/globals.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Every .tsx under app/, excluding tests. */
function componentFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry !== "node_modules") componentFiles(full, found);
    } else if (entry.endsWith(".tsx") && !entry.includes(".test.")) {
      found.push(full);
    }
  }
  return found;
}

/**
 * Classes on elements that also carry a `hidden` prop.
 *
 * Both orders are matched, because JSX attribute order is arbitrary and a pattern that only
 * caught `className` before `hidden` would silently miss half the real cases.
 */
function hideableClasses(): Map<string, string> {
  const byClass = new Map<string, string>();
  for (const file of componentFiles(resolve(webRoot, "app"))) {
    const source = readFileSync(file, "utf8");
    // One JSX opening tag at a time, so a `hidden` on one element cannot be paired with a
    // `className` on the next.
    for (const [tag] of source.matchAll(/<[a-zA-Z][^>]*?>/gs)) {
      if (!/\shidden(?:=|\s|$)/.test(tag)) continue;
      const className = tag.match(/className="([^"]+)"/);
      if (className === null) continue;
      for (const name of (className[1] as string).split(/\s+/)) {
        if (name !== "") byClass.set(name, file.replace(`${webRoot}/`, ""));
      }
    }
  }
  return byClass;
}

/** Whether the stylesheet sets `display` on a bare `.class` rule. */
function setsDisplay(className: string): boolean {
  const pattern = new RegExp(
    `(^|[,}])\\s*\\.${className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
    "m",
  );
  const found = css.match(pattern);
  return found !== null && /display\s*:/.test(found[2] as string);
}

/** Whether the stylesheet states the hidden case for a class. */
function hidesWhenHidden(className: string): boolean {
  const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `\\.${escaped}\\[hidden\\][^{]*\\{([^}]*)\\}`,
    "m",
  );
  const found = css.match(pattern);
  return found !== null && /display\s*:\s*none/.test(found[1] as string);
}

describe("the hidden attribute actually hides (B-042)", () => {
  it("finds the elements the app hides, so this sweep cannot pass by matching nothing", () => {
    // The guard on the guard. If the JSX pattern drifts, every assertion below becomes
    // vacuously true — a test that cannot fail. This is what makes the sweep mean something.
    const classes = hideableClasses();
    expect(
      [...classes.keys()],
      "no hideable classes found — the JSX pattern has drifted and the sweep below proves nothing",
    ).not.toHaveLength(0);
  });

  it("states display:none for every hideable class whose rule sets display", () => {
    const offenders: string[] = [];
    for (const [className, file] of hideableClasses()) {
      if (!setsDisplay(className)) continue; // The UA `display: none` wins unopposed.
      if (!hidesWhenHidden(className)) offenders.push(`.${className} (${file})`);
    }

    expect(
      offenders,
      `These classes set 'display' AND are used with the 'hidden' attribute, so 'hidden' does ` +
        `NOTHING for them — the element renders in full. Add '.<class>[hidden] { display: none }'. ` +
        `Offenders: ${offenders.join(", ")}`,
    ).toEqual([]);
  });
});
