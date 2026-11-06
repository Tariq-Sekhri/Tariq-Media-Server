import type { CSSProperties } from "react";
import { VOLUME_SLIDER_MAX } from "./media";

export function PlayPauseIcon({ playing }: { playing: boolean }) {
  return <svg className="watch-playpause-icon" viewBox="0 0 24 24" aria-hidden="true" fill="currentColor">
    {playing ? <><rect x="6" y="5" width="4" height="14" rx="1" /><rect x="14" y="5" width="4" height="14" rx="1" /></> : <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z" />}
  </svg>;
}

export function GearIcon() {
  return <svg className="watch-gear-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></svg>;
}

export const playbackClock = (seconds: number) => {
  if (!Number.isFinite(seconds)) return "0:00";
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainder = whole % 60;
  return `${hours ? `${hours}:` : ""}${hours ? String(minutes).padStart(2, "0") : minutes}:${String(remainder).padStart(2, "0")}`;
};

export function SkipIcon({ direction }: { direction: "back" | "forward" }) {
  const transform = direction === "forward" ? "translate(36 0) scale(-1 1)" : undefined;
  return <svg className="watch-skip-icon" viewBox="0 0 36 30" aria-hidden="true">
    <g transform={transform}>
      <path className="watch-skip-arrow" d="M18 1v8l-5.5-4z" />
      <path className="watch-skip-corner" d="M18 5a11 11 0 1 1-9.5 5.5" />
    </g>
    <text x="18" y="20.5" textAnchor="middle">10</text>
  </svg>;
}

export function QueueIcon({ direction }: { direction: "previous" | "next" }) {
  return <svg className="watch-queue-icon" viewBox="0 0 24 24" aria-hidden="true">
    {direction === "previous"
      ? <><path d="M6 5v14" /><path d="m18 6-9 6 9 6Z" /></>
      : <><path d="M18 5v14" /><path d="m6 6 9 6-9 6Z" /></>}
  </svg>;
}

export function VolumeIcon({ muted }: { muted: boolean }) {
  return <svg className="watch-volume-icon" viewBox="0 0 24 24" aria-hidden="true">
    <path fill="currentColor" d="M4 9v6h4l5 4V5L8 9H4z" />
    {muted
      ? <path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" d="M16 8.5 20 12.5M20 8.5 16 12.5" />
      : <>
          <path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" d="M15 8.5a4 4 0 010 7" />
          <path fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" d="M17.5 6a7 7 0 010 12" />
        </>}
  </svg>;
}

// Exposes the slider position to CSS so the track can paint its filled and boost ranges.
export const volumeSliderStyle = (position: number) => ({ "--volume-fill": `${Math.min(100, Math.max(0, position / VOLUME_SLIDER_MAX * 100))}%` }) as CSSProperties;
