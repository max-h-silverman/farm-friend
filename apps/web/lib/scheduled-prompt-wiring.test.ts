import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function executable(path: string): string {
  return readFileSync(path, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/^import[\s\S]*?;$/gm, "");
}

describe("scheduled prompt pass wiring (F-052)", () => {
  it("calls the prompt pass inside the one existing cron route before outbound dispatch", () => {
    const route = executable(resolve(__dirname, "../app/api/internal/cron/route.ts"));
    const promptCall = route.indexOf("runScheduledPromptPass({");
    const outboundCall = route.indexOf("runOutboundPass({");
    expect(promptCall).toBeGreaterThan(-1);
    expect(outboundCall).toBeGreaterThan(promptCall);
    expect(route).toMatch(/Response\.json\(\s*\{\s*inbound,\s*prompts,\s*outbound,/);
  });
});
