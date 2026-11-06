import { useEffect, useRef, useState, type RefObject } from "react";

type ViewportMediaOptions = {
  loadRootMargin?: string;
};

export function useViewportMedia<T extends Element>(
  options: ViewportMediaOptions = {},
): { ref: RefObject<T | null>; shouldLoad: boolean } {
  const ref = useRef<T | null>(null);
  const pinnedRef = useRef(false);
  const [shouldLoad, setShouldLoad] = useState(false);
  // Do not queue several screens of high-priority images on mobile. Keeping
  // this tight leaves the WebView's connection slots for what is on screen.
  const loadRootMargin = options.loadRootMargin ?? "160px 0px";

  useEffect(() => {
    const target = ref.current;
    if (!target) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        if (pinnedRef.current) return;
        pinnedRef.current = true;
        setShouldLoad(true);
      },
      { rootMargin: loadRootMargin, threshold: 0 },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, [loadRootMargin]);

  return { ref, shouldLoad: shouldLoad || pinnedRef.current };
}

export const useViewportLoad = useViewportMedia;
