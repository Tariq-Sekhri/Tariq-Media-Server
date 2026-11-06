import path from "node:path";
import { pathToFileURL } from "node:url";

const releaseRoot = process.env.TMS_FRONTEND_RELEASE_ROOT;
if (!releaseRoot) throw new Error("TMS_FRONTEND_RELEASE_ROOT is required.");

// Vinext intentionally does not publish this production-server helper through
// package exports. Resolve the installed implementation explicitly instead of
// depending on an unsupported package subpath.
const vinextServer = await import(pathToFileURL(path.join(process.cwd(), "node_modules", "vinext", "dist", "server", "prod-server.js")).href);

await vinextServer.startProdServer({
  host: process.env.TMS_FRONTEND_BIND_ADDRESS ?? "0.0.0.0",
  port: Number(process.env.TMS_FRONTEND_PORT ?? "3000"),
  outDir: path.join(releaseRoot, "dist"),
});
