import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("local development setup", () => {
  it("verifies the current core schema after migrations", () => {
    const script = readFileSync(resolve(process.cwd(), "scripts/dev-setup.sh"), "utf8");
    const verification = /applied_tables=.*?table_name in \(([^)]+)\)/s.exec(script)?.[1];

    expect(verification, "the assertion must stay anchored to the schema-effect query").toBeDefined();
    expect(verification?.match(/[a-z_]+/g)).toEqual([
      "sellers",
      "sales_locations",
      "administrators",
    ]);
  });
});
