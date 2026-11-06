"use client";

import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent, type RefObject } from "react";
import { PlayPauseIcon, QueueIcon, playbackClock } from "./lib/player-ui";
import { MINI_PLAYER_DISMISS_FRACTION, MINI_PLAYER_POSITION_KEY, clampMiniPlayerPosition, miniPlayerOverflow, parseMiniPlayerPosition, type MiniPlayerPosition } from "./lib/mini-player-position";

const DRAG_THRESHOLD = 6;

const readMiniPlayerPosition = () => {
  let raw: string | null = null;
  try { raw = window.localStorage.getItem(MINI_PLAYER_POSITION_KEY); } catch { /* Storage can be disabled. */ }
  return parseMiniPlayerPosition(raw, window.matchMedia("(max-width: 820px)").matches);
};

// Drag the floating player anywhere in the viewport. A press that does not
// move is a tap, which expands the player back to full Watch. Throwing it
// past the left or right edge dismisses it.
export function useMiniPlayerDrag(playerRef: RefObject<HTMLElement | null>, active: boolean, onTap: () => void, onDismiss: () => void) {
  const [position, setPosition] = useState<MiniPlayerPosition | null>(null);
  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; origin: MiniPlayerPosition; width: number; moved: boolean } | null>(null);

  const clampToViewport = (next: MiniPlayerPosition) => {
    const player = playerRef.current;
    if (!player) return next;
    const bounds = player.getBoundingClientRect();
    return clampMiniPlayerPosition(next, { width: bounds.width, height: bounds.height }, { width: window.innerWidth, height: window.innerHeight });
  };

  useEffect(() => {
    if (!active) return;
    const fit = () => setPosition((current) => clampToViewport(current ?? readMiniPlayerPosition()));
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [active]); // eslint-disable-line react-hooks/exhaustive-deps -- clampToViewport only reads the ref and window.

  const place = (player: HTMLElement, next: MiniPlayerPosition, opacity = "") => {
    player.style.setProperty("--mini-right", `${next.right}px`);
    player.style.setProperty("--mini-bottom", `${next.bottom}px`);
    player.style.opacity = opacity;
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || !position) return;
    if (event.target instanceof Element && event.target.closest("button")) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const width = event.currentTarget.getBoundingClientRect().width;
    dragRef.current = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: position, width, moved: false };
  };

  // Vertical movement stays on screen; horizontal movement may leave it.
  const dragPosition = (drag: NonNullable<typeof dragRef.current>, event: ReactPointerEvent<HTMLElement>) => {
    const raw = { right: drag.origin.right - (event.clientX - drag.startX), bottom: drag.origin.bottom - (event.clientY - drag.startY) };
    const clamped = clampToViewport(raw);
    return { raw: { right: Math.round(raw.right), bottom: clamped.bottom }, clamped, overflow: miniPlayerOverflow(raw.right, clamped.right, drag.width) };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    const player = playerRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !player) return;
    if (!drag.moved && Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < DRAG_THRESHOLD) return;
    drag.moved = true;
    player.classList.add("dragging");
    // Move the element directly while dragging; React renders once on release.
    const { raw, overflow } = dragPosition(drag, event);
    place(player, raw, overflow > 0 ? String(Math.max(0.25, 1 - overflow)) : "");
  };

  const finish = (event: ReactPointerEvent<HTMLElement>, cancelled = false) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    const player = playerRef.current;
    player?.classList.remove("dragging");
    if (!drag.moved) {
      if (!cancelled) onTap();
      return;
    }
    const { raw, clamped, overflow } = dragPosition(drag, event);
    if (!cancelled && overflow >= MINI_PLAYER_DISMISS_FRACTION && player) {
      // Finish the throw off screen, then end playback.
      player.classList.add("dismissing");
      place(player, { right: raw.right < clamped.right ? -drag.width - 40 : window.innerWidth + 40, bottom: raw.bottom }, "0");
      window.setTimeout(onDismiss, 180);
      return;
    }
    if (player) place(player, clamped);
    setPosition(clamped);
    try { window.localStorage.setItem(MINI_PLAYER_POSITION_KEY, JSON.stringify(clamped)); } catch { /* Position persistence is optional. */ }
  };

  const style = position ? { "--mini-right": `${position.right}px`, "--mini-bottom": `${position.bottom}px` } as CSSProperties : undefined;
  return {
    style,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (event: ReactPointerEvent<HTMLElement>) => finish(event),
      onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => finish(event, true),
    },
  };
}

type WatchMiniControlsProps = {
  title: string;
  subtitle: string;
  playing: boolean;
  loading: boolean;
  failed?: boolean;
  currentTime: number;
  duration: number;
  hasPrevious: boolean;
  hasNext: boolean;
  canPip: boolean;
  onTogglePlayback: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onExpand: () => void;
  onClose: () => void;
  onPip: () => void;
};

export function WatchMiniControls({ title, subtitle, playing, loading, failed = false, currentTime, duration, hasPrevious, hasNext, canPip, onTogglePlayback, onPrevious, onNext, onExpand, onClose, onPip }: WatchMiniControlsProps) {
  const progress = duration > 0 ? Math.max(0, Math.min(100, currentTime / duration * 100)) : 0;
  const cleanTitle = title.replace(/\.(mkv|mp4|m4v|avi|mov|webm)$/i, "");
  const titleParts = cleanTitle.split(" · ");
  const miniTitle = titleParts.length > 1 ? { primary: titleParts.slice(1).join(" · "), secondary: titleParts[0] } : { primary: cleanTitle, secondary: "" };
  return <>
    <div className="watch-mini-compact">
      <button type="button" className="watch-mini-compact-title" onClick={onExpand} aria-label={`Expand player: ${title}`}><b>{miniTitle.primary}</b><small>{failed ? "Couldn’t load this video" : loading ? "Loading playback…" : `${miniTitle.secondary ? `${miniTitle.secondary} · ` : ""}${playbackClock(currentTime)} / ${playbackClock(Math.round(duration))}`}</small></button>
      <button type="button" onClick={onTogglePlayback} aria-label={failed ? "Retry playback" : playing ? "Pause" : "Play"}>{failed ? "↻" : playing ? "Ⅱ" : "▶"}</button>
      <button type="button" onClick={onClose} aria-label="Close player">×</button>
    </div>
    <div className="watch-mini-overlay">
      <div className="watch-mini-top">
        <button type="button" className="watch-mini-button" onClick={onExpand} aria-label="Expand player" title="Expand player">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 10V4h6M20 14v6h-6M4 4l6.5 6.5M20 20l-6.5-6.5" /></svg>
        </button>
        <span />
        {canPip ? <button type="button" className="watch-mini-button" onClick={onPip} aria-label="Picture-in-picture" title="Picture-in-picture">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><rect x="12" y="11" width="7" height="5" rx="1" /></svg>
        </button> : null}
      </div>
      {/* Always visible so a playing video can be dismissed with one click. */}
      <button type="button" className="watch-mini-button watch-mini-close" onClick={onClose} aria-label="Close player" title="Close player (or drag it off the side)">
        <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18" /></svg>
      </button>
      <div className="watch-mini-center">
        <button type="button" className="watch-mini-button" disabled={!hasPrevious} onClick={onPrevious} aria-label="Previous" title="Previous"><QueueIcon direction="previous" /></button>
        <button type="button" className="watch-mini-button watch-mini-play" onClick={onTogglePlayback} aria-label={failed ? "Retry playback" : playing ? "Pause" : "Play"} title={playing ? "Pause" : "Play"}>
          {loading ? <i className="watch-mini-spinner" aria-hidden="true" /> : failed ? "↻" : <PlayPauseIcon playing={playing} />}
        </button>
        <button type="button" className="watch-mini-button" disabled={!hasNext} onClick={onNext} aria-label="Next" title="Next"><QueueIcon direction="next" /></button>
      </div>
      <div className="watch-mini-progress" role="progressbar" aria-label="Playback position" aria-valuemin={0} aria-valuemax={Math.round(duration)} aria-valuenow={Math.round(currentTime)} aria-valuetext={`${playbackClock(currentTime)} of ${playbackClock(duration)}`}>
        <b style={{ width: `${progress}%` }} />
      </div>
    </div>
    <div className="watch-mini-info">
      <b>{title}</b>
      <small>{subtitle}</small>
    </div>
  </>;
}
