"use client";

import { useEffect } from "react";

import { uploadsAreActive } from "./lib/uploads";

const RELEASE_MARKER = "/tms-release";
const POLL_INTERVAL_MS = 3_000;

/**
 * The production frontend is served from immutable build directories. Vinext
 * can replace that server without a websocket/HMR connection, so keep a small
 * uncached marker request open in every browser tab and reload once a new
 * release has actually taken over the port.
 */
export default function ProductionReleaseReloader() {
  useEffect(() => {
    let knownRelease: string | null = null;
    let reloading = false;

    const checkForRelease = async () => {
      try {
        const response = await fetch(`${RELEASE_MARKER}?t=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) return;
        const marker = await response.json() as { release?: unknown };
        if (typeof marker.release !== "string" || !marker.release) return;

        if (knownRelease && marker.release !== knownRelease && !reloading) {
          // Reloading would abort running uploads; pick the release up once
          // they finish (knownRelease stays old, so a later poll reloads).
          if (uploadsAreActive()) return;
          reloading = true;
          window.location.reload();
          return;
        }
        knownRelease = marker.release;
      } catch {
        // The production server is briefly unavailable while a release swaps.
        // Keep the current tab usable and try again after it has restarted.
      }
    };

    void checkForRelease();
    const timer = window.setInterval(() => { void checkForRelease(); }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, []);

  return null;
}
