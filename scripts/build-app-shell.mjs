import { build } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolve } from "node:path";
import { readFile, writeFile, rename } from "node:fs/promises";
import { createHash } from "node:crypto";

// Append to the completed Vinext release; writing public/ would retrigger the watcher.
const result = await build({
  configFile: false, publicDir: false,
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "next/navigation": resolve("app/client-navigation.ts") } },
  build: {
    outDir: "dist/client", emptyOutDir: false, assetsDir: "app-shell-assets",
    rollupOptions: { input: resolve("public/index.html") },
  },
});
await rename("dist/client/public/index.html", "dist/client/index.html");
const assets = result.output.filter(file => file.fileName !== "public/index.html").map(file => `/${file.fileName}`);
await writeFile("dist/client/app-shell-manifest.json", JSON.stringify(["/index.html", ...assets]));
await writeFile("dist/client/offline.html", await readFile("dist/client/index.html"));
const revision = createHash("sha256").update(JSON.stringify(assets)).digest("hex").slice(0, 16);
const worker = await readFile("public/service-worker.js", "utf8");
await writeFile("dist/client/service-worker.js", worker.replace("tms-react-shell-v2", `tms-react-shell-${revision}`));
