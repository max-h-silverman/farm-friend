import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface PackageManifest {
  name: string;
  workspaces?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const repositoryRoot = new URL("../../../", import.meta.url);
const approvedWorkspaces = [
  "apps/web",
  "packages/ai",
  "packages/core",
  "packages/db",
  "packages/sms",
];
const allowedWorkspaceDependencies: Record<string, readonly string[]> = {
  "@farm-friend/web": [
    "@farm-friend/ai",
    "@farm-friend/core",
    "@farm-friend/db",
    "@farm-friend/sms",
  ],
  "@farm-friend/ai": ["@farm-friend/core"],
  "@farm-friend/core": [],
  "@farm-friend/db": ["@farm-friend/core"],
  "@farm-friend/sms": ["@farm-friend/core"],
};

function readManifest(relativePath: string): PackageManifest {
  return JSON.parse(
    readFileSync(new URL(`${relativePath}/package.json`, repositoryRoot), "utf8"),
  ) as PackageManifest;
}

function workspaceDirectories(parent: "apps" | "packages"): string[] {
  return readdirSync(new URL(parent, repositoryRoot), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .filter((entry) => {
      try {
        readManifest(`${parent}/${entry.name}`);
        return true;
      } catch {
        return false;
      }
    })
    .map((entry) => `${parent}/${entry.name}`);
}

function workspaceDependencies(manifest: PackageManifest): string[] {
  return Object.keys({
    ...manifest.dependencies,
    ...manifest.devDependencies,
  })
    .filter((name) => name.startsWith("@farm-friend/"))
    .sort();
}

function sourceFiles(relativeDirectory: string): string[] {
  return readdirSync(new URL(`${relativeDirectory}/`, repositoryRoot), {
    withFileTypes: true,
  }).flatMap((entry) => {
    const relativePath = `${relativeDirectory}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(relativePath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [relativePath] : [];
  });
}

function workspaceImports(relativeDirectory: string): string[] {
  const importPattern = /(?:from\s+|import\s+)["'](@farm-friend\/[^"']+)["']/g;

  return sourceFiles(relativeDirectory).flatMap((relativePath) => {
    const source = readFileSync(new URL(relativePath, repositoryRoot), "utf8");
    return [...source.matchAll(importPattern)].map((match) => match[1]!);
  });
}

describe("workspace architecture", () => {
  it("contains only the approved web app and four packages", () => {
    const rootManifest = readManifest(".");
    const actualDirectories = [
      ...workspaceDirectories("apps"),
      ...workspaceDirectories("packages"),
    ].sort();

    expect(rootManifest.workspaces?.slice().sort()).toEqual(approvedWorkspaces);
    expect(actualDirectories).toEqual(approvedWorkspaces);
  });

  it("keeps core independent of every workspace adapter", () => {
    const coreManifest = readManifest("packages/core");

    expect(workspaceDependencies(coreManifest)).toEqual([]);
    expect(workspaceImports("packages/core/src")).toEqual([]);
  });

  it("allows workspace dependencies only in the approved direction", () => {
    for (const workspace of approvedWorkspaces) {
      const manifest = readManifest(workspace);
      const allowed = allowedWorkspaceDependencies[manifest.name] ?? [];
      const unexpected = workspaceDependencies(manifest).filter(
        (dependency) => !allowed.includes(dependency),
      );

      expect(unexpected, manifest.name).toEqual([]);
    }
  });
});

describe("direct administrator identity (B-031)", () => {
  it("has no generic role facade and resolves the administrator directly", () => {
    const rolesModule = new URL("packages/core/src/auth/roles.ts", repositoryRoot);
    const coreIndex = readFileSync(
      new URL("packages/core/src/index.ts", repositoryRoot),
      "utf8",
    );
    const databaseAuth = readFileSync(
      new URL("packages/db/src/admin.ts", repositoryRoot),
      "utf8",
    );
    const webAuth = readFileSync(
      new URL("apps/web/lib/auth.ts", repositoryRoot),
      "utf8",
    );
    const webGuard = readFileSync(
      new URL("apps/web/lib/admin-guard.ts", repositoryRoot),
      "utf8",
    );

    expect(existsSync(rolesModule)).toBe(false);
    expect(coreIndex).not.toContain("./auth/roles");
    expect(databaseAuth).toMatch(
      /return\s*\{\s*administratorId:\s*row\.administrator_id as string,\s*email:\s*row\.email as string,?\s*\}/,
    );
    expect(webAuth).toMatch(/export async function resolveAdministrator\s*\(/);
    expect(webGuard).toMatch(/await resolveAdministrator\(req\)/);
  });

  it("keeps enrollment request-bound and every standing link exact-targeted", () => {
    const databaseFarmer = readFileSync(
      new URL("packages/db/src/farmer.ts", repositoryRoot),
      "utf8",
    );
    const adminFarmerRoute = readFileSync(
      new URL("apps/web/app/api/admin/farmers/route.ts", repositoryRoot),
      "utf8",
    );

    const authorizationInput = /export interface AuthorizeFarmerInput\s*\{([^}]*)\}/.exec(
      databaseFarmer,
    )?.[1];
    expect(authorizationInput).toBeDefined();
    expect(authorizationInput).toMatch(/\brequestId:\s*string/);
    expect(authorizationInput).not.toMatch(/\bcontactHash\b/);

    const routeInput = /let body:\s*\{([^}]*)\}/.exec(adminFarmerRoute)?.[1];
    expect(routeInput).toBeDefined();
    expect(routeInput).toMatch(/\brequestId\?:\s*unknown/);
    expect(routeInput).not.toMatch(/\bcontactHash\b/);

    expect(databaseFarmer).toMatch(
      /export async function issueFarmerLink\([\s\S]*?input:\s*\{[\s\S]*?salesLocationId:\s*string;[\s\S]*?\}/,
    );
    expect(databaseFarmer).toMatch(
      /export async function resolveFarmerLink\([\s\S]*?join sales_locations as location\s+on location\.id = link\.sales_location_id/,
    );
  });
});

describe("the retired config and contracts packages stay deleted (F-028)", () => {
  // The handoff approves a FOUR-package baseline and directs `packages/config` and
  // `packages/contracts` be deleted. F-021 deleted their tracked sources, but the
  // directories survived on disk holding gitignored `tsconfig.tsbuildinfo` build output —
  // so the repository still showed six package directories to anyone reading it, and the
  // "approved workspaces" test above could not see them: `workspaceDirectories` skips any
  // directory without a `package.json`, which is exactly the shape an orphan leaves.
  //
  // Their content was superseded, not relocated: `config` carried a `mapProviderSchema`
  // for the seam F-017 deleted, and `contracts` carried a `migrated` provenance from the
  // legacy-migration model CLAUDE.md now forbids.

  const retiredPackages = ["config", "contracts"];

  it("leaves no directory for either retired package, not even build output", () => {
    const present = readdirSync(new URL("packages", repositoryRoot), {
      withFileTypes: true,
    })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);

    // Guard against a vacuous pass: the four approved packages must actually be found,
    // so an unreadable directory cannot make this assertion trivially true.
    expect(present.slice().sort()).toEqual(["ai", "core", "db", "sms"]);

    const revived = retiredPackages.filter((name) => present.includes(name));
    expect(revived, "packages/config and packages/contracts are deleted").toEqual([]);
  });

  it("declares neither retired package as a workspace or a dependency", () => {
    const retiredSpecifiers = retiredPackages.map((name) => `@farm-friend/${name}`);
    const rootManifest = readManifest(".");

    expect(
      (rootManifest.workspaces ?? []).filter((entry) =>
        retiredPackages.some((name) => entry === `packages/${name}`),
      ),
    ).toEqual([]);

    for (const workspace of approvedWorkspaces) {
      const manifest = readManifest(workspace);
      const declared = workspaceDependencies(manifest).filter((dependency) =>
        retiredSpecifiers.includes(dependency),
      );
      expect(declared, workspace).toEqual([]);
    }
  });

  it("imports neither retired package from any workspace source", () => {
    const offenders = approvedWorkspaces.flatMap((workspace) => {
      const directory = workspace.startsWith("apps/") ? `${workspace}/lib` : `${workspace}/src`;
      return workspaceImports(directory)
        .filter((specifier) =>
          retiredPackages.some(
            (name) =>
              specifier === `@farm-friend/${name}` ||
              specifier.startsWith(`@farm-friend/${name}/`),
          ),
        )
        .map((specifier) => `${workspace}: ${specifier}`);
    });

    expect(offenders).toEqual([]);
  });

  it("references neither retired package from the root TypeScript project", () => {
    const source = readFileSync(new URL("tsconfig.json", repositoryRoot), "utf8");
    expect(source.length).toBeGreaterThan(0);

    for (const name of retiredPackages) {
      expect(source, `tsconfig.json must not reference packages/${name}`).not.toContain(
        `packages/${name}`,
      );
    }
  });
});

describe("no runtime geocoder or map provider (F-017)", () => {
  // Geocoding is a ONE-TIME SEEDING concern. The approved boundary adds "no runtime
  // geocoder, permanent map package, coordinate-inventing stub, mapping platform, routing
  // engine, or travel-time estimator" — so this is the tripwire that makes reintroducing one
  // fail rather than merely being noticed in review.
  //
  // `StubMapProvider` previously invented deterministic pseudo-coordinates near Vashon for
  // ANY address string. A stand placed at a fabricated point is worse than a stand with no
  // point: it sends a customer somewhere real and wrong.

  const productionSources = [
    ...sourceFiles("packages/core/src"),
    ...sourceFiles("packages/ai/src"),
    ...sourceFiles("packages/db/src"),
    ...sourceFiles("packages/sms/src"),
    ...sourceFiles("apps/web/lib"),
  ].filter((path) => !path.endsWith(".test.ts") && !path.endsWith(".type-test.ts"));

  it("declares no MapProvider seam or coordinate-inventing stub anywhere", () => {
    const offenders = productionSources.filter((path) => {
      const source = readFileSync(new URL(path, repositoryRoot), "utf8");
      return /\bMapProvider\b|\bStubMapProvider\b|\bgeocode\s*\(/.test(source);
    });
    expect(offenders).toEqual([]);
  });

  it("takes no mapping, geocoding, or routing dependency in any workspace", () => {
    // A runtime map/geocoding package would be the "permanent map package" the decision
    // forbids. Listed literally rather than pattern-matched on "map", which would false-
    // positive on ordinary libraries.
    const forbidden = [
      "@googlemaps/google-maps-services-js",
      "leaflet",
      "react-leaflet",
      "mapbox-gl",
      "react-map-gl",
      "maplibre-gl",
      "@mapbox/mapbox-sdk",
      "node-geocoder",
      "geolib",
    ];

    for (const workspace of approvedWorkspaces) {
      const manifest = readManifest(workspace);
      const declared = Object.keys({
        ...manifest.dependencies,
        ...manifest.devDependencies,
      });
      const found = declared.filter((name) => forbidden.includes(name));
      expect(found, workspace).toEqual([]);
    }
  });

  // B-003: the integration suite was green on 2026-07-25 and 54 tests failed at midnight,
  // with no code change. Fixtures hard-coded calendar dates while `outbox_work.created_at`
  // defaults to `now()`, and the schema enforces `body_expires_at > created_at` — so a
  // fixture expiry written as "tomorrow" became "yesterday" when the wall clock passed it.
  //
  // A date-dependent suite is not a suite: it reports the calendar, not the code. Fixture
  // instants must be OFFSETS from a clock-derived anchor, never literals.
  it("integration fixtures carry no hard-coded calendar dates", () => {
    const suites = [
      "packages/db/src/workflow.integration.test.ts",
      "packages/db/src/transactions.integration.test.ts",
      "packages/db/src/schema.integration.test.ts",
      "packages/db/src/retention.integration.test.ts",
      "apps/web/lib/inquiry.integration.test.ts",
      "apps/web/lib/interpretation.integration.test.ts",
      "apps/web/lib/public-surface.integration.test.ts",
      "apps/web/lib/routing.integration.test.ts",
    ];

    // Guard against a vacuous pass: if a path stops existing the test must fail loudly
    // rather than silently checking nothing.
    expect(suites.length).toBeGreaterThan(0);

    for (const path of suites) {
      const source = readFileSync(new URL(path, repositoryRoot), "utf8");
      expect(source.length, path).toBeGreaterThan(0);

      // A literal instant inside a fixture value. Comments are stripped first: the notes
      // explaining this very defect legitimately name the date it surfaced.
      const withoutComments = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      const literalDates = withoutComments.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g) ?? [];
      expect(literalDates, `${path} must derive fixture instants from a clock anchor`).toEqual(
        [],
      );
    }
  });

  it("computes proximity in core rather than delegating it to a service", () => {
    // The replacement for the deleted seam is arithmetic, not a provider: a pure function
    // with no network, no client, and no injected adapter.
    const source = readFileSync(
      new URL("packages/core/src/public/proximity.ts", repositoryRoot),
      "utf8",
    );
    expect(source).not.toMatch(/\bfetch\s*\(|axios|XMLHttpRequest|https?:\/\/(?!www\.google)/);
    // The one URL it may produce is a destination-only Google Maps link.
    expect(source).toContain("https://www.google.com/maps/dir/");
  });
});

describe("no multi-occupancy concept anywhere in application source (F-027)", () => {
  // Multi-occupancy is an explicit non-goal: one VIGA operation, forever, by product decision.
  // The auth layer nonetheless carried a `Principal` scope field holding a hard-coded "viga"
  // plus a comparison that could only ever succeed. A guard that cannot fail is worse than no
  // guard — it reads as protection while proving nothing, and invites a future change to treat
  // the dimension as an existing property to preserve, or to add a second speculative field to
  // match.
  //
  // `packages/db/src/schema.integration.test.ts` already forbids the concept in the schema and
  // migration. This is the same tripwire for application source, and it deliberately covers TEST
  // sources too: the vestige's most visible construction sites were test fixtures building
  // principals with the removed field.
  //
  // The forbidden word is assembled from fragments rather than written literally, so this file
  // does not trip its own detector. That keeps the scan EXCEPTION-FREE: every scanned source is
  // held to the rule, including this one, and no path is carved out to make the suite pass.

  // NOT word-anchored, deliberately. The db schema tripwire matches `\btenant` against
  // snake_case SQL, where a leading boundary is correct. In camelCase TypeScript it is not: a
  // `targetTenantId` parameter — the exact name deleted here — carries no word boundary before
  // "Tenant" and would slip straight through an anchored pattern.
  const forbiddenTerm = ["ten", "ant"].join("");
  const forbiddenPattern = new RegExp(forbiddenTerm, "i");

  const scannedSources = [
    ...sourceFiles("packages/core/src"),
    ...sourceFiles("packages/ai/src"),
    ...sourceFiles("packages/db/src"),
    ...sourceFiles("packages/sms/src"),
    ...sourceFiles("apps/web/lib"),
    ...sourceFiles("apps/web/app"),
  ];

  it("scans a non-trivial set of sources, including its own file", () => {
    // Guard against a vacuous pass: if `sourceFiles` ever returned nothing, or stopped reaching
    // the auth module, the assertion below would be trivially true and the tripwire dead.
    expect(scannedSources.length).toBeGreaterThan(50);
    expect(scannedSources).toContain("packages/core/src/auth/session.ts");
    expect(scannedSources).toContain("packages/core/src/architecture.test.ts");
  });

  it("detects the forbidden term when it is present", () => {
    // Proves the detector actually detects. Without this, a typo in the pattern would make the
    // scan below pass forever while checking nothing.
    expect(forbiddenPattern.test(`${forbiddenTerm}Id: "viga"`)).toBe(true);
    // The camelCase parameter form an anchored pattern would have missed.
    expect(forbiddenPattern.test(`target${forbiddenTerm}Id`)).toBe(true);
    expect(forbiddenPattern.test(`multi-${forbiddenTerm}`)).toBe(true);
    expect(forbiddenPattern.test("personId, roles")).toBe(false);
  });

  it("names no such identifier in any scanned source", () => {
    const offenders = scannedSources.filter((path) => {
      const source = readFileSync(new URL(path, repositoryRoot), "utf8");
      // Comments are stripped: the notes explaining why the concept was removed legitimately
      // name it, and a historical explanation is not a live dimension.
      const withoutComments = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      return forbiddenPattern.test(withoutComments);
    });

    expect(offenders).toEqual([]);
  });
});

describe("SMS inventory is never gated on farm type (F-038)", () => {
  // max's decision, 2026-07-29: ANY farm may participate in SMS inventory. A by-order lamb
  // farm publishing "shares available" is the same act as a produce stand publishing "kale
  // in". Participation is gated on the farmer authorization and the farm approval — never on
  // what KIND of location it is, whether it can be visited, or what it offers.
  //
  // The decision was mostly a decision NOT to build a gate, which is exactly the kind of
  // property that erodes silently: a future change adding "skip service businesses" to the
  // publication path would look like a sensible special case and would quietly remove a
  // farmer's ability to publish. Nothing in a passing suite would report it.
  //
  // So this asserts the ABSENCE of a branch, anchored to the construct that would implement
  // one — a comparison against a location-type enum VALUE in publication-path source — rather
  // than to vocabulary near it. `sales_location_kind`, `visitability`, and `offering_type` are
  // all legitimate as data: selected, stored, projected, rendered. The forbidden thing is
  // branching business behaviour on their values.

  // The enum values, assembled from fragments so this file does not trip its own detector.
  const typeValues = [
    ["farm", "stand"].join("_"),
    ["farmers", "market"].join("_"),
    ["contact", "only"].join("_"),
    ["by", "order"].join("_"),
    "visitable",
    "services",
  ];

  // A COMPARISON specifically: `=== "farm_stand"`, `!== 'contact_only'`, `case "services":`.
  // Not a bare mention, which is how the value legitimately appears in a query or a type.
  const comparisonPattern = new RegExp(
    `(===?|!==?|case)\\s*["'\`](${typeValues.join("|")})["'\`]`,
  );

  // The PUBLICATION path only: where a farmer's text becomes a durable inventory revision.
  //
  // Deliberately NOT scanned, each for a stated reason rather than to make the suite pass:
  //  - the seeder and the schema — classifying a farm BY type at seed time is the whole point
  //    of F-038, and the schema must name the values to define them;
  //  - the public READ path (`public-listing.ts`, `map-view.ts`) — deciding whether to render
  //    an address is a display decision about a farm with no location, not a gate on whether
  //    that farm may publish. It legitimately tests `visitability === "visitable"`, and this
  //    scan flagged it on the first run, which is what narrowed the set to the claim actually
  //    being made.
  //  - the LISTING WRITE path (`farmer-listing.ts`, F-067) — the same distinction from the
  //    other side. `coherentVisitability` requires an address and coordinates for a visitable
  //    stand and forbids all three for a contact-only one, so a writer of listing facts must
  //    branch on visitability to satisfy the database at all. That decides the SHAPE OF A
  //    LISTING, never whether a farm may publish inventory: this file writes no revision, no
  //    proposal, and nothing SMS reaches. The test below pins that reason rather than
  //    trusting it.
  const publicationSources = [
    ...sourceFiles("packages/core/src/inventory"),
    ...sourceFiles("apps/web/lib"),
  ].filter(
    (path) =>
      !path.includes(".test.") &&
      !path.includes("public-listing") &&
      !path.includes("map-view") &&
      !path.includes("farmer-listing"),
  );

  it("scans the real publication path, not an empty set", () => {
    // Guard against a vacuous pass. If `sourceFiles` ever stopped reaching these directories
    // the assertion below would hold trivially and the tripwire would be dead.
    expect(publicationSources.length).toBeGreaterThan(15);
    expect(publicationSources).toContain(
      "packages/core/src/inventory/proposal.ts",
    );
    expect(publicationSources).toContain("apps/web/lib/workers.ts");
  });

  it("detects a farm-type gate when one is present", () => {
    // Proves the detector detects. Without this a typo in the pattern would make the scan
    // below pass forever while checking nothing — the exact failure this repo has hit twice
    // with source-reading assertions.
    expect(comparisonPattern.test('if (location.kind === "farm_stand") {')).toBe(
      true,
    );
    expect(
      comparisonPattern.test("if (loc.visitability !== 'contact_only') return;"),
    ).toBe(true);
    expect(comparisonPattern.test('case "services":')).toBe(true);

    // And does NOT fire on the legitimate uses: naming a column, typing a field, or carrying
    // a value through a projection.
    expect(comparisonPattern.test("l.offering_type as offering_type,")).toBe(
      false,
    );
    expect(
      comparisonPattern.test('visitability: "visitable" | "contact_only";'),
    ).toBe(false);
    expect(
      comparisonPattern.test("offeringType: row.offering_type as string,"),
    ).toBe(false);
  });

  it("branches on no location type anywhere in the publication path", () => {
    const offenders = publicationSources.filter((path) => {
      const source = readFileSync(new URL(path, repositoryRoot), "utf8");
      const withoutComments = source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      return comparisonPattern.test(withoutComments);
    });

    expect(offenders).toEqual([]);
  });

  it("keeps the excluded LISTING path from reaching inventory (F-067)", () => {
    // `farmer-listing.ts` is excluded because it branches on visitability to satisfy
    // `coherentVisitability` when writing a LISTING — not to gate publication. That reason
    // holds only while it writes no inventory. If it ever gained one, the exclusion above
    // would be carving a hole in exactly the path this guards, and the branch it already
    // contains would become a real gate on which farms may publish.
    //
    // Anchored to the inventory-write constructs specifically. This file DOES write listing
    // facts, so a generic write pattern would fire on its legitimate purpose and say nothing.
    const inventoryWritePattern =
      /\b(insert\s+into\s+inventory|update\s+inventory\w*\s+set|inventory_revisions|inventory_entries|publication_proposals)\b/i;

    const source = readFileSync(
      new URL("apps/web/lib/farmer-listing.ts", repositoryRoot),
      "utf8",
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(
      inventoryWritePattern.test(source),
      "farmer-listing.ts must reach no inventory write",
    ).toBe(false);

    // Proves the detector detects, so a typo cannot make the assertion above vacuous.
    expect(
      inventoryWritePattern.test("insert into inventory_revisions (id)"),
    ).toBe(true);
    expect(inventoryWritePattern.test("from inventory_entries where")).toBe(true);
  });

  it("keeps the read path free of any WRITE, so its exclusion cannot hide a gate", () => {
    // The two excluded files are excluded because they make DISPLAY decisions. That reason
    // holds only while they remain read-only — if either ever gained a write to inventory,
    // the exclusion above would be carving a hole in the very path this guards.
    //
    // Anchored to the durable-write constructs, not to the word "insert" in prose.
    const writePattern = /\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i;

    for (const path of ["apps/web/lib/public-listing.ts", "apps/web/lib/map-view.ts"]) {
      const source = readFileSync(new URL(path, repositoryRoot), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/^\s*\/\/.*$/gm, "");
      expect(writePattern.test(source), `${path} must stay read-only`).toBe(
        false,
      );
    }

    // Proves the detector detects, so a typo cannot make the loop above vacuous.
    expect(writePattern.test("insert into inventory_revisions (id)")).toBe(true);
    expect(writePattern.test("update sales_locations set kind = 'x'")).toBe(true);
    expect(writePattern.test("select l.visitability from sales_locations l")).toBe(
      false,
    );
  });
});
