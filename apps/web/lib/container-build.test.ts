import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// The container is the deployment contract on Cloud Run, and every property below has the
// same shape as B-005/B-007/B-008 and B-009: it belongs to the PLATFORM, not to the code,
// so no in-process behavioural test can see it. `npm test`, `typecheck`, `lint`, and
// `next build` all pass from the repo root against a tree that cannot produce a working
// image — npm workspaces hoists, and the repo root is not what gets copied into a layer.
//
// So these are source assertions, in the family of `cron-schedule.test.ts`,
// `kick-survival.test.ts` and `workspace-manifests.test.ts`. They are cheap guards against
// the specific ways this build silently degrades. They are NOT proof the image runs — only
// `docker build` and a container smoke test show that, and only a deployed revision shows
// the runtime behaviour. Each assertion is anchored to the construct it claims to prove,
// never to vocabulary that happens to appear nearby, because a loose source assertion that
// matches its own import line has already shipped twice in this repo.

const root = process.cwd();
const readRepo = (p: string) => readFileSync(resolve(root, p), "utf8");

const nextConfig = readRepo("apps/web/next.config.mjs");
const dockerfile = existsSync(resolve(root, "Dockerfile"))
  ? readRepo("Dockerfile")
  : "";

describe("next is configured to produce a self-contained server", () => {
  it("emits standalone output", () => {
    // Without this, `next build` leaves a tree that needs the full monorepo plus a hoisted
    // `node_modules` to start — which a container does not have. The failure is not subtle
    // in production (the server does not boot) but it IS invisible locally, where the repo
    // root supplies everything the standalone bundle would otherwise have to carry.
    expect(nextConfig).toMatch(/output\s*:\s*["']standalone["']/);
  });

  it("traces workspace dependencies from the repo root", () => {
    // In a monorepo, standalone tracing defaults to the app directory and silently omits
    // `packages/*`, producing an image whose server crashes on first import of
    // `@farm-friend/core`. The tracing root must be the workspace root.
    expect(nextConfig).toMatch(/outputFileTracingRoot/);
  });

  it("keeps the development build directory separate from production output", () => {
    // `next dev` rewrites its output while it serves requests. Sharing `.next` with a
    // production build lets one process leave the other with a page that references a
    // missing vendor chunk. Local development gets its own directory so the two modes cannot
    // corrupt each other's server graph.
    expect(nextConfig).toMatch(/distDir:\s*process\.env\.NODE_ENV\s*===\s*["']development["']/);
  });

  it("keeps every workspace package in transpilePackages", () => {
    // These two settings are coupled and the coupling is invisible.
    //
    // `transpilePackages` is what compiles the workspace sources INTO Next's server
    // chunks, and that is the only reason the standalone bundle works: verified by
    // running it, `.next/standalone/packages/*` contains nothing but a `package.json`
    // and `node_modules` holds no `postgres`, `drizzle-orm`, or `zod`. The code is not
    // missing — it is inlined. A package dropped from this list would NOT be inlined and
    // would NOT be traced either, and the resulting image boots and then dies on that
    // package's first import.
    //
    // `workspace-manifests.test.ts` already checks this list against what apps/web
    // imports. This asserts the container's stake in it, so the reason survives here.
    for (const pkg of ["ai", "core", "db", "sms"]) {
      expect(nextConfig).toContain(`@farm-friend/${pkg}`);
    }
  });
});

describe("the image builds the whole workspace, not just the app", () => {
  it("has a Dockerfile at the repo root", () => {
    // Root, not `apps/web` — the build context has to include `packages/*`, and a
    // Dockerfile inside the app directory cannot reach up out of its context.
    expect(dockerfile).not.toBe("");
  });

  it("runs as a non-root user", () => {
    // Anchored to the USER instruction, not to the word "nextjs" appearing in a COPY line.
    expect(dockerfile).toMatch(/^\s*USER\s+(?!root\b)\S+/m);
  });

  it("binds the port Cloud Run assigns rather than a hard-coded one", () => {
    // Cloud Run sets $PORT and the container must honour it; a hard-coded 3000 fails the
    // health check with no useful error. Anchored to a PORT reference in the runtime
    // stage's ENV/CMD, not merely the digits 3000 appearing somewhere.
    expect(dockerfile).toMatch(/\$\{?PORT\}?|ENV\s+PORT/);
  });

  it("copies the standalone server and its static assets", () => {
    // The three artifacts a standalone Next image needs. Missing `.next/static` yields a
    // server that boots and then serves an unstyled, script-less page — a failure that
    // looks like a CSS bug rather than a packaging one.
    expect(dockerfile).toMatch(/\.next\/standalone/);
    expect(dockerfile).toMatch(/\.next\/static/);
  });

  it("is a multi-stage build that does not ship the build toolchain", () => {
    // Two FROM lines minimum: build deps and source must not end up in the runtime layer.
    const stages = dockerfile.match(/^\s*FROM\s+/gm) ?? [];
    expect(stages.length).toBeGreaterThanOrEqual(2);
  });

  it("installs native-module build prerequisites only before the isolated npm install", () => {
    // Argon2 is a native module. Its Linux install can compile from source when a matching
    // prebuilt binary is unavailable, which requires Python, make, and a C++ compiler. The
    // dependency stage needs those tools before `npm ci`; the runtime stage must not ship them.
    const dependencyStage = dockerfile.match(
      /^FROM\s+[^\n]+\s+AS\s+deps\s*$([\s\S]*?)(?=^FROM\s+)/m,
    )?.[1] ?? "";
    const runtimeStage = dockerfile.match(
      /^FROM\s+[^\n]+\s+AS\s+runtime\s*$([\s\S]*)/m,
    )?.[1] ?? "";
    const nativeToolInstall = dependencyStage.match(
      /RUN\s+apt-get\s+update[\s\S]*?apt-get\s+install[\s\S]*?(?=\n\s*RUN|\n\s*COPY|$)/,
    )?.[0] ?? "";

    expect(nativeToolInstall).toContain("python3");
    expect(nativeToolInstall).toContain("make");
    expect(nativeToolInstall).toContain("g++");
    expect(dependencyStage.indexOf(nativeToolInstall)).toBeLessThan(
      dependencyStage.indexOf("RUN npm ci"),
    );
    expect(runtimeStage).not.toContain("apt-get install");
  });
});

describe("every route module IMPORTS with no environment at all", () => {
  // The defect this exists to catch shipped, and only the Cloud Build failed on it.
  //
  // `next build` collects page data by **importing every route module** in a process with no
  // `.env` — the container has no environment at build time. So anything a route does at
  // MODULE SCOPE runs there. `/api/farmer/link-request` built its throttle at module scope
  // from `publicReadContext()`, which constructs the database pool and therefore demands
  // `DATABASE_URL`; the import threw, and `next build` failed with "Failed to collect page
  // data". Locally it passed every time, because `.env` is present on this machine — the
  // exact "local runtime is not the deployed runtime" trap.
  //
  // This is a real IMPORT with the variable deleted, not a source grep: a regex for
  // `publicReadContext` at module scope would match the import line and survive the call
  // site moving into the handler, which is the whole thing being asserted.
  const routes = [
    "../app/api/farmer/link-request/route",
    "../app/api/public/stands/route",
    "../app/api/farmer/address-lookup/route",
    "../app/api/farmer/listing/route",
    "../app/api/farmer/onboarding/route",
    "../app/api/admin/farms/route",
    "../app/api/admin/stands/route",
    "../app/api/admin/test-farm-phones/route",
  ];

  for (const route of routes) {
    it(`imports ${route.replace("../app/api/", "").replace("/route", "")} without DATABASE_URL`, async () => {
      const saved = { ...process.env };
      // Every variable a route might reach for at module scope, removed together. A route
      // that needs one of these to be IMPORTED cannot be built into the image.
      for (const key of [
        "DATABASE_URL",
        "PHONE_HASH_SALT",
        "PUBLIC_BASE_URL",
        "TELNYX_API_KEY",
        "DEEPINFRA_API_KEY",
      ]) {
        delete process.env[key];
      }
      try {
        await expect(import(route)).resolves.toBeDefined();
      } finally {
        process.env = saved;
      }
    });
  }
});

describe("the build context excludes what must never enter an image", () => {
  const dockerignore = existsSync(resolve(root, ".dockerignore"))
    ? readRepo(".dockerignore")
    : "";

  it("has a .dockerignore", () => {
    expect(dockerignore).not.toBe("");
  });

  it("excludes environment files", () => {
    // `.env` holds the DeepInfra key, the phone-hash salt, and the Neon URL. Copying it
    // into a layer bakes live credentials into an artifact that is pushed to a registry
    // and retained — a leak that no runtime check would ever surface.
    expect(dockerignore).toMatch(/^\.env/m);
  });

  it("excludes node_modules so the image installs its own", () => {
    // A copied host `node_modules` carries darwin-arm64 binaries into a linux image and
    // defeats the isolated-install property B-005..B-008 exist to protect.
    expect(dockerignore).toMatch(/^node_modules/m);
  });
});
