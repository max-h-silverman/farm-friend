import { readdirSync, readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// B-007 — every workspace declares the sibling packages it imports.
//
// This exists because the first real deploy failed with
// `Module not found: Can't resolve '@farm-friend/ai'`, and NOTHING in the repository caught it.
//
// The reason nothing caught it is worth stating, because it makes the whole class invisible: npm
// workspaces **hoists** dependencies into the repository-root `node_modules`. Locally an import
// resolves whether or not the importing package declares it, so `npm test`, `npm run typecheck`,
// `npm run lint`, and `next build` from the repo root ALL pass with a manifest that is wrong. The
// declaration only becomes load-bearing when something installs one workspace on its own — which is
// precisely what a deployment does.
//
// So this is not a style check. It is the only place the repository asserts a property that
// production depends on and a developer's tree cannot show.

const repoRoot = resolve(__dirname, "../../..");

/** The workspace directories, read from the root manifest rather than hardcoded. */
function workspaceDirs(): string[] {
  const root = JSON.parse(
    readFileSync(resolve(repoRoot, "package.json"), "utf8"),
  ) as { workspaces?: string[] };
  return root.workspaces ?? [];
}

/** Every .ts/.tsx file under a directory, recursively. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
      const full = resolve(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.tsx?$/.test(entry)) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

/**
 * Workspace packages actually IMPORTED by a file — matched on `from "…"` / `import("…")` rather
 * than any occurrence of the string, so a package named in a comment or in the architecture test's
 * tripwire list is not mistaken for a dependency.
 */
function importedWorkspaces(file: string): Set<string> {
  const source = readFileSync(file, "utf8");
  const found = new Set<string>();
  const pattern = /(?:from|import\()\s*["'](@farm-friend\/[a-z-]+)["']/g;
  for (const match of source.matchAll(pattern)) {
    found.add(match[1] as string);
  }
  return found;
}

describe("apps/web transpiles every workspace package it imports", () => {
  // The SECOND half of the same deploy failure, and the one that was actually load-bearing.
  //
  // Every `@farm-friend/*` package ships raw TypeScript (`"main": "./src/index.ts"`), so Next.js
  // must be told to transpile them. `next.config.mjs` listed only `@farm-friend/core` while
  // `lib/composition.ts` imports `ai`, `db`, and `sms` as well.
  //
  // The dev server is more forgiving than a production build, so this — like the missing manifest
  // entry — is invisible until something runs `next build` for real.

  const webDir = resolve(repoRoot, "apps/web");

  /** The `transpilePackages` array, read out of the Next config source. */
  function transpiledPackages(): string[] {
    const source = readFileSync(resolve(webDir, "next.config.mjs"), "utf8");
    const match = source.match(/transpilePackages:\s*\[([^\]]*)\]/);
    if (match === null) return [];
    return [...(match[1] as string).matchAll(/["'](@farm-friend\/[a-z-]+)["']/g)].map(
      (m) => m[1] as string,
    );
  }

  it("transpiles every @farm-friend package apps/web imports", () => {
    const transpiled = new Set(transpiledPackages());

    const imported = new Set<string>();
    for (const file of sourceFiles(webDir)) {
      for (const pkg of importedWorkspaces(file)) imported.add(pkg);
    }

    // Guards the test: a config rename or regex drift returning nothing must not pass vacuously.
    expect(imported.size).toBeGreaterThan(0);

    const missing = [...imported].filter((pkg) => !transpiled.has(pkg)).sort();
    expect(missing).toEqual([]);
  });
});

describe("every workspace declares what it imports", () => {
  const dirs = workspaceDirs();

  it("finds the workspaces to check", () => {
    // Guards the test itself: a glob change that returned nothing would make every assertion below
    // vacuously pass.
    expect(dirs.length).toBeGreaterThan(0);
  });

  for (const workspace of dirs) {
    it(`${workspace} declares every @farm-friend package it imports`, () => {
      const dir = resolve(repoRoot, workspace);
      const manifest = JSON.parse(
        readFileSync(resolve(dir, "package.json"), "utf8"),
      ) as {
        name?: string;
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };

      const declared = new Set([
        ...Object.keys(manifest.dependencies ?? {}),
        ...Object.keys(manifest.devDependencies ?? {}),
      ]);

      const imported = new Set<string>();
      for (const file of sourceFiles(dir)) {
        for (const pkg of importedWorkspaces(file)) {
          // A package importing itself is not a dependency.
          if (pkg !== manifest.name) imported.add(pkg);
        }
      }

      const undeclared = [...imported].filter((pkg) => !declared.has(pkg)).sort();
      expect(undeclared).toEqual([]);
    });
  }
});
