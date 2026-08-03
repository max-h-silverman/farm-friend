import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const dashboard = readFileSync(resolve(process.cwd(), "apps/web/app/admin/page.tsx"), "utf8");

describe("the volunteer desk", () => {
  it("starts with work that needs a decision and keeps stand records secondary", () => {
    expect(dashboard).toContain("<h1>Volunteer desk</h1>");
    expect(dashboard).toContain("Needs attention");
    expect(dashboard).toContain("Farm approvals");
    expect(dashboard).toContain("Farmer access requests");
    expect(dashboard).toContain("Customer reports");
    expect(dashboard).toContain("Stock reports");
    expect(dashboard).toContain("Stand records");
    expect(dashboard).toContain("Stand records ({stands.length})");
    expect(dashboard).toContain("admin-secondary-disclosure");
  });
});
