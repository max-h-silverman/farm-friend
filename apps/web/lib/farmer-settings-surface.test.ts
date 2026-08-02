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
    expect(form).toMatch(
      /fetch\(\s*["']\/api\/farmer\/settings["'],\s*\{[\s\S]*body:\s*JSON\.stringify\(\s*\{\s*token,\s*salesLocationId\s*\}\s*\)/,
    );
    expect(form).not.toMatch(/\/api\/farmer\/settings\?/);
  });

  it("offers only the default SMS stand setting, not F-052 cadence or consent controls", () => {
    const form = source("apps/web/app/stand/[token]/settings/settings-form.tsx");
    expect(form).toMatch(/type=["']radio["']/);
    expect(form).toMatch(/Save default stand/);
    expect(form).not.toMatch(/cadence|pause prompts|sms consent|opt out/i);
  });
});
