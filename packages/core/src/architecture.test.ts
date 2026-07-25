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
