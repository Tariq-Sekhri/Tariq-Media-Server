import type { CapacitorConfig } from "@capacitor/cli";
import { resolveCapacitorLocalServerUrl, resolveCapacitorServerUrl, resolveCapacitorTailscaleServerUrl } from "./scripts/capacitor-server-url.mjs";

const serverUrl = resolveCapacitorServerUrl();
const localServerUrl = resolveCapacitorLocalServerUrl();

const config: CapacitorConfig = {
  appId: "ca.sekhrit.tms",
  appName: "TMS",
  // Keep the complete production web app in the APK.  Capacitor normally
  // opens the live TMS URL, but this local bundle is what it can fall back to
  // when that server is unavailable.
  webDir: "dist/client",
  android: {
    allowMixedContent: true,
  },
  plugins: {
    TmsConnection: { localUrl: localServerUrl, tailscaleUrl: resolveCapacitorTailscaleServerUrl() },
  },
  server: {
    // Bundle the same React library and player for server-free startup.
    errorPath: "index.html",
    // A server URL is an optional online enhancement.  Without one, Capacitor
    // starts the bundled app locally, which is exactly what offline mode needs.
    ...(serverUrl ? {
      url: serverUrl,
      cleartext: serverUrl.startsWith("http://"),
    } : {}),
  },
};

export default config;
