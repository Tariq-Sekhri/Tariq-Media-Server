// Per-library playback toggles, saved on this device. A library is the first
// folder of a media path.
export type LibraryPlayback = { startFresh?: boolean; alongside?: boolean };
export type LibraryPlaybackKey = keyof LibraryPlayback;

const STORAGE_KEY = "tms:library-playback";
export const LIBRARY_PLAYBACK_EVENT = "tms:library-playback";

const storage = () => {
  try { return typeof window === "undefined" ? null : window.localStorage; } catch { return null; }
};

// Playing alongside other media needs the installed app's second player.
export const alongsideAvailable = () => typeof window !== "undefined"
  && Boolean((window as Window & { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.());

export const libraryOf = (path?: string | null) => path?.replaceAll("\\", "/").split("/")[0]?.toLowerCase() ?? "";

export function readLibraryPlayback(): Record<string, LibraryPlayback> {
  try {
    const saved: unknown = JSON.parse(storage()?.getItem(STORAGE_KEY) ?? "{}");
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved as Record<string, LibraryPlayback> : {};
  } catch { return {}; }
}

export function writeLibraryPlayback(library: string, key: LibraryPlaybackKey, value: boolean) {
  const all = readLibraryPlayback();
  const name = library.toLowerCase();
  const next = { ...all[name], [key]: value };
  if (!next.startFresh && !next.alongside) delete all[name];
  else all[name] = next;
  storage()?.setItem(STORAGE_KEY, JSON.stringify(all));
  window.dispatchEvent(new Event(LIBRARY_PLAYBACK_EVENT));
}

const setting = (path: string | null | undefined, key: LibraryPlaybackKey) => {
  const library = libraryOf(path);
  return Boolean(library && readLibraryPlayback()[library]?.[key]);
};

/** Media in this library always starts from the beginning and saves no progress. */
export const startsFresh = (path?: string | null) => setting(path, "startFresh");
/** Media in this library plays in its own player alongside other media. */
export const playsAlongside = (path?: string | null) => alongsideAvailable() && setting(path, "alongside");
export const watchPlaysAlongside = (url: string) => {
  const params = new URL(url, "http://tms.local").searchParams;
  return playsAlongside(params.get("path") ?? params.get("folder") ?? "");
};
