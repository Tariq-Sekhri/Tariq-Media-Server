// Starts the screenshot demo: the normal frontend on http://localhost:3100 with
// a fake in-process backend (demo/mock-backend.ts). Open /demo to sign in.
import { spawn } from "node:child_process";

const child = spawn("npx", ["vinext", "dev", "--port", "3100", "--hostname", "127.0.0.1"], {
  stdio: "inherit",
  shell: true,
  env: { ...process.env, TMS_DEMO: "1", TMS_FRONTEND_BIND_ADDRESS: "127.0.0.1" },
});
child.on("exit", (code) => process.exit(code ?? 0));
