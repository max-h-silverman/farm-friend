import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const sourceRoot = new URL("./", import.meta.url);

function source(name: string): string {
  return readFileSync(new URL(name, sourceRoot), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

describe("the model call contract contains only consumed fields (B-033)", () => {
  it("has no provider label or schema-name argument at the provider call site", () => {
    const index = source("index.ts");
    const provider = /export interface LLMProvider\s*\{([\s\S]*?)\n\}/.exec(index)?.[1];
    const validated = /export async function generateValidated[\s\S]*?\)\s*:\s*Promise/.exec(index)?.[0];

    expect(provider).toBeDefined();
    expect(provider).not.toMatch(/readonly\s+name\s*:/);
    expect(provider).toMatch(/generateJson\s*\(\s*ctx:\s*ModelSafeContext\s*\)/);
    expect(provider).not.toMatch(/schemaName/);
    expect(validated).toBeDefined();
    expect(validated).not.toMatch(/schemaName/);
    expect(index).toMatch(/provider\.generateJson\s*\(\s*ctx\s*\)/);
  });

  it("requires output instructions because every projection and the live adapter consume them", () => {
    const projections = source("projections.ts");
    const deepInfra = source("deepinfra.ts");

    expect(projections).toMatch(/readonly\s+outputInstructions:\s*string/);
    expect(projections).not.toMatch(/readonly\s+outputInstructions\?:/);
    expect(deepInfra).toMatch(/`Output requirements:\s*\$\{ctx\.outputInstructions\}`/);
    expect(deepInfra).not.toMatch(/ctx\.outputInstructions\s*!==\s*undefined/);
  });
});
