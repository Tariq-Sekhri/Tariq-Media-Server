import { useCallback, useRef, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";

const DRAG_THRESHOLD = 5;

/**
 * Lets a mouse drag scroll a horizontally overflowing
 * row on desktop. Touch and pen keep the browser's native scrolling. A click
 * that ends a drag is swallowed so the chip under the pointer is not toggled.
 */
export function useDragScroll<T extends HTMLElement>() {
  const drag = useRef<{ id: number; startX: number; startScroll: number; moved: boolean } | null>(null);
  const suppressClick = useRef(false);

  const onPointerDown = useCallback((event: ReactPointerEvent<T>) => {
    if (event.pointerType !== "mouse" || event.button !== 0) return;
    const element = event.currentTarget;
    if (element.scrollWidth <= element.clientWidth) return;
    drag.current = { id: event.pointerId, startX: event.clientX, startScroll: element.scrollLeft, moved: false };
    suppressClick.current = false;
  }, []);

  const onPointerMove = useCallback((event: ReactPointerEvent<T>) => {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    const deltaX = event.clientX - state.startX;
    if (!state.moved) {
      if (Math.abs(deltaX) < DRAG_THRESHOLD) return;
      state.moved = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      event.currentTarget.style.cursor = "grabbing";
    }
    event.currentTarget.scrollLeft = state.startScroll - deltaX;
    event.preventDefault();
  }, []);

  const endDrag = useCallback((event: ReactPointerEvent<T>) => {
    const state = drag.current;
    if (!state || state.id !== event.pointerId) return;
    drag.current = null;
    if (state.moved) {
      suppressClick.current = true;
      event.currentTarget.style.cursor = "";
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const onClickCapture = useCallback((event: ReactMouseEvent<T>) => {
    if (!suppressClick.current) return;
    suppressClick.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return { onPointerDown, onPointerMove, onPointerUp: endDrag, onPointerCancel: endDrag, onClickCapture, onDragStart: (event: ReactMouseEvent<T>) => event.preventDefault() };
}
