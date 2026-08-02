import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(fileURLToPath(import.meta.url));
// The workspace root — two levels up from apps/web.
const workspaceRoot = join(appDir, "..", "..");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Cloud Run runs this app as a container, so the build must emit a server that carries
  // its own dependencies. Without `standalone`, `next build` leaves a tree that needs the
  // whole monorepo and a hoisted `node_modules` to start — which an image does not have.
  //
  // This is invisible locally for the same reason B-005..B-008 were: from the repo root
  // everything resolves, and `next build` passes against a tree that cannot produce a
  // working image.
  output: "standalone",
  // Tracing defaults to the app directory, which in a monorepo silently omits
  // `packages/*` — producing an image whose server boots and then dies on the first
  // import of `@farm-friend/core`. Point it at the workspace root so the four workspace
  // packages are traced into the bundle.
  outputFileTracingRoot: workspaceRoot,
  // Every workspace package ships raw TypeScript (`"main": "./src/index.ts"`), so Next must
  // transpile each one it imports. This listed only `core` until B-007, which the dev server
  // tolerated and a production build did not — the first real deploy failed on it.
  // `workspace-manifests.test.ts` keeps this list matched to what apps/web actually imports.
  transpilePackages: [
    "@farm-friend/ai",
    "@farm-friend/core",
    "@farm-friend/db",
    "@farm-friend/sms",
  ],
  // Administrator pages may be framed by VIGA's Squarespace site and nowhere else. This
  // contains clickjacking even though the session cookie must work inside that one iframe.
  async headers() {
    return [
      {
        source: "/admin/:path*",
        headers: [
          {
            key: "Content-Security-Policy",
            value:
              "frame-ancestors 'self' https://vigavashon.org https://www.vigavashon.org",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
