import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// GL-005 — `npm run typecheck` covers every workspace, including `apps/web`.
//
// The root script used to be a bare `tsc -b`, and the root `tsconfig.json` references only the
// four packages. So "typecheck passes" was a claim about `packages/*` and said NOTHING about
// `apps/web` — which held 57 real type errors while every suite, every lint run, and every
// `next build` stayed green. The gap was invisible precisely because the command that was
// supposed to close it reported success.
//
// This is the same family as `cron-schedule.test.ts` and `workspace-manifests.test.ts`: a
// property of BUILD CONFIGURATION rather than of runtime behavior, where the failure mode is a
// green check that covers less than its name implies. No behavioral test can see it — the
// errors are in the type layer, which vitest strips and never evaluates. So it is asserted
// against the manifests themselves.
//
// Per the constitution's "anchor a source assertion to the construct it proves": each assertion
// below is anchored to the CONSTRUCT it claims to prove — the script string that must invoke
// web, the workspace script that must exist to be invoked — never to vocabulary appearing
// nearby. `tsc` and `typecheck` are words that occur all over these files; matching them
// loosely would pass against a root script that dropped web entirely.

const repoRoot = resolve(process.cwd());

const rootManifest = JSON.parse(
  readFileSync(resolve(repoRoot, "package.json"), "utf8"),
) as { workspaces?: string[]; scripts?: Record<string, string> };

const webManifest = JSON.parse(
  readFileSync(resolve(repoRoot, "apps/web/package.json"), "utf8"),
) as { name?: string; scripts?: Record<string, string> };

const rootTsconfig = JSON.parse(
  readFileSync(resolve(repoRoot, "tsconfig.json"), "utf8"),
) as { references?: { path?: string }[] };

describe("the root typecheck covers the web workspace", () => {
  it("gives the web workspace its own typecheck script", () => {
    // Without this, the root script below has nothing to delegate to and `npm run typecheck
    // --workspace` exits 0 on a MISSING script in some npm versions — a silent no-op wearing
    // the name of a check.
    expect(webManifest.scripts?.typecheck).toBeDefined();
  });

  it("points the web typecheck at the web tsconfig with no emit", () => {
    // Anchored to the project flag and the config it names. A `tsc --noEmit` without `-p`
    // would typecheck whatever it happened to discover from the cwd, not this workspace.
    expect(webManifest.scripts?.typecheck).toMatch(/tsc\s+-p\s+tsconfig\.json\b/);
    expect(webManifest.scripts?.typecheck).toMatch(/--noEmit\b/);
  });

  it("makes the ROOT typecheck invoke the web workspace's own script", () => {
    // THE ASSERTION THIS FILE EXISTS FOR. Anchored to the delegation itself — the root script
    // must name the web workspace. A root script of bare `tsc -b` satisfies no part of this,
    // which is exactly the defect: it passed while `apps/web` held 57 errors.
    const root = rootManifest.scripts?.typecheck ?? "";
    const web = rootManifest.scripts?.["typecheck:web"] ?? "";
    expect(root).toContain("typecheck:web");
    expect(web).toMatch(/--workspace\s+@farm-friend\/web\b/);
  });

  it("still builds the package project graph, and fails if EITHER half fails", () => {
    // `&&` rather than `;` or `&`: a chain that swallows the first command's exit status would
    // report success whenever the LAST step passed, which is how a two-part check quietly
    // becomes a one-part check.
    const root = rootManifest.scripts?.typecheck ?? "";
    expect(rootManifest.scripts?.["typecheck:packages"]).toMatch(/tsc\s+-b\b/);
    expect(root).toContain("typecheck:packages");
    expect(root).toMatch(/typecheck:packages\s*&&\s*npm run typecheck:web/);
  });

  it("checks every declared workspace between the two halves", () => {
    // The guard against the NEXT instance of this defect rather than the one just fixed: a
    // fifth workspace added later must land in one half or the other. `tsc -b` covers a package
    // only if the root tsconfig references it, so that list is compared to the real workspace
    // list — a new `packages/*` with no reference would otherwise be as unchecked as `apps/web`
    // was, and nothing would say so.
    const declared = rootManifest.workspaces ?? [];
    const referenced = (rootTsconfig.references ?? []).map((r) => r.path);
    const uncovered = declared.filter(
      (ws) => ws !== "apps/web" && !referenced.includes(ws),
    );
    expect(uncovered).toEqual([]);
  });

  it("keeps `next build` as a SEPARATE verification layer", () => {
    // The build is not folded into the typecheck and must not become its substitute: it checks
    // things `tsc -p` does not (route/manifest conventions, the bundle graph), and `tsc -p`
    // checks test files the build never compiles. Two layers, deliberately.
    expect(webManifest.scripts?.build).toBe("next build");
    expect(webManifest.scripts?.typecheck).not.toContain("next build");
  });
});
