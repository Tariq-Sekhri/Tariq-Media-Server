export const PLAYBACK_HANDOFF_KEY = "tms:playback-handoff:v1";

export type PlaybackHandoff = {
  src: string;
  currentTime: number;
  playing: boolean;
  volume: number;
  muted: boolean;
  queuePaths: string[];
  queueLabel?: string;
  moviesTv: boolean;
  target: "watch" | "mini";
  savedAt: number;
};

export const savePlaybackHandoff = (handoff: Omit<PlaybackHandoff, "savedAt">) => {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.setItem(PLAYBACK_HANDOFF_KEY, JSON.stringify({ ...handoff, savedAt: Date.now() }));
  } catch {
    // Playback still works when session storage is unavailable.
  }
};

const readStoredHandoff = () => {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(PLAYBACK_HANDOFF_KEY);
    if (!raw) return null;
    const handoff = JSON.parse(raw) as PlaybackHandoff;
    if (Date.now() - handoff.savedAt > 30_000) {
      sessionStorage.removeItem(PLAYBACK_HANDOFF_KEY);
      return null;
    }
    return handoff;
  } catch {
    return null;
  }
};

export const readPlaybackHandoff = (src: string, target: PlaybackHandoff["target"]) => {
  const handoff = readStoredHandoff();
  if (!handoff || handoff.src !== src || handoff.target !== target) return null;
  return handoff;
};

export const readPendingPlaybackHandoff = (target: PlaybackHandoff["target"]) => {
  const handoff = readStoredHandoff();
  if (!handoff || handoff.target !== target) return null;
  return handoff;
};

export const clearPlaybackHandoff = () => {
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(PLAYBACK_HANDOFF_KEY);
  } catch {
    // Ignore storage failures.
  }
};
