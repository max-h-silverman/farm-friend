import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const appDir = dirname(fileURLToPath(import.meta.url));
// The workspace root — two levels up from apps/web.
const workspaceRoot = join(appDir, "..", "..");

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // `next dev` rewrites its server graph while it serves requests. Keep that graph away from
  // `.next`, which production build checks and `next start` use, so a local build cannot leave
  // a running dev server pointing at a missing vendor chunk.
  distDir: process.env.NODE_ENV === "development" ? ".next-dev" : ".next",
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
  /*
    Response headers. `apps/web/lib/public-map-headers.test.ts` and
    `admin-embed-security.test.ts` assert these against this config.

    VIGA's Squarespace page embeds the map in an iframe, and until 2026-08-14 only the
    ADMINISTRATOR routes carried any policy — the public map, which is what everyone actually
    loads, served no security headers at all. A farmer reported Webroot blocking it as
    phishing, and a bare response from a raw `*.run.app` host is part of that picture.

    The public map permits both VIGA hostnames. The administrator console permits only the
    canonical origin that hosts the official embed. Stated as separate policies because the
    two rules answer different questions — who may embed the PUBLIC map, and who may embed the
    ADMINISTRATOR console — and a future change to one must not silently move the other.
  */
  async headers() {
    const publicFrameAncestors =
      "frame-ancestors 'self' https://vigavashon.org https://www.vigavashon.org";
    const adminFrameAncestors = "frame-ancestors 'self' https://vigavashon.org";
    return [
      {
        // Everything, including the map at `/`. `/admin/*` matches this too and ALSO matches
        // the rule below; a browser intersects two frame-ancestors policies, so the admin
        // pages cannot be loosened by this broader rule.
        source: "/:path*",
        headers: [
          { key: "Content-Security-Policy", value: publicFrameAncestors },
          // A response whose declared type is not second-guessed. Cheap, and one of the
          // headers whose absence a scanner notices.
          { key: "X-Content-Type-Options", value: "nosniff" },
          // The map is framed by a third party, so a full referring URL would otherwise
          // travel outward on every asset request it makes.
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        ],
      },
      // Administrator pages may be framed by VIGA's Squarespace site and nowhere else. This
      // contains clickjacking even though the session cookie must work inside that one iframe.
      {
        source: "/admin/:path*",
        headers: [{ key: "Content-Security-Policy", value: adminFrameAncestors }],
      },
    ];
  },
};

export default nextConfig;
