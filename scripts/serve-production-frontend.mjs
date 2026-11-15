import net from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";

const releaseRoot = process.env.TMS_FRONTEND_RELEASE_ROOT;
if (!releaseRoot) throw new Error("TMS_FRONTEND_RELEASE_ROOT is required.");

// Vinext intentionally does not publish this production-server helper through
// package exports. Resolve the installed implementation explicitly instead of
// depending on an unsupported package subpath.
const vinextServer = await import(pathToFileURL(path.join(process.cwd(), "node_modules", "vinext", "dist", "server", "prod-server.js")).href);

const { server } = await vinextServer.startProdServer({
  host: process.env.TMS_FRONTEND_BIND_ADDRESS ?? "0.0.0.0",
  port: Number(process.env.TMS_FRONTEND_PORT ?? "3000"),
  outDir: path.join(releaseRoot, "dist"),
});

// Vinext proxies backend routes with fetch(), which cannot carry a WebSocket
// upgrade. Watch Together keeps one socket per member, so pass those upgrades
// straight through to the backend as raw TCP.
const backend = new URL(process.env.TMS_BACKEND_URL ?? "http://127.0.0.1:8787");
const SOCKET_PATHS = ["/api/watch-rooms/socket"];
const log = (message, details = {}) => console.log(`[${new Date().toISOString()}] watch-rooms-proxy ${message} ${JSON.stringify(details)}`);

server?.on("upgrade", (request, client, head) => {
  const pathname = (request.url ?? "").split("?")[0];
  if (!SOCKET_PATHS.includes(pathname)) {
    client.destroy();
    return;
  }
  const upstream = net.connect(Number(backend.port || 80), backend.hostname);
  const remote = request.socket.remoteAddress ?? "";
  const forwardedFor = [request.headers["x-forwarded-for"], remote].filter(Boolean).join(", ");
  upstream.on("connect", () => {
    const headerLines = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index];
      if (name.toLowerCase() === "x-forwarded-for") continue;
      headerLines.push(`${name}: ${request.rawHeaders[index + 1]}`);
    }
    headerLines.push(`X-Forwarded-For: ${forwardedFor}`);
    upstream.write(`${request.method} ${request.url} HTTP/1.1\r\n${headerLines.join("\r\n")}\r\n\r\n`);
    if (head?.length) upstream.write(head);
    upstream.pipe(client);
    client.pipe(upstream);
  });
  const close = (side) => (error) => {
    if (error) log("connection error", { side, path: pathname, remote, error: error.message });
    upstream.destroy();
    client.destroy();
  };
  upstream.on("error", close("backend"));
  client.on("error", close("client"));
  upstream.on("close", () => client.destroy());
  client.on("close", () => upstream.destroy());
});
