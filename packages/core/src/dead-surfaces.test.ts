import { existsSync, readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const repositoryRoot = new URL("../../../", import.meta.url);

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, repositoryRoot), "utf8");
}

function executableSource(relativePath: string): string {
  return read(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/^\s*import[\s\S]*?;\s*$/gm, "");
}

describe("admin routes expose only live browser contracts (B-033)", () => {
  // Each mutation route paired with the page that actually reads its data. The three message
  // queues share one page now: "Customer reports", "Stock reports" and the never-linked
  // /admin/stand-data were three destinations for one kind of work, and a volunteer could not
  // tell the first two apart by name. The pairing below is what keeps that merge honest — a
  // route whose reader stops being called on its page fails here.
  const serverRenderedQueues = [
    ["apps/web/app/api/admin/farms/route.ts", "apps/web/app/admin/farms/page.tsx", "listFarmsForApproval"],
    ["apps/web/app/api/admin/farmers/route.ts", "apps/web/app/admin/farms/page.tsx", "listFarmerAuthorizations"],
    ["apps/web/app/api/admin/flags/route.ts", "apps/web/app/admin/messages/page.tsx", "listFlagsForReview"],
    ["apps/web/app/api/admin/stock-out-reports/route.ts", "apps/web/app/admin/messages/page.tsx", "listStockOutReports"],
    ["apps/web/app/api/admin/stand-data-flags/route.ts", "apps/web/app/admin/messages/page.tsx", "listStandDataFlags"],
    ["apps/web/app/api/admin/stands/route.ts", "apps/web/app/admin/farms/page.tsx", "listStandsForAdministration"],
  ] as const;

  it.each(serverRenderedQueues)(
    "%s has no dead GET export while its page reads %s through %s",
    (routePath, pagePath, reader) => {
      const route = executableSource(routePath);
      const page = executableSource(pagePath);

      expect(route).not.toMatch(/export\s+async\s+function\s+GET\s*\(/);
      expect(route).toMatch(/export\s+async\s+function\s+POST\s*\(/);
      expect(page).toMatch(new RegExp(`await(?:\\s+Promise\\.all\\(\\[)?[\\s\\S]*?\\b${reader}\\s*\\(`));
    },
  );

  it("keeps the one browser-consumed GET at the flag-thread call site", () => {
    const route = executableSource(
      "apps/web/app/api/admin/flags/[flagId]/thread/route.ts",
    );
    const browser = executableSource("apps/web/app/admin/flags/flag-queue.tsx");

    expect(route).toMatch(/export\s+async\s+function\s+GET\s*\(/);
    expect(browser).toMatch(/fetch\s*\(\s*`\/api\/admin\/flags\/\$\{flagId\}\/thread`\s*\)/);
  });
});

describe("PHONE_HASH_SALT has no runnable rotation or rehash path (B-033)", () => {
  const oldSaltName = ["OLD", "PHONE", "HASH", "SALT"].join("_");
  const newSaltName = ["NEW", "PHONE", "HASH", "SALT"].join("_");
  const rehashCommand = ["db", "rehash-phones"].join(":");

  it("deletes the utility and package command while preserving the never-rotate rule", () => {
    expect(
      existsSync(new URL("packages/db/scripts/rehash-phones.ts", repositoryRoot)),
    ).toBe(false);

    const manifest = JSON.parse(read("package.json")) as {
      scripts?: Record<string, string>;
    };
    expect(manifest.scripts).not.toHaveProperty(rehashCommand);

    const governing = `${read("CLAUDE.md")}\n${read("docs/RUNBOOK.md")}`;
    expect(governing).toMatch(/PHONE_HASH_SALT[\s\S]{0,80}(?:never|MUST NOT)\s+(?:be\s+)?rotat/i);
  });

  it("anchors the absence check to executable configuration and script call sites", () => {
    const runnableRoots = ["scripts", "packages/db/scripts"];
    const runnableFiles: string[] = [];
    const walk = (relativeDirectory: string): void => {
      for (const entry of readdirSync(new URL(relativeDirectory, repositoryRoot), {
        withFileTypes: true,
      })) {
        const relativePath = `${relativeDirectory}/${entry.name}`;
        if (entry.isDirectory()) walk(relativePath);
        else if (entry.isFile() && /\.(?:ts|js|mjs)$/.test(entry.name)) runnableFiles.push(relativePath);
      }
    };
    for (const root of runnableRoots) walk(root);

    const executable = runnableFiles
      .filter((path) => !path.endsWith(".test.ts"))
      .map((path) => executableSource(path))
      .join("\n");
    const operational = `${read(".env.example")}\n${read("docs/RUNBOOK.md")}`;

    expect(executable).not.toContain(oldSaltName);
    expect(executable).not.toContain(newSaltName);
    expect(executable).not.toMatch(/rehash[-_ ]?phones?/i);
    expect(operational).not.toContain(oldSaltName);
    expect(operational).not.toContain(newSaltName);
    expect(operational).not.toContain(rehashCommand);
  });
});
