import { inheritedTags, type MediaItem, type ApiLibraryEntry } from "./media";
import type { PlaybackPreferences } from "./playback";

export const BROWSE_SNAPSHOT_KEY = "tms:browse-snapshot:v1";
const BROWSE_SCROLL_KEY = "tms:browse-scroll:v1";
export const BROWSE_SNAPSHOT_SKIP_FETCH_MS = 5 * 60 * 1000;
// sessionStorage is synchronous. Serializing a full recursive library here can
// monopolize the browser for minutes and even hold up an already-started
// navigation. Large libraries are already persisted in IndexedDB; keep their
// browse snapshot in memory for same-document restores and let a reload use the
// IndexedDB cache instead.
const MAX_SESSION_SNAPSHOT_ITEMS = 2_000;

export const shouldDeferLibraryRefetch = (snapshot: BrowseSnapshot | null): boolean => {
  if (!snapshot || snapshot.items.length === 0) return false;
  return Date.now() - snapshot.savedAt < BROWSE_SNAPSHOT_SKIP_FETCH_MS;
};

export type BrowseSnapshot = {
  url: string;
  folder: string | null;
  section: string;
  query: string;
  activeSearch: string;
  activeTags: string[];
  sort: string;
  sortDirection: string;
  libraryView: string;
  scrollY: number;
  items: MediaItem[];
  sidebarTreeEntries: Record<string, MediaItem[]>;
  trashItems?: MediaItem[];
  libraries: Record<string, any>;
  folderCovers: Record<string, string>;
  titleMetadata: Record<string, any>;
  playback: Record<string, { position: number; duration: number; updated: number; completed?: boolean }>;
  lastAccessed: Record<string, number>;
  customTags: Record<string, string[]>;
  tagCatalog: Record<string, any>;
  playlists: Record<string, any>;
  activePlaylistId: string | null;
  serverHasMore: boolean;
  serverLoadedCount: number;
  serverTotal?: number;
  clientVisibleLimit?: number;
  userId?: number;
  savedAt: number;
};

let inMemoryBrowseSnapshot: BrowseSnapshot | null = null;

export const saveBrowseSnapshot = (snapshot: Omit<BrowseSnapshot, "savedAt">) => {
  const fullSnapshot: BrowseSnapshot = { ...snapshot, savedAt: Date.now() };
  inMemoryBrowseSnapshot = fullSnapshot;
  if (typeof window === "undefined") return;
  if (fullSnapshot.items.length > MAX_SESSION_SNAPSHOT_ITEMS) {
    try {
      sessionStorage.removeItem(BROWSE_SNAPSHOT_KEY);
      sessionStorage.removeItem(BROWSE_SCROLL_KEY);
    } catch {
      // IndexedDB remains the durable large-library cache.
    }
    return;
  }
  try {
    sessionStorage.removeItem(BROWSE_SCROLL_KEY);
    sessionStorage.setItem(BROWSE_SNAPSHOT_KEY, JSON.stringify(fullSnapshot));
  } catch {
    // Session storage quota might be exceeded for massive libraries,
    // in-memory snapshot still preserves it for fast transitions.
    try {
      // Try saving without full trashItems or deep trees if quota is tight
      const compactSnapshot: BrowseSnapshot = {
        ...fullSnapshot,
        trashItems: [],
      };
      sessionStorage.setItem(BROWSE_SNAPSHOT_KEY, JSON.stringify(compactSnapshot));
    } catch {
      // Ignore quota errors
    }
  }
};

export const readBrowseSnapshot = (currentUrl?: string, userId?: number): BrowseSnapshot | null => {
  const isMatch = (snapshot: BrowseSnapshot | null): snapshot is BrowseSnapshot => {
    if (!snapshot) return false;
    // Expire snapshots older than 2 hours
    if (Date.now() - snapshot.savedAt > 2 * 60 * 60 * 1000) return false;
    if (userId !== undefined && snapshot.userId !== undefined && snapshot.userId !== userId) return false;
    if (currentUrl) {
      // If currentUrl is given, make sure it corresponds to the same folder / page
      const currentParams = new URLSearchParams(currentUrl.includes("?") ? currentUrl.slice(currentUrl.indexOf("?")) : "");
      const snapshotParams = new URLSearchParams(snapshot.url.includes("?") ? snapshot.url.slice(snapshot.url.indexOf("?")) : "");
      const currentFolder = currentParams.get("folder") ?? null;
      const snapshotFolder = snapshotParams.get("folder") ?? null;
      const currentSection = currentParams.get("section") ?? "library";
      const snapshotSection = snapshotParams.get("section") ?? "library";
      const currentQ = currentParams.get("q") ?? "";
      const snapshotQ = snapshotParams.get("q") ?? "";

      if (currentFolder !== snapshotFolder || currentSection !== snapshotSection || currentQ !== snapshotQ) {
        return false;
      }
    }
    return true;
  };

  if (isMatch(inMemoryBrowseSnapshot)) {
    return inMemoryBrowseSnapshot;
  }

  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(BROWSE_SNAPSHOT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as BrowseSnapshot;
    if (isMatch(parsed)) {
      const scroll = JSON.parse(sessionStorage.getItem(BROWSE_SCROLL_KEY) ?? "null");
      if (scroll?.savedAt === parsed.savedAt && scroll?.url === parsed.url && Number.isFinite(scroll.scrollY)) {
        parsed.scrollY = scroll.scrollY;
      }
      inMemoryBrowseSnapshot = parsed;
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
};

export const updateSnapshotOrganization = (
  path: string,
  state: {
    tags: Record<string, string[]>;
    tagCatalog: Record<string, any>;
    playlists: Record<string, any>;
  },
) => {
  const builtInTagsFor = (item: MediaItem) =>
    item.kind === "image" ? ["Photos"] : item.kind === "audio" ? ["Audio"] : item.kind === "video" ? ["Video"] : [];

  const apply = (snapshot: BrowseSnapshot) => {
    snapshot.customTags = state.tags;
    snapshot.tagCatalog = state.tagCatalog;
    snapshot.playlists = state.playlists;
    snapshot.items = snapshot.items.map((item) => {
      if (!item.path || (item.path !== path && !item.path.startsWith(`${path}/`))) return item;
      return {
        ...item,
        tags: [...new Set([...builtInTagsFor(item), ...inheritedTags(item.path, state.tags)])],
      };
    });
    return snapshot;
  };

  if (inMemoryBrowseSnapshot) {
    inMemoryBrowseSnapshot = apply({ ...inMemoryBrowseSnapshot });
  }

  if (typeof window === "undefined") return;
  try {
    const raw = sessionStorage.getItem(BROWSE_SNAPSHOT_KEY);
    if (!raw) return;
    const parsed = apply(JSON.parse(raw) as BrowseSnapshot);
    sessionStorage.setItem(BROWSE_SNAPSHOT_KEY, JSON.stringify(parsed));
  } catch {
  }
};

export const updateSnapshotPlayback = (
  path: string,
  playbackState: { position: number; duration: number; updated: number; completed?: boolean }
) => {
  if (inMemoryBrowseSnapshot) {
    inMemoryBrowseSnapshot.playback = {
      ...inMemoryBrowseSnapshot.playback,
      [path]: playbackState,
    };
    inMemoryBrowseSnapshot.lastAccessed = {
      ...inMemoryBrowseSnapshot.lastAccessed,
      [path]: playbackState.updated,
    };
    inMemoryBrowseSnapshot.items = inMemoryBrowseSnapshot.items.map((item) => {
      if (item.path === path) {
        return {
          ...item,
          lastOpenedAt: playbackState.updated,
          lastPlayed: new Date(playbackState.updated * 1000).toLocaleString(),
        };
      }
      return item;
    });
  }

  if (typeof window === "undefined") return;
  try {
    const raw = sessionStorage.getItem(BROWSE_SNAPSHOT_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as BrowseSnapshot;
    parsed.playback = {
      ...parsed.playback,
      [path]: playbackState,
    };
    parsed.lastAccessed = {
      ...parsed.lastAccessed,
      [path]: playbackState.updated,
    };
    parsed.items = parsed.items.map((item) => {
      if (item.path === path) {
        return {
          ...item,
          lastOpenedAt: playbackState.updated,
          lastPlayed: new Date(playbackState.updated * 1000).toLocaleString(),
        };
      }
      return item;
    });
    sessionStorage.setItem(BROWSE_SNAPSHOT_KEY, JSON.stringify(parsed));
  } catch {
    // Ignore storage errors
  }
};

export const clearBrowseSnapshot = () => {
  inMemoryBrowseSnapshot = null;
  if (typeof window === "undefined") return;
  try {
    sessionStorage.removeItem(BROWSE_SNAPSHOT_KEY);
    sessionStorage.removeItem(BROWSE_SCROLL_KEY);
  } catch {
    // Ignore storage errors
  }
};

export const updateSnapshotScroll = (scrollY: number) => {
  if (typeof window === "undefined") return;
  const touch = (snapshot: BrowseSnapshot) => {
    snapshot.scrollY = scrollY;
    inMemoryBrowseSnapshot = snapshot;
    try {
      sessionStorage.setItem(BROWSE_SCROLL_KEY, JSON.stringify({ url: snapshot.url, savedAt: snapshot.savedAt, scrollY }));
    } catch {
      // Ignore storage errors
    }
  };
  if (inMemoryBrowseSnapshot) {
    touch(inMemoryBrowseSnapshot);
    return;
  }
  try {
    const raw = sessionStorage.getItem(BROWSE_SNAPSHOT_KEY);
    if (!raw) return;
    touch(JSON.parse(raw) as BrowseSnapshot);
  } catch {
    // Ignore storage errors
  }
};

export const restoreBrowseScroll = (scrollY: number, onSettled?: () => void): (() => void) => {
  if (typeof window === "undefined" || scrollY <= 0) {
    onSettled?.();
    return () => {};
  }
  let cancelled = false;
  let rafId: number | null = null;
  let timers: number[] = [];
  let attempts = 0;
  const target = scrollY;

  const cleanup = () => {
    cancelled = true;
    if (rafId !== null) {
      window.cancelAnimationFrame(rafId);
      rafId = null;
    }
    timers.forEach((timer) => window.clearTimeout(timer));
    timers = [];
    removeUserListeners();
  };

  const finish = () => {
    if (cancelled) return;
    cleanup();
    onSettled?.();
  };

  const onUserInteraction = () => {
    // Abort scroll restoration immediately once the user starts interacting or scrolling manually.
    finish();
  };

  const userEvents: (keyof WindowEventMap)[] = ["wheel", "touchstart", "touchmove", "pointerdown", "keydown"];
  const removeUserListeners = () => {
    userEvents.forEach((ev) => window.removeEventListener(ev, onUserInteraction, true));
  };
  userEvents.forEach((ev) => window.addEventListener(ev, onUserInteraction, { passive: true, capture: true }));

  const apply = () => {
    if (cancelled) return;
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - window.innerHeight);
    const nextTop = Math.min(target, maxScroll);
    window.scrollTo(0, nextTop);
    const settled = Math.abs(window.scrollY - target) <= 2 || (maxScroll < target && Math.abs(window.scrollY - maxScroll) <= 2);
    const tallEnough = document.documentElement.scrollHeight >= target + window.innerHeight * 0.2;

    if (settled && tallEnough) {
      // Target reached and page height is sufficient; finish and release immediately.
      finish();
      return;
    }

    if (attempts < 60) {
      attempts += 1;
      rafId = window.requestAnimationFrame(apply);
    }
  };

  apply();

  if (!cancelled) {
    timers = [30, 80, 150, 300, 600, 1000].map((delay) =>
      window.setTimeout(() => {
        if (!cancelled) apply();
      }, delay)
    );
    timers.push(window.setTimeout(finish, 1200));
  }

  return cleanup;
};

export const readReturnBrowseSnapshot = (userId?: number): BrowseSnapshot | null => readBrowseSnapshot(undefined, userId);
