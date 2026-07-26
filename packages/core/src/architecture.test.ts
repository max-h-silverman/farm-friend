import { readdirSync, readFileSync } from "node:fs";
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
