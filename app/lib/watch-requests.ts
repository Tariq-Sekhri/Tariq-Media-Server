// Watch-page reads that several stages need within one Play action. Catalog
// resolution and queue building ask for the same show subtree and the same
// playback state, so share one in-flight request instead of repeating them.

const SHARED_REQUEST_TTL_MS = 15_000;
const sharedRequests = new Map<string, { at: number; promise: Promise<unknown> }>();

export type SharedFetcher = (url: string) => Promise<Response>;

export function sharedJson<T>(url: string, fetcher: SharedFetcher, now = Date.now()): Promise<T> {
  for (const [key, entry] of sharedRequests) {
    if (now - entry.at > SHARED_REQUEST_TTL_MS) sharedRequests.delete(key);
  }
  const existing = sharedRequests.get(url);
  if (existing) return existing.promise as Promise<T>;
  const promise = fetcher(url).then((response) => {
    if (!response.ok) throw Object.assign(new Error(`Request failed (${response.status})`), { status: response.status });
    return response.json() as Promise<T>;
  });
  sharedRequests.set(url, { at: now, promise });
  // A failed read must not poison later attempts.
  promise.catch(() => {
    if (sharedRequests.get(url)?.promise === promise) sharedRequests.delete(url);
  });
  return promise;
}

export function clearSharedRequests() {
  sharedRequests.clear();
}

/** Every entry below `folder`, recursively, without the rest of the library. */
export function librarySubtreeUrl(apiBase: string, folder: string) {
  return `${apiBase}/api/library?${new URLSearchParams({ under: folder })}`;
}

/** Favorites, progress, recency and preferences, without tags or playlists. */
export function playbackUserStateUrl(apiBase: string) {
  return `${apiBase}/api/user-state?view=playback`;
}

/** The deepest folder that contains every path, or "" when they share none. */
export function commonFolder(paths: readonly string[]) {
  const folders = paths.map((path) => path.split("/").filter(Boolean).slice(0, -1));
  if (!folders.length) return "";
  const shared: string[] = [];
  for (let index = 0; index < folders[0].length; index += 1) {
    const segment = folders[0][index];
    if (!folders.every((parts) => parts[index] === segment)) break;
    shared.push(segment);
  }
  return shared.join("/");
}

/**
 * The smallest set of library subtrees the queue needs. "" means the whole
 * library (for example a custom queue spanning several libraries).
 */
export function queueFetchScopes(scopes: readonly (string | undefined)[]) {
  const wanted = [...new Set(scopes.filter((scope): scope is string => scope !== undefined).map((scope) => scope.replace(/^\/+|\/+$/g, "")))];
  if (wanted.includes("")) return [""];
  return wanted.filter((scope) => !wanted.some((other) => other !== scope && scope.startsWith(`${other}/`)));
}
