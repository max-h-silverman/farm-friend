/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
};

export default nextConfig;
