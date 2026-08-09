import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function source(path: string): string {
  return readFileSync(resolve(process.cwd(), path), "utf8")
    .replace(/\{\s*\/\*[\s\S]*?\*\/\s*\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

describe("shared stock inventory interaction", () => {
  it("renders onboarding and returning-farmer inventory through one literal component", () => {
    const shared = source("apps/web/app/farmer/stock-item-row.tsx");
    const onboarding = source(
      "apps/web/app/farmer/onboarding/[token]/listing-step.tsx",
    );
    const returning = source("apps/web/app/stand/[token]/stand-form.tsx");

    expect(shared).toContain("export function StockInventoryEditor");
    expect(shared.match(/<StockItemPricingFields\b/g) ?? []).toHaveLength(1);
    expect(onboarding.match(/<StockInventoryEditor\b/g) ?? []).toHaveLength(1);
    expect(returning.match(/<StockInventoryEditor\b/g) ?? []).toHaveLength(1);
    expect(onboarding).not.toContain("StockItemPricingFields");
    expect(returning).not.toContain("StockItemPricingFields");
    expect(onboarding).not.toContain('className="farmer-listing-inventory"');
    expect(returning).not.toContain('className="farmer-listing-inventory');
    expect(onboarding).not.toContain('className="farmer-listing-item-pricing"');
    expect(returning).not.toContain('className="farmer-listing-item-pricing"');
  });
});
