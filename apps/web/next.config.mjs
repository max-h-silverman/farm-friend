/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  transpilePackages: ["@farm-friend/core", "@farm-friend/contracts"],
};

export default nextConfig;
