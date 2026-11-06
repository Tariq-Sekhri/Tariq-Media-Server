import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

export function resolveCapacitorServerUrl() {
  const override = process.env.TMS_CAPACITOR_SERVER_URL?.trim();
  if (override) {
    return override;
  }

  const tailscaleExe =
    process.platform === "win32"
      ? "C:\\Program Files\\Tailscale\\tailscale.exe"
      : "tailscale";

  if (!existsSync(tailscaleExe) && process.platform !== "win32") {
    try {
      execFileSync("tailscale", ["version"], { stdio: "ignore" });
    } catch {
      return null;
    }
  } else if (!existsSync(tailscaleExe)) {
    return null;
  }

  try {
    const output = execFileSync(tailscaleExe, ["status", "--json"], {
      encoding: "utf8",
    });
    const status = JSON.parse(output);
    const dnsName = String(status?.Self?.DNSName ?? "")
      .trim()
      .replace(/\.$/, "");
    if (dnsName) {
      return `https://${dnsName}`;
    }
  } catch {
    return null;
  }

  return null;
}
