import { useEffect, useRef } from "react";

// Open overlays (menus, drawers, dialogs) register a close handler. The
// Android Back button closes the most recently opened one before it navigates.
const layers: { close: () => void }[] = [];

export function closeTopBackLayer() {
  const layer = layers.pop();
  if (!layer) return false;
  layer.close();
  return true;
}

export function useBackLayer(open: boolean, close: () => void) {
  const closeRef = useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const layer = { close: () => closeRef.current() };
    layers.push(layer);
    return () => {
      const index = layers.indexOf(layer);
      if (index >= 0) layers.splice(index, 1);
    };
  }, [open]);
}
