import type { NextConfig } from "next";

const backendUrl = process.env.TMS_BACKEND_URL ?? "http://127.0.0.1:8787";
const backendPrefixes = [
  "/api",
  "/media",
  "/folder-downloads",
  "/trash-files",
  "/folder-covers",
  "/profile-avatars",
  "/transcodes",
  "/browser-media",
];

const nextConfig: NextConfig = {
  async rewrites() {
    // The screenshot demo (`npm run demo`) answers these paths itself.
    if (process.env.TMS_DEMO === "1") return { beforeFiles: [] };
    return {
      beforeFiles: backendPrefixes.map((prefix) => ({
        source: `${prefix}/:path*`,
        destination: `${backendUrl}${prefix}/:path*`,
      })),
    };
  },
};

export default nextConfig;
