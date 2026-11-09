import { Capacitor, registerPlugin } from "@capacitor/core";
import { getSessionUser } from "./auth";
import { installWatchProgressPersistence, readLocalWatchProgress, writeLocalWatchProgress, type WatchProgress } from "./watch-progress";

const NativeProgress = registerPlugin<{
  getOfflineWatchProgress(options: { ownerId: number }): Promise<{ playback: Record<string, WatchProgress> }>;
  saveOfflineWatchProgress(options: { ownerId: number; path: string; state: WatchProgress }): Promise<void>;
}>("TmsOffline");

export async function hydrateNativeWatchProgress() {
  const ownerId = getSessionUser()?.id;
  if (!Capacitor.isNativePlatform() || ownerId === undefined) return;
  const saved = await NativeProgress.getOfflineWatchProgress({ ownerId }).catch(() => undefined);
  if (!saved || getSessionUser()?.id !== ownerId) return;
  const local = readLocalWatchProgress(ownerId);
  for (const [path, state] of Object.entries(saved.playback ?? {})) {
    if (Number.isFinite(state.position) && state.position >= 0 && Number.isFinite(state.duration) && state.duration > 0
      && Number.isFinite(state.updated) && (!local[path] || state.updated > local[path].updated)) writeLocalWatchProgress(ownerId, path, state);
  }
}

export function connectNativeWatchProgress() {
  if (!Capacitor.isNativePlatform()) return () => {};
  const cleanup = installWatchProgressPersistence((ownerId, path, state) => {
    void NativeProgress.saveOfflineWatchProgress({ ownerId, path, state }).catch(() => undefined);
  });
  void hydrateNativeWatchProgress();
  return cleanup;
}
