import { reportClientPerformance } from "./auth";

const reportedImages = new WeakSet<HTMLImageElement>();

const sourceForUrl = (url: string) => {
  try {
    const path = new URL(url, window.location.href).pathname;
    if (path.startsWith("/api/grid-thumb")) return "server-grid-thumb";
    if (path.startsWith("/folder-covers/")) return "server-folder-cover";
    if (path.startsWith("/media/")) return "server-media";
    if (new URL(url, window.location.href).origin === window.location.origin) return "server-image";
    return "external-image";
  } catch {
    return "unknown-image";
  }
};

const resourceTiming = (url: string) => {
  const entries = performance.getEntriesByName(url, "resource") as PerformanceResourceTiming[];
  return entries.at(-1);
};

export function reportImageResult(image: HTMLImageElement, outcome: "loaded" | "failed", startedAt?: number, context = "dom") {
  if (typeof window === "undefined" || reportedImages.has(image)) return;
  reportedImages.add(image);

  const url = image.currentSrc || image.src;
  const timing = resourceTiming(url);
  const elapsedMs = timing
    ? Math.max(0, performance.now() - timing.startTime)
    : startedAt === undefined ? 0 : Math.max(0, performance.now() - startedAt);
  const fromBrowserCache = Boolean(timing && timing.transferSize === 0 && sourceForUrl(url) !== "external-image");
  const rect = image.getBoundingClientRect();

  reportClientPerformance("image_load", elapsedMs, {
    image_load_ms: Math.round(elapsedMs),
    outcome,
    load_context: context,
    source: sourceForUrl(url),
    browser_cache: fromBrowserCache,
    transfer_bytes: timing?.transferSize ?? null,
    decoded_bytes: timing?.decodedBodySize ?? null,
    natural_width: image.naturalWidth,
    natural_height: image.naturalHeight,
    visible: rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0,
    image_url: url.slice(0, 1000),
  });
}
