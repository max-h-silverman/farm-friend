import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// F-019's model-free public read surface, held in place while F-017 builds a UI on top of it.
//
// WHY THIS FILE EXISTS. F-019's integration test proves the public listing WORKS with a
// throwing provider — behavioural evidence, and good. But it cannot fail for the change most
// likely to undo the boundary: someone adds a model seam to the public page or handler in
// order to make the map "smarter" (a natural-language filter, a summarizer, a "stands you
// might like"). A throwing provider only fires if the new call is on the tested path with
// the test's fixture data; a new surface silently would not be covered.
//
// So this is a STATIC test over the actual module graph: the transitive local imports of the
// public read surface must contain no model seam. It fails at the moment the import is
// added, before any behaviour exists to test — which is the only point at which it is cheap
// to notice.
//
// It deliberately does NOT assert on `@farm-friend/ai` being absent from apps/web as a
// whole: the SMS inquiry path and the QR stock-out form legitimately use models and live in
// the same app. The claim is narrower and truer — nothing REACHABLE FROM the public read
// surface touches one.

const repositoryRoot = new URL("../../../", import.meta.url);

/** Local module specifiers, resolved to repo-relative .ts/.tsx paths. */
function localImports(relativePath: string): string[] {
  const source = readFileSync(new URL(relativePath, repositoryRoot), "utf8");
  const pattern = /(?:from\s+|import\s+)["'](\.[^"']+)["']/g;

  return [...source.matchAll(pattern)].flatMap((match) => {
    const specifier = match[1]!;
    const joined = new URL(specifier, new URL(relativePath, repositoryRoot));
    const resolved = joined.pathname.replace(repositoryRoot.pathname, "");
    for (const candidate of [`${resolved}.ts`, `${resolved}.tsx`, `${resolved}/index.ts`]) {
      try {
        readFileSync(new URL(candidate, repositoryRoot), "utf8");
        return [candidate];
      } catch {
        continue;
      }
    }
    return [];
  });
}

/** Every workspace-package specifier imported anywhere in the transitive local graph. */
function transitivePackageImports(entry: string): {
  packages: Set<string>;
  visited: string[];
} {
  const packages = new Set<string>();
  const visited: string[] = [];
  const queue = [entry];

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (visited.includes(current)) continue;
    visited.push(current);

    const source = readFileSync(new URL(current, repositoryRoot), "utf8");
    for (const match of source.matchAll(
      /(?:from\s+|import\s+)["'](@farm-friend\/[^"']+)["']/g,
    )) {
      packages.add(match[1]!);
    }
    queue.push(...localImports(current));
  }

  return { packages, visited };
}

/** The two entry points a customer's browser can reach without authentication. */
const PUBLIC_READ_ENTRIES = [
  "apps/web/app/api/public/stands/route.ts",
  "apps/web/app/page.tsx",
];

describe("the public read surface is model-free (F-019, preserved by F-017)", () => {
  it("resolves a real module graph rather than silently finding nothing", () => {
    // Guard against the test passing because the crawler is broken. If this file ever stops
    // resolving imports, every assertion below would vacuously pass — so prove the crawler
    // actually walked into the modules that matter first.
    for (const entry of PUBLIC_READ_ENTRIES) {
      const { visited, packages } = transitivePackageImports(entry);
      expect(visited.length, entry).toBeGreaterThan(1);
      expect(packages.size, entry).toBeGreaterThan(0);
      expect(visited, entry).toContain("apps/web/lib/public-listing.ts");
    }
  });

  it("imports no model package anywhere in its transitive graph", () => {
    for (const entry of PUBLIC_READ_ENTRIES) {
      const { packages } = transitivePackageImports(entry);
      expect([...packages].sort(), entry).not.toContain("@farm-friend/ai");
    }
  });

  it("names no model seam, provider, or prompt in its transitive graph", () => {
    // Belt and braces: a seam could in principle be re-exported through another package.
    // These are the constructors and types that exist today; naming any of them on the
    // public read path is the change this test exists to stop.
    const forbidden = [
      "createInquiryModel",
      "createStockOutModel",
      "createInventoryInterpreter",
      "generateValidated",
      "LLMProvider",
      "ModelSafeContext",
      "StubLLMProvider",
    ];

    for (const entry of PUBLIC_READ_ENTRIES) {
      const { visited } = transitivePackageImports(entry);
      for (const file of visited) {
        const source = readFileSync(new URL(file, repositoryRoot), "utf8");
        const found = forbidden.filter((name) =>
          new RegExp(`\\b${name}\\b`).test(source),
        );
        expect(found, `${entry} → ${file}`).toEqual([]);
      }
    }
  });

  it("keeps the listing handler's dependency set to db and clock", () => {
    // The signature IS the boundary: there is no parameter to hand a model to. A future
    // edit that adds one must change this line, which makes it visible in review.
    const source = readFileSync(
      new URL("apps/web/lib/public-listing.ts", repositoryRoot),
      "utf8",
    );
    expect(source).toMatch(/export interface PublicListingDeps \{\s*db: Db;\s*clock: Clock;\s*\}/);
  });

  it("exposes no free-text query parameter on the public read route", () => {
    // Natural-language inquiry is SMS-only (F-019). A `?q=` on this route would be the
    // anonymous model-backed web inquiry surface that decision keeps out of launch —
    // and the map UI added by F-017 is a deterministic list, not a chat box.
    const source = readFileSync(
      new URL("apps/web/app/api/public/stands/route.ts", repositoryRoot),
      "utf8",
    );
    expect(source).not.toMatch(/searchParams|nextUrl\.search|new URL\(req/);
  });
});
