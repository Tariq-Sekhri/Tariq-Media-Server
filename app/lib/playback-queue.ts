import { apiEntryToMediaItem, inheritedTags, type ApiLibraryEntry, type MediaItem } from "./media";
import { matchesSearchQuery } from "./search";
import type { PlaybackPreferences } from "./playback";

export type QueueSource = {
  version: 1;
  section: string;
  folder?: string;
  search: string;
  globalSearch: boolean;
  tags: string[];
  sort: string;
  direction: "asc" | "desc";
  method: "item" | "all" | "shuffle";
  returnUrl: string;
  startedAt: number;
  playlistPaths?: string[];
  // Preserve pre-play access times only for items we play. This keeps Recent
  // and Last opened stable without serializing the entire queue into the URL.
  opened?: Record<string, number>;
  seed?: string;
  anchor?: string;
};

export function readQueueSource(params: URLSearchParams): QueueSource | undefined {
  try {
    const value = JSON.parse(params.get("queueSource") ?? "null");
    if (!value || value.version !== 1
      || !["library", "recent", "new", "favorites", "playlists"].includes(value.section)
      || !["item", "all", "shuffle"].includes(value.method)
      || !["name", "opened", "date", "size", "length", "type"].includes(value.sort)
      || !["asc", "desc"].includes(value.direction)
      || typeof value.returnUrl !== "string" || !/^\/(?![\/\\])/.test(value.returnUrl) || value.returnUrl.startsWith("/watch")
      || typeof value.search !== "string" || typeof value.globalSearch !== "boolean"
      || !Number.isFinite(value.startedAt)
      || !Array.isArray(value.tags) || !value.tags.every((tag: unknown) => typeof tag === "string")
      || (value.opened !== undefined && (!value.opened || typeof value.opened !== "object" || Array.isArray(value.opened) || !Object.values(value.opened).every((time) => typeof time === "number" && Number.isFinite(time))))
      || [value.playlistPaths].some((paths) => paths !== undefined && (!Array.isArray(paths) || !paths.every((path: unknown) => typeof path === "string")))
      || [value.folder, value.seed, value.anchor].some((field) => field !== undefined && typeof field !== "string")) return undefined;
    return value as QueueSource;
  } catch { return undefined; }
}

export function writeQueueSource(params: URLSearchParams, source: QueueSource) {
  params.set("queueSource", JSON.stringify(source));
  params.set("return", source.returnUrl);
}

export function queueSourceForItem(source: QueueSource, item: MediaItem): QueueSource {
  if (!item.path || (source.sort !== "opened" && source.section !== "recent")) return source;
  if (source.opened && Object.hasOwn(source.opened, item.path)) return source;
  return { ...source, opened: { ...source.opened, [item.path]: item.lastOpenedAt ?? 0 } };
}

export const isQueueMedia = (item: MediaItem) => Boolean(item.src && item.path && ["video", "image", "audio"].includes(item.kind));

export function compareQueueMedia(a: MediaItem, b: MediaItem, sort: string, direction: string) {
  const byName = () => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
  const comparison = sort === "name" ? byName()
    : sort === "size" ? (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0)
    : sort === "length" ? (a.duration ?? 0) - (b.duration ?? 0)
    : sort === "type" ? a.kind.localeCompare(b.kind) || byName()
    : sort === "opened" ? (a.lastOpenedAt ?? a.addedAt ?? 0) - (b.lastOpenedAt ?? b.addedAt ?? 0)
    : (a.addedAt ?? 0) - (b.addedAt ?? 0);
  return (comparison || byName() || (a.path ?? "").localeCompare(b.path ?? "")) * (direction === "asc" ? 1 : -1);
}

function rank(seed: string, path: string) {
  let hash = 2166136261;
  for (const char of `${seed}\0${path}`) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return hash >>> 0;
}

export function buildPlaybackQueue(items: MediaItem[], source: QueueSource): MediaItem[] {
  const unique = new Map(items.filter(isQueueMedia).map((item) => [item.path!, source.opened && Object.hasOwn(source.opened, item.path!)
    ? { ...item, lastOpenedAt: source.opened[item.path!] || undefined } : item]));
  let queue = [...unique.values()].filter((item) => {
    if (item.trashed) return false;
    if (source.section === "recent" && (!item.lastOpenedAt || item.lastOpenedAt > source.startedAt)) return false;
    if (source.section === "new" && (item.addedAt ?? 0) < source.startedAt - 86400) return false;
    if (source.section === "favorites" && !item.favorite) return false;
    if (source.section === "playlists" && !source.playlistPaths?.includes(item.path!)) return false;
    if (source.section === "library" && !source.globalSearch) {
      const recursive = source.tags.length > 0 || Boolean(source.search.trim());
      if (recursive ? source.folder && item.parent !== source.folder && !item.parent?.startsWith(`${source.folder}/`) : item.parent !== source.folder) return false;
    }
    return source.tags.every((tag) => tag === "Favorites" ? item.favorite : item.tags.includes(tag))
      && (!source.search.trim() || matchesSearchQuery(item, source.search));
  });
  const sort = source.section === "recent" ? "opened" : source.section === "new" ? "date" : source.sort;
  const direction = ["recent", "new"].includes(source.section) ? "desc" : source.direction;
  queue.sort((a, b) => compareQueueMedia(a, b, sort, direction));
  if (source.method === "shuffle") {
    const seed = source.seed ?? "";
    queue.sort((a, b) => rank(seed, a.path!) - rank(seed, b.path!) || a.path!.localeCompare(b.path!));
    const anchor = queue.findIndex((item) => item.path === source.anchor);
    if (anchor > 0) queue = [...queue.slice(anchor), ...queue.slice(0, anchor)];
  }
  return queue;
}

// Navigation is deliberately synchronous. Resolving the full source belongs
// to Watch and must never delay the first media request.
export function startPlaybackQueue(items: MediaItem[], source: QueueSource, navigate: (item: MediaItem, source: QueueSource) => void, random = Math.random) {
  if (!items.length) return;
  const first = items[source.method === "shuffle" ? Math.floor(random() * items.length) : 0];
  navigate(first, queueSourceForItem(source.method === "shuffle" ? { ...source, anchor: first.path } : source, first));
}

// A paged folder must sample the entire source, including unloaded pages.
// Fetch just the page at a random offset, then let Watch load the rest.
export async function startPagedShuffle(total: number, source: QueueSource, loadPage: (offset: number) => Promise<MediaItem[]>, navigate: (item: MediaItem, source: QueueSource) => void, random = Math.random) {
  const offset = Math.floor(random() * total);
  let items = (await loadPage(offset)).filter(isQueueMedia);
  if (!items.length && offset > 0) items = (await loadPage(0)).filter(isQueueMedia);
  if (!items.length) throw new Error("No playable media in this view");
  const first = items[0];
  navigate(first, queueSourceForItem({ ...source, anchor: first.path }, first));
}

export type QueueUserState = {
  favorites?: string[];
  tags?: Record<string, string[]>;
  last_accessed?: Record<string, number>;
  playback?: Record<string, { duration?: number; updated?: number }>;
  playback_preferences?: Partial<PlaybackPreferences>;
};

export function queueItemsWithState(items: MediaItem[], state: QueueUserState) {
  const favorites = new Set(state.favorites ?? []);
  return items.map((item) => ({ ...item,
    favorite: favorites.has(item.path!),
    tags: [...new Set([...item.tags, ...inheritedTags(item.path, state.tags ?? {})])],
    lastOpenedAt: Math.max(state.last_accessed?.[item.path!] ?? 0, state.playback?.[item.path!]?.updated ?? 0) || undefined,
    duration: item.duration || state.playback?.[item.path!]?.duration,
  }));
}

export function queueLibraryUrl(source: QueueSource) {
  const params = new URLSearchParams({ sort: source.sort, direction: source.direction, metadata: "false" });
  if (source.section === "library" && source.folder && !source.globalSearch && !source.search.trim() && !source.tags.length) {
    params.set("folder", source.folder);
    params.set("offset", "0");
    params.set("limit", "999999");
  }
  return `/api/library?${params}`;
}

export async function loadPlaybackQueue(source: QueueSource, fetcher: (url: string, init?: RequestInit) => Promise<Response>, signal?: AbortSignal, viewer?: { name: string; is_admin: boolean } | null) {
  const read = async (url: string) => {
    const response = await fetcher(url, { signal });
    if (!response.ok) throw new Error(`Queue unavailable (${response.status})`);
    return response.json();
  };
  const [entries, state, libraries] = await Promise.all([
    read(queueLibraryUrl(source)) as Promise<ApiLibraryEntry[]>,
    read("/api/user-state") as Promise<QueueUserState>,
    viewer && !viewer.is_admin ? read("/api/libraries") as Promise<Record<string, { members: { name: string; can_view: boolean }[] }>> : Promise.resolve(null),
  ]);
  const items = entries.map(apiEntryToMediaItem).filter((item): item is MediaItem => Boolean(item));
  const allowed = libraries && viewer ? items.filter((item) => libraries[(item.parent ?? item.name).split("/")[0]]?.members.some((member) => member.can_view && member.name.toLowerCase() === viewer.name.toLowerCase())) : items;
  return { queue: buildPlaybackQueue(queueItemsWithState(allowed, state), source), state };
}
