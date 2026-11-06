import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { networkInterfaces } from "node:os";

export function resolveCapacitorLocalServerUrl() {
  const override = process.env.TMS_CAPACITOR_LOCAL_SERVER_URL?.trim();
  if (override) return override;
  if (process.env.TMS_CAPACITOR_SERVER_URL?.trim()) return null;
  // Generate device-specific addresses at build time; keep them out of source.
  const interfaces = Object.entries(networkInterfaces())
    .filter(([name]) => !/tailscale|vpn|virtual|loopback|vethernet/i.test(name))
    .sort(([left], [right]) => Number(!/ethernet/i.test(left)) - Number(!/ethernet/i.test(right)));
  for (const [, addresses] of interfaces) {
    const address = addresses?.find((entry) => entry.family === "IPv4" && !entry.internal);
    if (address) return `http://${address.address}:${process.env.TMS_FRONTEND_PORT || "3000"}`;
  }
  return null;
}

export function resolveCapacitorTailscaleServerUrl() {
  if (process.env.TMS_CAPACITOR_SERVER_URL?.trim()) return null;
  const executable = process.platform === "win32" ? "C:\\Program Files\\Tailscale\\tailscale.exe" : "tailscale";
  try {
    const status = JSON.parse(execFileSync(executable, ["status", "--json"], { encoding: "utf8" }));
    const address = status?.Self?.TailscaleIPs?.find((value) => !value.includes(":"));
    return address ? `http://${address}:${process.env.TMS_FRONTEND_PORT || "3000"}` : null;
  } catch {
    return null;
  }
}

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
