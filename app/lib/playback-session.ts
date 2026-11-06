import { savesWatchProgress } from "./watch-progress";
import type { MediaItem } from "./media";
import { queueSourceForItem, writeQueueSource, type QueueSource } from "./playback-queue";

// The queue belongs to playback, not to either player view. Keep a tab-local,
// user-scoped copy across the native navigations used by LAN installations.
export type PlaybackSession = {
  id: string;
  userId: number;
  item: MediaItem;
  queue: MediaItem[];
  source?: QueueSource;
  label?: string;
  returnUrl: string;
  complete: boolean;
  time: number;
  playing: boolean;
  savedAt: number;
  handoff?: boolean;
  watchEntry?: boolean;
};
let current: PlaybackSession | null = null;
const listeners = new Set<() => void>();
const key = (userId: number) => `tms:playback-session:v1:${userId}`;
const progressKey = (userId: number) => `${key(userId)}:progress`;
export const playbackReturnUrl = (url?: string) => url && /^\/(?![\/\\])/.test(url) && !url.startsWith("/watch") ? url : "/";
export const samePlaybackItem = (a: MediaItem, b: MediaItem) => a.path && b.path ? a.path === b.path : a.src === b.src;
export const subscribePlaybackSession = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const playbackSessionSnapshot = () => current;
export const serverPlaybackSessionSnapshot = () => null;

export function restorePlaybackSession(userId?: number) {
  if (userId === undefined || typeof window === "undefined") return null;
  if (current?.userId === userId) return current;
  try {
    const saved = JSON.parse(sessionStorage.getItem(key(userId)) ?? "null") as PlaybackSession | null;
    if (saved?.userId === userId && saved.item?.src && Array.isArray(saved.queue)
      && saved.queue.every((item) => item && typeof item.src === "string" && ["audio", "video", "image"].includes(item.kind))
      && Date.now() - saved.savedAt < 24 * 60 * 60 * 1000) {
      const progress = JSON.parse(sessionStorage.getItem(progressKey(userId)) ?? "null");
      const time = progress?.id === saved.id && progress.path === saved.item.path && progress.src === saved.item.src
        && progress.savedAt >= saved.savedAt && Number.isFinite(progress.time) ? Math.max(0, progress.time) : saved.time;
      current = { ...saved, time: savesWatchProgress(saved.item.path) ? time : 0, returnUrl: playbackReturnUrl(saved.returnUrl), playing: Boolean(saved.handoff && saved.playing && Date.now() - saved.savedAt < 30_000), handoff: false };
      return current;
    }
  } catch { /* Storage may be disabled or full. In-memory playback still works. */ }
  current = null;
  return null;
}

export function setPlaybackSession(session: PlaybackSession | null) {
  const previous = current;
  current = session;
  // Fresh-start libraries keep a live handoff in memory but never persist its resume position.
  if (typeof window !== "undefined") {
    try {
      if (session) sessionStorage.setItem(key(session.userId), JSON.stringify({ ...session, time: savesWatchProgress(session.item.path) ? session.time : 0, savedAt: Date.now() }));
      else if (previous) {
        sessionStorage.removeItem(key(previous.userId));
        sessionStorage.removeItem(progressKey(previous.userId));
      }
    } catch { /* Native navigation can still reconstruct online queues from their URL. */ }
  }
  listeners.forEach((listener) => listener());
}

export function startPlaybackSession(input: Omit<PlaybackSession, "id" | "savedAt" | "returnUrl"> & { returnUrl?: string }) {
  const session = { ...input, id: `${Date.now()}-${Math.random()}`, savedAt: Date.now(), returnUrl: playbackReturnUrl(input.returnUrl) };
  setPlaybackSession(session);
  return session;
}

export function selectPlaybackItem(session: PlaybackSession, item: MediaItem, playing = true): PlaybackSession {
  return { ...session, item, source: session.source ? queueSourceForItem(session.source, item) : undefined, time: 0, playing, handoff: false };
}

export function checkpointPlaybackSession(item: MediaItem, time: number, playing: boolean) {
  if (!current || !samePlaybackItem(current.item, item) || !Number.isFinite(time)) return;
  // Time is deliberately not a subscribed UI value. Preserve it when queue
  // metadata updates without causing a React render on every media tick.
  current.time = Math.max(0, time);
  current.playing = playing;
  current.savedAt = Date.now();
  if (!savesWatchProgress(item.path)) return;
  // Avoid serializing a potentially very large queue at media-tick frequency.
  try { sessionStorage.setItem(progressKey(current.userId), JSON.stringify({ id: current.id, path: item.path, src: item.src, time: current.time, playing, savedAt: current.savedAt })); } catch { /* Optional persistence. */ }
}

export function playbackWatchUrl(session: PlaybackSession) {
  const item = session.item;
  const params = new URLSearchParams({ name: item.name, size: item.size, kind: item.kind, folder: item.parent ?? "My library", return: session.returnUrl, playbackSession: session.id });
  if (item.path) params.set("path", item.path);
  if (item.offline?.bundleId && item.offline.fileId) {
    params.set("offlineBundle", item.offline.bundleId);
    params.set("offlineFile", item.offline.fileId);
  } else if (item.src) params.set("src", item.src);
  if (session.source) writeQueueSource(params, session.source);
  else params.set("queue", "custom");
  if (session.label) params.set("queueLabel", session.label);
  if (item.catalogKind) params.set("catalogKind", item.catalogKind);
  if (session.playing) params.set("play", "1");
  if (session.time > 0) params.set("start", String(session.time));
  return `/watch?${params}`;
}
