"use client";

import { useEffect, useState, type ImgHTMLAttributes } from "react";
import { getSessionUser } from "./lib/auth";
import { loadArtwork } from "./lib/artwork-cache";
import { useViewportMedia } from "./lib/use-viewport-load";

export default function CachedArtworkImage({ src, alt, ...props }: ImgHTMLAttributes<HTMLImageElement> & { src: string }) {
  const { ref, shouldLoad } = useViewportMedia<HTMLImageElement>();
  const scope = String(getSessionUser()?.id ?? "anonymous");
  const [resolved, setResolved] = useState<{ src: string; scope: string; url: string } | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!shouldLoad) return;
    let cancelled = false;
    let objectUrl: string | undefined;
    const load = () => {
      void loadArtwork(src, scope).then(image => {
        if (cancelled) return;
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        objectUrl = URL.createObjectURL(image);
        setResolved({ src, scope, url: objectUrl });
      }).catch(() => {
        // Preserve support for image hosts which do not allow CORS fetches.
        if (!cancelled) setResolved({ src, scope, url: src });
      });
    };
    load();
    window.addEventListener("online", load);
    return () => {
      cancelled = true;
      window.removeEventListener("online", load);
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [src, scope, shouldLoad]);

  // No network src is assigned until the persistent cache has been checked.
  const url = resolved?.src === src && resolved.scope === scope ? resolved.url : undefined;
  const failed = url !== undefined && failedUrl === url;
  // A failed image keeps its accessible name but never paints broken-image alt text over the tile.
  return <img {...props} ref={ref} alt={alt} src={url} data-artwork-failed={failed ? "" : undefined} style={failed ? { ...props.style, visibility: "hidden" } : props.style} onError={event => { if (url) setFailedUrl(url); props.onError?.(event); }} />;
}
