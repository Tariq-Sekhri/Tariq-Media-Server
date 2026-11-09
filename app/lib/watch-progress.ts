import { startsFresh } from "./library-playback";

// Libraries set to start from the beginning neither save nor restore progress.
export const savesWatchProgress = (path?: string) => !startsFresh(path);

export type WatchProgress = { position: number; duration: number; updated: number; completed?: boolean };

// Episodes often finish before the file does because the remaining time is credits.
export const episodeFinished = (state?: WatchProgress) => Boolean(state && (
  state.completed || (state.duration > 0 && state.position >= state.duration * 0.9
    && state.duration - state.position <= 120)
));

export const selectSeriesEpisode = <T extends { path?: string }>(ordered: T[], playback: Record<string, WatchProgress>): T | undefined => {
  const recent = ordered.map((item, index) => ({ item, index, state: playback[item.path ?? ""] }))
    .filter(({ state }) => state && (state.position > 0 || state.completed))
    .sort((left, right) => right.state.updated - left.state.updated || right.index - left.index)[0];
  if (!recent) return ordered[0];
  if (!episodeFinished(recent.state)) return recent.item;
  return ordered.slice(recent.index + 1).find((item) => !episodeFinished(playback[item.path ?? ""])) ?? recent.item;
};

const storageKey = (userId: number) => `tms:watch-progress:${userId}`;
let persistOnDevice: ((userId: number, path: string, state: WatchProgress) => void) | undefined;
export const installWatchProgressPersistence = (persist: typeof persistOnDevice) => {
  persistOnDevice = persist;
  return () => { if (persistOnDevice === persist) persistOnDevice = undefined; };
};

export const readLocalWatchProgress = (userId?: number): Record<string, WatchProgress> => {
  if (userId === undefined || typeof window === "undefined") return {};
  try {
    const saved = JSON.parse(window.localStorage.getItem(storageKey(userId)) ?? "{}");
    if (!saved || typeof saved !== "object" || Array.isArray(saved)) return {};
    return Object.fromEntries(Object.entries(saved).filter((entry): entry is [string, WatchProgress] => {
      const value = entry[1] as WatchProgress | null;
      return Boolean(savesWatchProgress(entry[0]) && value && Number.isFinite(value.position) && value.position >= 0
        && Number.isFinite(value.duration) && value.duration > 0 && Number.isFinite(value.updated));
    }));
  } catch { return {}; }
};

export const mergeWatchProgress = (remote: Record<string, WatchProgress>, local: Record<string, WatchProgress>) => {
  const merged = { ...remote };
  for (const [path, state] of Object.entries(local)) {
    if (!merged[path] || state.updated >= merged[path].updated) merged[path] = state;
  }
  return Object.fromEntries(Object.entries(merged).filter(([path]) => savesWatchProgress(path)));
};

export const writeLocalWatchProgress = (userId: number | undefined, path: string, state: WatchProgress) => {
  if (userId === undefined || typeof window === "undefined" || !savesWatchProgress(path)) return;
  try {
    const entries = Object.entries({ ...readLocalWatchProgress(userId), [path]: state })
      .sort((left, right) => right[1].updated - left[1].updated).slice(0, 1000);
    window.localStorage.setItem(storageKey(userId), JSON.stringify(Object.fromEntries(entries)));
  } catch { /* Server persistence remains available when local storage is full. */ }
  persistOnDevice?.(userId, path, state);
};

export const syncLocalWatchProgress = async (remote: Record<string, WatchProgress>, local: Record<string, WatchProgress>, save: (path: string, state: WatchProgress) => Promise<void>) => {
  for (const [path, state] of Object.entries(local)) {
    const saved = remote[path];
    if (!savesWatchProgress(path) || (saved && (saved.updated > state.updated
      || (saved.updated === state.updated && saved.position === state.position && saved.duration === state.duration && Boolean(saved.completed) === Boolean(state.completed))))) continue;
    // Failed uploads leave the durable local record untouched for the next run.
    await save(path, state);
  }
  return mergeWatchProgress(remote, local);
};
