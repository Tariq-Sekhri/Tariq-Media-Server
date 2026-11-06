import vinext from "vinext";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import os from "node:os";

const backendUrl = process.env.TMS_BACKEND_URL ?? "http://127.0.0.1:8787";
const bindAddress = process.env.TMS_FRONTEND_BIND_ADDRESS ?? "127.0.0.1";
const configuredHosts = (process.env.TMS_ALLOWED_HOSTS ?? "")
  .split(",")
  .map((host) => host.trim())
  .filter(Boolean);
const machineName = os.hostname().trim();
const allowedHosts = [
  ...configuredHosts,
  machineName,
  `${machineName}.local`,
  ".ts.net",
  ".local",
].filter((host, index, hosts) => host && hosts.indexOf(host) === index);

// `npm run demo` serves the app against an in-process fake backend for
// screenshots. The demo code is only imported when that flag is set.
const demo = process.env.TMS_DEMO === "1";
const demoPlugins = demo ? [(await import("./demo/mock-backend")).demoBackend()] : [];

export default defineConfig({
  plugins: [...demoPlugins, tailwindcss(), vinext()],
  server: {
    host: bindAddress,
    port: demo ? 3100 : 3000,
    strictPort: true,
    watch: {
      ignored: ["**/TariqsMediaServer/**"],
    },
    allowedHosts,
    proxy: demo ? undefined : {
      "/api": backendUrl,
      "/media": backendUrl,
      "/folder-downloads": backendUrl,
      "/trash-files": backendUrl,
      "/folder-covers": backendUrl,
      "/profile-avatars": backendUrl,
      "/transcodes": backendUrl,
      "/browser-media": backendUrl,
    },
  },
});
