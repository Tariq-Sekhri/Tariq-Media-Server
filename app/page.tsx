"use client";

/* Dynamic media comes directly from the local server, so Next's image optimizer is not applicable. */
/* eslint-disable @next/next/no-img-element */

import { useBackLayer } from "./lib/back-layers";
import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type FormEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from "react";
import MobileNavigation from "./MobileNavigation";
import LibraryPlaybackSettings from "./LibraryPlaybackSettings";
import { playsAlongside } from "./lib/library-playback";
import { Capacitor } from "@capacitor/core";
import { API_BASE, ancestorTags, inheritedTags, resolveEpisodeMetadata, apiEntryToMediaItem, episodeNumbers, formatBytes, isMovieWatch, isShowWatch, mediaEvidenceForFolder, mediaUrl, previewFrameUrl, gridThumbUrl, seasonNumberForFolder, stableId, supportedFormats, titleCollectionForFolder, titleCollectionSortOrder, volumeFromSlider, volumeLabelFromSlider, sliderFromVolume, type ApiLibraryEntry, type MediaItem } from "./lib/media";
import { completeSearchToken, fuzzyMatches, matchesSearchQuery, parseSearchQuery, searchCompletionContext, searchFields } from "./lib/search";
import { buildSearchSuggestions, canSuggestLibraryPath, searchSuggestionItemPath, type SearchSuggestion, type SuggestionKind } from "./lib/search-suggestions";
import { browseTagFilters } from "./lib/browse-tag-filters";
import { queueSourceForItem, startPagedShuffle, startPlaybackQueue, writeQueueSource, type QueueSource } from "./lib/playback-queue";
import { authFetch, canAccessAdminPanel, clearSession, getSessionToken, getSessionUser, hasAdminPermission, isAbortError, logOut, reportClientError, reportClientPerformance } from "./lib/auth";
import { DEFAULT_PLAYBACK_PREFERENCES, normalizeImageSeconds, playbackPreferencesFromState, type PlaybackPreferences } from "./lib/playback";
import { clearBrowseSnapshot, readBrowseSnapshot, restoreBrowseScroll, saveBrowseSnapshot, shouldDeferLibraryRefetch, updateSnapshotScroll } from "./lib/browse-cache";
import { readCachedAspectRatio, readCachedThumbFrame, writeCachedAspectRatio, writeCachedThumbFrame } from "./lib/thumb-cache";
import { useViewportMedia } from "./lib/use-viewport-load";
import { reportImageResult } from "./lib/image-metrics";
import { applyVideoPreviewTime, ensureFrameAt, playPreviewFromStart, resetPreviewFrame, stopVideoPreview, waitForMetadata } from "./lib/video-preview";
import { mainNavigation } from "./lib/navigation";
import ImageDurationControl from "./ImageDurationControl";
import MagnetDownloader from "./MagnetDownloader";
import ServerDownloadDialog, { type YtDlpJob } from "./ServerDownloadDialog";
import TagInput from "./TagInput";
import { usePlaybackSession } from "./PlaybackProvider";
import { navigateApp } from "./lib/app-shell";
import { startPlaybackSession, playbackSessionSnapshot, setPlaybackSession } from "./lib/playback-session";
import { readLocalWatchProgress, savesWatchProgress } from "./lib/watch-progress";
import RichTextEditor from "./RichTextEditor";
import { authorizeOfflineSync, chooseOfflineLocation, clearPendingOfflineFavorite, clearPendingOfflineOrganization, hydratePendingOfflineChanges, listOfflineBundles, makeAvailableOffline, offlineLocation, openConfiguredTmsServer, openOfflineFile, pendingOfflineFavoriteOverrides, queueOfflineFavorite, queueOfflineOrganization, queueOfflinePlaylistCreate, queueOfflinePlaylistDelete, queueOfflineTagCreate, queueOfflineTagDelete, readOfflineUserState, readPendingOfflineChanges, reconcileOfflineBundle, removeOfflineBundle, resolveOfflineFileUrl, retryOfflineBundle, saveOfflineUserState, syncPendingOfflineOrganization, type OfflineBundle, type OfflineFile } from "./lib/offline";
import { applyPendingOrganization, emptyPendingChanges, isOfflinePlaylistId, type PendingOrganization } from "./lib/offline-organization";
import { buildOfflineAllMediaItems, buildOfflineBrowseItems, findOfflineBundleForFolder, offlineArtworkKey, offlineFolderFromLocation, offlineLocationFromFolder, offlinePlaybackKey } from "./lib/offline-browse";
import { addNativeHomeScreenShortcut } from "./lib/native-shortcuts";
import { cancelUploadSession, isIgnoredUploadFile, isUploadAbort, listUploadSessions, setUploadsActive, uploadFileResumably } from "./lib/uploads";
import Discover from "./discover/Discover";
import CachedArtworkImage from "./CachedArtworkImage";
import MenuIcon from "./MenuIcon";

type Section = "discover" | "library" | "recent" | "new" | "favorites" | "playlists" | "offline" | "trash" | "notes";
type SortField = "opened" | "date" | "name" | "size" | "length" | "type";
type SortDirection = "asc" | "desc";
type SidebarSort = "count" | "recent" | "name";
type CollectionSidebarSort = "count" | "opened" | "name";
const collectionOpenedStorageKey = (userId: number) => `tms_collection_last_opened:${userId}`;
const readCollectionLastOpened = (userId?: number): Record<string, number> => {
  if (typeof window === "undefined" || userId === undefined) return {};
  try {
    const stored: unknown = JSON.parse(window.localStorage.getItem(collectionOpenedStorageKey(userId)) ?? "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    return Object.fromEntries(Object.entries(stored).filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value > 0));
  } catch { return {}; }
};
type LibraryContentType = "mixed" | "movies_tv" | "music" | "files";
type BackgroundMagnetDownload = { hash: string; name: string; state: string; progress: number; download_speed: number; eta: number; completed?: number; total?: number; amount_left?: number; complete: boolean; stopped: boolean; speed_cap_enabled?: boolean | null };
type BackgroundMagnetStatus = { downloads?: BackgroundMagnetDownload[]; connected?: boolean; message?: string; qbittorrent_checked?: boolean };
type LibraryMember = { name: string; can_view: boolean; can_delete: boolean; can_move: boolean; can_create_folders: boolean; can_upload: boolean; can_download: boolean; can_rename: boolean };
type LibraryConfig = { content_type: LibraryContentType; members: LibraryMember[]; title_folders: string[]; folder_structure_static: boolean };
type BackendState = "loading" | "cached" | "online" | "offline";
type EpisodeMetadata = { id: string; name?: string; title?: string; season: number; episode: number; thumbnail?: string; released?: string };
type TrailerMetadata = { source?: string; type?: string; name?: string };
type TitleMetadata = { id: string; name: string; type: "movie" | "series"; releaseInfo?: string; imdbRating?: string; runtime?: string; genres?: string[]; description?: string; poster?: string; background?: string; trailers?: TrailerMetadata[]; videos?: EpisodeMetadata[] };
type TitleEvidence = ReturnType<typeof mediaEvidenceForFolder>;
type CatalogTitle = { path: string; title: string; evidence: TitleEvidence };
type PlaybackState = { position: number; duration: number; updated: number; completed?: boolean };
type Playlist = { id: string; name: string; paths: string[]; created_at: number; updated_at?: number };
type TagDefinition = { name: string; created_at: number; updated_at?: number };
type UserState = { favorites: string[]; playback: Record<string, PlaybackState>; last_accessed?: Record<string, number>; tags: Record<string, string[]>; tag_catalog?: Record<string, TagDefinition>; playlists: Record<string, Playlist>; playback_preferences?: PlaybackPreferences };
// "needs-file" rows come back from the server after a reload: the partial
// upload is safe there, but the browser needs the file selected again.
type UploadQueueStatus = "pending" | "uploading" | "paused" | "complete" | "error" | "needs-file";
type UploadQueueItem = { id: string; file: File | null; name: string; size: number; lastModified: number; parentPath: string; relativePath: string; status: UploadQueueStatus; progress: number; uploadedBytes: number; speed: number; sessionId?: string; error?: string };
const OFFLINE_RETURN_KEY = "tms-offline-return-location";
// Files upload two at a time, leaving browser connections free for browsing.
const UPLOAD_CONCURRENCY = 2;
type UploadCandidate = { file: File; relativePath?: string };
type WebkitEntry = { isFile: boolean; isDirectory: boolean; fullPath: string };
type WebkitFileEntry = WebkitEntry & { file: (success: (file: File) => void, failure?: () => void) => void };
type WebkitDirectoryEntry = WebkitEntry & { createReader: () => { readEntries: (success: (entries: WebkitEntry[]) => void, failure?: () => void) => void } };
type TrashEntry = { id: string; original_path: string; stored_name: string; name: string; kind: "file" | "folder"; size: number; deleted_at: number };
type DeviceSession = { token: string; created_at: number; device: string; user_agent: string; ip_address: string; current: boolean; expires_at: number };
type StorageQuota = { storage_quota_bytes: number | null; used_bytes: number; reserved_bytes: number; available_bytes: number | null; unlimited: boolean };
type SidebarContext = { kind: "playlists" | "tags"; x: number; y: number } | { kind: "playlist"; playlist: Playlist; x: number; y: number } | { kind: "tag"; tagName: string; x: number; y: number };
// The server path is authoritative. Rebuilding it from a display name can
// target a path that does not exist after a rename or cached metadata update.
const mediaPath = (item: MediaItem) => item.path ?? (item.kind === "folder" ? item.parent ? `${item.parent}/${item.name}` : item.name : undefined);
const rewritePathPrefix = (value: string, source: string, destination: string) => value === source ? destination : value.startsWith(`${source}/`) ? `${destination}${value.slice(source.length)}` : value;
type LibraryCache = {
  version: 13;
  userId: number;
  savedAt: number;
  entries: ApiLibraryEntry[];
  pages: Record<string, ApiLibraryEntry[]>;
  favoritePaths: string[];
  userState: UserState;
  libraries: Record<string, LibraryConfig>;
  folderCovers: Record<string, string>;
  titleMetadata: Record<string, TitleMetadata>;
};

const LIBRARY_PAGE_SIZE = 100;
const libraryConsumedCount = (response: Response, fetchedLength: number) => {
  const consumed = Number(response.headers.get("x-tms-consumed"));
  return Number.isFinite(consumed) && consumed > 0 ? consumed : fetchedLength;
};
const fileNameStem = (name: string) => {
  const extensionIndex = name.lastIndexOf(".");
  return extensionIndex > 0 ? name.slice(0, extensionIndex) : name;
};
const fileNameExtension = (name: string) => {
  const extensionIndex = name.lastIndexOf(".");
  return extensionIndex > 0 ? name.slice(extensionIndex) : "";
};
const openedTimestamp = (item: MediaItem, lastAccessed: Record<string, number>, playback: Record<string, PlaybackState>) => {
  // Recent is for items the user actually opened or played. Do not use the
  // added date as a fallback, or every new library item becomes "recent".
  if (!item.path) return undefined;
  const folderPrefix = item.kind === "folder" ? `${item.path}/` : null;
  // A title card represents the media underneath it. Opening Monarch's
  // episode must therefore update Monarch's Last opened position, even
  // though the episode—not the folder—is what is persisted in user state.
  const descendantAccessed = folderPrefix
    ? Object.entries(lastAccessed).reduce((latest, [path, timestamp]) => path.startsWith(folderPrefix) ? Math.max(latest, timestamp) : latest, 0)
    : 0;
  const descendantPlayed = folderPrefix
    ? Object.entries(playback).reduce((latest, [path, state]) => path.startsWith(folderPrefix) ? Math.max(latest, state.updated) : latest, 0)
    : 0;
  const timestamp = Math.max(lastAccessed[item.path] ?? 0, playback[item.path]?.updated ?? 0, descendantAccessed, descendantPlayed);
  return timestamp > 0 ? timestamp : undefined;
};
type OfflineUserState = Pick<UserState, "favorites" | "tags" | "tag_catalog" | "playlists"> & Record<string, unknown>;
const withOpenedMetadata = (item: MediaItem, lastAccessed: Record<string, number>, playback: Record<string, PlaybackState>, extras: Partial<MediaItem> = {}) => {
  const timestamp = openedTimestamp(item, lastAccessed, playback);
  return {
    ...item,
    ...extras,
    lastOpenedAt: timestamp,
    lastPlayed: timestamp ? new Date(timestamp * 1000).toLocaleString() : undefined,
  };
};
const indexSidebarTree = (entries: MediaItem[]): Record<string, MediaItem[]> => entries.reduce<Record<string, MediaItem[]>>((tree, item) => {
  const parent = item.parent ?? "";
  (tree[parent] ??= []).push(item);
  if (item.kind === "folder" && item.path) tree[item.path] ??= [];
  return tree;
}, {});
const libraryApiUrl = (sort: SortField, direction: SortDirection, folder?: string | null, offset = 0, limit?: number) => {
  const params = new URLSearchParams({ sort, direction });
  if (folder) {
    params.set("folder", folder);
    params.set("offset", String(offset));
    if (limit !== undefined) params.set("limit", String(limit));
  }
  return `${API_BASE}/api/library?${params}`;
};
const LIBRARY_CACHE_DB = "tms-client-cache";
const LIBRARY_CACHE_STORE = "library-cache-v13";
// IndexedDB only runs onupgradeneeded when this version increases. Bump it
// whenever the library cache moves to a new object store.
const LIBRARY_CACHE_DB_VERSION = 2;
const LEGACY_LIBRARY_CACHE_KEY = "framebox:library-cache:v6";
// Keep in-memory Fast Refresh state from pinning metadata selected by an older
// matching policy. Bump alongside a meaningful matcher change.
const TITLE_METADATA_MATCH_VERSION = 8;
const NEW_ITEMS_WINDOW_SECONDS = 24 * 60 * 60;
const titleMetadataKey = (path: string, kind: string) => `${path}::${kind}::v${TITLE_METADATA_MATCH_VERSION}`;
const PLAYBACK_QUEUE_KEY = "tms:playback-queue:v1";
const LEGACY_PLAYBACK_QUEUE_KEY = "framebox:playback-queue:v1";
const PLAYBACK_QUEUE_ORDER_KEY = "tms:playback-queue-order:v1";
const FAVORITES_FILTER = "Favorites";
const LIBRARY_BROWSE_PREFS_KEY = "tms_library_browse_prefs";
type LibraryView = "grid" | "list";
type LibraryServerBatch = {
  id: number;
  count: number;
  durationMs: number;
  imageCount: number;
  imagesLoaded: number;
  imagesFailed: number;
  imagesReadyMs?: number;
};

type LibraryDebugInfo = {
  cacheState?: "hit" | "miss";
  cacheLoadTimeMs?: number;
  serverLoadTimeMs?: number;
  totalWaitMs?: number;
  imageLoadTimeMs?: number;
  serverBatches?: LibraryServerBatch[];
  folder?: string | null;
};
type LibraryBrowsePreferences = { sort: SortField; sortDirection: SortDirection; tag: string; view: LibraryView };
type LibraryBrowsePreferenceStore = { version: 3; root: LibraryBrowsePreferences; folders: Record<string, LibraryBrowsePreferences> };
const DEFAULT_LIBRARY_BROWSE_PREFS: LibraryBrowsePreferences = { sort: "opened", sortDirection: "desc", tag: "All", view: "grid" };
const validSortField = (value: string | null | undefined): SortField | null =>
  value === "name" || value === "size" || value === "length" || value === "type" || value === "date" || value === "opened" ? value : null;
const normalizeLibraryBrowsePrefs = (prefs: Partial<LibraryBrowsePreferences> | null | undefined): LibraryBrowsePreferences => ({
  sort: validSortField(prefs?.sort) ?? DEFAULT_LIBRARY_BROWSE_PREFS.sort,
  sortDirection: prefs?.sortDirection === "asc" ? "asc" : "desc",
  tag: typeof prefs?.tag === "string" && prefs.tag ? prefs.tag : DEFAULT_LIBRARY_BROWSE_PREFS.tag,
  view: prefs?.view === "list" ? "list" : "grid",
});
const normalizeActiveTags = (values: string[]): string[] => {
  const raw = values.length > 1 ? values : (() => {
    const value = values[0] ?? "";
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [value];
    } catch {
      return [value];
    }
  })();
  return [...new Set(raw.filter((value): value is string => typeof value === "string" && value && value !== "All"))].slice(-1);
};
const readLibraryBrowsePreferenceStore = (): LibraryBrowsePreferenceStore => {
  if (typeof window === "undefined") return { version: 3, root: DEFAULT_LIBRARY_BROWSE_PREFS, folders: {} };
  try {
    const parsed = JSON.parse(window.localStorage.getItem(LIBRARY_BROWSE_PREFS_KEY) ?? "null") as Partial<LibraryBrowsePreferenceStore & LibraryBrowsePreferences> | null;
    if (parsed?.version === 3) return { version: 3, root: normalizeLibraryBrowsePrefs(parsed.root), folders: parsed.folders ?? {} };
    // Keep the previous global view as the root default, then remember each
    // library and folder independently from this point onward.
    const legacyView = window.localStorage.getItem("tms_library_view") === "list" ? "list" : "grid";
    if (parsed?.version === 2) return { version: 3, root: { ...normalizeLibraryBrowsePrefs(parsed.root), view: legacyView }, folders: parsed.folders ?? {} };
    return { version: 3, root: { ...normalizeLibraryBrowsePrefs(parsed), view: legacyView }, folders: {} };
  } catch {
    return { version: 3, root: DEFAULT_LIBRARY_BROWSE_PREFS, folders: {} };
  }
};
const SEASON_FOLDER = /^(season|series|s)\s*\d+$|^specials$/i;
const readLibraryBrowsePrefs = (folder?: string | null): LibraryBrowsePreferences => {
  const store = readLibraryBrowsePreferenceStore();
  // Do not leak a root filter into a folder that has never saved one.
  if (!folder) return store.root;
  const saved = store.folders[folder];
  // Seasons list episodes in order until the user picks another sort.
  if (!saved?.sort && SEASON_FOLDER.test(folder.split("/").pop() ?? "")) return normalizeLibraryBrowsePrefs({ ...saved, sort: "name", sortDirection: "asc" });
  return normalizeLibraryBrowsePrefs(saved);
};
const writeLibraryBrowsePrefs = (prefs: Partial<LibraryBrowsePreferences>, folder?: string | null) => {
  if (typeof window === "undefined") return;
  try {
    const store = readLibraryBrowsePreferenceStore();
    if (folder) store.folders[folder] = { ...readLibraryBrowsePrefs(folder), ...prefs };
    else store.root = { ...store.root, ...prefs };
    window.localStorage.setItem(LIBRARY_BROWSE_PREFS_KEY, JSON.stringify(store));
  } catch {}
};
const defaultLibraryConfig = (): LibraryConfig => ({ content_type: "mixed", members: [{ name: "Tariq", can_view: true, can_delete: true, can_move: true, can_create_folders: true, can_upload: true, can_download: true, can_rename: true }], title_folders: [], folder_structure_static: false });
const libraryTypeLabel = (contentType: LibraryContentType) => ({ mixed: "Mixed media", movies_tv: "Movies & TV shows", music: "Music", files: "Any files" })[contentType];
const formatMediaDuration = (seconds?: number) => {
  if (!seconds || !Number.isFinite(seconds)) return "";
  const total = Math.max(0, Math.round(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours ? `${hours}h ${String(minutes).padStart(2, "0")}m` : minutes ? `${minutes}m ${String(remainder).padStart(2, "0")}s` : `${remainder}s`;
};
const formatListDuration = (seconds?: number) => {
  if (!seconds || !Number.isFinite(seconds)) return "";
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
};
const movieFinishTime = (runtime?: string) => {
  if (!runtime) return "";
  const hours = Number(runtime.match(/(\d+)\s*h/i)?.[1] ?? 0);
  const minutes = Number(runtime.match(/(\d+)\s*m(?:in)?/i)?.[1] ?? 0);
  const totalMinutes = hours * 60 + minutes;
  if (!totalMinutes) return "";
  const finish = new Date(Date.now() + totalMinutes * 60_000);
  return `Finishes at ${finish.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
};
const formatJobStoppedTime = (timestamp?: number) => {
  if (!timestamp) return "";
  const date = new Date(timestamp * 1000);
  if (Number.isNaN(date.getTime())) return "";
  const isToday = new Date().toDateString() === date.toDateString();
  return isToday
    ? date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : date.toLocaleDateString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
};
const trailerYoutubeId = (metadata?: TitleMetadata) => {
  const source = metadata?.trailers?.find((trailer) => trailer.type?.toLowerCase().includes("trailer"))?.source
    ?? metadata?.trailers?.[0]?.source;
  if (!source) return null;
  const match = source.match(/(?:v=|youtu\.be\/|youtube:|yt:)?([A-Za-z0-9_-]{11})$/);
  return match?.[1] ?? null;
};
const formatUploadSize = (bytes: number) => bytes <= 0
  ? "0 B"
  : bytes >= 1024 ** 4
    ? `${(bytes / 1024 ** 4).toFixed(2)} TB`
  : bytes >= 1024 * 1024 * 1024
    ? `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  : bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(bytes >= 10 * 1024 * 1024 ? 0 : 1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
const formatUploadRate = (bytesPerSecond: number) => bytesPerSecond > 0 ? `${formatUploadSize(bytesPerSecond)}/s` : "Calculating";
const magnetRateLabel = (bytesPerSecond: number) => bytesPerSecond > 0 ? `${(bytesPerSecond / 1024 / 1024).toFixed(1)} MB/s` : "Connecting";
const magnetEtaLabel = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds >= 8_640_000) return "Calculating";
  const minutes = Math.ceil(seconds / 60);
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m left` : `${minutes}m left`;
};
// More than this many active downloads collapse into one combined card.
const MAGNET_GROUP_AFTER = 2;
const magnetIsPaused = (download: BackgroundMagnetDownload) => /paused|stopped/i.test(download.state);
// The shared start of the release names ("Avatar Seven Havens"), cut at a word
// boundary so a partial episode tag like "S01E0" is not shown.
const magnetGroupTitle = (downloads: BackgroundMagnetDownload[]) => {
  const names = downloads.map((download) => download.name);
  let prefix = names[0] ?? "";
  for (const name of names.slice(1)) {
    let length = 0;
    while (length < prefix.length && length < name.length && prefix[length].toLowerCase() === name[length].toLowerCase()) length += 1;
    prefix = prefix.slice(0, length);
  }
  if (!names.every((name) => name.length === prefix.length)) prefix = prefix.replace(/[^\s._-]*$/, "");
  const title = prefix.replace(/[._]+/g, " ").replace(/[\s-]+$/, "").trim();
  return title.length >= 3 ? title : "";
};
const magnetGroupSummary = (downloads: BackgroundMagnetDownload[]) => {
  const sized = downloads.every((download) => (download.total ?? 0) > 0);
  const total = downloads.reduce((sum, download) => sum + (download.total ?? 0), 0);
  const progress = sized && total > 0
    ? downloads.reduce((sum, download) => sum + Math.min(download.total ?? 0, download.completed ?? 0), 0) / total
    : downloads.reduce((sum, download) => sum + Math.max(0, Math.min(1, download.progress)), 0) / Math.max(1, downloads.length);
  const running = downloads.filter((download) => !magnetIsPaused(download));
  const speed = running.reduce((sum, download) => sum + download.download_speed, 0);
  // Downloads share one connection, so the whole batch finishes when its
  // remaining bytes drain at the combined speed, or when the slowest one does.
  const remaining = running.reduce((sum, download) => sum + (download.amount_left ?? 0), 0);
  const etas = running.map((download) => download.eta).filter((eta) => eta > 0 && eta < 8_640_000);
  const eta = speed > 0 && remaining > 0 ? Math.max(remaining / speed, ...etas) : etas.length ? Math.max(...etas) : 0;
  return { progress, speed, eta, paused: downloads.length - running.length };
};

const readDirectoryEntries = async (reader: ReturnType<WebkitDirectoryEntry["createReader"]>) => {
  const entries: WebkitEntry[] = [];
  while (true) {
    const batch = await new Promise<WebkitEntry[]>((resolve) => reader.readEntries(resolve, () => resolve([])));
    if (!batch.length) return entries;
    entries.push(...batch);
  }
};

const collectDroppedEntryFiles = async (entry: WebkitEntry): Promise<UploadCandidate[]> => {
  if (entry.isFile) {
    return new Promise((resolve) => (entry as WebkitFileEntry).file(
      (file) => resolve([{ file, relativePath: entry.fullPath.replace(/^\/+/, "") || file.name }]),
      () => resolve([]),
    ));
  }
  if (!entry.isDirectory) return [];
  const entries = await readDirectoryEntries((entry as WebkitDirectoryEntry).createReader());
  return (await Promise.all(entries.map(collectDroppedEntryFiles))).flat();
};

const collectDroppedUploadFiles = async (dataTransfer: DataTransfer): Promise<UploadCandidate[]> => {
  const entries = Array.from(dataTransfer.items)
    .map((item) => (item as DataTransferItem & { webkitGetAsEntry?: () => WebkitEntry | null }).webkitGetAsEntry?.())
    .filter((entry): entry is WebkitEntry => entry !== null && entry !== undefined);
  if (!entries.length) return Array.from(dataTransfer.files).map((file) => ({ file }));
  return (await Promise.all(entries.map(collectDroppedEntryFiles))).flat();
};

const libraryCachePageKey = (folder: string | null, sort: SortField, direction: SortDirection) => `${folder ?? "root"}\u0000${sort}\u0000${direction}`;
const cachedFolderFromRoot = (cache: LibraryCache, folder: string | null): ApiLibraryEntry[] | null => {
  if (!cache.entries.length) return null;
  if (!folder) return cache.entries;
  const prefix = `${folder}/`;
  const children = cache.entries.filter((entry) => entry.path.startsWith(prefix) && !entry.path.slice(prefix.length).includes("/"));
  // Root scans do not follow external library junctions, so an absent folder
  // must still be loaded from the server rather than shown as an empty hit.
  return children.length ? children : null;
};
const emptyUserState = (): UserState => ({ favorites: [], playback: {}, tags: {}, tag_catalog: {}, playlists: {} });

let libraryCacheDbPromise: Promise<IDBDatabase> | null = null;
const openLibraryCacheDb = () => {
  if (libraryCacheDbPromise) return libraryCacheDbPromise;
  libraryCacheDbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(LIBRARY_CACHE_DB, LIBRARY_CACHE_DB_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(LIBRARY_CACHE_STORE)) {
        request.result.createObjectStore(LIBRARY_CACHE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return libraryCacheDbPromise;
};

let activeCacheReadPromise: Promise<LibraryCache | null> | null = null;

const readLibraryCache = async (userId: number | undefined): Promise<LibraryCache | null> => {
  if (userId === undefined) return null;
  if (activeCacheReadPromise) return activeCacheReadPromise;

  activeCacheReadPromise = (async () => {
    try {
      const database = await openLibraryCacheDb();
      const parsed = await new Promise<LibraryCache | null>((resolve, reject) => {
        const request = database.transaction(LIBRARY_CACHE_STORE, "readonly").objectStore(LIBRARY_CACHE_STORE).get(userId);
        request.onsuccess = () => resolve((request.result as LibraryCache | undefined) ?? null);
        request.onerror = () => reject(request.error);
      });
      if (!parsed) {
        console.log(`[Cache DB] readLibraryCache found no record for user ${userId}`);
        return null;
      }
      const isValid = parsed.version === 13 && parsed.userId === userId && Array.isArray(parsed.entries) && Array.isArray(parsed.favoritePaths) && parsed.pages && parsed.userState;
      if (!isValid) {
        console.warn(`[Cache DB] readLibraryCache found INVALID record for user ${userId}. version=${parsed.version}, expected 13. keys=${Object.keys(parsed)}`);
        return null;
      }
      console.log(`[Cache DB] Successfully read cache for user ${userId}. pages keys: ${Object.keys(parsed.pages).length}`);
      return parsed;
    } catch (err) {
      console.error(`[Cache DB] Failed to read cache for user ${userId}:`, err);
      return null;
    } finally {
      activeCacheReadPromise = null;
    }
  })();

  return activeCacheReadPromise;
};

let writeLibraryCacheTimeout: ReturnType<typeof setTimeout> | null = null;
const writeLibraryCache = (cache: LibraryCache, immediate = false) => {
  if (writeLibraryCacheTimeout) clearTimeout(writeLibraryCacheTimeout);
  const persist = async () => {
    try {
      const database = await openLibraryCacheDb();
      await new Promise<void>((resolve, reject) => {
        const transaction = database.transaction(LIBRARY_CACHE_STORE, "readwrite");
        transaction.objectStore(LIBRARY_CACHE_STORE).put(cache, cache.userId);
        transaction.oncomplete = () => {
          console.log(`[Cache DB] Successfully wrote cache to IndexedDB for user ${cache.userId}`);
          resolve();
        };
        transaction.onerror = () => {
          console.error(`[Cache DB] Error writing cache to IndexedDB:`, transaction.error);
          reject(transaction.error);
        };
        transaction.onabort = () => {
          console.error(`[Cache DB] Aborted writing cache to IndexedDB:`, transaction.error);
          reject(transaction.error);
        };
      });
      localStorage.removeItem(LEGACY_LIBRARY_CACHE_KEY);
    } catch (err) {
      console.error(`[Cache DB] Failed to write cache to IndexedDB:`, err);
    }
  };
  // A folder click navigates to a new document. Persist server pages before
  // that navigation can discard a delayed write; debounce metadata updates.
  if (immediate) return persist();
  writeLibraryCacheTimeout = setTimeout(() => { void persist(); }, 1000);
};

const storedPlaybackQueue = (items: MediaItem[]) => JSON.stringify({
  paths: items.flatMap((item) => item.path ? [item.path] : []),
  offlineEntries: items.flatMap((item) => {
    if (!item.offline?.bundleId || !item.offline.fileId || !item.path) return [];
    return [{
      path: item.path,
      bundleId: item.offline.bundleId,
      fileId: item.offline.fileId,
      name: item.name,
      size: item.size,
      kind: item.kind,
      parent: item.parent,
    }];
  }),
  createdAt: Date.now(),
});

const shuffleMedia = (items: MediaItem[]) => {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
};

function CatalogBadgeIcon({ kind }: { kind: "movie" | "series" }) {
  if (kind === "series") {
    return (
      <svg className="catalog-badge-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="8.5" y="10.5" width="12" height="8.5" rx="1.4" fill="currentColor" opacity="0.3" />
        <rect x="7" y="9" width="12" height="8.5" rx="1.4" fill="currentColor" opacity="0.52" />
        <rect x="5.5" y="7.5" width="12" height="8.5" rx="1.4" fill="currentColor" opacity="0.74" />
        <rect x="4" y="6" width="12" height="8.5" rx="1.4" fill="currentColor" />
        <path className="catalog-badge-icon-play" d="M9.1 9.2v5.6l4.2-2.8z" />
      </svg>
    );
  }

  return (
    <svg className="catalog-badge-icon catalog-badge-icon-movie" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="11" r="7.6" fill="none" stroke="currentColor" strokeWidth="1.55" />
      <circle cx="12" cy="11" r="0.95" fill="currentColor" />
      <circle cx="12" cy="5.75" r="1.65" fill="none" stroke="currentColor" strokeWidth="1.55" />
      <circle cx="12" cy="16.25" r="1.65" fill="none" stroke="currentColor" strokeWidth="1.55" />
      <circle cx="6.75" cy="11" r="1.65" fill="none" stroke="currentColor" strokeWidth="1.55" />
      <circle cx="17.25" cy="11" r="1.65" fill="none" stroke="currentColor" strokeWidth="1.55" />
      <circle cx="8.95" cy="7.95" r="0.55" fill="currentColor" />
      <circle cx="15.05" cy="7.95" r="0.55" fill="currentColor" />
      <circle cx="8.95" cy="14.05" r="0.55" fill="currentColor" />
      <circle cx="15.05" cy="14.05" r="0.55" fill="currentColor" />
      <path d="M19.6 18.6h3.6" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" />
    </svg>
  );
}

function VideoPreviewThumb({ src, className, videoPath, onRatio }: { src: string; className?: string; videoPath?: string; onRatio?: (ratio: number) => void }) {
  const { ref, shouldLoad } = useViewportMedia<HTMLDivElement>();
  const videoRef = useRef<HTMLVideoElement>(null);
  const onRatioRef = useRef(onRatio);
  onRatioRef.current = onRatio;
  const previewTimeRef = useRef(0);
  const [frameSrc, setFrameSrc] = useState(() => (videoPath ? readCachedThumbFrame(videoPath) : null) ?? "");
  const [videoReady, setVideoReady] = useState(() => Boolean(videoPath && readCachedThumbFrame(videoPath)));

  useEffect(() => {
    if (!shouldLoad || !videoPath || frameSrc) return;
    const cached = readCachedThumbFrame(videoPath);
    if (cached) {
      setFrameSrc(cached);
      setVideoReady(true);
      return;
    }
    let cancelled = false;
    const url = gridThumbUrl(videoPath);
    const img = new Image();
    const startedAt = performance.now();
    img.onload = () => {
      reportImageResult(img, "loaded", startedAt, "invisible-preload");
      if (cancelled) return;
      if (img.naturalWidth && img.naturalHeight) {
        writeCachedAspectRatio(videoPath, img.naturalWidth / img.naturalHeight);
        onRatioRef.current?.(img.naturalWidth / img.naturalHeight);
      }
      writeCachedThumbFrame(videoPath, url);
      setFrameSrc(url);
      setVideoReady(true);
    };
    img.onerror = () => {
      reportImageResult(img, "failed", startedAt, "invisible-preload");
      if (!cancelled) setFrameSrc("");
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [shouldLoad, videoPath, frameSrc, onRatio]);

  useEffect(() => {
    if (!shouldLoad || frameSrc) return;
    previewTimeRef.current = 0;
    const video = videoRef.current;
    if (!video) return;
    let cancelled = false;
    const prepare = async () => {
      try {
        await waitForMetadata(video);
        if (cancelled) return;
        const { videoWidth, videoHeight } = video;
        if (videoWidth && videoHeight) {
          if (videoPath) writeCachedAspectRatio(videoPath, videoWidth / videoHeight);
          onRatioRef.current?.(videoWidth / videoHeight);
        }
        setVideoReady(true);
        await ensureFrameAt(video, 0, () => cancelled);
        if (cancelled) return;
        previewTimeRef.current = await applyVideoPreviewTime(video, () => cancelled);
      } catch (error) {
        if (cancelled || isAbortError(error)) return;
        previewTimeRef.current = 0;
        setVideoReady(true);
      }
    };
    void prepare();
    return () => {
      cancelled = true;
      stopVideoPreview(video);
    };
  }, [shouldLoad, src, frameSrc, videoPath]);

  const showMedia = shouldLoad || Boolean(frameSrc) || videoReady;

  return <div ref={ref} className={`viewport-media-slot${showMedia && (frameSrc || videoReady) ? " ready" : ""}`}>
    {showMedia && frameSrc ? (
      <img className={className} src={frameSrc} alt="" decoding="async" fetchPriority="high" />
    ) : null}
    {showMedia && !frameSrc ? <video
      ref={videoRef}
      className={className}
      src={src}
      muted
      playsInline
      preload="metadata"
      style={videoReady ? undefined : { opacity: 0 }}
    /> : null}
  </div>;
}

function CatalogArtwork({ src, name, initial, metadataPending }: { src?: string; name: string; initial: string; metadataPending: boolean }) {
  const [imageResult, setImageResult] = useState<{ src: string; failed: boolean } | null>(null);
  const imageSettled = Boolean(src && imageResult?.src === src);
  const imageFailed = imageSettled && imageResult?.failed;
  const loading = metadataPending || Boolean(src && !imageSettled);

  return <>
    {src && !imageFailed ? <CachedArtworkImage
      key={src}
      className="catalog-poster-image"
      src={src}
      alt={`${name} cover`}
      loading="lazy"
      style={!imageSettled ? { opacity: 0 } : undefined}
      onLoad={() => setImageResult({ src, failed: false })}
      onError={() => setImageResult({ src, failed: true })}
    /> : null}
    {!loading && (!src || imageFailed) ? <div className="folder-shape"><span>{initial}</span></div> : null}
    {loading ? <div className={`catalog-artwork-loading${imageSettled && !imageFailed ? " with-artwork" : ""}`} role="status" aria-label={`Loading ${name}`}>
      <span className="library-loading-spinner" aria-hidden="true" />
      <span>{metadataPending ? "Loading details…" : "Loading artwork…"}</span>
    </div> : null}
  </>;
}

function ViewportImageThumb({ src, path, onRatio }: { src: string; path?: string; onRatio?: (ratio: number) => void }) {
  const { ref, shouldLoad } = useViewportMedia<HTMLDivElement>();
  const ready = (shouldLoad || Boolean(path && readCachedAspectRatio(path))) && Boolean(src);

  return <div ref={ref} className={`viewport-video-preview ${ready ? "ready" : ""}`}>
    <span className="preview-skeleton" />
    {shouldLoad && src ? (
      <img
        className="thumb-video"
        src={src}
        alt=""
        decoding="async"
        fetchPriority="high"
        onLoad={(event) => {
          const img = event.currentTarget;
          reportImageResult(img, "loaded");
          if (img.naturalWidth && img.naturalHeight) {
            const ratio = img.naturalWidth / img.naturalHeight;
            if (path) writeCachedAspectRatio(path, ratio);
            onRatio?.(ratio);
          }
        }}
        onError={(event) => reportImageResult(event.currentTarget, "failed")}
      />
    ) : null}
  </div>;
}

function ViewportVideoPreview({ item, onRatio, onDuration, onPreviewResult }: { item: MediaItem; onRatio: (ratio: number) => void; onDuration: (duration: number) => void; onPreviewResult?: (outcome: "loaded" | "failed") => void }) {
  const { ref: containerRef, shouldLoad } = useViewportMedia<HTMLDivElement>();
  const videoRef = useRef<HTMLVideoElement>(null);
  const onRatioRef = useRef(onRatio);
  const onDurationRef = useRef(onDuration);
  const onPreviewResultRef = useRef(onPreviewResult);
  onRatioRef.current = onRatio;
  onDurationRef.current = onDuration;
  onPreviewResultRef.current = onPreviewResult;
  const previewTimeRef = useRef(0);
  const hoveringRef = useRef(false);
  const [hovering, setHovering] = useState(false);
  const [frameSrc, setFrameSrc] = useState(() => (item.path ? readCachedThumbFrame(item.path) : null) ?? "");
  const [videoReady, setVideoReady] = useState(() => Boolean(item.path && readCachedThumbFrame(item.path)));
  const ready = Boolean(frameSrc || videoReady);

  useEffect(() => {
    if (!shouldLoad || !item.path || frameSrc) return;
    const cached = readCachedThumbFrame(item.path);
    if (cached) {
      setFrameSrc(cached);
      setVideoReady(true);
      return;
    }
    let cancelled = false;
    const url = gridThumbUrl(item.path);
    const img = new Image();
    const startedAt = performance.now();
    img.onload = () => {
      reportImageResult(img, "loaded", startedAt, "invisible-preload");
      onPreviewResultRef.current?.("loaded");
      if (cancelled) return;
      if (img.naturalWidth && img.naturalHeight) {
        writeCachedAspectRatio(item.path!, img.naturalWidth / img.naturalHeight);
        onRatioRef.current(img.naturalWidth / img.naturalHeight);
      }
      writeCachedThumbFrame(item.path!, url);
      setFrameSrc(url);
      setVideoReady(true);
    };
    img.onerror = () => {
      reportImageResult(img, "failed", startedAt, "invisible-preload");
      // A missing grid JPEG is not a failed card: the visible video fallback
      // below takes over and reports once it has real media metadata.
      if (!cancelled) setFrameSrc("");
    };
    img.src = url;
    return () => {
      cancelled = true;
    };
  }, [shouldLoad, item.path, frameSrc]);

  useEffect(() => {
    if (!shouldLoad || !item.src || frameSrc) return;
    let cancelled = false;
    let video = videoRef.current;
    previewTimeRef.current = 0;
    const stop = () => cancelled || hoveringRef.current;
    const prepare = async (element: HTMLVideoElement) => {
      try {
        await waitForMetadata(element);
        if (cancelled) return;
        const { videoWidth, videoHeight, duration } = element;
        if (videoWidth && videoHeight) {
          if (item.path) writeCachedAspectRatio(item.path, videoWidth / videoHeight);
          onRatioRef.current(videoWidth / videoHeight);
        }
        if (Number.isFinite(duration)) onDurationRef.current(duration);
        setVideoReady(true);
        onPreviewResultRef.current?.("loaded");
        await ensureFrameAt(element, 0, stop);
        if (cancelled) return;
        previewTimeRef.current = await applyVideoPreviewTime(element, stop);
      } catch (error) {
        if (cancelled || isAbortError(error)) return;
        previewTimeRef.current = 0;
        setVideoReady(true);
        onPreviewResultRef.current?.("failed");
      }
    };
    const start = () => {
      video = videoRef.current;
      if (!video) {
        if (!cancelled) window.requestAnimationFrame(start);
        return;
      }
      void prepare(video);
    };
    start();
    return () => {
      cancelled = true;
      if (video) stopVideoPreview(video);
    };
  }, [shouldLoad, item.path, item.src, frameSrc]);

  const showMedia = shouldLoad || ready;

  return <div
    ref={containerRef}
    className={`viewport-video-preview ${ready ? "ready" : ""}`}
    onMouseEnter={() => {
      if (!showMedia) return;
      hoveringRef.current = true;
      setHovering(true);
      const video = videoRef.current;
      if (video) playPreviewFromStart(video);
    }}
    onMouseLeave={() => {
      hoveringRef.current = false;
      setHovering(false);
      const video = videoRef.current;
      if (video) resetPreviewFrame(video, previewTimeRef.current);
    }}
  >
    <span className="preview-skeleton" />
    {showMedia && frameSrc && !hovering ? (
      <img className="thumb-video" src={frameSrc} alt="" decoding="async" fetchPriority="high" />
    ) : null}
    {showMedia && item.src && (hovering || !frameSrc) ? <video
      ref={videoRef}
      className="thumb-video"
      src={item.src}
      muted
      loop
      playsInline
      preload="metadata"
      style={{ opacity: frameSrc && !hovering ? 0 : videoReady ? 1 : 0 }}
    /> : null}
  </div>;
}

function EpisodeVideoPreview({ item, episode, onRatio, onDuration, onPreviewResult }: { item: MediaItem; episode?: EpisodeMetadata; onRatio: (ratio: number) => void; onDuration: (duration: number) => void; onPreviewResult?: (outcome: "loaded" | "failed") => void }) {
  const { ref, shouldLoad } = useViewportMedia<HTMLDivElement>();
  const [imageFailed, setImageFailed] = useState(false);
  const cachedRatio = item.path ? readCachedAspectRatio(item.path) : null;
  if (!episode?.thumbnail || imageFailed) {
    return <ViewportVideoPreview item={item} onRatio={onRatio} onDuration={onDuration} onPreviewResult={onPreviewResult} />;
  }
  return <div ref={ref} className={`viewport-video-preview ${shouldLoad || cachedRatio ? "ready" : ""}`}>
    <span className="preview-skeleton" />
    {shouldLoad ? <>
      <img
        className="thumb-video episode-thumbnail"
        src={episode.thumbnail}
        alt={episode.name ?? episode.title ? `${episode.name ?? episode.title} episode image` : `Season ${episode.season}, episode ${episode.episode}`}
        decoding="async"
        fetchPriority="high"
        onLoad={(event) => {
          const img = event.currentTarget;
          reportImageResult(img, "loaded");
          onPreviewResult?.("loaded");
          if (img.naturalWidth && img.naturalHeight) {
            const ratio = img.naturalWidth / img.naturalHeight;
            if (item.path) writeCachedAspectRatio(item.path, ratio);
            onRatio(ratio);
          }
        }}
        onError={(event) => { reportImageResult(event.currentTarget, "failed"); setImageFailed(true); }}
      />
      <VideoDurationProbe item={item} onRatio={onRatio} onDuration={onDuration} shouldLoad={shouldLoad} />
    </> : null}
  </div>;
}

function VideoDurationProbe({ item, onRatio, onDuration, shouldLoad = true }: { item: MediaItem; onRatio: (ratio: number) => void; onDuration: (duration: number) => void; shouldLoad?: boolean }) {
  if (!shouldLoad) return null;
  return <div className="duration-probe" aria-hidden="true"><video src={item.src} preload="metadata" onLoadedMetadata={(event) => { const { duration, videoWidth, videoHeight } = event.currentTarget; if (Number.isFinite(duration)) onDuration(duration); if (videoWidth && videoHeight) { if (item.path) writeCachedAspectRatio(item.path, videoWidth / videoHeight); onRatio(videoWidth / videoHeight); } }} /></div>;
}

const formatAudioTime = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const rounded = Math.floor(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, "0")}`;
};

const AUDIO_WAVEFORM = Array.from({ length: 42 }).map((_, i) => {
  const norm = (i / 41) * Math.PI;
  const window = Math.sin(norm);
  const noise = Math.sin(i * 2.1) * Math.cos(i * 1.3);
  return Math.max(8, (Math.abs(noise) * 45 + 15) * window);
});

const audioWaveformFor = (name: string) => {
  let seed = 0;
  for (let i = 0; i < name.length; i += 1) seed = (seed * 31 + name.charCodeAt(i)) | 0;
  return AUDIO_WAVEFORM.map((height, index) => {
    const variation = 0.72 + (Math.abs(Math.sin(seed * 0.017 + index * 1.71)) * 0.56);
    return Math.max(7, Math.round(height * variation));
  });
};

function PreviewAudioPlayer({ src, name }: { src: string; name: string }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(1);
  const seek = (time: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    const nextTime = Math.max(0, Math.min(duration || audio.duration || 0, time));
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
  };
  const togglePlayback = () => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play(); else audio.pause();
  };
  return <div className="preview-audio-player">
    <audio ref={audioRef} className="preview-audio-source" src={src} preload="metadata" autoPlay onLoadedMetadata={(event) => setDuration(event.currentTarget.duration)} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => { setPlaying(false); setCurrentTime(0); }} />
    <div className="preview-audio-title"><span aria-hidden="true">♫</span><div><b>{name}</b><small>Audio player</small></div></div>
    <div className="preview-audio-controls">
      <button type="button" onClick={() => seek(currentTime - 5)} aria-label="Skip back 5 seconds" title="Back 5 seconds">-5</button>
      <button type="button" className="preview-audio-play" onClick={togglePlayback} aria-label={playing ? "Pause" : "Play"}>{playing ? "Pause" : "Play"}</button>
      <button type="button" onClick={() => seek(currentTime + 5)} aria-label="Skip forward 5 seconds" title="Forward 5 seconds">+5</button>
      <span>{formatAudioTime(currentTime)} / {formatAudioTime(duration)}</span>
    </div>
    <input className="preview-audio-seek" aria-label="Playback position" type="range" min="0" max={duration || 0} step="0.1" value={Math.min(currentTime, duration || 0)} onChange={(event) => seek(Number(event.target.value))} />
    <div className="preview-audio-volume"><span aria-hidden="true">{volume === 0 ? "Muted" : `Volume ${volumeLabelFromSlider(volume)}`}</span><input aria-label="Volume" aria-valuetext={volumeLabelFromSlider(volume)} type="range" min="0" max="1" step="0.01" value={volume} onChange={(event) => { const nextPosition = Number(event.target.value); setVolume(nextPosition); if (audioRef.current) audioRef.current.volume = volumeFromSlider(nextPosition); }} /></div>
  </div>;
}

type MixedMediaListRowProps = {
  folderDescription?: string;
  episodeThumbnail?: string;
  playbackProgress?: number;
  watched?: boolean;
  item: MediaItem;
  displayName: string;
  openedLabel?: string;
  displayTags: string[];
  itemPath: string;
  isLibrary: boolean;
  coverImage?: string;
  folderItemCount: number;
  durationLabel: string;
  dragTarget: boolean;
  canMove: boolean;
  selectionMode?: boolean;
  selected?: boolean;
  canSelect?: boolean;
  onToggleSelect?: () => void;
  onEnterSelection?: () => void;
  onOpen: () => void;
  onFavorite: () => void;
  onMenu: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  onDragStart: (event: DragEvent<HTMLElement>) => void;
  onDragEnd: () => void;
  onDragOver?: (event: DragEvent<HTMLElement>) => void;
  onDragLeave?: () => void;
  onDrop?: (event: DragEvent<HTMLElement>) => void;
  menuOpen: boolean;
  nowPlaying?: boolean;
  nowPlayingActive?: boolean;
  children?: ReactNode;
};

function NowPlayingEq({ active }: { active: boolean }) {
  return (
    <span className={`now-playing-eq${active ? " active" : ""}`} aria-hidden="true">
      <i /><i /><i /><i />
    </span>
  );
}

function MixedMediaListRow({
  folderDescription,
  playbackProgress = 0,
  watched = false,
  item,
  episodeThumbnail,
  displayName,
  openedLabel,
  displayTags,
  itemPath,
  isLibrary,
  coverImage,
  folderItemCount,
  durationLabel,
  dragTarget,
  canMove,
  selectionMode = false,
  selected = false,
  canSelect = false,
  onToggleSelect,
  onEnterSelection,
  onOpen,
  onFavorite,
  onMenu,
  onContextMenu,
  onDragStart,
  onDragEnd,
  onDragOver,
  onDragLeave,
  onDrop,
  menuOpen,
  nowPlaying = false,
  nowPlayingActive = false,
  children,
}: MixedMediaListRowProps) {
  const handleMainClick = (event: ReactMouseEvent) => {
    event.preventDefault();
    if (selectionMode && canSelect) {
      onToggleSelect?.();
      return;
    }
    onOpen();
  };
  return (
    <article
      draggable={canMove && !selectionMode}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      className={`media-list-row${selectionMode ? " selection-mode" : ""}${dragTarget ? " drag-target" : ""}${menuOpen ? " menu-open" : ""}${selected ? " selected" : ""}${nowPlaying ? " now-playing" : ""}${nowPlaying && nowPlayingActive ? " is-playing" : ""}`}
      aria-current={nowPlaying ? "true" : undefined}
      onContextMenu={onContextMenu}
    >
      {selectionMode && !isLibrary && canSelect ? (
        <button
          type="button"
          className={`card-select list-select ${selected ? "on" : ""}`}
          aria-label={`Select ${displayName}`}
          aria-pressed={selected}
          onClick={(event) => {
            event.stopPropagation();
            if (!selectionMode) onEnterSelection?.();
            else onToggleSelect?.();
          }}
        />
      ) : (
        null
      )}
      <button type="button" className="media-list-main" onClick={handleMainClick}>
        <span className={`media-list-icon ${item.kind}${coverImage || episodeThumbnail ? " has-cover" : ""}`}>
          {item.kind === "folder" ? (
            coverImage ? (
              <img src={coverImage} alt="" loading="lazy" />
            ) : (
              <span aria-hidden="true">▦</span>
            )
          ) : item.kind === "audio" ? (
            nowPlaying ? <NowPlayingEq active={nowPlayingActive} /> : <span aria-hidden="true">♫</span>
          ) : item.kind === "image" && item.src ? (
            <img src={item.thumbSrc ?? item.src} alt="" loading="lazy" />
          ) : item.kind === "video" && episodeThumbnail ? (
            <img src={episodeThumbnail} alt="" loading="lazy" />
          ) : item.kind === "video" && item.src ? (
            <VideoPreviewThumb src={item.src} videoPath={item.path} />
          ) : (
            <span aria-hidden="true">{item.kind === "video" ? "▶" : "◉"}</span>
          )}
          {playbackProgress > 0 && <progress className="list-playback-progress" aria-label={`Playback progress for ${displayName}`} value={playbackProgress} max={100} />}
        </span>
        <span className="media-list-copy">
          <strong className={displayName.length > 110 ? "media-title-very-long" : displayName.length > 70 ? "media-title-long" : undefined} title={displayName}>{mediaTitleContent(displayName)}</strong>
          <small className="list-watch-state">{[watched ? "Watched" : playbackProgress > 0 ? `Resume ${Math.round(playbackProgress)}%` : "", item.kind !== "folder" ? durationLabel : ""].filter(Boolean).join(" · ")}</small>
          {openedLabel && <small className="list-opened-date">{openedLabel}</small>}
          {item.kind === "folder" ? (
            <small>{[folderDescription || (isLibrary ? "Library" : `${folderItemCount} ${/^Season \d+/i.test(item.name) ? "episode" : "item"}${folderItemCount === 1 ? "" : "s"}`), item.favorite ? "Favorite" : ""].filter(Boolean).join(" · ")}</small>
          ) : null}
          {displayTags.length > 0 && (
            <span className="media-list-tags">
              {displayTags.map((tag) => <em key={tag}>{tag}</em>)}
            </span>
          )}
        </span>
      </button>
      {!isLibrary ? (
        <button
          type="button"
          className={`media-list-fav${item.favorite ? " on" : ""}`}
          aria-label={`${item.favorite ? "Remove" : "Add"} ${displayName} ${item.favorite ? "from" : "to"} favorites`}
          aria-pressed={Boolean(item.favorite)}
          onClick={(event) => {
            event.stopPropagation();
            onFavorite();
          }}
        >
          <span aria-hidden="true">{item.favorite ? "★" : "☆"}</span>
        </button>
      ) : (
        <span className="media-list-fav-spacer" aria-hidden="true" />
      )}
      <button
        type="button"
        className="media-list-menu"
        aria-label={`More actions for ${displayName}`}
        aria-expanded={menuOpen}
        onClick={(event) => {
          event.stopPropagation();
          onMenu(event);
        }}
      >
        •••
      </button>
      {children}
    </article>
  );
}

const nav = mainNavigation;

// "Series · S01E03 · Episode name" reads as a muted series line above the episode name,
// so a narrow card never ends a line on a separator.
function mediaTitleContent(text: string) {
  const parts = text.split(" · ");
  if (parts.length < 3 || !/^S\d{2,}E\d{2,}$/.test(parts[1])) return text;
  const code = parts[1].replace(/^S0*(\d+)E0*(\d+)$/, "S$1 E$2");
  return <><span className="media-title-kicker">{parts[0]} · {code}</span>{parts.slice(2).join(" · ")}</>;
}

export default function Home() {
  const sessionUser = useMemo(() => getSessionUser(), []);
  const canOpenAdminPanel = canAccessAdminPanel(sessionUser);
  const canAccessNotes = canOpenAdminPanel;
  const canManageLibraries = hasAdminPermission(sessionUser, "manage_libraries");
  const sessionInitials = sessionUser?.name.slice(0, 2).toUpperCase() ?? "?";
  const initialSnapshot = useMemo(() => {
    if (typeof window === "undefined") return null;
    return readBrowseSnapshot(window.location.pathname + window.location.search, sessionUser?.id);
  }, [sessionUser?.id]);
  const [items, setItems] = useState<MediaItem[]>(() => (initialSnapshot?.items ?? []).map((item) => {
    if (item.aspectRatio || !item.path) return item;
    const cachedRatio = readCachedAspectRatio(item.path);
    return cachedRatio ? { ...item, aspectRatio: cachedRatio } : item;
  }));
  const [favoritePaths, setFavoritePaths] = useState<string[]>(() => {
    const base = new Set(initialSnapshot?.items.filter((item) => item.favorite && item.path).map((item) => item.path!) ?? []);
    if (typeof window !== "undefined") {
      Object.entries(pendingOfflineFavoriteOverrides()).forEach(([path, favorite]) => {
        if (favorite) base.add(path);
        else base.delete(path);
      });
    }
    return [...base];
  });
  const [offlineFavoriteOverrides, setOfflineFavoriteOverrides] = useState<Record<string, boolean>>(() => typeof window === "undefined" ? {} : pendingOfflineFavoriteOverrides());
  const [loadedFolder, setLoadedFolder] = useState<string | null | undefined>(() => initialSnapshot?.folder);
  // A cached page can be partial while its live folder request is still in
  // flight. Keep automatic single-season navigation off that provisional data.
  const [authoritativeFolder, setAuthoritativeFolder] = useState<string | null>(null);
  // Grid data changes with currentFolder. The sidebar needs to retain each
  // fetched folder level so navigating into a child never removes its parents.
  const [sidebarTreeEntries, setSidebarTreeEntries] = useState<Record<string, MediaItem[]>>(() => initialSnapshot?.sidebarTreeEntries ?? {});
  const [filterCatalog, setFilterCatalog] = useState<MediaItem[]>(() => Object.values(initialSnapshot?.sidebarTreeEntries ?? {}).flat());
  const [trashItems, setTrashItems] = useState<MediaItem[]>(() => initialSnapshot?.trashItems ?? []);
  const [pendingDeleteRequests, setPendingDeleteRequests] = useState(0);
  const [pendingDiscoverRequests, setPendingDiscoverRequests] = useState(0);
  const pendingAdminNotifications = pendingDeleteRequests + pendingDiscoverRequests;
  const [requestedDeletePaths, setRequestedDeletePaths] = useState<Set<string>>(() => new Set());
  const [playback, setPlayback] = useState<Record<string, PlaybackState>>(() => initialSnapshot?.playback ?? {});
  const [lastAccessed, setLastAccessed] = useState<Record<string, number>>(() => initialSnapshot?.lastAccessed ?? {});
  // Tags and playlists edited offline are shown as they will be once synced.
  const [initialOrganization] = useState(() => applyPendingOrganization({
    tags: initialSnapshot?.customTags,
    tag_catalog: initialSnapshot?.tagCatalog,
    playlists: initialSnapshot?.playlists,
  }, typeof window === "undefined" ? emptyPendingChanges() : readPendingOfflineChanges()));
  const [customTags, setCustomTags] = useState<Record<string, string[]>>(initialOrganization.tags);
  const [tagCatalog, setTagCatalog] = useState<Record<string, TagDefinition>>(initialOrganization.tag_catalog);
  const [playlists, setPlaylists] = useState<Record<string, Playlist>>(initialOrganization.playlists);
  const [activePlaylistId, setActivePlaylistId] = useState<string | null>(() => initialSnapshot?.activePlaylistId ?? null);
  const [playlistDraft, setPlaylistDraft] = useState<string | null>(null);
  const [playlistError, setPlaylistError] = useState("");
  const [savingPlaylist, setSavingPlaylist] = useState(false);
  const [tagDraft, setTagDraft] = useState<string | null>(null);
  const [tagError, setTagError] = useState("");
  const [savingTag, setSavingTag] = useState(false);
  const [organizeTarget, setOrganizeTarget] = useState<MediaItem | null>(null);
  const [organizeTags, setOrganizeTags] = useState<string[]>([]);
  const [organizePlaylists, setOrganizePlaylists] = useState<string[]>([]);
  const [organizeError, setOrganizeError] = useState("");
  const [savingOrganization, setSavingOrganization] = useState(false);
  const [inlinePlaylistName, setInlinePlaylistName] = useState("");
  const [tagSidebarSort, setTagSidebarSort] = useState<CollectionSidebarSort>("count");
  const [playlistSidebarSort, setPlaylistSidebarSort] = useState<CollectionSidebarSort>("count");
  const [collectionLastOpened, setCollectionLastOpened] = useState(() => readCollectionLastOpened(sessionUser?.id));
  const [playlistBrowseSort, setPlaylistBrowseSort] = useState<SidebarSort>("recent");
  const [playlistBrowseDirection, setPlaylistBrowseDirection] = useState<"asc" | "desc">("desc");
  const [playlistBrowseView, setPlaylistBrowseView] = useState<"grid" | "list">("grid");
  const [playlistBrowseQuery, setPlaylistBrowseQuery] = useState("");
  const [playlistBrowseTags, setPlaylistBrowseTags] = useState<string[]>([]);
  const [sidebarExpanded, setSidebarExpanded] = useState({ tags: true, playlists: true });
  const [sidebarShowAll, setSidebarShowAll] = useState({ tags: false, playlists: false });
  const [sidebarContext, setSidebarContext] = useState<SidebarContext | null>(null);
  const [backendState, setBackendState] = useState<BackendState>(() => (initialSnapshot && initialSnapshot.items.length > 0) ? "online" : "loading");
  const [backendError, setBackendError] = useState("");
  const [offlineBundles, setOfflineBundles] = useState<OfflineBundle[]>([]);
  const [offlineLocationName, setOfflineLocationName] = useState<string>();
  const [offlineBusy, setOfflineBusy] = useState(false);
  const [pendingOfflineUrl, setPendingOfflineUrl] = useState<{ bundleId: string; relativePath: string } | null>(() => {
    if (typeof window === "undefined") return null;
    const params = new URLSearchParams(window.location.search);
    if (params.get("section") !== "offline") return null;
    if (params.get("folder")) return null;
    const offline = params.get("offline");
    if (!offline) return null;
    return { bundleId: offline, relativePath: params.get("offlinePath") ?? "" };
  });
  const [offlineResolvedSrc, setOfflineResolvedSrc] = useState<Record<string, string>>({});
  const [offlineDurations, setOfflineDurations] = useState<Record<string, number>>({});
  const [section, setSection] = useState<Section>(() => {
    if (typeof window === "undefined") return "library";
    const requestedSection = new URLSearchParams(window.location.search).get("section");
    const sec = requestedSection === "downloads" ? "offline" : requestedSection;
    if (sec === "trash" && !sessionUser?.is_admin) return "library";
    if (sec === "discover" || sec === "library" || sec === "recent" || sec === "new" || sec === "favorites" || sec === "playlists" || sec === "offline" || sec === "trash" || sec === "notes") return sec as Section;
    if (initialSnapshot?.section && !(initialSnapshot.section === "trash" && !sessionUser?.is_admin)) return initialSnapshot.section as Section;
    return "library";
  });
  const [query, setQuery] = useState(() => {
    if (initialSnapshot?.query !== undefined) return initialSnapshot.query;
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("q") ?? "";
  });
  const [activeSearch, setActiveSearch] = useState(() => {
    if (initialSnapshot?.activeSearch !== undefined) return initialSnapshot.activeSearch;
    if (typeof window === "undefined") return "";
    return new URLSearchParams(window.location.search).get("q") ?? "";
  });
  const [activeTags, setActiveTags] = useState<string[]>(() => {
    if (typeof window === "undefined") return [];
    const params = new URLSearchParams(window.location.search);
    const urlTags = params.getAll("tag");
    return normalizeActiveTags(urlTags.length ? urlTags : [readLibraryBrowsePrefs(params.get("folder")).tag]);
  });
  const [sort, setSort] = useState<SortField>(() => {
    if (typeof window === "undefined") return DEFAULT_LIBRARY_BROWSE_PREFS.sort;
    const params = new URLSearchParams(window.location.search);
    const saved = readLibraryBrowsePrefs(params.get("folder"));
    return validSortField(params.get("sort")) ?? saved.sort;
  });
  const [sortDirection, setSortDirection] = useState<SortDirection>(() => {
    if (typeof window === "undefined") return DEFAULT_LIBRARY_BROWSE_PREFS.sortDirection;
    const params = new URLSearchParams(window.location.search);
    const urlDirection = params.get("direction");
    if (urlDirection === "asc" || urlDirection === "desc") return urlDirection;
    return readLibraryBrowsePrefs(params.get("folder")).sortDirection;
  });
  const [preview, setPreview] = useState<MediaItem | null>(null);
  const [toast, setToast] = useState("");
  const [currentFolder, setCurrentFolder] = useState<string | null>(() => {
    if (initialSnapshot?.folder !== undefined) return initialSnapshot.folder;
    if (typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("folder");
  });
  const [serverHasMore, setServerHasMore] = useState(() => initialSnapshot?.serverHasMore ?? false);
  const [serverLoadedCount, setServerLoadedCount] = useState(() => initialSnapshot?.serverLoadedCount ?? 0);
  const [serverTotal, setServerTotal] = useState(() => initialSnapshot?.serverTotal ?? 0);
  const [serverPageLoading, setServerPageLoading] = useState(false);
  const [clientFilterLoadedFolderKey, setClientFilterLoadedFolderKey] = useState<string | null>(null);
  const [debugInfo, setDebugInfo] = useState<LibraryDebugInfo>({});
  const debugInfoRef = useRef<LibraryDebugInfo>({});
  const [imageBatchByPath, setImageBatchByPath] = useState<Record<string, number>>({});
  const nextServerBatchIdRef = useRef(0);
  const pendingBatchImagesRef = useRef(new Map<number, { startedAt: number; paths: Set<string> }>());
  const appendServerBatch = (batchItems: MediaItem[], durationMs: number) => {
    const id = ++nextServerBatchIdRef.current;
    const imagePaths = batchItems
      .filter((item) => (item.kind === "image" || item.kind === "video") && Boolean(item.path))
      .map((item) => item.path!);
    const imageCount = imagePaths.length;
    const serverBatches = [...(debugInfoRef.current.serverBatches ?? []), {
      id,
      count: batchItems.length,
      durationMs,
      imageCount,
      imagesLoaded: 0,
      imagesFailed: 0,
    }].slice(-12);
    debugInfoRef.current = { ...debugInfoRef.current, serverBatches };
    setDebugInfo(debugInfoRef.current);
    if (imageCount) {
      pendingBatchImagesRef.current.set(id, { startedAt: performance.now(), paths: new Set(imagePaths) });
      setImageBatchByPath((current) => ({ ...current, ...Object.fromEntries(imagePaths.map((path) => [path, id])) }));
    } else {
      const completedBatches = serverBatches.map((batch) => batch.id === id
        ? { ...batch, imagesReadyMs: 0 }
        : batch);
      debugInfoRef.current = { ...debugInfoRef.current, serverBatches: completedBatches };
      setDebugInfo(debugInfoRef.current);
    }
  };
  const recordBatchImageResult = (batchId: number, path: string, outcome: "loaded" | "failed") => {
    const pending = pendingBatchImagesRef.current.get(batchId);
    if (!pending || !pending.paths.delete(path)) return;
    const elapsedMs = performance.now() - pending.startedAt;
    const serverBatches = (debugInfoRef.current.serverBatches ?? []).map((batch) => batch.id === batchId
      ? {
        ...batch,
        imagesLoaded: batch.imagesLoaded + (outcome === "loaded" ? 1 : 0),
        imagesFailed: batch.imagesFailed + (outcome === "failed" ? 1 : 0),
        imagesReadyMs: elapsedMs,
      }
      : batch);
    debugInfoRef.current = { ...debugInfoRef.current, serverBatches };
    setDebugInfo(debugInfoRef.current);
    if (!pending.paths.size) pendingBatchImagesRef.current.delete(batchId);
  };
  const recordBatchImageFinished = (target: Element, outcome: "loaded" | "failed") => {
    const card = target.closest<HTMLElement>("[data-image-batch-id]");
    const batchId = Number(card?.dataset.imageBatchId);
    const path = card?.dataset.imageBatchPath;
    // Video cards intentionally fall back to a <video> when their grid JPEG
    // misses. Let that fallback report the final visual result instead of
    // locking the batch into a false failure on the thumbnail's error event.
    if (outcome === "failed" && card?.dataset.imageBatchKind === "video") return;
    if (batchId && path) recordBatchImageResult(batchId, path, outcome);
  };
  const [railCollapsed, setRailCollapsed] = useState<boolean>(() => typeof window !== "undefined" && window.localStorage.getItem("tms_rail_collapsed") === "true");
  const [railDrawerOpen, setRailDrawerOpen] = useState(false);
  const [railDrawerVisible, setRailDrawerVisible] = useState(false);
  const sidebarSwipeStart = useRef<{ x: number; y: number; time: number } | null>(null);
  useEffect(() => {
    if (railDrawerOpen) {
      setRailDrawerVisible(true);
      return;
    }
    const timer = window.setTimeout(() => setRailDrawerVisible(false), 280);
    return () => window.clearTimeout(timer);
  }, [railDrawerOpen]);
  const [libraryView, setLibraryView] = useState<LibraryView>(() => {
    return typeof window === "undefined" ? DEFAULT_LIBRARY_BROWSE_PREFS.view : readLibraryBrowsePrefs(new URLSearchParams(window.location.search).get("folder")).view;
  });

  useEffect(() => {
    console.log(`[Navigation] currentFolder changed to: ${currentFolder === null ? "root" : `"${currentFolder}"`}`);
  }, [currentFolder]);

  const playbackSession = usePlaybackSession();
  const miniplayerItem = playbackSession?.item.kind === "audio" ? playbackSession.item : null;
  const [miniplayerPlaying, setMiniplayerPlaying] = useState(false);
  const [offlineCatalogSyncTick, setOfflineCatalogSyncTick] = useState(0);
  const [offlineSyncError, setOfflineSyncError] = useState("");
  const offlineSyncInFlightRef = useRef(new Set<string>());

  const browsePrefsFolderRef = useRef(currentFolder);
  useEffect(() => {
    if (!urlStateReady.current) return;
    if (browsePrefsFolderRef.current !== currentFolder) {
      browsePrefsFolderRef.current = currentFolder;
      return;
    }
    writeLibraryBrowsePrefs({ sort, sortDirection, tag: JSON.stringify(activeTags), view: libraryView }, currentFolder);
  }, [activeTags, currentFolder, libraryView, sort, sortDirection]);

  const toggleRailCollapsed = () => {
    setRailCollapsed((current) => {
      const next = !current;
      try { window.localStorage.setItem("tms_rail_collapsed", next.toString()); } catch {}
      return next;
    });
  };
  const restoreFolderBrowsePrefs = (folder: string | null) => {
    const saved = readLibraryBrowsePrefs(folder);
    setActiveTags(normalizeActiveTags([saved.tag]));
    setSort(saved.sort);
    setSortDirection(saved.sortDirection);
    setLibraryView(saved.view);
  };
  const selectLibraryView = (view: LibraryView) => {
    setLibraryView(view);
    writeLibraryBrowsePrefs({ view }, currentFolder);
  };

  const [contextItem, setContextItem] = useState<{ item: MediaItem; x: number; y: number } | null>(null);
  const [moveFolderPaths, setMoveFolderPaths] = useState<string[]>([]);
  const [libraryContext, setLibraryContext] = useState<{ path: string; x: number; y: number } | null>(null);
  const [librariesContext, setLibrariesContext] = useState<{ x: number; y: number } | null>(null);
  const [libraryDraft, setLibraryDraft] = useState<{ name: string; contentType: LibraryContentType } | null>(null);
  const [creatingLibrary, setCreatingLibrary] = useState(false);
  const [libraryCreateError, setLibraryCreateError] = useState("");
  const [folderDraft, setFolderDraft] = useState<{ parentPath: string; name: string } | null>(null);
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [folderCreateError, setFolderCreateError] = useState("");
  const [renameTarget, setRenameTarget] = useState<MediaItem | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const [renameError, setRenameError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<MediaItem | null>(null);
  const [deletingMedia, setDeletingMedia] = useState(false);
  const [deleteLibraryTarget, setDeleteLibraryTarget] = useState<string | null>(null);
  const [deletingLibrary, setDeletingLibrary] = useState(false);
  const [deletePlaylistTarget, setDeletePlaylistTarget] = useState<Playlist | null>(null);
  const [deleteTagTarget, setDeleteTagTarget] = useState<string | null>(null);
  const [moveTarget, setMoveTarget] = useState<MediaItem | null>(null);
  const [moveDestination, setMoveDestination] = useState<string>("");
  const [moveExpandedDestinations, setMoveExpandedDestinations] = useState<string[]>([]);
  const [movingMedia, setMovingMedia] = useState(false);
  const [moveError, setMoveError] = useState("");
  const [nameConflict, setNameConflict] = useState<{ action: "move" | "rename"; name: string; retry: () => void } | null>(null);
  const [permanentDeleteTarget, setPermanentDeleteTarget] = useState<MediaItem | null>(null);
  const [emptyTrashOpen, setEmptyTrashOpen] = useState(false);
  const [emptyingTrash, setEmptyingTrash] = useState(false);
  const [showDevicePath, setShowDevicePath] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>([]);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [bulkMoveOpen, setBulkMoveOpen] = useState(false);
  const [bulkMoving, setBulkMoving] = useState(false);
  const [bulkPermanentDeleteOpen, setBulkPermanentDeleteOpen] = useState(false);
  const [bulkPermanentDeleting, setBulkPermanentDeleting] = useState(false);
  const [bulkRestoring, setBulkRestoring] = useState(false);
  const [bulkOrganizeOpen, setBulkOrganizeOpen] = useState(false);
  const [bulkOrganizeTags, setBulkOrganizeTags] = useState<string[]>([]);
  const [bulkOrganizePlaylists, setBulkOrganizePlaylists] = useState<string[]>([]);
  const [bulkOrganizeError, setBulkOrganizeError] = useState("");
  useEffect(() => {
    try {
      if (localStorage.getItem("framebox-show-device-path") === "true") {
        setShowDevicePath(true);
      }
    } catch {}
  }, []);
  const [draggedItem, setDraggedItem] = useState<MediaItem | null>(null);
  const [dragTarget, setDragTarget] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [folderToolsOpen, setFolderToolsOpen] = useState(false);
  useBackLayer(folderToolsOpen, () => setFolderToolsOpen(false));
  const [accountMenuOpen, setAccountMenuOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [savingPassword, setSavingPassword] = useState(false);
  const [settingsError, setSettingsError] = useState("");
  const [playbackPreferences, setPlaybackPreferences] = useState<PlaybackPreferences>(DEFAULT_PLAYBACK_PREFERENCES);
  const [savingImageSeconds, setSavingImageSeconds] = useState(false);
  const [deviceSessions, setDeviceSessions] = useState<DeviceSession[]>([]);
  const [storageQuota, setStorageQuota] = useState<StorageQuota | null>(null);
  const [revokingDeviceSession, setRevokingDeviceSession] = useState("");
  const [uploadTarget, setUploadTarget] = useState<string | null>(null);
  const [uploadQueue, setUploadQueue] = useState<UploadQueueItem[]>([]);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [uploadPickerOpen, setUploadPickerOpen] = useState(false);
  const [backgroundUploadTarget, setBackgroundUploadTarget] = useState<string | null>(null);
  const [magnetTarget, setMagnetTarget] = useState<string | null>(null);
  const [serverDownloadTarget, setServerDownloadTarget] = useState<string | null>(null);
  const [incomingMagnet, setIncomingMagnet] = useState<string | null>(null);
  const [backgroundMagnetDownloads, setBackgroundMagnetDownloads] = useState<BackgroundMagnetDownload[]>([]);
  const [magnetGroupExpanded, setMagnetGroupExpanded] = useState(false);
  const [backgroundMagnetStatus, setBackgroundMagnetStatus] = useState("");
  const [hiddenMagnetHashes, setHiddenMagnetHashes] = useState<string[]>([]);
  const [ytDlpJobs, setYtDlpJobs] = useState<YtDlpJob[]>([]);
  const [ytDlpControlId, setYtDlpControlId] = useState<string | null>(null);
  const [downloadModalHash, setDownloadModalHash] = useState<string | null>(null);
  const [magnetControlHash, setMagnetControlHash] = useState<string | null>(null);
  // Android Back closes these before leaving the page.
  useBackLayer(contextItem !== null, () => setContextItem(null));
  useBackLayer(libraryContext !== null, () => setLibraryContext(null));
  useBackLayer(librariesContext !== null, () => setLibrariesContext(null));
  useBackLayer(sidebarContext !== null, () => setSidebarContext(null));
  useBackLayer(railDrawerOpen, () => setRailDrawerOpen(false));
  useBackLayer(accountMenuOpen, () => setAccountMenuOpen(false));
  useBackLayer(settingsOpen, () => setSettingsOpen(false));
  useBackLayer(uploadPickerOpen, () => setUploadPickerOpen(false));
  useBackLayer(renameTarget !== null, () => setRenameTarget(null));
  useBackLayer(deleteTarget !== null, () => setDeleteTarget(null));
  useBackLayer(moveTarget !== null, () => setMoveTarget(null));
  useBackLayer(folderDraft !== null, () => setFolderDraft(null));
  useBackLayer(libraryDraft !== null, () => setLibraryDraft(null));
  useBackLayer(emptyTrashOpen, () => setEmptyTrashOpen(false));

  const [expandedFolders, setExpandedFolders] = useState<string[]>([]);
  const [searchFocused, setSearchFocused] = useState(false);
  const [searchCaret, setSearchCaret] = useState(query.length);
  const [selectedSuggestion, setSelectedSuggestion] = useState<string | null>(null);
  const [compactScreen, setCompactScreen] = useState(false);
  const [discoverHeaderQuery, setDiscoverHeaderQuery] = useState(() => typeof window === "undefined" ? "" : new URLSearchParams(window.location.search).get("dq") ?? "");
  const itemMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const update = () => setCompactScreen(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useLayoutEffect(() => {
    if (!contextItem || !itemMenuRef.current) return;
    const bounds = itemMenuRef.current.getBoundingClientRect();
    const x = Math.max(8, Math.min(contextItem.x, window.innerWidth - bounds.width - 8));
    const y = Math.max(68, Math.min(contextItem.y, window.innerHeight - bounds.height - 80));
    if (x !== contextItem.x || y !== contextItem.y) setContextItem(current => current ? { ...current, x, y } : null);
  }, [contextItem]);
  const [previousSearches, setPreviousSearches] = useState<string[]>([]);
  const [recentFolders, setRecentFolders] = useState<string[]>([]);
  const [pagination, setPagination] = useState(() => ({
    key: "",
    limit: Math.max(initialSnapshot?.clientVisibleLimit ?? LIBRARY_PAGE_SIZE, LIBRARY_PAGE_SIZE),
  }));
  const restoredVisibleLimitRef = useRef(Math.max(initialSnapshot?.clientVisibleLimit ?? LIBRARY_PAGE_SIZE, LIBRARY_PAGE_SIZE));
  const paginationKeyInitializedRef = useRef(false);
  const [libraries, setLibraries] = useState<Record<string, LibraryConfig>>(() => initialSnapshot?.libraries ?? {});
  const [folderCovers, setFolderCovers] = useState<Record<string, string>>(() => initialSnapshot?.folderCovers ?? {});
  const [coverFolder, setCoverFolder] = useState<MediaItem | null>(null);
  const [titleMetadata, setTitleMetadata] = useState<Record<string, TitleMetadata>>(() => initialSnapshot?.titleMetadata ?? {});
  const [trailer, setTrailer] = useState<{ title: string; youtubeId: string } | null>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const uploadInput = useRef<HTMLInputElement>(null);
  const uploadFolderInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const loadMoreInFlightRef = useRef(false);
  const urlStateReady = useRef(false);
  const restoringHistory = useRef(false);
  const metadataLoading = useRef(new Set<string>());
  const [pendingTitleMetadata, setPendingTitleMetadata] = useState<Set<string>>(() => new Set());
  const trailerMetadataRefresh = useRef(new Set<string>());
  const automaticFolderCoverRequests = useRef(new Set<string>());
  const libraryCache = useRef<LibraryCache | null>(null);
  const uploadQueueRef = useRef<UploadQueueItem[]>([]);
  const uploadControllers = useRef(new Map<string, AbortController>());
  const uploadStopReasons = useRef(new Map<string, "pause" | "remove">());
  const uploadWorkerCount = useRef(0);
  const uploadBatchCompleted = useRef(0);
  const uploadDropHandler = useRef<{ target: string | null; drop: (dataTransfer: DataTransfer) => void }>({ target: null, drop: () => undefined });
  const [uploadDragTarget, setUploadDragTarget] = useState<{ path: string | null } | null>(null);
  const activeMagnetHashes = useRef<Set<string>>(new Set());
  const activeYtDlpJobIds = useRef<Set<string>>(new Set());
  const activeYtDlpJobTitles = useRef(new Map<string, string>());
  const magnetDownloadNames = useRef(new Map<string, string>());
  const ignoredMagnetCompletionHashes = useRef(new Set<string>());
  const toastTimeout = useRef<number | null>(null);
  const downloadLibraryRefreshUntil = useRef(0);
  const lastDownloadLibraryRefresh = useRef(0);
  const sharedTodoSaveTimer = useRef<number | null>(null);
  const sharedTodoSavedText = useRef("");
  const sharedTodoTextRef = useRef("");
  const [sharedTodoText, setSharedTodoText] = useState("");
  const [sharedTodoSyncState, setSharedTodoSyncState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const updateLibraryCache = (update: (current: LibraryCache) => LibraryCache) => {
    if (!libraryCache.current) return;
    const next = update(libraryCache.current);
    if (!currentFolder) {
      next.pages = {
        ...next.pages,
        [libraryCachePageKey(null, sort, sortDirection)]: next.entries,
      };
    }
    libraryCache.current = next;
    void writeLibraryCache(next);
  };

  const loadTrash = async () => {
    if (!sessionUser?.is_admin) {
      setTrashItems([]);
      return;
    }
    try {
      const response = await authFetch(`${API_BASE}/api/trash`);
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const entries = await response.json() as TrashEntry[];
      setTrashItems(entries.map((entry) => {
        const mapped = apiEntryToMediaItem({ path: entry.original_path, name: entry.name, kind: entry.kind, size: entry.size, created_at: entry.deleted_at });
        if (mapped) return { ...mapped, trashed: true, trashId: entry.id, src: `${API_BASE}/trash-files/${entry.stored_name.split("/").map(encodeURIComponent).join("/")}`, updated: `Deleted ${new Date(entry.deleted_at * 1000).toLocaleDateString()}` };
        const slash = entry.original_path.lastIndexOf("/");
        return { id: stableId(`trash:${entry.id}`), trashId: entry.id, path: entry.original_path, name: entry.name, kind: "folder", size: "Folder", sizeBytes: entry.size, addedAt: entry.deleted_at, updated: `Deleted ${new Date(entry.deleted_at * 1000).toLocaleDateString()}`, tags: [], owner: "Trash", parent: slash < 0 ? undefined : entry.original_path.slice(0, slash), tone: "lavender", trashed: true };
      }));
    } catch (error) { console.error("Could not load trash", error); }
  };

  useEffect(() => {
    if (!sessionUser?.is_admin) return;
    let active = true;
    const loadRequests = async () => {
      await Promise.allSettled([ (async () => {
        const response = await authFetch(`${API_BASE}/api/admin/delete-requests`);
        if (!response.ok) return;
        const requests = await response.json() as { id: string }[];
        if (active) setPendingDeleteRequests(requests.length);
      })(), (async () => {
        const response = await authFetch(`${API_BASE}/api/discover/requests`);
        if (!response.ok) return;
        const result = await response.json() as { requests: { id: string }[] };
        if (active) setPendingDiscoverRequests(result.requests.length);
      })() ]); // Keep each last visible count if its endpoint is unavailable.
    };
    const initial = window.setTimeout(() => void loadRequests(), 0);
    const timer = window.setInterval(() => void loadRequests(), 30_000);
    return () => { active = false; window.clearTimeout(initial); window.clearInterval(timer); };
  }, [sessionUser?.id, sessionUser?.is_admin]);

  useEffect(() => {
    if (!sessionUser || sessionUser.is_admin) return;
    let active = true;
    const loadOwnRequests = async () => {
      try {
        const response = await authFetch(`${API_BASE}/api/delete-requests`);
        if (response.ok && active) setRequestedDeletePaths(new Set((await response.json() as { path: string }[]).map((entry) => entry.path)));
      } catch { /* A temporary connection loss should not clear the current labels. */ }
    };
    const initial = window.setTimeout(() => void loadOwnRequests(), 0);
    const timer = window.setInterval(() => void loadOwnRequests(), 30_000);
    return () => { active = false; window.clearTimeout(initial); window.clearInterval(timer); };
  }, [sessionUser]);

  useEffect(() => {
    const timer = window.setTimeout(() => void loadTrash(), 0);
    return () => window.clearTimeout(timer);
  }, [sessionUser?.is_admin]);

  const refreshOfflineDownloads = useCallback(async () => {
    try {
      const result = await listOfflineBundles();
      // A successful local read is authoritative, including deletion of the
      // selected folder. Failed reads keep the previous state in the catch.
      setOfflineBundles(result.bundles);
      setOfflineLocationName(result.locationName || undefined);
    } catch (error) {
      console.error("Could not load offline downloads", error);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    let checking = false;
    let failures = 0;
    // One slow probe is not an outage: the browser can queue it behind
    // uploads or other long requests to the same host. Only consecutive
    // failures send the app to Offline.
    const failed = () => {
      failures += 1;
      if (!cancelled && failures >= 3) setBackendState("offline");
    };
    const checkConnection = async () => {
      if (checking) return;
      checking = true;
      try {
        const response = await fetch(`${API_BASE}/api/health`, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
        if (cancelled) return;
        if (response.ok) {
          failures = 0;
          setBackendState("online");
        } else failed();
      } catch {
        failed();
      } finally { checking = false; }
    };
    const onOffline = () => setBackendState("offline");
    window.addEventListener("online", checkConnection);
    window.addEventListener("offline", onOffline);
    const timer = window.setInterval(checkConnection, 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
      window.removeEventListener("online", checkConnection);
      window.removeEventListener("offline", onOffline);
    };
  }, []);

  // Cached library cards can describe media that is no longer reachable. Once
  // the server check fails, make Downloaded the only browse surface rather
  // than leaving a stale library, Favorites, or search result one tap away.
  useEffect(() => {
    if (backendState !== "offline") return;
    // Remember where the user was so reconnecting can take them back. The
    // URL still describes the pre-offline location here; when it already
    // shows Offline (a reload while disconnected) keep the earlier one.
    // Watch pages are their own route, so this is always a browse location.
    if (new URLSearchParams(window.location.search).get("section") !== "offline") {
      try {
        window.sessionStorage.setItem(OFFLINE_RETURN_KEY, `${window.location.pathname}${window.location.search}`);
      } catch { /* storage unavailable: reconnecting simply stays put */ }
    }
    setSection("offline");
    setCurrentFolder(null);
    clearSearch();
    void refreshOfflineDownloads();
  }, [backendState, refreshOfflineDownloads]);

  // Back online after being sent to Offline: return to the saved location,
  // unless the user has already browsed somewhere else themselves.
  useEffect(() => {
    if (backendState !== "online") return;
    let destination: string | null = null;
    try {
      destination = window.sessionStorage.getItem(OFFLINE_RETURN_KEY);
      window.sessionStorage.removeItem(OFFLINE_RETURN_KEY);
    } catch { return; }
    if (!destination || new URLSearchParams(window.location.search).get("section") !== "offline") return;
    window.history.pushState(null, "", destination);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, [backendState]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refreshOfflineDownloads(), 0);
    return () => window.clearTimeout(timer);
  }, [refreshOfflineDownloads]);

  const offlineDownloadsActive = offlineBundles.some((bundle) => bundle.status === "downloading");
  useEffect(() => {
    if (section !== "offline") return;
    const refresh = () => void refreshOfflineDownloads();
    refresh();
    // Ready downloads never need a one-second native manifest read. Poll only
    // while a download is actively writing progress; this prevents playback
    // from racing the SAF catalog and makes the offline view stable.
    if (!offlineDownloadsActive) return;
    const timer = window.setInterval(refresh, 1_000);
    return () => window.clearInterval(timer);
  }, [offlineDownloadsActive, refreshOfflineDownloads, section]);

  useEffect(() => {
    if (!pendingOfflineUrl || !offlineBundles.length) return;
    const bundle = offlineBundles.find((candidate) => candidate.id === pendingOfflineUrl.bundleId);
    if (!bundle) {
      setPendingOfflineUrl(null);
      return;
    }
    setSection("offline");
    setCurrentFolder(offlineFolderFromLocation(bundle, pendingOfflineUrl.relativePath));
    setPendingOfflineUrl(null);
  }, [offlineBundles, pendingOfflineUrl]);

  useEffect(() => {
    if (section !== "offline" || !currentFolder || !offlineBundles.length) return;
    if (!findOfflineBundleForFolder(offlineBundles, currentFolder)) setCurrentFolder(null);
  }, [currentFolder, offlineBundles, section]);

  const offlineFavoritePaths = useMemo(() => {
    const paths = new Set(favoritePaths);
    Object.entries(offlineFavoriteOverrides).forEach(([path, favorite]) => {
      if (favorite) paths.add(path);
      else paths.delete(path);
    });
    return paths;
  }, [favoritePaths, offlineFavoriteOverrides]);

  const offlineBrowseLocation = useMemo(() => {
    if (section !== "offline") return null;
    if (!currentFolder) return null;
    return offlineLocationFromFolder(currentFolder, offlineBundles);
  }, [currentFolder, offlineBundles, section]);

  const durationsByPath = useMemo(() => {
    const map = new Map<string, number>();
    items.forEach((item) => {
      if (item.path && item.duration) map.set(item.path, item.duration);
    });
    Object.entries(offlineDurations).forEach(([path, duration]) => map.set(path, duration));
    return map;
  }, [items, offlineDurations]);

  const libraryByPath = useMemo(() => {
    const map = new Map<string, MediaItem>();
    items.forEach((item) => {
      if (!item.path) return;
      map.set(item.path, item);
      map.set(item.path.replace(/\\/g, "/"), item);
    });
    return map;
  }, [items]);

  const offlineBrowseBaseItems = useMemo(() => {
    if (section === "offline" && currentFolder && !offlineBrowseLocation) return [];
    return buildOfflineBrowseItems({
      bundles: offlineBundles,
      location: offlineBrowseLocation,
      customTags,
      favoritePaths: offlineFavoritePaths,
      durationsByPath,
      libraryByPath,
    });
  }, [currentFolder, customTags, durationsByPath, libraryByPath, offlineFavoritePaths, offlineBrowseLocation, offlineBundles, section]);

  const nativeOfflineFileUrls = useMemo(() => {
    if (!Capacitor.isNativePlatform()) return new Map<string, string>();
    const urls = new Map<string, string>();
    offlineBundles.forEach((bundle) => {
      const localFiles = [
        ...bundle.files,
        ...(bundle.cover ? [bundle.cover] : []),
        ...Object.values(bundle.covers ?? {}),
      ];
      localFiles.forEach((file) => {
        if (file.localUri) urls.set(`${bundle.id}:${file.id}`, Capacitor.convertFileSrc(file.localUri));
      });
    });
    return urls;
  }, [offlineBundles]);

  const offlineBrowseItems = useMemo(
    () => offlineBrowseBaseItems.map((item) => {
      const playbackKey = offlinePlaybackKey(item);
      const artworkKey = offlineArtworkKey(item);
      const playbackUrl = playbackKey ? nativeOfflineFileUrls.get(playbackKey) ?? offlineResolvedSrc[playbackKey] : undefined;
      const artworkUrl = artworkKey ? nativeOfflineFileUrls.get(artworkKey) ?? offlineResolvedSrc[artworkKey] : undefined;
      let next = item;
      if (playbackUrl && (item.kind === "audio" || item.kind === "video" || item.kind === "image")) {
        next = { ...next, src: playbackUrl, thumbSrc: playbackUrl };
      }
      if (artworkUrl && item.kind === "folder") {
        next = { ...next, previewSrc: artworkUrl, previewThumbSrc: artworkUrl, previewKind: item.offline?.artworkKind };
      } else if (artworkUrl && (item.kind === "image" || item.kind === "video") && !playbackUrl) {
        next = { ...next, src: artworkUrl, thumbSrc: artworkUrl };
      }
      return withOpenedMetadata(next, lastAccessed, playback);
    }),
    [lastAccessed, nativeOfflineFileUrls, offlineBrowseBaseItems, offlineResolvedSrc, playback],
  );

  const offlineAllMediaBaseItems = useMemo(() => buildOfflineAllMediaItems({
    bundles: offlineBundles,
    customTags,
    favoritePaths: offlineFavoritePaths,
    durationsByPath,
    libraryByPath,
  }), [customTags, durationsByPath, libraryByPath, offlineBundles, offlineFavoritePaths]);

  const offlineAllMediaItems = useMemo(() => offlineAllMediaBaseItems.map((item) => {
    const playbackKey = offlinePlaybackKey(item);
    const artworkKey = offlineArtworkKey(item);
    const playbackUrl = playbackKey ? nativeOfflineFileUrls.get(playbackKey) ?? offlineResolvedSrc[playbackKey] : undefined;
    const artworkUrl = artworkKey ? offlineResolvedSrc[artworkKey] : undefined;
    if (playbackUrl && (item.kind === "audio" || item.kind === "video" || item.kind === "image")) {
      return withOpenedMetadata({ ...item, src: playbackUrl, thumbSrc: playbackUrl }, lastAccessed, playback);
    }
    if (artworkUrl && (item.kind === "image" || item.kind === "video")) {
      return withOpenedMetadata({ ...item, src: artworkUrl, thumbSrc: artworkUrl }, lastAccessed, playback);
    }
    return withOpenedMetadata(item, lastAccessed, playback);
  }), [lastAccessed, nativeOfflineFileUrls, offlineAllMediaBaseItems, offlineResolvedSrc, playback]);

  useEffect(() => {
    let active = true;
    const objectUrls: string[] = [];
    const needed = new Map<string, { bundleId: string; fileId: string }>();
    [...offlineBrowseBaseItems, ...offlineAllMediaBaseItems].forEach((item) => {
      const keys = [offlinePlaybackKey(item), offlineArtworkKey(item)].filter((key): key is string => Boolean(key));
      keys.forEach((key) => {
        const separator = key.indexOf(":");
        if (separator < 0) return;
        const bundleId = key.slice(0, separator);
        const fileId = key.slice(separator + 1);
        if (bundleId && fileId) needed.set(key, { bundleId, fileId });
      });
    });
    // Android already exposes local playback files through the persisted SAF
    // URI. Do not ask the native catalog to find every audio file again here:
    // a large offline collection used to fan out into dozens of simultaneous
    // `list()` calls, which could race the catalog's on-disk reconciliation.
    const missing = [...needed.entries()].filter(([key]) =>
      !offlineResolvedSrc[key] && !(Capacitor.isNativePlatform() && nativeOfflineFileUrls.has(key)),
    );
    if (!missing.length) {
      return () => {
        active = false;
      };
    }
    void Promise.all(missing.map(async ([key, target]) => {
      try {
        const resolved = await resolveOfflineFileUrl(target.bundleId, target.fileId);
        if (resolved.url.startsWith("blob:")) objectUrls.push(resolved.url);
        return [key, resolved.url] as const;
      } catch {
        return null;
      }
    })).then((results) => {
      if (!active) {
        objectUrls.forEach((url) => URL.revokeObjectURL(url));
        return;
      }
      const nextEntries = results.filter((entry): entry is readonly [string, string] => Boolean(entry));
      if (!nextEntries.length) return;
      setOfflineResolvedSrc((current) => {
        let changed = false;
        const next = { ...current };
        nextEntries.forEach(([key, url]) => {
          if (next[key] === url) return;
          next[key] = url;
          changed = true;
        });
        return changed ? next : current;
      });
    });
    return () => {
      active = false;
    };
  }, [nativeOfflineFileUrls, offlineAllMediaBaseItems, offlineBrowseBaseItems, offlineResolvedSrc]);

  const loadSharedTodo = useCallback(async () => {
    try {
      const response = await authFetch(`${API_BASE}/api/shared-todo`);
      if (!response.ok) return;
      const payload = await response.json() as { text?: string };
      const nextText = payload.text ?? "";
      if (sharedTodoTextRef.current === sharedTodoSavedText.current && nextText !== sharedTodoTextRef.current) {
        sharedTodoTextRef.current = nextText;
        setSharedTodoText(nextText);
        sharedTodoSavedText.current = nextText;
      }
    } catch {
      return;
    }
  }, []);

  const saveSharedTodo = useCallback(async (text: string) => {
    setSharedTodoSyncState("saving");
    try {
      const response = await authFetch(`${API_BASE}/api/shared-todo`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      sharedTodoSavedText.current = text;
      setSharedTodoSyncState(sharedTodoTextRef.current === text ? "saved" : "saving");

    } catch {
      if (sharedTodoTextRef.current === text) setSharedTodoSyncState("error");
    }
  }, []);

  const queueSharedTodoSave = useCallback((text: string) => {
    setSharedTodoSyncState("saving");
    if (sharedTodoSaveTimer.current !== null) {
      window.clearTimeout(sharedTodoSaveTimer.current);
    }
    sharedTodoSaveTimer.current = window.setTimeout(() => {
      sharedTodoSaveTimer.current = null;
      void saveSharedTodo(text);
    }, 800);
  }, [saveSharedTodo]);

  useEffect(() => {
    if (!canAccessNotes) return;
    let cancelled = false;
    const loadInitialSharedTodo = async () => {
      try {
        const response = await authFetch(`${API_BASE}/api/shared-todo`);
        if (!response.ok || cancelled) return;
        const payload = await response.json() as { text?: string };
        const nextText = payload.text ?? "";
        if (cancelled) return;
        sharedTodoTextRef.current = nextText;
        setSharedTodoText(nextText);
        sharedTodoSavedText.current = nextText;
      } catch {
        return;
      }
    };
    void loadInitialSharedTodo();
    return () => { cancelled = true; };
  }, [canAccessNotes]);

  useEffect(() => {
    if (!canAccessNotes || section !== "notes") return;
    void loadSharedTodo();
    const timer = window.setInterval(() => { void loadSharedTodo(); }, 3000);
    return () => window.clearInterval(timer);
  }, [canAccessNotes, loadSharedTodo, section]);

  useEffect(() => {
    if (section === "notes" && !canAccessNotes) setSection("library");
  }, [canAccessNotes, section]);

  useEffect(() => {
    return () => {
      if (sharedTodoSaveTimer.current !== null) {
        window.clearTimeout(sharedTodoSaveTimer.current);
      }
    };
  }, []);

  const restoredFromBfcacheRef = useRef(false);
  const pendingScrollYRef = useRef<number | null>(null);
  const loadStartedRef = useRef<number>(0);
  const totalStartedRef = useRef<number>(0);
  const lastLibraryLoadKeyRef = useRef<string | null>(null);

  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (!event.persisted) return;
      restoredFromBfcacheRef.current = true;
      const snapshot = readBrowseSnapshot(window.location.pathname + window.location.search, sessionUser?.id);
      if (!snapshot || snapshot.scrollY <= 0) return;
      pendingScrollYRef.current = snapshot.scrollY;
      restoreBrowseScroll(snapshot.scrollY, () => {
        pendingScrollYRef.current = null;
      });
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, [sessionUser?.id]);

  useEffect(() => {
    if (section !== "offline") return;
    let cancelled = false;
    // The offline shell cannot access the connected WebView's localStorage.
    // Hydrate the last signed-in user's saved favorites/tags before attempting
    // the network request below, so filters and edits work without a server.
    void hydratePendingOfflineChanges().then(() => readOfflineUserState<OfflineUserState>()).then((state) => {
      if (cancelled || !state) return;
      applyOrganizationState(state);
      applyFavoritePaths(state.favorites ?? []);
    }).catch(() => undefined);
    void authFetch(`${API_BASE}/api/user-state`).then(async (response) => {
      if (!response.ok || cancelled) return;
      const state = await response.json() as UserState;
      if (cancelled) return;
      applyOrganizationState(state);
      applyFavoritePaths(state.favorites);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [section]);

  useEffect(() => {
    if (!sessionUser?.id) return;
    // Mirror only organization metadata to the device-owned store. The server
    // remains authoritative and this copy exists solely for the offline shell.
    saveOfflineUserState({
      favorites: favoritePaths,
      tags: customTags,
      tag_catalog: tagCatalog,
      playlists,
    });
  }, [customTags, favoritePaths, playlists, sessionUser?.id, tagCatalog]);

  useEffect(() => {
    if (section !== "offline" || !offlineBrowseLocation) return;
    const bundle = offlineBundles.find((candidate) => candidate.id === offlineBrowseLocation.bundleId);
    if (!bundle?.path) return;
    let cancelled = false;
    void authFetch(libraryApiUrl("name", "asc", bundle.path)).then(async (response) => {
      if (!response.ok || cancelled) return;
      const entries = await response.json() as ApiLibraryEntry[];
      if (cancelled) return;
      const folderItems = entries
        .map(apiEntryToMediaItem)
        .filter((item): item is MediaItem => item !== null)
        .map((item) => {
          const tags = [...new Set([...item.tags, ...inheritedTags(item.path, customTags)])];
          const favorite = Boolean(item.path && offlineFavoritePaths.has(item.path));
          return { ...item, tags, favorite };
        });
      if (!folderItems.length) return;
      setItems((current) => {
        const byPath = new Map(current.map((item) => [item.path ?? `id:${item.id}`, item]));
        folderItems.forEach((item) => {
          if (!item.path) return;
          const existing = byPath.get(item.path);
          byPath.set(item.path, existing ? {
            ...existing,
            tags: [...new Set([...existing.tags, ...item.tags])],
            favorite: Boolean(existing.favorite || item.favorite),
            duration: existing.duration ?? item.duration,
          } : item);
        });
        return [...byPath.values()];
      });
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [customTags, offlineBrowseLocation, offlineBundles, offlineFavoritePaths, section]);

  const playlistsOffline = section === "playlists" && backendState === "offline";
  useEffect(() => {
    if (section === "offline" || section === "discover" || section === "notes" || playlistsOffline) return;
    let cancelled = false;
    const loadLibrary = async () => {
      const loadKey = `${currentFolder ?? "root"}\u0000${sort}\u0000${sortDirection}`;
      const repeatedEffect = lastLibraryLoadKeyRef.current === loadKey;
      // performance.now() begins at the navigation's first tick. Include the
      // document, bundle, and React startup on the first library load; later
      // folder/sort loads still begin at the interaction that triggered them.
      const loadStarted = repeatedEffect ? loadStartedRef.current : performance.now();
      const totalStarted = lastLibraryLoadKeyRef.current === null
        ? 0
        : repeatedEffect
          ? totalStartedRef.current
          : loadStarted;
      lastLibraryLoadKeyRef.current = loadKey;
      loadStartedRef.current = loadStarted;
      totalStartedRef.current = totalStarted;
      const currentUrl = `${window.location.pathname}${window.location.search}`;
      const snapshot = readBrowseSnapshot(currentUrl, sessionUser?.id);
      if (restoredFromBfcacheRef.current) {
        restoredFromBfcacheRef.current = false;
        if (snapshot && snapshot.items.length > 0) setBackendState("online");
        reportClientPerformance("library_load", performance.now() - loadStarted, {
          snapshot_restore: true,
          folder: currentFolder || "root",
          entries: snapshot?.items.length ?? 0,
          sort,
          sort_direction: sortDirection,
        });
        window.setTimeout(() => {
          if (cancelled) return;
          void loadLibraryBackground();
        }, 5000);
        return;
      }
      await loadLibraryBackground();

      async function loadLibraryBackground() {
      const backgroundLoadStarted = performance.now();
      console.log(`[Navigation] loadLibraryBackground started for folder: "${currentFolder ?? "root"}", sort: ${sort} ${sortDirection}`);
      const libraryRequest = authFetch(libraryApiUrl(sort, sortDirection, currentFolder));
      const librariesRequest = fetch(`${API_BASE}/api/libraries`);
      const userStateRequest = authFetch(`${API_BASE}/api/user-state`);
      const coversRequest = fetch(`${API_BASE}/api/folder-covers?t=${Date.now()}`);
      
      const cacheKey = libraryCachePageKey(currentFolder, sort, sortDirection);
      console.log(`[Cache] Checking cache for user: ${sessionUser?.id}, key: "${cacheKey}"`);
      let cached = libraryCache.current?.userId === sessionUser?.id ? libraryCache.current : null;
      let usedMemoryCache = true;
      if (!cached) {
        usedMemoryCache = false;
        cached = await readLibraryCache(sessionUser?.id);
        if (cached && sessionUser?.id !== undefined) {
           libraryCache.current = cached;
        }
      }
      
      const exactCachedEntries = cached?.pages[cacheKey];
      const rootCachedEntries = cached && !exactCachedEntries ? cachedFolderFromRoot(cached, currentFolder) : null;
      const cachedEntries = exactCachedEntries ?? rootCachedEntries;
      const cacheReadMs = performance.now() - backgroundLoadStarted;
      
      if (!cached) {
        console.log(`[Cache Miss] No cache found at all for user ${sessionUser?.id} (took ${cacheReadMs.toFixed(1)}ms)`);
      } else if (!cachedEntries) {
        console.log(`[Cache Miss] Cache exists, but NO entries found for key: "${cacheKey}" (took ${cacheReadMs.toFixed(1)}ms, memory: ${usedMemoryCache})`);
      } else {
        console.log(`[Cache Hit] Found ${cachedEntries.length} items for key: "${cacheKey}" (took ${cacheReadMs.toFixed(1)}ms, memory: ${usedMemoryCache})`);
      }

      if (cancelled) return;

      if (cached && cachedEntries) {
        if (rootCachedEntries && currentFolder) {
          setServerHasMore(false);
          setServerLoadedCount(rootCachedEntries.length);
          setServerTotal(rootCachedEntries.length);
          setClientFilterLoadedFolderKey(cacheKey);
        }
        const cachedFavoritePaths = new Set(cached.userState.favorites);
        const cachedItems = cachedEntries.map(apiEntryToMediaItem).filter((item): item is MediaItem => item !== null).map((item) => withOpenedMetadata(item, cached.userState.last_accessed ?? {}, cached.userState.playback, {
          tags: [...new Set([...item.tags, ...inheritedTags(item.path, cached.userState.tags)])],
          favorite: item.path ? cachedFavoritePaths.has(item.path) : false,
        }));
        const cacheReadMs = performance.now() - backgroundLoadStarted;
        debugInfoRef.current = { cacheState: "hit", cacheLoadTimeMs: cacheReadMs, folder: currentFolder, serverBatches: [] };
        setDebugInfo(debugInfoRef.current);
        libraryCache.current = cached;
        setItems(cachedItems);
        setFavoritePaths(cached.userState.favorites);
        setLoadedFolder(currentFolder ?? null);
        setSidebarTreeEntries((current) => currentFolder ? { ...current, [currentFolder]: cachedItems } : { ...current, ...indexSidebarTree(cachedItems) });
        setPlayback(cached.userState.playback);
        setLastAccessed(cached.userState.last_accessed ?? {});
        setCustomTags(cached.userState.tags);
        setTagCatalog(cached.userState.tag_catalog ?? {});
        setPlaylists(cached.userState.playlists);
        setActivePlaylistId((current) => current && cached.userState.playlists[current] ? current : null);
        setLibraries(cached.libraries);
        setFolderCovers(cached.folderCovers);
        setTitleMetadata(cached.titleMetadata);
        setBackendState("cached");
      } else if (!items.length || !items.some((item) => item.parent === (currentFolder ?? undefined))) {
        debugInfoRef.current = { cacheState: "miss", cacheLoadTimeMs: cacheReadMs, folder: currentFolder, serverBatches: [] };
        setDebugInfo(debugInfoRef.current);
        setBackendState("loading");
      } else {
        debugInfoRef.current = { cacheState: "miss", cacheLoadTimeMs: cacheReadMs, folder: currentFolder, serverBatches: [] };
        setDebugInfo(debugInfoRef.current);
      }
      try {
        const [response, librariesResponse, userStateResponse, coversResponse] = await Promise.all([
          libraryRequest,
          librariesRequest,
          userStateRequest,
          coversRequest,
        ]);
        if (cancelled) return;
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        const entries = await response.json() as ApiLibraryEntry[];
        setServerHasMore(response.headers.get("x-tms-has-more") === "true");
        setServerLoadedCount(libraryConsumedCount(response, entries.length));
        const totalHeader = response.headers.get("x-tms-total");
        if (currentFolder) setServerTotal(totalHeader ? Number(totalHeader) : entries.length);
        else setServerTotal(0);
        const userState = userStateResponse.ok ? await userStateResponse.json() as UserState : cached?.userState ?? emptyUserState();
        if (cancelled) return;
        const favoritePaths = new Set(userState.favorites);
        const realItems = entries.map(apiEntryToMediaItem).filter((item): item is MediaItem => item !== null).map((item) => withOpenedMetadata(item, userState.last_accessed ?? {}, userState.playback, { tags: [...new Set([...item.tags, ...inheritedTags(item.path, userState.tags)])], favorite: item.path ? favoritePaths.has(item.path) : false }));
        const nextLibraries = librariesResponse.ok ? await librariesResponse.json() as Record<string, LibraryConfig> : cached?.libraries ?? {};
        const nextFolderCovers = coversResponse.ok ? await coversResponse.json() as Record<string, string> : cached?.folderCovers ?? {};
        if (cancelled) return;
        const nextCache: LibraryCache = {
          version: 13,
          userId: sessionUser?.id ?? 0,
          savedAt: Date.now(),
          entries: currentFolder ? cached?.entries ?? [] : entries,
          pages: { ...(cached?.pages ?? {}), [libraryCachePageKey(currentFolder, sort, sortDirection)]: entries },
          favoritePaths: userState.favorites,
          userState,
          libraries: nextLibraries,
          folderCovers: nextFolderCovers,
          titleMetadata: cached?.titleMetadata ?? {},
        };
        console.log(`[Cache Write] Updating memory and DB cache for user: ${sessionUser?.id}, keys present in pages: ${Object.keys(nextCache.pages).length}. Wrote key: "${libraryCachePageKey(currentFolder, sort, sortDirection)}"`);
        libraryCache.current = nextCache;
        void writeLibraryCache(nextCache, true);
        setItems(realItems);
        if (!currentFolder) setFilterCatalog(realItems);
        setLoadedFolder(currentFolder ?? null);
        setAuthoritativeFolder(currentFolder ?? null);
        setSidebarTreeEntries((current) => currentFolder ? { ...current, [currentFolder]: realItems } : { ...current, ...indexSidebarTree(realItems) });
        setPlayback(userState.playback);
        setLastAccessed(userState.last_accessed ?? {});
        applyOrganizationState(userState);
        applyFavoritePaths(userState.favorites);
        setLibraries(nextLibraries);
        setFolderCovers(nextFolderCovers);
        setBackendError("");
        setBackendState("online");
        const apiWaitMs = performance.now() - backgroundLoadStarted;
        debugInfoRef.current = {
          ...debugInfoRef.current,
          serverLoadTimeMs: apiWaitMs,
        };
        setDebugInfo(debugInfoRef.current);
        saveBrowseSnapshot({
          url: `${window.location.pathname}${window.location.search}`,
          folder: currentFolder,
          section,
          query,
          activeSearch,
          activeTags,
          sort,
          sortDirection,
          libraryView,
          scrollY: window.scrollY,
          items: realItems,
          sidebarTreeEntries: currentFolder ? { ...sidebarTreeEntries, [currentFolder]: realItems } : { ...sidebarTreeEntries, ...indexSidebarTree(realItems) },
          trashItems,
          libraries: nextLibraries,
          folderCovers: nextFolderCovers,
          titleMetadata: cached?.titleMetadata ?? titleMetadata,
          playback: userState.playback,
          lastAccessed: userState.last_accessed ?? {},
          customTags: userState.tags,
          tagCatalog: userState.tag_catalog ?? {},
          playlists: userState.playlists,
          activePlaylistId,
          serverHasMore: response.headers.get("x-tms-has-more") === "true",
          serverLoadedCount: entries.length,
          serverTotal: currentFolder ? (totalHeader ? Number(totalHeader) : entries.length) : undefined,
          clientVisibleLimit: LIBRARY_PAGE_SIZE,
          userId: sessionUser?.id,
        });
        reportClientPerformance("library_server_load", performance.now() - loadStarted, {
          cache_hit: Boolean(cached),
          cache_read_ms: Math.round(cacheReadMs),
          // This is the serialized IndexedDB record size, so it reflects the
          // actual per-user library cache payload rather than disk quota.
          // Do not stringify the recursive library cache on the UI thread just
          // for telemetry. IndexedDB owns the durable cache size and the full
          // serialization used to freeze Favorites while a refresh completed.
          cache_size_bytes: null,
          api_wait_ms: Math.round(apiWaitMs),
          folder: currentFolder || "root",
          entries: entries.length,
          sort,
          sort_direction: sortDirection,
        });
      } catch (error) {
        if (cancelled || isAbortError(error)) return;
        setBackendError(error instanceof Error ? error.message : "Could not reach the server");
        // A slow or failed library request alone does not mean the server is
        // gone; only switch to Offline when its health check agrees.
        const reachable = await fetch(`${API_BASE}/api/health`, { cache: "no-store", signal: AbortSignal.timeout(8_000) })
          .then((response) => response.ok, () => false);
        if (cancelled || reachable) return;
        setBackendState("offline");
        setSection("offline");
        setCurrentFolder(null);
        void refreshOfflineDownloads();
      }
      }
    };
    void loadLibrary().catch(() => undefined);
    return () => { cancelled = true; };
  }, [currentFolder, playlistsOffline, section, sort, sortDirection]);

  // Direct links can start inside a library, so fetch the root independently
  // when it was not the page that populated the grid.
  useEffect(() => {
    // The normal root load already returns and indexes these entries. Starting
    // this second request on `/` doubled the largest startup payload.
    if (currentFolder === null) return;
    let cancelled = false;
    void authFetch(libraryApiUrl("name", "asc"))
      .then(async (response) => {
        if (!response.ok) return;
        const entries = await response.json() as ApiLibraryEntry[];
        if (cancelled) return;
        const rootItems = entries.map(apiEntryToMediaItem).filter((item): item is MediaItem => item !== null);
        setFilterCatalog(rootItems);
        setSidebarTreeEntries((current) => ({ ...current, ...indexSidebarTree(rootItems) }));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [sessionUser?.id]);

  useEffect(() => {
    // The server creates one persisted image at a time. Do not ask for covers
    // from card rendering: scrolling must never start browser video decoding or
    // a burst of FFmpeg work.
    if (!canManageLibraries || !currentFolder || !items.length) return;
    const folders = items
      .filter((item) => item.kind === "folder")
      .map((item) => mediaPath(item))
      // Catalog folders deliberately use fetched movie/show/season art. Do
      // not create a persistent frame or image from an arbitrary descendant.
      .filter((path): path is string => Boolean(path && !folderCovers[path] && libraries[path.split("/")[0]]?.content_type !== "movies_tv"));
    if (!folders.length) return;
    let cancelled = false;
    const createCovers = async () => {
      for (const folderPath of folders) {
        if (cancelled || automaticFolderCoverRequests.current.has(folderPath)) continue;
        automaticFolderCoverRequests.current.add(folderPath);
        try {
          const response = await authFetch(`${API_BASE}/api/folder-covers/automatic`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ folder_path: folderPath }),
          });
          if (!response.ok || cancelled) continue;
          const result = await response.json() as { filename?: string };
          if (!result.filename || cancelled) continue;
          setFolderCovers((current) => ({ ...current, [folderPath]: result.filename! }));
          updateLibraryCache((current) => ({
            ...current,
            folderCovers: { ...current.folderCovers, [folderPath]: result.filename! },
          }));
        } catch {
          // A missing codec or a media file that vanished should leave its
          // normal folder glyph in place without disrupting the library.
        }
      }
    };
    void createCovers();
    return () => { cancelled = true; };
  }, [canManageLibraries, currentFolder, folderCovers, items, libraries]);
  useEffect(() => {
    if (!settingsOpen) return;
    const modal = document.querySelector<HTMLElement>(".profile-settings-backdrop");
    const background = modal?.parentElement ? Array.from(modal.parentElement.children).filter((node): node is HTMLElement => node instanceof HTMLElement && node !== modal && !node.inert) : [];
    background.forEach(node => { node.inert = true; });
    return () => { background.forEach(node => { node.inert = false; }); };
  }, [settingsOpen]);
  useEffect(() => {
    if (!settingsOpen) return;
    setSettingsError("");
    void authFetch(`${API_BASE}/api/profile/sessions`).then(async (response) => {
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      setDeviceSessions(await response.json() as DeviceSession[]);
    }).catch(() => setSettingsError("Could not load profile settings."));
    void authFetch(`${API_BASE}/api/user-state`).then(async (response) => {
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const state = await response.json() as UserState;
      setPlaybackPreferences(playbackPreferencesFromState(state.playback_preferences));
    }).catch(() => setSettingsError("Could not load playback preferences."));
    void authFetch(`${API_BASE}/api/storage/quota`).then(async (response) => {
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      setStorageQuota(await response.json() as StorageQuota);
    }).catch(() => setSettingsError("Could not load storage usage."));
  }, [settingsOpen]);

  useEffect(() => {
    const restoreFromUrl = () => {
      restoringHistory.current = true;
      const params = new URLSearchParams(window.location.search);
      const nextQuery = params.get("q") ?? "";
      const requestedSection = params.get("section");
      const nextSection = requestedSection === "downloads" ? "offline" : requestedSection;
      const nextFolder = params.get("folder");
      const nextPlaylist = params.get("playlist");
      const nextTags = params.getAll("tag");
      const nextSort = params.get("sort");
      const nextDirection = params.get("direction");
      const nextMagnet = params.get("magnet")?.trim();
      const nextOffline = params.get("offline");
      const nextOfflinePath = params.get("offlinePath") ?? "";

      if (params.get("settings") === "1") {
        setSettingsOpen(true);
        params.delete("settings");
        const cleanQuery = params.toString();
        window.history.replaceState(null, "", `${window.location.pathname}${cleanQuery ? `?${cleanQuery}` : ""}`);
      }

      const savedBrowsePrefs = readLibraryBrowsePrefs(nextFolder);
      if (nextQuery) {
        setQuery(nextQuery);
        setActiveSearch(nextQuery);
        setSection("library");
        setCurrentFolder(null);
        setPendingOfflineUrl(null);
        setActivePlaylistId(null);
        setActiveTags([]);
      } else {
        setActiveSearch("");
        if (nextSection === "discover" || nextSection === "library" || nextSection === "recent" || nextSection === "new" || nextSection === "favorites" || nextSection === "playlists" || nextSection === "offline" || nextSection === "trash" || (nextSection === "notes" && canAccessNotes)) setSection(nextSection);
        else setSection("library");
        const folderIsRelevant = !nextSection || nextSection === "library" || nextSection === "offline";
        if (nextSection === "offline" && nextOffline && !nextFolder) {
          setPendingOfflineUrl({ bundleId: nextOffline, relativePath: nextOfflinePath });
          setCurrentFolder(null);
        } else {
          setPendingOfflineUrl(null);
          setCurrentFolder(folderIsRelevant ? nextFolder || null : null);
        }
        setActivePlaylistId(nextSection === "playlists" ? nextPlaylist || null : null);
        setActiveTags(normalizeActiveTags(nextTags.length ? nextTags : [savedBrowsePrefs.tag]));
      }
      setSort(validSortField(nextSort) ?? savedBrowsePrefs.sort);
      setSortDirection(nextDirection === "asc" ? "asc" : nextDirection === "desc" ? "desc" : savedBrowsePrefs.sortDirection);
      setLibraryView(savedBrowsePrefs.view);
      if (nextMagnet?.toLowerCase().startsWith("magnet:?") && nextMagnet.length <= 8192) {
        window.setTimeout(() => setIncomingMagnet(nextMagnet), 0);
        params.delete("magnet");
        const cleanQuery = params.toString();
        window.history.replaceState(null, "", `${window.location.pathname}${cleanQuery ? `?${cleanQuery}` : ""}`);
      }

      if (nextFolder && !nextQuery && (!nextSection || nextSection === "library")) {
        const parts = nextFolder.split("/");
        setExpandedFolders(parts.map((_, index) => parts.slice(0, index + 1).join("/")));
      }
    };

    restoreFromUrl();
    urlStateReady.current = true;
    window.addEventListener("popstate", restoreFromUrl);
    return () => window.removeEventListener("popstate", restoreFromUrl);
  }, []);

  useLayoutEffect(() => {
    if (typeof window === "undefined") return;
    if ("scrollRestoration" in window.history) window.history.scrollRestoration = "manual";
  }, []);

  useLayoutEffect(() => {
    const snapshot = readBrowseSnapshot(typeof window !== "undefined" ? window.location.pathname + window.location.search : undefined, sessionUser?.id);
    if (!snapshot || typeof snapshot.scrollY !== "number" || snapshot.scrollY <= 0) return;
    pendingScrollYRef.current = snapshot.scrollY;
    return restoreBrowseScroll(snapshot.scrollY, () => {
      pendingScrollYRef.current = null;
    });
  }, [sessionUser?.id]);

  useEffect(() => {
    if (pendingScrollYRef.current == null) return;
    return restoreBrowseScroll(pendingScrollYRef.current, () => {
      pendingScrollYRef.current = null;
    });
  }, [backendState, items.length]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => updateSnapshotScroll(window.scrollY), 120);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!urlStateReady.current) return;
    if (restoringHistory.current) {
      restoringHistory.current = false;
      return;
    }

    const params = new URLSearchParams();
    if (activeSearch.trim()) params.set("q", activeSearch.trim());
    else {
      if (section !== "library") params.set("section", section);
      if (currentFolder && (section === "library" || section === "offline")) params.set("folder", currentFolder);
      if (section === "playlists" && activePlaylistId) params.set("playlist", activePlaylistId);
      activeTags.forEach((tag) => params.append("tag", tag));
    }
    if (section === "discover") {
      const current = new URLSearchParams(window.location.search);
      ["dq", "dkind"].forEach((key) => {
        const value = current.get(key);
        if (value) params.set(key, value);
      });
    }
    if (sort !== "opened") params.set("sort", sort);
    if (sortDirection !== "desc") params.set("direction", sortDirection);
    const queryString = params.toString();
    const nextUrl = `${activeSearch.trim() ? "/search" : "/"}${queryString ? `?${queryString}` : ""}`;
    const currentUrl = `${window.location.pathname}${window.location.search}`;
    if (nextUrl !== currentUrl) window.history.pushState(null, "", nextUrl);
  }, [activePlaylistId, activeSearch, activeTags, currentFolder, section, sort, sortDirection]);

  useEffect(() => {
    if (!sessionUser) return;
    let cancelled = false;
    const refreshDownloadedMedia = async () => {
      const response = await authFetch(libraryApiUrl(sort, sortDirection, currentFolder));
      if (!response.ok) return;
      const entries = await response.json() as ApiLibraryEntry[];
      if (cancelled) return;
      setItems((current) => {
        const existingByPath = new Map(current.flatMap((item) => item.path ? [[item.path, item] as const] : []));
        return entries
          .map(apiEntryToMediaItem)
          .filter((item): item is MediaItem => item !== null)
          .map((item) => {
            const existing = item.path ? existingByPath.get(item.path) : undefined;
            return existing
              ? { ...item, favorite: existing.favorite, lastPlayed: existing.lastPlayed, lastOpenedAt: existing.lastOpenedAt, tags: existing.tags }
              : item;
          });
      });
      if (!currentFolder) updateLibraryCache((current) => ({ ...current, entries }));
    };
    const loadMagnetProgress = async () => {
      try {
        const response = await authFetch(`${API_BASE}/api/downloads/magnet`);
        if (!response.ok) return;
        const result = await response.json() as BackgroundMagnetStatus;
        if (cancelled) return;
        // The server skips qBittorrent once no TMS download is active (the last
        // one just finished), so an unchecked response is an empty list.
        if (result.connected === false && result.qbittorrent_checked !== false) {
          // qBittorrent cannot enumerate its torrents while its Web UI is
          // down. Keep the last known cards visible so an empty response is
          // never mistaken for a completed download.
          setBackgroundMagnetStatus(result.message || "qBittorrent is unavailable. TMS is restarting it…");
          return;
        }
        setBackgroundMagnetStatus("");
        const trackedDownloads = result.downloads ?? [];
        const activeDownloads = trackedDownloads.filter((download) => !download.complete && !download.stopped);
        const nextHashes = new Set(trackedDownloads.map((download) => download.hash));
        trackedDownloads.forEach((download) => magnetDownloadNames.current.set(download.hash, download.name));
        const completedHashes = [...activeMagnetHashes.current].filter((hash) => !nextHashes.has(hash));
        if (completedHashes.length) {
          // Organization happens just after completion and can be delayed by a
          // short Windows file lock. Keep rescanning while that settles.
          downloadLibraryRefreshUntil.current = Date.now() + 30_000;
          const completedNames = completedHashes
            .filter((hash) => !ignoredMagnetCompletionHashes.current.has(hash))
            .map((hash) => magnetDownloadNames.current.get(hash) ?? "Magnet download");
          completedHashes.forEach((hash) => {
            ignoredMagnetCompletionHashes.current.delete(hash);
            magnetDownloadNames.current.delete(hash);
          });
          if (completedNames.length === 1) {
            flash(`Download complete: ${completedNames[0]}`);
          } else if (completedNames.length > 1) {
            flash(`${completedNames.length} downloads complete`);
          }
        }
        activeMagnetHashes.current = nextHashes;
        setBackgroundMagnetDownloads(activeDownloads);
        setHiddenMagnetHashes((current) => current.filter((hash) => nextHashes.has(hash)));
        if (
          Date.now() < downloadLibraryRefreshUntil.current
          && Date.now() - lastDownloadLibraryRefresh.current >= 1_500
        ) {
          lastDownloadLibraryRefresh.current = Date.now();
          await refreshDownloadedMedia();
        }
      } catch {
        // Modal readiness errors are shown in the modal; background status stays unobtrusive.
      }
    };
    void loadMagnetProgress();
    let timeout: number | undefined;
    const poll = async () => {
      await loadMagnetProgress();
      if (!cancelled) timeout = window.setTimeout(() => void poll(), 750);
    };
    void poll();
    return () => { cancelled = true; if (timeout !== undefined) window.clearTimeout(timeout); };
  }, [currentFolder, sessionUser, sort, sortDirection]);

  useEffect(() => {
    if (!sessionUser) return;
    let cancelled = false;
    let timeout: number | undefined;
    const poll = async () => {
      try {
        const response = await authFetch(`${API_BASE}/api/downloads/yt-dlp`);
        if (response.ok) {
          const jobs = await response.json() as YtDlpJob[];
          if (!cancelled) {
            const activeJobs = jobs.filter((job) => !["complete", "completed", "cancelled"].includes(job.status));
            const nextActiveJobIds = new Set(activeJobs.map((job) => job.id));
            activeJobs.forEach((job) => {
              activeYtDlpJobTitles.current.set(job.id, job.title);
            });
            const finishedJobIds = Array.from(activeYtDlpJobIds.current).filter((id) => !nextActiveJobIds.has(id));
            const completedNames = finishedJobIds.map((id) => {
              const title = activeYtDlpJobTitles.current.get(id) || "Server download";
              activeYtDlpJobTitles.current.delete(id);
              return title;
            });
            activeYtDlpJobIds.current = nextActiveJobIds;
            setYtDlpJobs(activeJobs);
            if (completedNames.length) {
              const [libraryResponse, userStateResponse] = await Promise.all([
                authFetch(libraryApiUrl(sort, sortDirection, currentFolder)),
                authFetch(`${API_BASE}/api/user-state`),
              ]);
              if (libraryResponse.ok && !cancelled) {
                const entries = await libraryResponse.json() as ApiLibraryEntry[];
                const userState = userStateResponse.ok
                  ? await userStateResponse.json() as UserState
                  : null;
                if (userState) {
                  applyOrganizationState(userState);
                  applyFavoritePaths(userState.favorites);
                }
                const pendingFav = pendingOfflineFavoriteOverrides();
                const favorites = new Set(userState?.favorites ?? favoritePaths);
                Object.entries(pendingFav).forEach(([path, favorite]) => {
                  if (favorite) favorites.add(path);
                  else favorites.delete(path);
                });
                const tagsByPath = userState?.tags ?? customTags;
                setItems(
                  entries
                    .map(apiEntryToMediaItem)
                    .filter((item): item is MediaItem => item !== null)
                    .map((item) => ({
                      ...item,
                      tags: [
                        ...new Set([
                          ...item.tags,
                          ...inheritedTags(item.path, tagsByPath),
                        ]),
                      ],
                      favorite: Boolean(item.path && favorites.has(item.path)),
                    })),
                );
                if (!currentFolder) updateLibraryCache((current) => ({ ...current, entries }));
                flash(completedNames.length === 1 ? `Download complete: ${completedNames[0]}` : `${completedNames.length} server downloads complete`);
              }
            }
          }
        }
      } catch {}
      if (!cancelled) timeout = window.setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timeout !== undefined) window.clearTimeout(timeout);
    };
  }, [currentFolder, sessionUser, sort, sortDirection]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (event.key === "Escape" && preview) {
        setPreview(null);
        return;
      }
      if (event.ctrlKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInput.current?.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [preview]);

  // Track the destination rather than individual buttons, including search,
  // context menus, direct links, and the playlist selector.
  const openedCollectionKey = section === "playlists" && activePlaylistId
    ? `playlist:${activePlaylistId}`
    : section === "library" && activeTags.length === 1 ? `tag:${activeTags[0]}` : null;
  useEffect(() => {
    if (!openedCollectionKey || sessionUser?.id === undefined) return;
    const next = { ...readCollectionLastOpened(sessionUser.id), [openedCollectionKey]: Date.now() };
    setCollectionLastOpened(next);
    try { window.localStorage.setItem(collectionOpenedStorageKey(sessionUser.id), JSON.stringify(next)); } catch {}
  }, [openedCollectionKey, sessionUser?.id]);

  const allSystemTags = useMemo(() => {
    return [...new Set([
      ...Object.keys(tagCatalog),
      ...Object.values(customTags).flat(),
    ])];
  }, [customTags, tagCatalog]);

  const tagItemCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const itemTags of Object.values(customTags)) {
      for (const itemTag of itemTags) {
        counts.set(itemTag, (counts.get(itemTag) ?? 0) + 1);
      }
    }
    return counts;
  }, [customTags]);

  const sidebarTags = useMemo(() => [...allSystemTags]
    .map((name) => ({
      name,
      count: tagItemCounts.get(name) ?? 0,
      openedAt: collectionLastOpened[`tag:${name}`] ?? 0,
    }))
    .sort((left, right) => (
      tagSidebarSort === "name"
        ? left.name.localeCompare(right.name)
        : tagSidebarSort === "opened"
          ? right.openedAt - left.openedAt || left.name.localeCompare(right.name)
          : right.count - left.count || left.name.localeCompare(right.name)
    )), [allSystemTags, collectionLastOpened, tagItemCounts, tagSidebarSort]);

  const sidebarPlaylists = useMemo(() => Object.values(playlists)
    .sort((left, right) => (
      playlistSidebarSort === "name"
        ? left.name.localeCompare(right.name)
        : playlistSidebarSort === "opened"
          ? (collectionLastOpened[`playlist:${right.id}`] ?? 0) - (collectionLastOpened[`playlist:${left.id}`] ?? 0) || left.name.localeCompare(right.name)
          : right.paths.length - left.paths.length || left.name.localeCompare(right.name)
    )), [collectionLastOpened, playlistSidebarSort, playlists]);
  const visibleSidebarTags = sidebarShowAll.tags ? sidebarTags : sidebarTags.slice(0, 4);
  const visibleSidebarPlaylists = sidebarShowAll.playlists ? sidebarPlaylists : sidebarPlaylists.slice(0, 4);
  // Server media cannot play offline, so playlists show their downloaded items.
  const playlistSourceItems = backendState === "offline" ? offlineAllMediaItems : items;
  const playlistBrowseCards = useMemo(() => {
    const mediaByPath = new Map<string, MediaItem>();
    for (const item of [...(backendState === "offline" ? [] : Object.values(sidebarTreeEntries).flat()), ...playlistSourceItems]) {
      if (item.path && !item.trashed) mediaByPath.set(item.path, item);
    }
    return Object.values(playlists).map((playlist) => {
      const members = playlist.paths.map((path) => mediaByPath.get(path)).filter((item): item is MediaItem => Boolean(item));
      const tags = [...new Set(playlist.paths.flatMap((path) => inheritedTags(path, customTags)))].sort((a, b) => a.localeCompare(b));
      const coverCandidates = members.filter((item) => (item.kind === "image" || item.kind === "video") && item.src);
      const cover = coverCandidates.length ? coverCandidates[stableId(`playlist-cover:${playlist.id}`) % coverCandidates.length] : null;
      return { playlist, tags, cover };
    });
  }, [backendState, playlists, playlistSourceItems, sidebarTreeEntries, customTags]);
  const playlistBrowseAvailableTags = useMemo(() => [...new Set(playlistBrowseCards.flatMap((card) => card.tags))].sort((a, b) => a.localeCompare(b)), [playlistBrowseCards]);
  const filteredPlaylistCards = useMemo(() => {
    const search = playlistBrowseQuery.trim().toLowerCase();
    return playlistBrowseCards.filter(({ playlist, tags }) =>
      (!search || playlist.name.toLowerCase().includes(search)) && playlistBrowseTags.every((tag) => tags.includes(tag)),
    ).sort((left, right) => {
      const comparison = playlistBrowseSort === "name"
        ? left.playlist.name.localeCompare(right.playlist.name)
        : playlistBrowseSort === "count"
          ? left.playlist.paths.length - right.playlist.paths.length
          : (left.playlist.updated_at ?? left.playlist.created_at) - (right.playlist.updated_at ?? right.playlist.created_at);
      return (playlistBrowseDirection === "asc" ? comparison : -comparison) || left.playlist.name.localeCompare(right.playlist.name);
    });
  }, [playlistBrowseCards, playlistBrowseQuery, playlistBrowseTags, playlistBrowseSort, playlistBrowseDirection]);

  const { filters: filterTags, commonTags } = useMemo(() => {
    let scopedMedia: MediaItem[];
    if (section === "offline") {
      const bundle = offlineBrowseLocation
        ? offlineBundles.find((candidate) => candidate.id === offlineBrowseLocation.bundleId)
        : null;
      const offlineFiles = offlineBrowseLocation
        ? offlineBrowseItems.filter((item) => item.kind !== "folder")
        : offlineAllMediaItems;
      if (bundle?.path) {
        const libraryScoped = items.filter((item) => (
          item.kind !== "folder"
          && !item.trashed
          && Boolean(item.path)
          && (
            item.parent === bundle.path
            || item.parent?.startsWith(`${bundle.path}/`)
            || item.path === bundle.path
            || offlineFiles.some((offline) => offline.path === item.path)
          )
        ));
        if (libraryScoped.length) {
          const merged = new Map<string, MediaItem>();
          for (const item of [...libraryScoped, ...offlineFiles]) {
            if (!item.path) continue;
            const current = merged.get(item.path);
            if (!current) {
              merged.set(item.path, item);
              continue;
            }
            merged.set(item.path, {
              ...current,
              tags: [...new Set([...current.tags, ...item.tags])],
              favorite: Boolean(current.favorite || item.favorite),
            });
          }
          scopedMedia = [...merged.values()];
        } else {
          scopedMedia = offlineFiles;
        }
      } else {
        scopedMedia = offlineFiles;
      }
    } else {
      // The root catalog includes later pages and descendants. Overlay the
      // current page and user tags so counts cover the whole folder scope.
      const source = section === "library"
        ? [...new Map([...filterCatalog, ...items].map((item) => [item.path ?? item.id, item])).values()]
        : section === "playlists" ? playlistSourceItems : items;
      scopedMedia = source.filter((item) => {
        if (item.kind === "folder") return false;
        if (section === "recent") return !item.trashed && Boolean(item.lastOpenedAt);
        if (section === "new") return !item.trashed && (item.addedAt ?? 0) >= (Date.now() / 1000) - NEW_ITEMS_WINDOW_SECONDS;
        if (section === "favorites") return !item.trashed && Boolean(item.favorite);
        if (section === "playlists") return Boolean(item.path && activePlaylistId && playlists[activePlaylistId]?.paths.includes(item.path));
        if (section === "trash") return Boolean(item.trashed);
        if (item.trashed) return false;
        if (!currentFolder) return true;
        return item.parent === currentFolder || item.parent?.startsWith(`${currentFolder}/`);
      });
      if (section === "library") scopedMedia = scopedMedia.map((item) => ({
        ...item, tags: [...new Set([...item.tags, ...inheritedTags(item.path, customTags)])],
      }));
    }
    const favoritesCount = scopedMedia.filter((item) => item.favorite).length;
    const showFavorites = section === "library" || section === "offline" || (section === "playlists" ? favoritesCount > 0 : favoritesCount > 0 && favoritesCount < scopedMedia.length);
    return browseTagFilters(scopedMedia, showFavorites);
  }, [activePlaylistId, currentFolder, customTags, filterCatalog, items, offlineAllMediaItems, offlineBrowseItems, offlineBrowseLocation, offlineBundles, playlistSourceItems, playlists, section]);

  const searchSuggestionsPanel = useRef<HTMLDivElement>(null);
  useEffect(() => { if (searchSuggestionsPanel.current) searchSuggestionsPanel.current.scrollTop = 0; }, [query, searchCaret]);
  const completionContext = searchCompletionContext(query, searchCaret);
  const allSearchSuggestions = useMemo(() => buildSearchSuggestions({
    query, caret: searchCaret, items: [...items, ...Object.values(sidebarTreeEntries).flat()],
    libraries, user: sessionUser, previousSearches, recentFolders,
  }), [items, libraries, previousSearches, query, recentFolders, searchCaret, sessionUser, sidebarTreeEntries]);
  const searchSuggestions = compactScreen ? allSearchSuggestions.filter(suggestion => query.trim() || suggestion.kind === "search" || suggestion.kind === "folder").slice(0, 5) : allSearchSuggestions;
  useEffect(() => {
    if (selectedSuggestion) document.getElementById(`suggestion-${selectedSuggestion}`)?.scrollIntoView({ block: "nearest" });
  }, [selectedSuggestion]);
  const isServerPagedFolder = Boolean(currentFolder && section === "library" && !activeSearch.trim() && !query.trim() && activeTags.length === 0);
  const recursiveFavorites = section === "library" && Boolean(currentFolder) && activeTags.includes(FAVORITES_FILTER);
  const favoriteBrowseItems = useMemo(() => {
    if (!recursiveFavorites) return items;
    // Folder pages contain immediate children only. The sidebar's root
    // catalog includes every descendant, so use it for recursive favorites.
    // Prefer freshly loaded folder items and reapply current user metadata.
    const catalog = new Map<string, MediaItem>();
    for (const item of [...Object.values(sidebarTreeEntries).flat(), ...items]) {
      if (item.parent === currentFolder || item.parent?.startsWith(`${currentFolder}/`)) catalog.set(item.id, item);
    }
    const favorites = new Set(favoritePaths);
    return [...catalog.values()].map((item) => withOpenedMetadata(item, lastAccessed, playback, {
      tags: [...new Set([...item.tags, ...inheritedTags(item.path, customTags)])],
      favorite: Boolean(item.path && favorites.has(item.path)),
    }));
  }, [recursiveFavorites, items, sidebarTreeEntries, currentFolder, favoritePaths, lastAccessed, playback, customTags]);
  const visible = useMemo(() => {
    let next: MediaItem[];
    if (section === "recent") next = items.filter((item) => !item.trashed && item.kind !== "folder" && item.lastOpenedAt);
    else if (section === "new") next = items.filter((item) => !item.trashed && item.kind !== "folder" && (item.addedAt ?? 0) >= (Date.now() / 1000) - NEW_ITEMS_WINDOW_SECONDS);
    else if (section === "favorites") next = items.filter((item) => !item.trashed && item.favorite);
    else if (section === "playlists") {
      const paths = new Set(activePlaylistId ? playlists[activePlaylistId]?.paths ?? [] : []);
      next = playlistSourceItems.filter((item) => Boolean(item.path && paths.has(item.path)));
      if (activeTags.length) next = next.filter((item) => activeTags.every((tag) => tag === FAVORITES_FILTER ? Boolean(item.favorite) : item.tags.includes(tag)));
    }
    else if (section === "trash") next = trashItems;
    else if (section === "notes") next = [];
    else if (section === "discover") next = [];
    else {
      const offlineRootFilter = section === "offline" && !currentFolder && (activeTags.length > 0 || activeSearch.trim() || query.trim());
      const sourceItems = section === "offline" ? (offlineRootFilter ? offlineAllMediaItems : offlineBrowseItems) : favoriteBrowseItems;
      // Preserve the original Favorites view: it includes favorite folders as
      // well as files. Combining Favorites with a tag intentionally narrows to
      // media, because folders do not carry media tags.
      if (activeTags.length === 1 && activeTags[0] === FAVORITES_FILTER) next = sourceItems.filter((item) => !item.trashed && item.favorite && (!currentFolder || item.parent === currentFolder || item.parent?.startsWith(`${currentFolder}/`)));
      else if (activeTags.length) next = sourceItems.filter((item) => !item.trashed && item.kind !== "folder" && (!currentFolder || item.parent === currentFolder || item.parent?.startsWith(`${currentFolder}/`)));
      else if (activeSearch.trim()) {
        const searchTerm = query.trim() || activeSearch.trim();
        const searchFilters = parseSearchQuery(searchTerm).filters;
        const searchesTrash = searchFilters.is.some((value) => fuzzyMatches(value, "trashed") || fuzzyMatches(value, "deleted"));
        next = sourceItems.filter((item) => (searchesTrash || !item.trashed) && matchesSearchQuery(item, searchTerm));
      }
      else if (query.trim()) {
        const searchFilters = parseSearchQuery(query).filters;
        const searchesTrash = searchFilters.is.some((value) => fuzzyMatches(value, "trashed") || fuzzyMatches(value, "deleted"));
        next = sourceItems.filter((item) => (searchesTrash || !item.trashed) && (!currentFolder || item.parent === currentFolder || item.parent?.startsWith(`${currentFolder}/`)));
      }
      else next = sourceItems.filter((item) => !item.trashed && item.parent === (currentFolder ?? undefined));
      if (activeTags.some((tag) => tag !== FAVORITES_FILTER)) next = next.filter((item) =>
        item.kind !== "folder" && activeTags.every((tag) => tag === FAVORITES_FILTER ? item.favorite : item.tags.includes(tag)),
      );
    }
    if (["recent", "new", "favorites"].includes(section) && activeTags.length) {
      next = next.filter((item) => activeTags.every((tag) => tag === FAVORITES_FILTER ? item.favorite : item.tags.includes(tag)));
    }
    if (!activeSearch.trim() && query.trim()) next = next.filter((item) => matchesSearchQuery(item, query));
    if (section !== "offline" && !playlistsOffline && !sessionUser?.is_admin) next = next.filter((item) => {
      const libraryPath = (item.parent ?? item.name).split("/")[0];
      return libraries[libraryPath]?.members.some((member) => member.can_view && member.name.toLowerCase() === sessionUser?.name.toLowerCase());
    });
    // A paged folder with more results still relies on the server's global
    // order. A fully loaded folder must sort its cached entries locally too,
    // otherwise a newly recorded "Last opened" value is hidden until a later
    // network refresh replaces the cache.
    if (isServerPagedFolder && serverHasMore) return next;
    const effectiveSort: SortField = section === "trash" || section === "new" ? "date" : section === "recent" ? "opened" : sort;
    const effectiveDirection: SortDirection = section === "trash" || section === "recent" || section === "new" ? "desc" : sortDirection;
    const direction = effectiveDirection === "asc" ? 1 : -1;
    const currentParts = currentFolder?.split("/") ?? [];
    const currentIsShow = section === "library" && currentParts.length > 1 && libraries[currentParts[0]]?.content_type === "movies_tv" && mediaEvidenceForFolder(items, currentFolder!).kind === "series";
    next = [...next].sort((a, b) => {
      if (currentIsShow && a.kind === "folder" && b.kind === "folder") {
        const aPath = a.parent ? `${a.parent}/${a.name}` : a.name;
        const bPath = b.parent ? `${b.parent}/${b.name}` : b.name;
        const collectionOrder = titleCollectionSortOrder(titleCollectionForFolder(items, aPath)) - titleCollectionSortOrder(titleCollectionForFolder(items, bPath));
        if (collectionOrder) return collectionOrder;
      }
      if (a.kind === "folder" && b.kind !== "folder") return -1;
      if (a.kind !== "folder" && b.kind === "folder") return 1;
      const comparison = effectiveSort === "name" ? a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })
        : effectiveSort === "size" ? (a.sizeBytes ?? 0) - (b.sizeBytes ?? 0)
        : effectiveSort === "length" ? (a.duration ?? 0) - (b.duration ?? 0)
          : effectiveSort === "type" ? a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, undefined, { numeric: true })
            // "Last opened" falls back to when an item was added for media
            // this user has never opened. This keeps one chronological order
            // instead of forcing every unopened item to the bottom.
            : effectiveSort === "opened" ? (a.lastOpenedAt ?? a.addedAt ?? 0) - (b.lastOpenedAt ?? b.addedAt ?? 0)
              : (a.addedAt ?? 0) - (b.addedAt ?? 0);
      // Offline files in one bundle share a download timestamp. Give equal
      // values a stable order so either direction still changes their order.
      return (comparison || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }) || (a.path ?? "").localeCompare(b.path ?? "")) * direction;
    });
    return next;
  }, [activePlaylistId, activeSearch, activeTags, currentFolder, favoriteBrowseItems, isServerPagedFolder, items, libraries, offlineAllMediaItems, offlineBrowseItems, playlistSourceItems, playlists, playlistsOffline, query, section, serverHasMore, sessionUser?.is_admin, sessionUser?.name, sort, sortDirection, trashItems]);
  const currentLibraryPath = currentFolder?.split("/")[0] ?? null;
  const currentLibrary = currentLibraryPath ? libraries[currentLibraryPath] ?? defaultLibraryConfig() : null;
  const currentLibraryType = currentLibrary?.content_type ?? "mixed";
  const useMixedListView = (compactScreen && section === "recent") || libraryView === "list" && (
    section === "offline"
    || ((currentLibraryType === "mixed" || currentLibraryType === "music") && (Boolean(currentFolder) || Boolean(activeSearch.trim()) || Boolean(query.trim())))
  );
  const canUploadToPath = (path: string) => {
    const library = libraries[path.split("/")[0]];
    return Boolean(sessionUser?.is_admin || library?.members.some((member) => member.name.toLowerCase() === sessionUser?.name.toLowerCase() && member.can_upload));
  };
  const canDownloadToPath = (path: string) => {
    const library = libraries[path.split("/")[0]];
    return Boolean(!library?.folder_structure_static && (sessionUser?.is_admin || library?.members.some((member) => member.name.toLowerCase() === sessionUser?.name.toLowerCase() && member.can_download)));
  };
  const canCreateFolderAtPath = (path: string) => {
    const library = libraries[path.split("/")[0]];
    return Boolean(!library?.folder_structure_static && (sessionUser?.is_admin || library?.members.some((member) => member.name.toLowerCase() === sessionUser?.name.toLowerCase() && member.can_create_folders)));
  };
  const folderActionPath = section === "library" && currentFolder ? currentFolder : null;
  const canCreateFolderHere = Boolean(folderActionPath && canCreateFolderAtPath(folderActionPath));
  const canUploadHere = Boolean(folderActionPath && canUploadToPath(folderActionPath));
  const canMagnetToPath = (path: string) => canDownloadToPath(path);
  const canServerDownloadHere = Boolean(folderActionPath && canDownloadToPath(folderActionPath));
  const magnetLibraries = Object.entries(libraries)
    .filter(([path]) => canMagnetToPath(path))
    .sort(([left], [right]) => left.localeCompare(right));
  const magnetDestinations = magnetLibraries.flatMap(([libraryPath]) => [
    libraryPath,
    ...items
      .filter((item) => item.kind === "folder" && !item.trashed)
      .map(mediaPath)
      .filter((path) => path.startsWith(`${libraryPath}/`) && canMagnetToPath(path)),
  ]).filter((path, index, paths) => paths.indexOf(path) === index)
    .sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right));
  const visibleBackgroundMagnetDownloads = backgroundMagnetDownloads.filter(
    (download) => !hiddenMagnetHashes.includes(download.hash),
  );
  const serverDownloadDestinations = Object.entries(libraries)
    .filter(([path]) => canDownloadToPath(path))
    .flatMap(([libraryPath, library]) => [
      { path: libraryPath, contentType: library.content_type },
      ...items
        .filter((item) => item.kind === "folder" && !item.trashed)
        .map(mediaPath)
        .filter((path) => path.startsWith(`${libraryPath}/`))
        .map((path) => ({ path, contentType: library.content_type })),
    ])
    .filter((item, index, all) => all.findIndex((other) => other.path === item.path) === index)
    .sort((left, right) => left.path.split("/").length - right.path.split("/").length || left.path.localeCompare(right.path));
  const defaultIncomingMagnetDestination = Object.entries(libraries)
    .filter(([path, library]) => library.content_type === "movies_tv" && canDownloadToPath(path))
    .sort(([left], [right]) => {
      const leftName = left.toLowerCase();
      const rightName = right.toLowerCase();
      const leftPreferred = leftName.includes("shows") && (leftName.includes("movies") || leftName.includes("moives"));
      const rightPreferred = rightName.includes("shows") && (rightName.includes("movies") || rightName.includes("moives"));
      return Number(rightPreferred) - Number(leftPreferred) || left.localeCompare(right);
    })[0]?.[0];
  const canDeleteItem = (item: MediaItem) => {
    if (item.offline || section === "offline") return false;
    if (item.trashed) return false;
    const library = libraries[(item.parent ?? "").split("/")[0]];
    return Boolean((item.kind !== "folder" || !library?.folder_structure_static) && (sessionUser?.is_admin || library?.members.some((member) => member.name.toLowerCase() === sessionUser?.name.toLowerCase() && member.can_delete)));
  };
  const canMoveInPath = useCallback((path: string) => {
    if (libraries[path.split("/")[0]]?.folder_structure_static) return false;
    if (sessionUser?.is_admin) return true;
    const libraryName = path.split("/")[0];
    const library = libraries[libraryName];
    return Boolean(library?.members.some((member) => member.name.toLowerCase() === sessionUser?.name.toLowerCase() && member.can_move));
  }, [libraries, sessionUser]);

  const availableDestinations = useMemo(() => {
    return [
      ...Object.keys(libraries).filter(canMoveInPath),
      ...items.filter((i) => i.kind === "folder").map(mediaPath).filter((p): p is string => Boolean(p) && canMoveInPath(p!))
    ].sort();
  }, [libraries, items, canMoveInPath]);

  const moveDestinationPaths = moveFolderPaths.length ? moveFolderPaths : availableDestinations;

  const loadMoveFolderPaths = useCallback(async () => {
    try {
      const response = await authFetch(libraryApiUrl("name", "asc"));
      if (!response.ok) return;
      const entries = await response.json() as ApiLibraryEntry[];
      const folderPaths = entries
        .filter((entry) => entry.kind === "folder")
        .map((entry) => entry.path ?? entry.name)
        .filter((path): path is string => Boolean(path) && canMoveInPath(path));
      const roots = Object.keys(libraries).filter(canMoveInPath);
      setMoveFolderPaths([...new Set([...roots, ...folderPaths])].sort());
    } catch {}
  }, [canMoveInPath, libraries]);

  useEffect(() => {
    if (moveTarget || bulkMoveOpen) void loadMoveFolderPaths();
  }, [bulkMoveOpen, loadMoveFolderPaths, moveTarget]);

  const movePathAncestors = (path: string) =>
    path.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/"));

  const openMoveForItem = (item: MediaItem) => {
    const destination = item.parent ?? "";
    setMoveDestination(destination);
    setMoveExpandedDestinations(destination ? movePathAncestors(destination) : []);
    setMoveError("");
    setMoveTarget(item);
    setContextItem(null);
  };

  const canMoveItem = useCallback((item: MediaItem) => {
    if (item.offline || section === "offline") return false;
    const path = mediaPath(item);
    return Boolean(!item.trashed && path && !(item.kind === "folder" && !item.parent) && canMoveInPath(path));
  }, [canMoveInPath, section]);

  const isMoviesTvLibraryItem = useCallback((item: MediaItem) => {
    const libraryPath = (item.parent ?? item.name).split("/")[0];
    return libraries[libraryPath]?.content_type === "movies_tv";
  }, [libraries]);
  const canSelectItem = useCallback((item: MediaItem) => {
    if (section === "offline") return item.kind !== "folder";
    if (section === "trash") return Boolean(item.trashId);
    if (item.kind === "folder" && !item.parent) return false;
    if (isMoviesTvLibraryItem(item)) return false;
    return canDeleteItem(item) || canMoveItem(item);
  }, [section, canMoveItem, isMoviesTvLibraryItem]);
  const selectedItems = useMemo(() => {
    const idSet = new Set(selectedIds);
    if (section === "offline") return offlineBrowseItems.filter((item) => idSet.has(item.id));
    const pool = section === "trash" ? trashItems : items;
    return pool.filter((item) => idSet.has(item.id));
  }, [items, offlineBrowseItems, section, selectedIds, trashItems]);
  const selectableVisible = useMemo(
    () => visible.filter(canSelectItem),
    [canSelectItem, visible],
  );
  const selectedDeletableItems = useMemo(
    () => selectedItems.filter((item) => section === "trash" ? Boolean(item.trashId) : canDeleteItem(item)),
    [section, selectedItems],
  );
  const selectedMovableItems = useMemo(
    () => selectedItems.filter(canMoveItem),
    [canMoveItem, selectedItems],
  );
  const selectedOrganizableItems = useMemo(
    () => selectedItems.filter((item) => item.kind !== "folder" && item.path && !item.trashed),
    [selectedItems],
  );
  const selectedFolderItems = useMemo(
    () => selectedItems.filter((item) => item.kind === "folder" && !item.trashed),
    [selectedItems],
  );
  const selectedTaggableFolderPaths = useMemo(
    () => selectedFolderItems
      .filter((item) => !item.offline)
      .map((item) => mediaPath(item))
      .filter((path): path is string => Boolean(path)),
    [selectedFolderItems],
  );
  const bulkTagTargetPaths = useMemo(() => {
    const paths = new Set<string>(selectedTaggableFolderPaths);
    selectedOrganizableItems.forEach((item) => {
      if (item.path) paths.add(item.path);
    });
    return [...paths];
  }, [selectedOrganizableItems, selectedTaggableFolderPaths]);
  const canBulkOrganize = selectedOrganizableItems.length > 0 || selectedTaggableFolderPaths.length > 0;
  const leaveSelectionIfEmpty = (nextIds: number[]) => {
    if (nextIds.length === 0) {
      setSelectionMode(false);
      setBulkDeleteOpen(false);
      setBulkMoveOpen(false);
      setBulkPermanentDeleteOpen(false);
      setBulkOrganizeOpen(false);
    }
  };
  const toggleItemSelection = (item: MediaItem) => {
    if (!canSelectItem(item)) return;
    setSelectedIds((current) => {
      const next = current.includes(item.id) ? current.filter((id) => id !== item.id) : [...current, item.id];
      leaveSelectionIfEmpty(next);
      return next;
    });
  };
  const selectAllVisible = () => setSelectedIds(selectableVisible.map((item) => item.id));
  const clearSelection = () => {
    setSelectedIds([]);
    leaveSelectionIfEmpty([]);
  };
  const exitSelectionMode = () => {
    setSelectionMode(false);
    setSelectedIds([]);
    setBulkDeleteOpen(false);
    setBulkMoveOpen(false);
    setBulkPermanentDeleteOpen(false);
    setBulkOrganizeOpen(false);
  };
  const enterSelectionMode = (item?: MediaItem) => {
    setSelectionMode(true);
    setSelectedIds(item && canSelectItem(item) ? [item.id] : []);
  };
  useEffect(() => {
    setSelectionMode(false);
    setSelectedIds([]);
    setBulkDeleteOpen(false);
    setBulkMoveOpen(false);
    setBulkPermanentDeleteOpen(false);
    setBulkOrganizeOpen(false);
  }, [section, currentFolder, query, activeSearch, activeTags, activePlaylistId]);

  const canRenameItem = (item: MediaItem) => {
    if (item.offline || section === "offline") return false;
    const path = mediaPath(item);
    const library = path ? libraries[path.split("/")[0]] : undefined;
    return Boolean(!item.trashed && path?.includes("/") && (item.kind !== "folder" || !library?.folder_structure_static) && (sessionUser?.is_admin || library?.members.some((member) => member.name.toLowerCase() === sessionUser?.name.toLowerCase() && member.can_rename)));
  };
  const isTitleFolder = useCallback((path: string) => {
    const [libraryPath, ...relativePath] = path.split("/");
    const library = libraries[libraryPath];
    if (library?.content_type !== "movies_tv" || relativePath.length === 0) return false;
    return relativePath.length === 1 || library.title_folders.includes(relativePath.join("/"));
  }, [libraries]);
  const titleCollectionForPath = (path: string) => {
    const slash = path.lastIndexOf("/");
    if (slash < 0) return null;
    const titlePath = path.slice(0, slash);
    if (!isTitleFolder(titlePath) || mediaEvidenceForFolder(items, titlePath).kind !== "series") return null;
    return titleCollectionForFolder(items, path);
  };

  const titlePathForVideo = useCallback((item: MediaItem) => {
    let candidate = item.parent;
    while (candidate) {
      if (isTitleFolder(candidate)) return candidate;
      candidate = candidate.includes("/") ? candidate.slice(0, candidate.lastIndexOf("/")) : undefined;
    }
    return null;
  }, [isTitleFolder]);

  // Library navigation has an active folder, but Recent, Favorites, and Trash
  // deliberately do not. Work from the item's own path so title cards keep
  // their movie/show treatment in every view.
  const catalogTitleForItem = useCallback((item: MediaItem): CatalogTitle | null => {
    const path = mediaPath(item);
    if (!path || libraries[path.split("/")[0]]?.content_type !== "movies_tv") return null;

    // The backend owns this classification so every client gets the same
    // movie/show/episode result without repeating a full descendant scan.
    if (item.catalogKind) {
      if (item.catalogKind === "episode") return null;
      const titlePath = item.catalogTitlePath ?? path;
      // The backend tells us whether this is a title or an episode, but it
      // deliberately does not duplicate the local descendant scan. Keep the
      // real season/episode evidence here: using placeholder 1/0 values made
      // remakes with identical names look indistinguishable to metadata search.
      const detected = mediaEvidenceForFolder(items, titlePath);
      return {
        path: titlePath,
        title: titlePath.split("/").at(-1) ?? item.name,
        evidence: { ...detected, kind: detected.kind === "series" ? "series" : titleMetadata[titleMetadataKey(titlePath, item.catalogKind)]?.type ?? item.catalogKind },
      };
    }

    if (item.kind === "folder" && isTitleFolder(path)) {
      const detected = mediaEvidenceForFolder(items, path);
      // A trashed title no longer has descendants in the live library. Retain
      // a previously identified show type when metadata is already cached.
      const evidence = titleMetadata[titleMetadataKey(path, "series")] ? { ...detected, kind: "series" as const } : detected;
      return { path, title: item.name, evidence };
    }

    if (item.kind !== "video") return null;
    const parentTitlePath = titlePathForVideo(item);
    if (parentTitlePath) {
      const evidence = mediaEvidenceForFolder(items, parentTitlePath);
      // Episodes stay episode cards, but a movie file inside its own title
      // folder still represents that movie and keeps the movie card.
      if (evidence.kind === "series") return null;
      return {
        path: parentTitlePath,
        title: parentTitlePath.split("/").at(-1) ?? item.name,
        evidence,
      };
    }

    // A video directly in a Movies & TV library is an ungrouped movie.
    if (path.split("/").length === 2 && !episodeNumbers(item.name)) {
      return {
        path,
        title: item.name.replace(/\.[a-z0-9]{2,5}$/i, ""),
        evidence: { kind: "movie", seasons: 0, episodes: 0, videos: 1, year: item.name.match(/\b((?:19|20)\d{2})\b/)?.[1] },
      };
    }
    return null;
  }, [isTitleFolder, items, libraries, titleMetadata, titlePathForVideo]);

  const displayVisible = useMemo(() => {
    if (!activeSearch.trim()) return visible;
    const seenTitles = new Set<string>();
    return visible.filter((item) => {
      const title = catalogTitleForItem(item);
      if (!title) return true;
      if (seenTitles.has(title.path)) return false;
      seenTitles.add(title.path);
      return true;
    });
  }, [activeSearch, catalogTitleForItem, visible]);

  const playableVisible = useMemo(() => {
    const source = section === "offline" && !currentFolder && !activeTags.length && !activeSearch.trim() && !query.trim()
      ? offlineAllMediaItems
      : displayVisible;
    return source.filter((item) => (item.kind === "video" || item.kind === "audio" || item.kind === "image") && item.src && item.path);
  }, [activeSearch, activeTags.length, currentFolder, displayVisible, offlineAllMediaItems, query, section]);
  const paginationKey = `${currentFolder ?? ""}\u0000${activeSearch.trim() || query.trim()}\u0000${section}\u0000${sort}\u0000${sortDirection}\u0000${activeTags.join("\u0001")}`;
  const visibleLimit = playbackPreferences.load_all_items ? 999999 : (pagination.key === paginationKey ? pagination.limit : restoredVisibleLimitRef.current);
  const targetCacheKey = libraryCachePageKey(currentFolder, sort, sortDirection);
  const rendersServerPageDirectly = isServerPagedFolder && clientFilterLoadedFolderKey !== targetCacheKey;
  const renderedVisible = useMemo(() => rendersServerPageDirectly ? displayVisible : displayVisible.slice(0, visibleLimit), [displayVisible, rendersServerPageDirectly, visibleLimit]);
  const hasMoreVisible = rendersServerPageDirectly ? serverHasMore : ((currentFolder && section === "library" && !recursiveFavorites && serverHasMore) || renderedVisible.length < displayVisible.length);
  const hasMemoryCache = Boolean(libraryCache.current?.pages[targetCacheKey]);
  const visibleTotalCount = isServerPagedFolder && serverTotal > 0 ? serverTotal : displayVisible.length;
  const isFetchingNewFolder = (loadedFolder ?? null) !== (currentFolder ?? null) && backendState !== "offline" && backendState !== "cached" && !hasMemoryCache;
  const isRestoringMemoryCache = (loadedFolder ?? null) !== (currentFolder ?? null) && hasMemoryCache;

  useEffect(() => {
    setPagination((current) => {
      if (current.key === paginationKey) return current;
      const limit = !paginationKeyInitializedRef.current
        ? Math.max(restoredVisibleLimitRef.current, LIBRARY_PAGE_SIZE)
        : LIBRARY_PAGE_SIZE;
      paginationKeyInitializedRef.current = true;
      return { key: paginationKey, limit };
    });
  }, [paginationKey]);

  useEffect(() => {
    const metadataTargets = new Map<string, { path: string; title: string; evidence: ReturnType<typeof mediaEvidenceForFolder> }>();
    renderedVisible.forEach((item) => {
      const title = catalogTitleForItem(item);
      if (title) {
        metadataTargets.set(title.path, title);
        return;
      }
      const showPath = item.kind === "video" ? titlePathForVideo(item) : null;
      if (showPath) {
        metadataTargets.set(showPath, {
          path: showPath,
          title: showPath.split("/").at(-1) ?? item.name,
          evidence: mediaEvidenceForFolder(items, showPath),
        });
      }
    });

    // Keep the selected title's metadata ready while browsing its seasons and
    // episodes; it is not itself part of the folder's visible child list.
    if (currentFolder && currentLibraryType === "movies_tv" && isTitleFolder(currentFolder)) {
      metadataTargets.set(currentFolder, { path: currentFolder, title: currentFolder.split("/").at(-1) ?? "", evidence: mediaEvidenceForFolder(items, currentFolder) });
    } else if (currentFolder && currentLibraryType === "movies_tv" && titleCollectionForPath(currentFolder)) {
      // Specials, featurettes, and soundtrack folders are all part of the
      // title directly above them. Keep their metadata anchored to that show
      // instead of trying to identify a folder named "Featurettes" on its own.
      const path = currentFolder.slice(0, currentFolder.lastIndexOf("/"));
      metadataTargets.set(path, { path, title: path.split("/").at(-1) ?? "", evidence: mediaEvidenceForFolder(items, path) });
    }
    metadataTargets.forEach(({ path, title: rawTitle, evidence }) => {
      const metadataKey = titleMetadataKey(path, evidence.kind);
      const cachedMetadata = titleMetadata[metadataKey];
      const hasCachedTrailer = Boolean(trailerYoutubeId(cachedMetadata));
      const needsTrailerRefresh = Boolean(cachedMetadata && !hasCachedTrailer && !trailerMetadataRefresh.current.has(metadataKey));
      const hasCompleteCachedMetadata = Boolean(cachedMetadata && (evidence.kind !== "series" || cachedMetadata.videos?.length));
      if ((hasCompleteCachedMetadata && !needsTrailerRefresh) || metadataLoading.current.has(metadataKey)) return;
      if (needsTrailerRefresh) trailerMetadataRefresh.current.add(metadataKey);
      metadataLoading.current.add(metadataKey);
      setPendingTitleMetadata(new Set(metadataLoading.current));
      // Torrent sites prefix folders with their domain ("www.UIndex.org - The Odyssey").
      const title = rawTitle.replace(/^(?:\s*\[[^\]]+\]\s*)+/, "").replace(/^\s*www\.[\w-]+(?:\.[\w-]+)+\s*[-–—|]+\s*/i, "").replace(/\b(?:19|20)\d{2}\b.*$/i, "").replace(/\b(?:1080p|720p|2160p|bluray|web-?dl).*$/i, "").trim();
      const params = new URLSearchParams({ title, kind: evidence.kind, seasons: String(evidence.seasons), episodes: String(evidence.episodes), videos: String(evidence.videos) });
      if (evidence.year) params.set("year", evidence.year);
      const tmdbId = path.match(/\[tmdbid-(\d+)\]/i)?.[1];
      if (tmdbId) params.set("tmdb_id", tmdbId);
      const normalizeTitle = (name: string) => name.toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      const requested = normalizeTitle(title);
      const isMatchingTitle = (metadata: TitleMetadata) => {
        const candidate = normalizeTitle(metadata.name);
        return Boolean(requested && candidate && (requested === candidate || requested.startsWith(`${candidate} `) || candidate.startsWith(`${requested} `)));
      };
      void fetch(`${API_BASE}/api/title-metadata?${params}`)
        .then(async (response) => {
          let metadata = response.ok ? await response.json() as TitleMetadata : undefined;
          // Empty title folders have no episode evidence yet. Try the show
          // catalog when movie matching finds no relevant title. Validate the
          // response too, so an older server cannot repopulate a bad cache.
          if ((response.status === 404 || (metadata && !isMatchingTitle(metadata))) && evidence.kind === "movie" && evidence.videos === 0) {
            params.set("kind", "series");
            const seriesResponse = await fetch(`${API_BASE}/api/title-metadata?${params}`);
            metadata = seriesResponse.ok ? await seriesResponse.json() as TitleMetadata : undefined;
          }
          if (!metadata || !isMatchingTitle(metadata)) throw new Error("No matching catalog title");
          return metadata;
        })
        .then((metadata) => {
          const matches = { [metadataKey]: metadata, [titleMetadataKey(path, metadata.type)]: metadata };
          setTitleMetadata((current) => ({ ...current, ...matches }));
          updateLibraryCache((current) => ({ ...current, titleMetadata: { ...current.titleMetadata, ...matches } }));
        })
        .catch(() => undefined)
        .finally(() => {
          metadataLoading.current.delete(metadataKey);
          setPendingTitleMetadata(new Set(metadataLoading.current));
        });
    });
  }, [catalogTitleForItem, currentFolder, currentLibraryType, isTitleFolder, items, renderedVisible, titleMetadata, titlePathForVideo]);

  const observerStateRef = useRef({ currentFolder, section, activeTags, serverHasMore, serverPageLoading, sort, sortDirection, serverLoadedCount, isServerPagedFolder, paginationKey, customTags, playback, lastAccessed, favoritePaths });
  observerStateRef.current = { currentFolder, section, activeTags, serverHasMore, serverPageLoading, sort, sortDirection, serverLoadedCount, isServerPagedFolder, paginationKey, customTags, playback, lastAccessed, favoritePaths };

  useEffect(() => {
    if (isServerPagedFolder || recursiveFavorites || !currentFolder || section !== "library") return;
    if (!serverHasMore || serverPageLoading) return;
    if (displayVisible.length >= visibleLimit) return;
    // A client-side filter cannot know whether later server pages contain a
    // match. Fetch the remaining folder once instead of walking every small
    // page serially; sparse filters such as Favorites otherwise turn one
    // folder click into dozens (or hundreds) of back-to-back requests.
    setServerPageLoading(true);
    const pageRequestStarted = performance.now();
    authFetch(libraryApiUrl(sort, sortDirection, currentFolder, serverLoadedCount, 999999))
      .then(async (response) => {
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        const fetchedEntries = await response.json() as ApiLibraryEntry[];
        appendServerBatch(
          fetchedEntries.map(apiEntryToMediaItem).filter((item): item is MediaItem => item !== null),
          performance.now() - pageRequestStarted,
        );
        const totalHeader = response.headers.get("x-tms-total");
        if (totalHeader) setServerTotal(Number(totalHeader));
        setItems((current) => {
          const latestState = observerStateRef.current;
          const favoritePathSet = new Set(latestState.favoritePaths);
          const newItems = fetchedEntries.map(apiEntryToMediaItem).filter((item): item is MediaItem => item !== null).map((item) => withOpenedMetadata(item, latestState.lastAccessed, latestState.playback, { tags: [...new Set([...item.tags, ...inheritedTags(item.path, latestState.customTags)])], favorite: item.path ? favoritePathSet.has(item.path) : false }));
          const existingIds = new Set(current.map((item) => item.id));
          return [...current, ...newItems.filter((item) => !existingIds.has(item.id))];
        });
        setServerLoadedCount((current) => current + libraryConsumedCount(response, fetchedEntries.length));
        setServerHasMore(response.headers.get("x-tms-has-more") === "true");
        setClientFilterLoadedFolderKey(libraryCachePageKey(currentFolder, sort, sortDirection));
      })
      .catch((error) => setBackendError(error instanceof Error ? error.message : "Could not load more items"))
      .finally(() => setServerPageLoading(false));
  }, [currentFolder, displayVisible.length, isServerPagedFolder, recursiveFavorites, section, serverHasMore, serverLoadedCount, serverPageLoading, sort, sortDirection, visibleLimit]);

  const handleLoadMore = useCallback((all = false) => {
    const state = observerStateRef.current;
    const loadAmount = all ? 999999 : LIBRARY_PAGE_SIZE;
    if (state.currentFolder && state.section === "library" && !state.activeTags.includes(FAVORITES_FILTER) && state.serverHasMore) {
      if (state.serverPageLoading || loadMoreInFlightRef.current) return;
      loadMoreInFlightRef.current = true;
      setServerPageLoading(true);
      const pageRequestStarted = performance.now();
      void authFetch(libraryApiUrl(state.sort, state.sortDirection, state.currentFolder, state.serverLoadedCount, all ? loadAmount : undefined))
        .then(async (response) => {
          if (!response.ok) throw new Error(`Server returned ${response.status}`);
          const fetchedEntries = await response.json() as ApiLibraryEntry[];
          appendServerBatch(
            fetchedEntries.map(apiEntryToMediaItem).filter((item): item is MediaItem => item !== null),
            performance.now() - pageRequestStarted,
          );
          const totalHeader = response.headers.get("x-tms-total");
          if (totalHeader) setServerTotal(Number(totalHeader));
          setItems((current) => {
            const latestState = observerStateRef.current;
            const favoritePathSet = new Set(latestState.favoritePaths);
            const newItems = fetchedEntries.map(apiEntryToMediaItem).filter((item): item is MediaItem => item !== null).map((item) => withOpenedMetadata(item, latestState.lastAccessed, latestState.playback, { tags: [...new Set([...item.tags, ...inheritedTags(item.path, latestState.customTags)])], favorite: item.path ? favoritePathSet.has(item.path) : false }));
            const existingIds = new Set(current.map((item) => item.id));
            return [...current, ...newItems.filter((item) => !existingIds.has(item.id))];
          });
          setServerLoadedCount((current) => current + libraryConsumedCount(response, fetchedEntries.length));
          setServerHasMore(response.headers.get("x-tms-has-more") === "true");
        })
        .catch((error) => setBackendError(error instanceof Error ? error.message : "Could not load more items"))
        .finally(() => {
          loadMoreInFlightRef.current = false;
          setServerPageLoading(false);
        });
      if (state.isServerPagedFolder) return;
    }
    if (state.isServerPagedFolder) return;
    setPagination((current) => ({
      key: state.paginationKey,
      limit: (current.key === state.paginationKey ? current.limit : LIBRARY_PAGE_SIZE) + loadAmount,
    }));
  }, []);

  useEffect(() => {
    if (!hasMoreVisible) return;
    let previousScrollY = window.scrollY;
    let frame = 0;
    const onScroll = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        const currentScrollY = window.scrollY;
        const scrollingDown = currentScrollY > previousScrollY;
        previousScrollY = currentScrollY;
        const pageBottom = document.documentElement.scrollHeight - window.innerHeight;
        if (scrollingDown && currentScrollY >= Math.max(0, pageBottom - 32)) {
          handleLoadMore();
        }
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [hasMoreVisible, handleLoadMore]);

  const flash = (message: string) => {
    if (toastTimeout.current !== null) window.clearTimeout(toastTimeout.current);
    setToast(message);
    toastTimeout.current = window.setTimeout(() => {
      setToast("");
      toastTimeout.current = null;
    }, 2800);
  };

  const readPlayback = (item: MediaItem): PlaybackState | null => item.path && savesWatchProgress(item.path) ? playback[item.path] ?? null : null;

  const seriesPathForVideo = (item: MediaItem) => {
    if (item.catalogKind === "movie") return null;
    const parentSegments = (item.parent ?? "").split("/").filter(Boolean);
    const seasonIndex = parentSegments.findIndex((segment) => /^(?:Season[ ._-]*0*\d{1,3}|Specials?)$/i.test(segment));
    if (seasonIndex > 0) return parentSegments.slice(0, seasonIndex).join("/");
    let candidate = item.parent;
    while (candidate) {
      const collection = titleCollectionForFolder(items, candidate);
      if (collection?.kind !== "season" && mediaEvidenceForFolder(items, candidate).kind === "series") return candidate;
      candidate = candidate.includes("/") ? candidate.slice(0, candidate.lastIndexOf("/")) : undefined;
    }
    return null;
  };
  const recordAccess = useCallback(async (path: string | undefined, updateVisibleItem = true) => {
    if (!path) return;
    const now = Math.floor(Date.now() / 1000);
    setLastAccessed((current) => ({ ...current, [path]: Math.max(current[path] ?? 0, now) }));
    updateLibraryCache((current) => ({
      ...current,
      userState: {
        ...current.userState,
        last_accessed: { ...current.userState.last_accessed, [path]: Math.max(current.userState.last_accessed?.[path] ?? 0, now) },
      },
    }));
    if (updateVisibleItem) {
      setItems((current) => current.map((item) => {
        if (item.path !== path) return item;
        const timestamp = Math.max(now, playback[path]?.updated ?? 0);
        return { ...item, lastOpenedAt: timestamp, lastPlayed: new Date(timestamp * 1000).toLocaleString() };
      }));
      setSidebarTreeEntries((current) => Object.fromEntries(Object.entries(current).map(([parent, entries]) => [
        parent,
        entries.map((item) => item.path === path
          ? { ...item, lastOpenedAt: Math.max(now, playback[path]?.updated ?? 0), lastPlayed: new Date(now * 1000).toLocaleString() }
          : item),
      ])));
    }
    try {
      const response = await authFetch(`${API_BASE}/api/activity/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
      keepalive: true,
      });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
    } catch {
      // Local optimistic state still keeps the current view responsive. A
      // later refresh will reconcile if the access write could not persist.
    }
  }, [playback]);

  const playbackBrowseSnapshot = () => {
    return {
      url: `${window.location.pathname}${window.location.search}`,
      folder: currentFolder,
      section,
      query,
      activeSearch,
      activeTags,
      sort,
      sortDirection,
      libraryView,
      scrollY: window.scrollY,
      items,
      sidebarTreeEntries,
      trashItems,
      libraries,
      folderCovers,
      titleMetadata,
      playback,
      lastAccessed,
      customTags,
      tagCatalog,
      playlists,
      activePlaylistId,
      serverHasMore,
      serverLoadedCount,
      serverTotal: serverTotal > 0 ? serverTotal : undefined,
      clientVisibleLimit: Math.max(pagination.key === paginationKey ? pagination.limit : restoredVisibleLimitRef.current, LIBRARY_PAGE_SIZE),
      userId: sessionUser?.id,
    };
  };
  const savePlaybackBrowseSnapshot = useEffectEvent(() => {
    saveBrowseSnapshot(playbackBrowseSnapshot());
    const latest = playbackSessionSnapshot();
    if (latest) {
      const returnUrl = `${window.location.pathname}${window.location.search}`;
      setPlaybackSession({ ...latest, returnUrl, source: latest.source ? { ...latest.source, returnUrl } : undefined });
    }
  });
  const playbackFavoriteChanged = useEffectEvent((event: Event) => {
    const { path, favorite, locallyQueued } = (event as CustomEvent<{ path: string; favorite: boolean; locallyQueued?: boolean }>).detail;
    setItems((current) => current.map((file) => file.path === path ? { ...file, favorite } : file));
    setFavoritePaths((current) => favorite ? [...new Set([...current, path])] : current.filter((entry) => entry !== path));
    if (locallyQueued) setOfflineFavoriteOverrides((current) => ({ ...current, [path]: favorite }));
  });
  const playbackOrganizationChanged = useEffectEvent((event: Event) => {
    applyOrganizationState((event as CustomEvent).detail);
  });
  useEffect(() => {
    const beforeWatch = () => savePlaybackBrowseSnapshot();
    const favorite = (event: Event) => playbackFavoriteChanged(event);
    const organize = (event: Event) => playbackOrganizationChanged(event);
    const playing = (event: Event) => setMiniplayerPlaying((event as CustomEvent<boolean>).detail);
    window.addEventListener("tms:before-watch", beforeWatch);
    window.addEventListener("tms:playback-favorite", favorite);
    window.addEventListener("tms:playback-organize", organize);
    window.addEventListener("tms:playback-playing", playing);
    return () => {
      window.removeEventListener("tms:before-watch", beforeWatch);
      window.removeEventListener("tms:playback-favorite", favorite);
      window.removeEventListener("tms:playback-organize", organize);
      window.removeEventListener("tms:playback-playing", playing);
    };
  }, []);

  const playVideo = (
    item: MediaItem,
    startAt?: number,
    playbackQueue?: MediaItem[],
    queueLabel?: string,
    folderQueue?: { folder: string; sort: SortField; direction: SortDirection; shuffle?: boolean; shuffleSeed?: string },
    queueSource?: QueueSource,
  ) => {
    if (!item.src) return;

    const libraryType = libraries[(item.parent ?? "").split("/")[0]]?.content_type;
    const source = queueSource ? queueSourceForItem(queueSource, item) : undefined;
    const remoteAudio = readPlayback(item);
    const localAudio = readLocalWatchProgress(sessionUser?.id)[item.path ?? ""];
    const savedAudio = localAudio && (!remoteAudio || localAudio.updated >= remoteAudio.updated) ? localAudio : remoteAudio;
    const initialQueue = playbackQueue ?? [item];
    const startedSession = startPlaybackSession({
      userId: sessionUser?.id ?? 0, item, queue: initialQueue, source,
      label: queueLabel ?? (source?.method === "shuffle" ? "Shuffled" : source?.method === "all" ? "Play all" : "Queue"),
      returnUrl: `${window.location.pathname}${window.location.search}`,
      watchEntry: item.kind !== "audio", complete: !source, time: !savesWatchProgress(item.path) ? 0 : startAt ?? (savedAudio && !savedAudio.completed ? savedAudio.position : 0), playing: true,
    });
    if (item.kind === "audio" && !playsAlongside(item.path)) {
      void recordAccess(item.path);
      return;
    }

    const saved = readPlayback(item);
    const resumeAt = !savesWatchProgress(item.path) ? 0 : startAt ?? (saved && !saved.completed ? saved.position : 0);
    const params = new URLSearchParams({ src: item.src, name: item.name, size: item.size, folder: item.parent ?? "My library", kind: item.kind });
    params.set("playbackSession", startedSession.id);
    if (item.path) params.set("path", item.path);
    if (item.offline?.bundleId && item.offline.fileId) {
      params.set("offlineBundle", item.offline.bundleId);
      params.set("offlineFile", item.offline.fileId);
      params.delete("src");
    }
    const titlePath = titlePathForVideo(item);
    const titleKind = titlePath ? mediaEvidenceForFolder(items, titlePath).kind : null;
    const metadata = titlePath && titleKind ? titleMetadata[titleMetadataKey(titlePath, titleKind)] : undefined;
    if (metadata?.id?.startsWith("tt")) params.set("imdb", metadata.id);
    const series = item.catalogKind === "movie" ? null : seriesPathForVideo(item);
    const episode = series ? episodeNumbers(`${item.parent ?? ""}/${item.name}`) : null;
    if (episode) {
      params.set("season", String(episode.season));
      params.set("episode", String(episode.episode));
    }
    const isMovie = item.catalogKind === "movie" || (!series && isMovieWatch({ kind: item.kind, folder: item.parent ?? "My library", catalogKind: item.catalogKind, moviesTv: libraryType === "movies_tv", name: item.name, src: item.src }));
    if (queueSource) {
      writeQueueSource(params, queueSourceForItem(queueSource, item));
      if (series) params.set("series", series);
      params.set("queueLabel", queueSource.method === "shuffle" ? "Shuffled" : queueSource.method === "all" ? "Play all" : "Queue");
    } else if (folderQueue && !isMovie) {
      try {
        sessionStorage.removeItem(PLAYBACK_QUEUE_KEY);
        sessionStorage.removeItem(PLAYBACK_QUEUE_ORDER_KEY);
      } catch {
      }
      params.set("queueFolder", folderQueue.folder);
      params.set("queueSort", folderQueue.sort);
      params.set("queueDirection", folderQueue.direction);
      params.set("queueLabel", queueLabel ?? "Queue");
      if (folderQueue.shuffle) {
        params.set("queueShuffle", "1");
        params.set(
          "queueShuffleSeed",
          folderQueue.shuffleSeed
            ?? (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
              ? crypto.randomUUID()
              : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`),
        );
      }
    } else if (playbackQueue?.length && !isMovie) {
      try {
        sessionStorage.setItem(PLAYBACK_QUEUE_KEY, storedPlaybackQueue(playbackQueue));
        sessionStorage.removeItem(LEGACY_PLAYBACK_QUEUE_KEY);
        sessionStorage.removeItem(PLAYBACK_QUEUE_ORDER_KEY);
      } catch {
        return flash("This browser could not create a playback queue");
      }
      params.set("queue", "custom");
      params.set("queueLabel", queueLabel ?? "Queue");
    } else {
      try {
        sessionStorage.removeItem(PLAYBACK_QUEUE_KEY);
        sessionStorage.removeItem(PLAYBACK_QUEUE_ORDER_KEY);
      } catch {
      }
      if (series) params.set("series", series);
    }
    if (libraryType === "movies_tv") params.set("catalog", "movies_tv");
    if (item.catalogKind) params.set("catalogKind", item.catalogKind);
    if (resumeAt > 2) params.set("start", String(Math.floor(resumeAt)));
    params.set("play", "1");
    params.set("return", `${window.location.pathname}${window.location.search}`);
    const browseSnapshot = playbackBrowseSnapshot();
    // Avoid vinext's client router: it can fail while initializing Web Crypto
    // on plain-HTTP LAN installs. The app shell opens Watch in this document.
    navigateApp(`/watch?${params.toString()}`);
    // Serializing a full library snapshot and updating thousands of items can
    // take long enough to make a video click feel stuck. Start navigation
    // first; this work is only for the eventual return to the library.
    window.setTimeout(() => {
      saveBrowseSnapshot(browseSnapshot);
      void recordAccess(item.path);
    }, 0);
  };

  const currentQueueSource = (method: QueueSource["method"]): QueueSource => ({
    version: 1,
    section,
    folder: currentFolder ?? undefined,
    search: query.trim() || activeSearch.trim(),
    globalSearch: Boolean(activeSearch.trim()),
    tags: [...activeTags],
    sort,
    direction: sortDirection,
    method,
    returnUrl: `${window.location.pathname}${window.location.search}`,
    startedAt: Date.now() / 1000,
    playlistPaths: section === "playlists" && activePlaylistId ? playlists[activePlaylistId]?.paths : undefined,
    seed: method === "shuffle" ? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}` : undefined,
  });

  const playVisibleQueue = (shuffle: boolean) => {
    if (!playableVisible.length) return flash("No playable media in this view");
    if (section === "offline") {
      const queue = shuffle ? shuffleMedia(playableVisible) : [...playableVisible];
      playVideo(queue[0], undefined, queue, shuffle ? "Shuffled" : "Play all", undefined);
      return;
    }
    const source = currentQueueSource(shuffle ? "shuffle" : "all");
    const navigate = (item: MediaItem, source: QueueSource) => {
      playVideo(item, undefined, undefined, undefined, undefined, source);
    };
    if (shuffle && isServerPagedFolder && serverHasMore && serverTotal > 0) {
      void startPagedShuffle(serverTotal, source, async (offset) => {
        const response = await authFetch(libraryApiUrl(sort, sortDirection, currentFolder, offset));
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        const entries = await response.json() as ApiLibraryEntry[];
        return entries.map(apiEntryToMediaItem).filter((item): item is MediaItem => Boolean(item));
      }, navigate).catch((error) => flash(error instanceof Error ? error.message : "Could not start shuffle"));
      return;
    }
    startPlaybackQueue(playableVisible, source, navigate);
  };

  const openItem = (item: MediaItem) => {
    if (item.offline) {
      if (item.offline.status && item.offline.status !== "ready") return;
      if (item.kind === "folder") {
        const path = item.parent ? `${item.parent}/${item.name}` : item.name;
        const saved = readLibraryBrowsePrefs(path);
        setSort(saved.sort);
        setSortDirection(saved.sortDirection);
        setLibraryView(saved.view);
        setCurrentFolder(path);
        return;
      }
      // Native Android items already have a local WebView URL for artwork and
      // previews. They are still offline files, so always use the dedicated
      // path that resolves the persisted SAF entry and starts the TMS player.
      if (item.offline.fileId) {
        const bundle = offlineBundles.find((candidate) => candidate.id === item.offline!.bundleId);
        const file = bundle?.files.find((candidate) => candidate.id === item.offline!.fileId);
        if (bundle && file) void openDownloadedFile(bundle, file, item);
        return;
      }
    }
    if ((item.kind === "video" || item.kind === "audio" || item.kind === "image") && item.src) {
      if (!item.offline) {
        playVideo(item, undefined, undefined, undefined, undefined, currentQueueSource("item"));
      } else {
        playVideo(item, undefined, playableVisible, "Queue", undefined);
      }
      return;
    }
    setPreview(item);
  };

  const loadCatalogVideos = async (path: string): Promise<MediaItem[]> => {
    const folders = [path];
    const visited = new Set<string>();
    const videos: MediaItem[] = [];
    const loadDirectVideo = async (filePath: string): Promise<MediaItem | null> => {
      const slash = filePath.lastIndexOf("/");
      if (slash < 0) return null;
      const parent = filePath.slice(0, slash);
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const response = await authFetch(libraryApiUrl("name", "asc", parent, offset));
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        const entries = await response.json() as ApiLibraryEntry[];
        const match = entries
          .map(apiEntryToMediaItem)
          .find((item): item is MediaItem => item?.kind === "video" && item.path === filePath && Boolean(item.src));
        if (match) return match;
        offset += libraryConsumedCount(response, entries.length);
        hasMore = response.headers.get("x-tms-has-more") === "true" && entries.length > 0;
      }
      return null;
    };
    // Titles normally contain only a few season folders. Keep the walk bounded
    // so a malformed library response can never turn one Play click into a
    // whole-library scan.
    while (folders.length && visited.size < 80) {
      const folder = folders.shift()!;
      if (visited.has(folder)) continue;
      visited.add(folder);
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const response = await authFetch(libraryApiUrl("name", "asc", folder, offset));
        if (!response.ok) {
          // Root-level movie files are catalog titles too, but their title path
          // is the file itself. Verify that exact file through its real parent
          // folder instead of asking the folder API to open an MKV as a folder.
          if (response.status === 404 && folder === path && offset === 0) {
            const directVideo = await loadDirectVideo(path);
            if (directVideo) return [directVideo];
          }
          throw new Error(`Server returned ${response.status}`);
        }
        const entries = await response.json() as ApiLibraryEntry[];
        const loaded = entries.map(apiEntryToMediaItem).filter((item): item is MediaItem => item !== null);
        videos.push(...loaded.filter((item) => item.kind === "video" && item.src));
        loaded.filter((item) => item.kind === "folder" && item.path).forEach((item) => folders.push(item.path!));
        offset += libraryConsumedCount(response, entries.length);
        hasMore = response.headers.get("x-tms-has-more") === "true" && entries.length > 0;
      }
    }
    return videos;
  };

  const playCatalogTitle = (path: string, kind: "movie" | "series") => {
    // Route first. The watch page resolves the current feature/episode after
    // it has painted, so Play never waits on a recursive catalog walk here.
    const params = new URLSearchParams({ catalogPath: path, catalogKind: kind, catalog: "movies_tv", play: "1", return: `${window.location.pathname}${window.location.search}` });
    const metadata = titleMetadata[titleMetadataKey(path, kind)];
    if (metadata?.id?.startsWith("tt")) params.set("imdb", metadata.id);
    // Avoid vinext's client router: it relies on Web Crypto, which is
    // unavailable on the app's plain-HTTP LAN address.
    navigateApp(`/watch?${params.toString()}`);
  };

  const rememberVideoRatio = (item: MediaItem, aspectRatio: number) => {
    if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return;
    if (item.path) writeCachedAspectRatio(item.path, aspectRatio);
    if (Math.abs((item.aspectRatio ?? 0) - aspectRatio) < 0.001) return;
    setItems((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, aspectRatio } : candidate));
  };
  const rememberMediaDuration = (item: MediaItem, duration: number) => {
    if (!Number.isFinite(duration) || duration <= 0 || Math.abs((item.duration ?? 0) - duration) < 0.5) return;
    // Length sorting is server-owned. Updating an unknown duration as a card
    // enters the viewport would otherwise move that card above the user's
    // current scroll position while the authoritative response is loading.
    if (sort === "length") return;
    if (item.offline && item.path) {
      setOfflineDurations((current) => current[item.path!] === duration ? current : { ...current, [item.path!]: duration });
      return;
    }
    setItems((current) => current.map((candidate) => candidate.id === item.id ? { ...candidate, duration } : candidate));
  };

  const applyOrganizationState = (state: Partial<Pick<UserState, "tags" | "tag_catalog" | "playlists">>) => {
    const pending = typeof window === "undefined" ? emptyPendingChanges() : readPendingOfflineChanges();
    const { tags: nextTags, tag_catalog: nextTagCatalog, playlists: nextPlaylists } = applyPendingOrganization(state, pending);
    setCustomTags(nextTags);
    setTagCatalog(nextTagCatalog);
    setPlaylists(nextPlaylists);
    setActivePlaylistId((current) => current && nextPlaylists[current] ? current : null);
    setItems((current) => current.map((item) => {
      const builtInTags = item.kind === "image" ? ["Photos"] : item.kind === "audio" ? ["Audio"] : item.kind === "video" ? ["Video"] : [];
      return { ...item, tags: [...new Set([...builtInTags, ...inheritedTags(item.path, nextTags)])] };
    }));
  };
  const applyFavoritePaths = (paths: Iterable<string>) => {
    const overrides = typeof window === "undefined" ? {} : pendingOfflineFavoriteOverrides();
    const merged = new Set(paths);
    Object.entries(overrides).forEach(([path, favorite]) => {
      if (favorite) merged.add(path);
      else merged.delete(path);
    });
    setFavoritePaths([...merged]);
    setOfflineFavoriteOverrides(overrides);
    setItems((current) => current.map((item) => ({ ...item, favorite: Boolean(item.path && merged.has(item.path)) })));
  };
  const reloadOrganizationState = async () => {
    const response = await authFetch(`${API_BASE}/api/user-state`);
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    const state = await response.json() as UserState;
    applyOrganizationState(state);
    applyFavoritePaths(state.favorites);
    return state;
  };
  const pathIsDownloaded = useCallback((path?: string) => {
    if (!path) return false;
    return offlineBundles.some((bundle) => bundle.path === path || bundle.files.some((file) => file.path === path || file.path.startsWith(`${path}/`)));
  }, [offlineBundles]);
  // Reach the server for an organization change. Null means it is unavailable
  // and the change belongs in the offline queue instead.
  const reachServer = async (path: string, init?: RequestInit) => {
    if (backendState === "offline") return null;
    try {
      return await authFetch(`${API_BASE}${path}`, init);
    } catch {
      return null;
    }
  };
  const organizedLocally = (update: PendingOrganization) =>
    applyPendingOrganization({ tags: customTags, tag_catalog: tagCatalog, playlists }, { ...emptyPendingChanges(), organization: [update] });
  const startOrganizing = (item: MediaItem) => {
    if (!item.path) return;
    setContextItem(null);
    setLibraryContext(null);
    setOrganizeError("");
    setOrganizeTarget(item);
    setOrganizeTags(customTags[item.path] ?? []);
    setOrganizePlaylists(Object.values(playlists).filter((playlist) => playlist.paths.includes(item.path as string)).map((playlist) => playlist.id));
  };
  const saveOrganization = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!organizeTarget?.path || savingOrganization) return;
    const path = organizeTarget.path;
    const isFolder = organizeTarget.kind === "folder";
    const tags = organizeTags.map((value) => value.trim()).filter(Boolean);
    const playlistIds = isFolder ? [] : organizePlaylists;
    const update = { path, tags, playlist_ids: playlistIds, updatedAt: Date.now() };
    setSavingOrganization(true);
    setOrganizeError("");
    try {
      const response = await reachServer("/api/organize", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, tags, playlist_ids: playlistIds }),
      });
      if (response?.status === 400) throw new Error("Use no more than 20 tags, with 32 characters per tag");
      if (response?.ok) {
        clearPendingOfflineOrganization(path);
        await reloadOrganizationState().catch(() => applyOrganizationState(organizedLocally(update)));
        setOrganizeTarget(null);
        flash(isFolder ? "Folder tags updated" : "Tags and playlists updated");
        return;
      }
      if (!pathIsDownloaded(path)) throw new Error(response ? `Server returned ${response.status}` : "The server is unavailable. Only downloaded items can be organized offline.");
      queueOfflineOrganization(path, tags, playlistIds);
      applyOrganizationState(organizedLocally(update));
      setOrganizeTarget(null);
      flash(isFolder ? "Saved locally · Folder tags will sync when the server reconnects" : "Saved locally · Tags and playlists will sync when the server reconnects");
    } catch (error) {
      setOrganizeError(error instanceof Error ? error.message : "Could not organize this item");
    } finally {
      setSavingOrganization(false);
    }
  };

  useEffect(() => {
    if (backendState !== "online") return;
    let cancelled = false;
    void syncPendingOfflineOrganization().then(async ({ synced, favoritesSynced, catalogSynced, processed, playlistIds }) => {
      if (cancelled || !processed) return;
      // A playlist created offline keeps its place under its new server id.
      setActivePlaylistId((current) => current && isOfflinePlaylistId(current) && current in playlistIds ? playlistIds[current] : current);
      await reloadOrganizationState().catch(() => undefined);
      const total = synced + favoritesSynced + catalogSynced;
      if (!cancelled && total) flash(`${total} offline change${total === 1 ? "" : "s"} synced`);
    });
    return () => { cancelled = true; };
  }, [backendState]);
  const buildBulkOrganizationUpdates = () => {
    const addedTags = bulkOrganizeTags.map((value) => value.trim()).filter(Boolean);
    const directPaths = selectedOrganizableItems
      .map((item) => item.path)
      .filter((path): path is string => Boolean(path));
    const tagPaths = bulkTagTargetPaths;
    if (!addedTags.length && !bulkOrganizePlaylists.length) {
      return { error: "Add at least one tag or choose a playlist" as const };
    }
    if (addedTags.length && !tagPaths.length) {
      return { error: "No taggable items found in this selection" as const };
    }
    if (bulkOrganizePlaylists.length && !directPaths.length) {
      return { error: "Select files directly to add them to playlists" as const };
    }
    const pathsToUpdate = new Set<string>();
    if (addedTags.length) tagPaths.forEach((path) => pathsToUpdate.add(path));
    if (bulkOrganizePlaylists.length) directPaths.forEach((path) => pathsToUpdate.add(path));
    const updates = [...pathsToUpdate].map((path) => {
      const mergedTags = addedTags.length
        ? [...new Set([...(customTags[path] ?? []), ...addedTags])]
        : [...(customTags[path] ?? [])];
      const existingPlaylistIds = Object.values(playlists)
        .filter((playlist) => playlist.paths.includes(path))
        .map((playlist) => playlist.id);
      const playlistIds = directPaths.includes(path)
        ? [...new Set([...existingPlaylistIds, ...bulkOrganizePlaylists])]
        : existingPlaylistIds;
      return { path, tags: mergedTags, playlist_ids: playlistIds };
    });
    return { addedTags, updates };
  };
  const applyOptimisticBulkOrganization = (
    updates: Array<{ path: string; tags: string[]; playlist_ids: string[] }>,
    addedTags: string[],
  ) => {
    const nextTags = { ...customTags };
    const nextPlaylists = Object.fromEntries(
      Object.entries(playlists).map(([id, playlist]) => [id, { ...playlist, paths: [...playlist.paths] }]),
    ) as Record<string, Playlist>;
    const now = Math.floor(Date.now() / 1000);
    const nextTagCatalog = { ...tagCatalog };
    for (const update of updates) {
      if (update.tags.length) nextTags[update.path] = update.tags;
      else delete nextTags[update.path];
      for (const playlistId of update.playlist_ids) {
        const playlist = nextPlaylists[playlistId];
        if (playlist && !playlist.paths.includes(update.path)) {
          playlist.paths = [...playlist.paths, update.path];
          playlist.updated_at = now;
        }
      }
    }
    for (const tag of addedTags) {
      if (!nextTagCatalog[tag]) {
        nextTagCatalog[tag] = { name: tag, created_at: now, updated_at: now };
      }
    }
    applyOrganizationState({ tags: nextTags, tag_catalog: nextTagCatalog, playlists: nextPlaylists });
  };
  const syncBulkOrganizationUpdates = async (
    updates: Array<{ path: string; tags: string[]; playlist_ids: string[] }>,
  ) => {
    let failedCount = 0;
    let queuedCount = 0;
    for (const update of updates) {
      const response = await reachServer("/api/organize", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      });
      if (response?.ok) {
        clearPendingOfflineOrganization(update.path);
      } else if (response?.status !== 400 && pathIsDownloaded(update.path)) {
        queueOfflineOrganization(update.path, update.tags, update.playlist_ids);
        queuedCount += 1;
      } else {
        failedCount += 1;
      }
    }
    if (!failedCount && !queuedCount) return;
    if (failedCount) {
      try {
        await reloadOrganizationState();
      } catch {
      }
      flash(`Could not save changes for ${failedCount} item${failedCount === 1 ? "" : "s"}. Restored server tags.`);
      return;
    }
    flash(`Saved locally · ${queuedCount} update${queuedCount === 1 ? "" : "s"} will sync when the server reconnects`);
  };
  const startBulkOrganizing = () => {
    if (!canBulkOrganize) return;
    setBulkOrganizeError("");
    setBulkOrganizeTags([]);
    setBulkOrganizePlaylists([]);
    setBulkOrganizeOpen(true);
  };
  const saveBulkOrganization = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const plan = buildBulkOrganizationUpdates();
    if ("error" in plan) {
      setBulkOrganizeError(plan.error ?? "Could not update selection");
      return;
    }
    const { addedTags, updates } = plan;
    setBulkOrganizeError("");
    applyOptimisticBulkOrganization(updates, addedTags);
    setBulkOrganizeOpen(false);
    exitSelectionMode();
    flash(`Updated tags and playlists for ${updates.length} item${updates.length === 1 ? "" : "s"}`);
    void syncBulkOrganizationUpdates(updates);
  };
  // Create on the server, or on this device when the server is unavailable.
  const createPlaylistRecord = async (name: string) => {
    const response = await reachServer("/api/playlists", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!response) return queueOfflinePlaylistCreate(name, Object.values(playlists).map((playlist) => playlist.name));
    if (!response.ok) throw new Error(response.status === 409 ? "A playlist with that name already exists" : `Server returned ${response.status}`);
    return await response.json() as Playlist;
  };
  const createdPlaylistMessage = (playlist: Playlist) =>
    isOfflinePlaylistId(playlist.id) ? `Created ${playlist.name} · It will sync when the server reconnects` : `Created ${playlist.name}`;
  const createPlaylistInline = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || savingPlaylist) return;
    setSavingPlaylist(true);
    setOrganizeError("");
    setBulkOrganizeError("");
    try {
      const playlist = await createPlaylistRecord(trimmed);
      setPlaylists((current) => ({ ...current, [playlist.id]: playlist }));
      if (bulkOrganizeOpen) {
        setBulkOrganizePlaylists((current) => [...current, playlist.id]);
      } else {
        setOrganizePlaylists((current) => [...current, playlist.id]);
      }
      flash(createdPlaylistMessage(playlist));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not create playlist";
      if (bulkOrganizeOpen) setBulkOrganizeError(message);
      else setOrganizeError(message);
    } finally {
      setSavingPlaylist(false);
    }
  };
  const createPlaylist = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!playlistDraft || savingPlaylist) return;
    setSavingPlaylist(true);
    setPlaylistError("");
    try {
      const playlist = await createPlaylistRecord(playlistDraft);
      setPlaylists((current) => ({ ...current, [playlist.id]: playlist }));
      setActivePlaylistId(playlist.id);
      setSection("playlists");
      setCurrentFolder(null);
      setPlaylistDraft(null);
      flash(createdPlaylistMessage(playlist));
    } catch (error) {
      setPlaylistError(error instanceof Error ? error.message : "Could not create playlist");
    } finally {
      setSavingPlaylist(false);
    }
  };
  const createTag = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!tagDraft?.trim() || savingTag) return;
    setSavingTag(true);
    setTagError("");
    try {
      const response = await reachServer("/api/tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: tagDraft }),
      });
      if (response && !response.ok) throw new Error(response.status === 409 ? "A tag with that name already exists" : response.status === 400 ? "Use a name of up to 32 characters" : `Server returned ${response.status}`);
      const tag = response
        ? await response.json() as TagDefinition
        : queueOfflineTagCreate(tagDraft, [...Object.keys(tagCatalog), ...Object.values(customTags).flat()]);
      setTagCatalog((current) => ({ ...current, [tag.name]: tag }));
      setTagDraft(null);
      setSidebarExpanded((current) => ({ ...current, tags: true }));
      flash(response ? `Created #${tag.name}` : `Created #${tag.name} · It will sync when the server reconnects`);
    } catch (error) {
      setTagError(error instanceof Error ? error.message : "Could not create tag");
    } finally {
      setSavingTag(false);
    }
  };
  const deletePlaylist = async (id: string) => {
    if (savingPlaylist) return;
    const playlist = playlists[id];
    if (!playlist) return;
    setSavingPlaylist(true);
    try {
      // A playlist created offline was never saved on the server.
      const response = isOfflinePlaylistId(id) ? null : await reachServer(`/api/playlists/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (response && !response.ok) throw new Error(`Server returned ${response.status}`);
      if (!response) queueOfflinePlaylistDelete(id);
      setPlaylists((current) => {
        const next = { ...current };
        delete next[id];
        return next;
      });
      setActivePlaylistId((current) => current === id ? null : current);
      flash(response || isOfflinePlaylistId(id) ? `Deleted ${playlist.name}` : `Deleted ${playlist.name} · It will sync when the server reconnects`);
      setDeletePlaylistTarget(null);
    } catch (error) {
      flash(error instanceof Error ? `Could not delete playlist: ${error.message}` : "Could not delete playlist");
    } finally {
      setSavingPlaylist(false);
    }
  };
  const deleteActivePlaylist = () => {
    if (activePlaylistId && playlists[activePlaylistId]) {
      setDeletePlaylistTarget(playlists[activePlaylistId]);
    }
  };
  const deleteTag = async (tagName: string) => {
    if (savingTag) return;
    setSavingTag(true);
    try {
      const response = await reachServer(`/api/tags/${encodeURIComponent(tagName)}`, { method: "DELETE" });
      if (response && !response.ok) throw new Error(`Server returned ${response.status}`);
      if (response) {
        await reloadOrganizationState();
      } else {
        queueOfflineTagDelete(tagName);
        applyOrganizationState({ tags: customTags, tag_catalog: tagCatalog, playlists });
      }
      setActiveTags((current) => current.filter((tag) => tag !== tagName));
      flash(response ? `Deleted #${tagName}` : `Deleted #${tagName} · It will sync when the server reconnects`);
      setDeleteTagTarget(null);
    } catch (error) {
      flash(error instanceof Error ? `Could not delete tag: ${error.message}` : "Could not delete tag");
    } finally {
      setSavingTag(false);
    }
  };

  const toggleFavorite = async (item: MediaItem) => {
    if (!item.path) return flash("This item is not backed by a library path");
    const favorite = !item.favorite;
    const path = item.path;
    setFavoritePaths((current) => favorite ? [...new Set([...current, path])] : current.filter((entry) => entry !== path));
    setItems((current) => current.map((candidate) => candidate.path === path ? { ...candidate, favorite } : candidate));
    setOfflineFavoriteOverrides((current) => ({ ...current, [path]: favorite }));
    updateLibraryCache((current) => {
      const favorites = new Set(current.userState.favorites);
      if (favorite) favorites.add(path); else favorites.delete(path);
      return { ...current, favoritePaths: [...favorites], userState: { ...current.userState, favorites: [...favorites] } };
    });
    try {
      const response = await authFetch(`${API_BASE}/api/favorites`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path, favorite }) });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      clearPendingOfflineFavorite(path);
      setOfflineFavoriteOverrides((current) => {
        const next = { ...current };
        delete next[path];
        return next;
      });
      flash(favorite ? "Added to favorites" : "Removed from favorites");
    } catch (error) {
      if (item.offline || section === "offline" || pathIsDownloaded(path)) {
        queueOfflineFavorite(path, favorite);
        flash(favorite ? "Saved locally · Favorite will sync when the server reconnects" : "Saved locally · Favorite change will sync when the server reconnects");
        return;
      }
      setFavoritePaths((current) => favorite ? current.filter((entry) => entry !== path) : [...new Set([...current, path])]);
      setItems((current) => current.map((candidate) => candidate.path === path ? { ...candidate, favorite: !favorite } : candidate));
      setOfflineFavoriteOverrides((current) => {
        const next = { ...current };
        delete next[path];
        return next;
      });
      flash(error instanceof Error ? `Could not save favorite: ${error.message}` : "Could not save favorite");
    }
  };
  const downloadPreview = (item: MediaItem) => {
    if (!item.src) return flash("This item is not available from the server");
    const link = document.createElement("a");
    link.href = item.src;
    link.download = item.name;
    link.click();
  };
  const collectOfflineFiles = async (item: MediaItem): Promise<OfflineFile[]> => {
    const selectedPath = mediaPath(item);
    if (!selectedPath) throw new Error("This item is not backed by a hosted file.");
    const toOfflineFile = (media: MediaItem): OfflineFile | null => {
      if (media.kind === "folder" || !media.path || !media.src) return null;
      const relativePath = item.kind === "folder" && media.path.startsWith(`${selectedPath}/`)
        ? media.path.slice(selectedPath.length + 1)
        : media.name;
      return {
        id: `offline-file-${stableId(media.path)}`,
        path: media.path,
        name: media.name,
        kind: media.kind,
        size: media.sizeBytes ?? 0,
        url: new URL(media.src, window.location.href).href,
        relativePath,
      };
    };
    if (item.kind !== "folder") {
      const file = toOfflineFile(item);
      if (!file) throw new Error("This file cannot be hosted by TMS.");
      return [file];
    }
    const folders = [selectedPath];
    const visited = new Set<string>();
    const files: OfflineFile[] = [];
    while (folders.length) {
      const folder = folders.shift()!;
      if (visited.has(folder)) continue;
      visited.add(folder);
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const response = await authFetch(libraryApiUrl("name", "asc", folder, offset));
        if (!response.ok) throw new Error(`Could not read ${folder} (${response.status})`);
        const entries = await response.json() as ApiLibraryEntry[];
        entries.map(apiEntryToMediaItem).forEach((entry) => {
          if (!entry) return;
          if (entry.kind === "folder" && entry.path) folders.push(entry.path);
          else {
            const file = toOfflineFile(entry);
            if (file) files.push(file);
          }
        });
        offset += libraryConsumedCount(response, entries.length);
        hasMore = response.headers.get("x-tms-has-more") === "true" && entries.length > 0;
      }
    }
    if (!files.length) throw new Error("No hosted files were found in this folder.");
    return files;
  };
  const collectOfflineCovers = (path: string, files: OfflineFile[], coverPaths = folderCovers): Record<string, OfflineFile> => {
    const folderPaths = new Set<string>([path]);
    for (const file of files) {
      const parts = file.path.split("/");
      for (let index = 1; index < parts.length; index += 1) {
        const folderPath = parts.slice(0, index).join("/");
        if (folderPath === path || folderPath.startsWith(`${path}/`)) folderPaths.add(folderPath);
      }
    }
    return Object.fromEntries(Array.from(folderPaths).flatMap((folderPath) => {
      const coverName = coverPaths[folderPath];
      if (!coverName) return [];
      return [[folderPath, {
        id: `offline-cover-${stableId(folderPath)}`, path: folderPath,
        name: "folder-cover.jpg", kind: "image" as const, size: 0,
        url: `${API_BASE}/folder-covers/${encodeURIComponent(coverName)}`,
        relativePath: `.tms-folder-cover-${stableId(folderPath)}.jpg`,
      } satisfies OfflineFile]];
    }));
  };
  const saveItemOffline = async (item: MediaItem) => {
    const path = mediaPath(item);
    if (!path || offlineBusy) return;
    if (offlineBundles.some((bundle) => bundle.path === path && bundle.status === "ready")) {
      const bundle = offlineBundles.find((candidate) => candidate.path === path && candidate.status === "ready");
      setSection("offline");
      setCurrentFolder(bundle ? offlineFolderFromLocation(bundle) : null);
      return flash(`${item.name} is already available offline`);
    }
    setOfflineBusy(true);
    try {
      let location = await offlineLocation();
      if (!location.configured) location = await chooseOfflineLocation();
      setOfflineLocationName(location.name || undefined);
      flash(item.kind === "folder" ? `Finding files in ${item.name}…` : `Preparing ${item.name}…`);
      const files = await collectOfflineFiles(item);
      const covers = item.kind === "folder" ? collectOfflineCovers(path, files) : {};
      const updateBundle = (bundle: OfflineBundle) => setOfflineBundles((current) => {
        const index = current.findIndex((entry) => entry.id === bundle.id);
        if (index < 0) return [bundle, ...current];
        const next = [...current];
        next[index] = bundle;
        return next;
      });
      await makeAvailableOffline({ ...item, path }, files, covers, updateBundle);
      await refreshOfflineDownloads();
      flash(`${item.name} is ready offline`);
    } catch (error) {
      flash(error instanceof Error ? error.message : "Could not make this item available offline");
    } finally {
      setOfflineBusy(false);
    }
  };
  useEffect(() => {
    if (backendState !== "online" || !sessionUser?.id) return;
    let cancelled = false;
    void (async () => {
      const coversResponse = await authFetch(`${API_BASE}/api/folder-covers`);
      if (!coversResponse.ok) return;
      const coverPaths = await coversResponse.json() as Record<string, string>;
      for (const bundle of offlineBundles.filter((candidate) => (candidate.status === "ready" || candidate.status === "error") && candidate.kind === "folder")) {
        if (cancelled) return;
        if (offlineSyncInFlightRef.current.has(bundle.id)) continue;
        offlineSyncInFlightRef.current.add(bundle.id);
        try {
          const sourcePath = bundle.path;
          const files = await collectOfflineFiles({
            id: 0, path: sourcePath, name: bundle.name, kind: "folder", size: "0 B", updated: "", tags: [], owner: "", tone: "",
            parent: sourcePath.split("/").slice(0, -1).join("/"),
          });
          const covers = collectOfflineCovers(sourcePath, files, coverPaths);
          const sameFiles = files.length === bundle.files.length && files.every((file, index) => {
            const saved = bundle.files[index];
            return file.path === saved?.path && file.name === saved.name
              && file.size === saved.size && file.url === saved.url;
          });
          const savedCovers = bundle.covers ?? {};
          const sameCovers = Object.keys(covers).length === Object.keys(savedCovers).length
            && Object.entries(covers).every(([path, cover]) => {
              const saved = savedCovers[path];
              return saved?.id === cover.id && saved.url === cover.url && saved.size === cover.size
                && Boolean(saved.localUri?.includes(".tms_data"));
            });
          // A catalog check must not rewrite every SAF entry and briefly mark
          // a complete folder as downloading while its audio is playing.
          if (bundle.status === "ready" && sameFiles && sameCovers) continue;
          const updated = await reconcileOfflineBundle({ ...bundle, path: sourcePath }, files, covers);
          if (!cancelled) {
            setOfflineBundles((current) => current.map((entry) => entry.id === updated.id ? updated : entry));
            setOfflineSyncError("");
          }
        } catch (error) {
          // Keep the existing offline copy usable if a background refresh fails.
          console.warn(`Could not sync offline folder ${bundle.name}`, error);
          if (!cancelled) setOfflineSyncError(`${bundle.name}: ${error instanceof Error ? error.message : "Sync failed. Try again."}`);
        } finally {
          offlineSyncInFlightRef.current.delete(bundle.id);
        }
      }
    })().catch(() => undefined);
    return () => { cancelled = true; };
  }, [backendState, folderCovers, offlineBundles, offlineCatalogSyncTick, sessionUser?.id]);

  useEffect(() => {
    if (backendState !== "online" || !sessionUser?.id) return;
    const timer = window.setTimeout(() => setOfflineCatalogSyncTick((value) => value + 1), 60_000);
    return () => window.clearTimeout(timer);
  }, [backendState, offlineCatalogSyncTick, sessionUser?.id]);
  const syncOfflineFolders = async () => {
    if (offlineBusy) return;
    setOfflineBusy(true);
    try {
      for (const bundle of offlineBundles.filter((entry) => entry.kind === "folder")) await authorizeOfflineSync(bundle);
      setOfflineSyncError("");
      setOfflineCatalogSyncTick((value) => value + 1);
    } catch (error) {
      setOfflineSyncError(error instanceof Error ? error.message : "Could not sync offline folders.");
    } finally {
      setOfflineBusy(false);
    }
  };
  const chooseOfflineDownloadLocation = async () => {
    if (offlineBusy) return;
    setOfflineBusy(true);
    try {
      const location = await chooseOfflineLocation();
      setOfflineLocationName(location.name || undefined);
      // Choosing the folder used before a reinstall restores its downloads.
      await refreshOfflineDownloads();
      flash(location.name ? `Offline downloads will be saved in ${location.name}` : "Offline download location saved");
    } catch (error) {
      flash(error instanceof Error ? error.message : "Could not choose an offline folder");
    } finally {
      setOfflineBusy(false);
    }
  };
  const removeOfflineDownload = async (bundle: OfflineBundle) => {
    if (!window.confirm(`Remove the offline copy of ${bundle.name}? The server copy will not be changed.`)) return;
    try {
      await removeOfflineBundle(bundle.id);
      setOfflineBundles((current) => current.filter((entry) => entry.id !== bundle.id));
      flash(`Removed the offline copy of ${bundle.name}`);
    } catch (error) {
      flash(error instanceof Error ? error.message : "Could not remove the offline copy");
    }
  };
  const retryOfflineDownload = async (bundle: OfflineBundle) => {
    if (offlineBusy || bundle.status !== "error") return;
    setOfflineBusy(true);
    const updateBundle = (next: OfflineBundle) => setOfflineBundles((current) => current.map((entry) => entry.id === next.id ? next : entry));
    try {
      await retryOfflineBundle(bundle, updateBundle);
      await refreshOfflineDownloads();
      flash(`${bundle.name} is ready offline`);
    } catch (error) {
      flash(error instanceof Error ? error.message : `Could not retry ${bundle.name}`);
    } finally {
      setOfflineBusy(false);
    }
  };
  const openDownloadedFile = async (bundle: OfflineBundle, file: OfflineFile, item: MediaItem) => {
    try {
      const filteredQueue = playableVisible
        .filter((candidate) => Boolean(candidate.offline?.fileId && candidate.src))
        .map((candidate) => candidate.id === item.id ? item : candidate);
      if (file.kind === "audio") {
        const resolved = await resolveOfflineFileUrl(bundle.id, file.id);
        const selected = { ...item, src: resolved.url };
        const queue = filteredQueue.map((candidate) => candidate.id === item.id ? selected : candidate);
        startPlaybackSession({ userId: sessionUser?.id ?? 0, item: selected, queue: queue.length ? queue : [selected],
          label: bundle.name, returnUrl: `${window.location.pathname}${window.location.search}`, complete: true, time: 0, playing: true });
        return;
      }
      if (file.kind === "video" || file.kind === "image") {
        const queue = filteredQueue.some((candidate) => candidate.id === item.id) ? filteredQueue : [item];
        let hasQueue = false;
        try {
          sessionStorage.setItem(PLAYBACK_QUEUE_KEY, storedPlaybackQueue(queue));
          sessionStorage.removeItem(LEGACY_PLAYBACK_QUEUE_KEY);
          sessionStorage.removeItem(PLAYBACK_QUEUE_ORDER_KEY);
          hasQueue = true;
        } catch {
          // The selected file can still play if browser storage is unavailable.
        }
        const returnParams = new URLSearchParams({ section: "offline" });
        if (currentFolder) returnParams.set("folder", currentFolder);
        const params = new URLSearchParams({
          offlineBundle: bundle.id,
          offlineFile: file.id,
          path: file.path,
          name: file.name,
          size: formatBytes(file.size),
          folder: item.parent ?? bundle.path,
          kind: file.kind,
          play: "1",
          return: `/?${returnParams.toString()}`,
        });
        if (hasQueue) {
          params.set("queue", "custom");
          params.set("queueLabel", "Queue");
        }
        navigateApp(`/watch?${params.toString()}`);
        return;
      }
      await openOfflineFile(bundle.id, file.id);
    } catch (error) {
      flash(error instanceof Error ? error.message : `Could not open ${file.name}`);
    }
  };
  const downloadFolder = async (item: MediaItem) => {
    const path = mediaPath(item);
    if (!path) return flash("This folder is not available from the server");
    try {
      const response = await authFetch(`${API_BASE}/api/folder-download?path=${encodeURIComponent(path)}`, { method: "POST" });
      const result = await response.json() as { url?: string; filename?: string; item_count?: number; message?: string };
      if (!response.ok || !result.url) throw new Error(result.message || "Could not create the folder download.");
      const link = document.createElement("a");
      link.href = result.url;
      link.download = result.filename || `${item.name}.zip`;
      link.click();
      flash(`Downloading ${result.item_count ?? 0} file${result.item_count === 1 ? "" : "s"} from ${item.name}`);
    } catch (error) {
      flash(error instanceof Error ? error.message : "Could not download this folder");
    }
  };
  const rememberFolder = useCallback((path: string) => {
    setRecentFolders((current) => [path, ...current.filter((item) => item !== path)].slice(0, 6));
  }, []);
  const resolveFolderDestination = useCallback((path: string) => {
    const libraryPath = path.split("/")[0];
    if (authoritativeFolder !== path || libraries[libraryPath]?.content_type !== "movies_tv" || !isTitleFolder(path)) return { path, episodeList: false };
    const evidence = mediaEvidenceForFolder(items, path);
    if (evidence.kind !== "series") return { path, episodeList: false };
    const seasons = items.filter((item) => item.kind === "folder" && item.parent === path && seasonNumberForFolder(items, `${path}/${item.name}`) !== null);
    if (seasons.length !== 1) return { path, episodeList: false };
    return { path: `${path}/${seasons[0].name}`, episodeList: true };
  }, [authoritativeFolder, isTitleFolder, items, libraries]);

  const openFolderDocument = (path: string) => {
    // Ordinary folders already have a complete URL. Start a real navigation
    // before React can spend time re-filtering a very large cached library.
    // The destination restores its own saved sort, tag, and view preferences.
    if (uploadWorkerCount.current > 0) {
      // A document navigation would abort every running upload, so browse
      // in place until the uploads finish.
      restoreFolderBrowsePrefs(path);
      setSection("library");
      setCurrentFolder(path);
      window.scrollTo(0, 0);
    } else {
      navigateApp(`/?folder=${encodeURIComponent(path)}`);
    }
    void authFetch(`${API_BASE}/api/activity/access`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path }),
      keepalive: true,
    }).catch(() => undefined);
  };

  // A direct URL to a single-season show should land on its episodes, not an
  // unnecessary one-card season screen. Normal multi-season shows stay put.
  useEffect(() => {
    if (section !== "library" || !currentFolder) return;
    const destination = resolveFolderDestination(currentFolder);
    if (!destination.episodeList || destination.path === currentFolder) return;
    restoreFolderBrowsePrefs(destination.path);
    setCurrentFolder(destination.path);
    rememberFolder(destination.path);
  }, [currentFolder, rememberFolder, resolveFolderDestination, section]);

  const openFolder = (item: MediaItem) => {
    if (item.offline) {
      if (item.offline.status && item.offline.status !== "ready") return;
      const path = item.parent ? `${item.parent}/${item.name}` : item.name;
      const saved = readLibraryBrowsePrefs(path);
      setSort(saved.sort);
      setSortDirection(saved.sortDirection);
      setLibraryView(saved.view);
      setCurrentFolder(path);
      window.scrollTo(0, 0);
      return;
    }
    const path = item.parent ? `${item.parent}/${item.name}` : item.name;
    if (!isTitleFolder(path)) {
      openFolderDocument(path);
      return;
    }
    void recordAccess(path, false);
    const evidence = mediaEvidenceForFolder(items, path);
    if (evidence.kind === "movie") return playCatalogTitle(path, "movie");
    const destination = resolveFolderDestination(path);
    restoreFolderBrowsePrefs(destination.path);
    setCurrentFolder(destination.path);
    rememberFolder(destination.path);
    window.scrollTo(0, 0);
  };
  const cacheSidebarFolder = (path: string) => {
    if (sidebarTreeEntries[path]) return;
    void authFetch(libraryApiUrl("name", "asc", path))
      .then(async (response) => {
        if (!response.ok) return;
        const entries = await response.json() as ApiLibraryEntry[];
        setSidebarTreeEntries((current) => ({
          ...current,
          [path]: entries.map(apiEntryToMediaItem).filter((item): item is MediaItem => item !== null),
        }));
      })
      .catch(() => undefined);
  };
  const openFolderFromTree = (folder: MediaItem) => {
    const path = folder.parent ? `${folder.parent}/${folder.name}` : folder.name;
    if (!isTitleFolder(path)) {
      openFolderDocument(path);
      return;
    }
    const destination = resolveFolderDestination(path);
    void recordAccess(destination.path, false);
    setSection("library");
    restoreFolderBrowsePrefs(destination.path);
    setCurrentFolder(destination.path);
    rememberFolder(destination.path);
    window.scrollTo(0, 0);
    if (!expandedFolders.includes(path)) cacheSidebarFolder(path);
    setExpandedFolders((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path]);
  };
  const homeScreenDestination = (item: MediaItem) => {
    const path = mediaPath(item);
    const catalogTitle = catalogTitleForItem(item);
    if (catalogTitle?.evidence.kind === "series") return `/?folder=${encodeURIComponent(catalogTitle.path)}`;
    if (catalogTitle) {
      const params = new URLSearchParams({ catalogPath: catalogTitle.path, catalogKind: catalogTitle.evidence.kind, catalog: "movies_tv", play: "1" });
      return `/watch?${params.toString()}`;
    }
    if (item.kind === "folder" && path) return `/?folder=${encodeURIComponent(path)}`;
    if (!item.src) return "/";
    const params = new URLSearchParams({
      src: item.src,
      name: item.name,
      size: item.size,
      folder: item.parent ?? "My library",
      kind: item.kind,
      play: "1",
    });
    if (libraryType === "movies_tv") params.set("catalog", "movies_tv");
    if (item.catalogKind) params.set("catalogKind", item.catalogKind);
    return `/watch?${params.toString()}`;
  };
  const createHomeScreenShortcut = (item: MediaItem) => {
    const destination = homeScreenDestination(item);
    if (Capacitor.getPlatform() !== "android") {
      const params = new URLSearchParams({ to: destination, name: item.name });
      window.location.assign(`/shortcut?${params.toString()}`);
      return;
    }
    void addNativeHomeScreenShortcut(destination, item.name)
      .then((requested) => {
        if (requested) flash("Customize your shortcut");
        else flash("Your Android launcher does not support Home screen shortcuts");
      })
      .catch(() => flash("Could not add the Home screen shortcut"));
  };
  const folderPath = (folder: MediaItem) => mediaPath(folder) ?? folder.name;
  const automaticFolderCover = (path: string) => {
    const candidates = items.filter((item) => (item.kind === "image" || item.kind === "video") && item.src && (item.parent === path || item.parent?.startsWith(`${path}/`)));
    return candidates.length ? candidates[stableId(`cover:${path}`) % candidates.length] : null;
  };
  const chooseFolderCover = (folder: MediaItem) => {
    setCoverFolder(folder);
    setContextItem(null);
    coverInput.current?.click();
  };
  const uploadFolderCover = async (file: File | undefined) => {
    if (!file || !coverFolder) return;
    const path = folderPath(coverFolder);
    try {
      const response = await authFetch(`${API_BASE}/api/folder-covers`, { method: "PUT", headers: { "Content-Type": file.type, "X-Folder-Path": path }, body: file });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const coversResponse = await fetch(`${API_BASE}/api/folder-covers?t=${Date.now()}`);
      if (!coversResponse.ok) throw new Error("Could not reload folder covers");
      const nextFolderCovers = await coversResponse.json() as Record<string, string>;
      setFolderCovers(nextFolderCovers);
      updateLibraryCache((current) => ({ ...current, folderCovers: nextFolderCovers }));
      flash(`Cover updated for ${coverFolder.name}`);
    } catch (error) {
      flash(error instanceof Error ? `Could not save cover: ${error.message}` : "Could not save cover");
    } finally {
      setCoverFolder(null);
      if (coverInput.current) coverInput.current.value = "";
    }
  };
  const changeFolderCover = async (folder: MediaItem) => {
    const path = folderPath(folder);
    setContextItem(null);
    try {
      const response = await authFetch(`${API_BASE}/api/folder-covers/automatic`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ folder_path: path, refresh: true }),
      });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const result = await response.json() as { filename?: string };
      if (!result.filename) throw new Error("TMS could not create a new cover");
      setFolderCovers((current) => ({ ...current, [path]: result.filename! }));
      updateLibraryCache((current) => ({ ...current, folderCovers: { ...current.folderCovers, [path]: result.filename! } }));
      flash(`Generated a new cover for ${folder.name}`);
    } catch (error) {
      flash(error instanceof Error ? `Could not change cover: ${error.message}` : "Could not change cover");
    }
  };
  const refreshLibraryEntries = async (targetFolder = currentFolder) => {
    const response = await authFetch(libraryApiUrl(sort, sortDirection, targetFolder));
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    const entries = await response.json() as ApiLibraryEntry[];
    const favoritePaths = new Set(items.filter((item) => item.favorite).map((item) => item.path).filter((path): path is string => Boolean(path)));
    const nextItems = entries.map(apiEntryToMediaItem).filter((item): item is MediaItem => item !== null).map((item) => withOpenedMetadata(item, lastAccessed, playback, { favorite: item.path ? favoritePaths.has(item.path) : false }));
    setItems(nextItems);
    setSidebarTreeEntries((current) => ({ ...current, [targetFolder ?? ""]: nextItems }));
    updateLibraryCache((current) => ({
      ...current,
      entries: targetFolder ? current.entries : entries,
      pages: {
        ...current.pages,
        [libraryCachePageKey(targetFolder, sort, sortDirection)]: entries,
      },
    }));
  };
  const refreshAfterMediaMove = async () => {
    clearBrowseSnapshot();
    setSidebarTreeEntries({});
    updateLibraryCache((current) => ({ ...current, entries: [], pages: {} }));
    const [, stateResponse, coversResponse] = await Promise.all([
      refreshLibraryEntries(),
      authFetch(`${API_BASE}/api/user-state`),
      authFetch(`${API_BASE}/api/folder-covers?t=${Date.now()}`),
    ]);
    if (!stateResponse.ok || !coversResponse.ok) throw new Error("Moved successfully, but could not refresh saved metadata");
    const state = await stateResponse.json() as UserState;
    const covers = await coversResponse.json() as Record<string, string>;
    setPlayback(state.playback);
    setLastAccessed(state.last_accessed ?? {});
    applyOrganizationState(state);
    applyFavoritePaths(state.favorites);
    setFolderCovers(covers);
    updateLibraryCache((current) => ({ ...current, userState: state, folderCovers: covers }));
  };
  const startMoveDrag = (event: DragEvent<HTMLElement>, item: MediaItem) => {
    if (!canMoveItem(item)) { event.preventDefault(); return; }
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", mediaPath(item) ?? "");
    setDraggedItem(item);
  };
  const allowDrop = (event: DragEvent<HTMLElement>, destinationPath: string) => {
    if (!draggedItem || !canMoveInPath(destinationPath)) return;
    const sourcePath = mediaPath(draggedItem);
    if (!sourcePath || sourcePath === destinationPath || destinationPath.startsWith(`${sourcePath}/`)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDragTarget(destinationPath);
  };
  const moveToFolder = async (event: DragEvent<HTMLElement>, destinationPath: string) => {
    event.preventDefault();
    const item = draggedItem;
    setDragTarget(null);
    setDraggedItem(null);
    const sourcePath = item ? mediaPath(item) : null;
    if (!sourcePath || sourcePath === destinationPath || destinationPath.startsWith(`${sourcePath}/`)) return;
    try {
      const response = await authFetch(`${API_BASE}/api/move`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source_path: sourcePath, destination_path: destinationPath }) });
      if (response.status === 403) throw new Error("You do not have permission to move there");
      if (response.status === 409) throw new Error("That folder already contains an item with this name");
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      await refreshAfterMediaMove();
      flash(`Moved ${item?.name}`);
    } catch (error) {
      flash(error instanceof Error ? `Could not move: ${error.message}` : "Could not move item");
    }
  };

  const moveMedia = async (autoRename = false, targetOverride: MediaItem | null = null, destinationOverride: string | null = null) => {
    const target = targetOverride ?? moveTarget;
    const destination = destinationOverride ?? moveDestination;
    if (!target || !destination || movingMedia) return;
    const started = performance.now();
    setMoveTarget(null);
    setMovingMedia(true);
    setMoveError("");
    const sourcePath = mediaPath(target);
    setItems((current) => current.filter((item) => item.path !== sourcePath && !item.path?.startsWith(`${sourcePath}/`)));
    updateLibraryCache((current) => ({
      ...current,
      entries: current.entries.filter((entry) => entry.path !== sourcePath && !entry.path.startsWith(`${sourcePath}/`)),
    }));
    if (currentFolder === sourcePath || currentFolder?.startsWith(`${sourcePath}/`)) {
      setCurrentFolder(target.parent ?? null);
    }
    try {
      const response = await authFetch(`${API_BASE}/api/move`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source_path: sourcePath, destination_path: destination, ...(autoRename ? { conflict_strategy: "auto_rename" } : {}) }) });
      if (response.status === 403) throw new Error("You do not have permission to move there");
      if (response.status === 409 && !autoRename) {
        void refreshLibraryEntries();
        setNameConflict({ action: "move", name: target.name, retry: () => void moveMedia(true, target, destination) });
        return;
      }
      if (response.status === 409) throw new Error("Could not find an available conflict name");
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const result = await response.json().catch(() => null) as { path?: string; name?: string } | null;
      await refreshAfterMediaMove();
      reportClientPerformance("media_move", performance.now() - started, { outcome: "success", item_kind: target.kind, auto_renamed: autoRename });
      flash(`Moved ${result?.name || target.name}${autoRename ? " with a conflict-safe name" : ""}`);
    } catch (error) {
      reportClientPerformance("media_move", performance.now() - started, { outcome: "error", item_kind: target.kind, auto_renamed: autoRename });
      reportClientError(error, { kind: "media-move", source: sourcePath ?? "" });
      void refreshLibraryEntries();
      flash(error instanceof Error ? `Could not move: ${error.message}` : "Could not move item");
    } finally {
      setMovingMedia(false);
    }
  };

  const startFolderCreation = (parentPath: string) => {
    setLibraryContext(null);
    setFolderCreateError("");
    setFolderDraft({ parentPath, name: "" });
  };
  const startLibraryCreation = () => {
    setLibrariesContext(null);
    setLibraryCreateError("");
    setLibraryDraft({ name: "", contentType: "mixed" });
  };
  const startRename = (item: MediaItem) => {
    setContextItem(null);
    setRenameError("");
    setRenameName(item.kind === "folder" ? item.name : fileNameStem(item.name));
    setRenameTarget(item);
  };
  const renameMedia = async (event?: FormEvent<HTMLFormElement> | null, autoRename = false, targetOverride: MediaItem | null = null, nameOverride: string | null = null) => {
    event?.preventDefault();
    const target = targetOverride ?? renameTarget;
    const name = (nameOverride ?? renameName).trim();
    const sourcePath = target ? mediaPath(target) : null;
    if (!sourcePath || !name || renaming) return;
    const requestedFinalName = target?.kind === "folder" ? name : `${name}${fileNameExtension(target?.name ?? "")}`;
    if (requestedFinalName === target?.name) {
      setRenameTarget(null);
      return;
    }
    const started = performance.now();
    setRenaming(true);
    setRenameError("");
    setRenameTarget(null);
    try {
      const response = await authFetch(`${API_BASE}/api/rename`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source_path: sourcePath, new_name: name, ...(autoRename ? { conflict_strategy: "auto_rename" } : {}) }) });
      if (response.status === 403) throw new Error("You do not have permission to rename this item");
      if (response.status === 409 && !autoRename) {
        setRenameTarget(null);
        setNameConflict({ action: "rename", name: requestedFinalName, retry: () => void renameMedia(null, true, target, name) });
        return;
      }
      if (response.status === 409) throw new Error("Could not find an available conflict name");
      if (response.status === 404) {
        void refreshLibraryEntries();
        throw new Error("Item not found on server. Refreshing library view...");
      }
      if (response.status === 500) throw new Error("Could not rename. Close the file if it is open, then try again.");
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const result = await response.json().catch(() => null) as { path?: string; name?: string } | null;
      const finalName = result?.name || requestedFinalName;
      const destinationPath = result?.path || `${sourcePath.slice(0, sourcePath.lastIndexOf("/") + 1)}${finalName}`;
      const isFolder = target?.kind === "folder";
      const swapTarget = !isFolder
        ? items.find((item) => item.path === destinationPath && item.path !== sourcePath)
        : undefined;

      setItems((current) => current.map((item) => {
        if (swapTarget && item.path === destinationPath) {
          return {
            ...item,
            id: stableId(`file:${sourcePath}`),
            name: target?.name ?? item.name,
            path: sourcePath,
            src: mediaUrl(sourcePath),
            thumbSrc: gridThumbUrl(sourcePath),
          };
        }
        if (item.path === sourcePath) {
          return {
            ...item,
            id: stableId(`${isFolder ? "folder" : "file"}:${destinationPath}`),
            name: finalName,
            path: destinationPath,
            src: isFolder ? item.src : mediaUrl(destinationPath),
            thumbSrc: isFolder ? item.thumbSrc : gridThumbUrl(destinationPath),
          };
        }
        if (isFolder && item.path?.startsWith(`${sourcePath}/`)) {
          const rewritten = rewritePathPrefix(item.path, sourcePath, destinationPath);
          return {
            ...item,
            id: stableId(`${item.kind === "folder" ? "folder" : "file"}:${rewritten}`),
            path: rewritten,
            parent: item.parent ? rewritePathPrefix(item.parent, sourcePath, destinationPath) : item.parent,
            src: item.kind === "folder" ? item.src : mediaUrl(rewritten),
            thumbSrc: item.kind === "folder" ? item.thumbSrc : gridThumbUrl(rewritten),
          };
        }
        return item;
      }));

      updateLibraryCache((current) => {
        const rewriteEntry = (entry: ApiLibraryEntry): ApiLibraryEntry => {
          if (entry.path === sourcePath) {
            return { ...entry, path: destinationPath, name: finalName };
          }
          if (isFolder && entry.path.startsWith(`${sourcePath}/`)) {
            return { ...entry, path: rewritePathPrefix(entry.path, sourcePath, destinationPath) };
          }
          return entry;
        };
        const nextPages: Record<string, ApiLibraryEntry[]> = {};
        for (const [pageKey, pageEntries] of Object.entries(current.pages)) {
          const rewrittenPageKey = isFolder ? rewritePathPrefix(pageKey, sourcePath, destinationPath) : pageKey;
          nextPages[rewrittenPageKey] = pageEntries.map(rewriteEntry);
        }
        return {
          ...current,
          entries: current.entries.map(rewriteEntry),
          pages: nextPages,
        };
      });

      if (typeof window !== "undefined") {
        try {
          clearBrowseSnapshot();
        } catch {}
      }

      const nextFolder = currentFolder ? rewritePathPrefix(currentFolder, sourcePath, destinationPath) : currentFolder;
      setCurrentFolder(nextFolder);
      setExpandedFolders((current) => current.map((path) => rewritePathPrefix(path, sourcePath, destinationPath)));
      setRecentFolders((current) => current.map((path) => rewritePathPrefix(path, sourcePath, destinationPath)));
      setTitleMetadata({});
      setRenameTarget(null);
      reportClientPerformance("media_rename", performance.now() - started, { outcome: "success", item_kind: target?.kind ?? "file", auto_renamed: autoRename || finalName !== requestedFinalName });
      flash(swapTarget ? `Swapped with ${finalName}` : `Renamed to ${finalName}${autoRename || finalName !== requestedFinalName ? " (conflict-safe name chosen)" : ""}`);

      try {
        await refreshLibraryEntries(nextFolder);
        const [stateResponse, librariesResponse, coversResponse] = await Promise.all([
          authFetch(`${API_BASE}/api/user-state`),
          fetch(`${API_BASE}/api/libraries`),
          fetch(`${API_BASE}/api/folder-covers?t=${Date.now()}`),
        ]);
        if (stateResponse.ok) {
          const state = await stateResponse.json() as UserState;
          const favoritePaths = new Set(state.favorites);
          setPlayback(state.playback);
          setLastAccessed(state.last_accessed ?? {});
          setItems((current) => current.map((item) => withOpenedMetadata(item, state.last_accessed ?? {}, state.playback, { favorite: Boolean(item.path && favoritePaths.has(item.path)) })));
          applyOrganizationState(state);
        }
        if (librariesResponse.ok) setLibraries(await librariesResponse.json() as Record<string, LibraryConfig>);
        if (coversResponse.ok) setFolderCovers(await coversResponse.json() as Record<string, string>);
      } catch {
      }
    } catch (error) {
      reportClientPerformance("media_rename", performance.now() - started, { outcome: "error", item_kind: target?.kind ?? "file", auto_renamed: autoRename });
      reportClientError(error, { kind: "media-rename", source: sourcePath });
      setRenameTarget(target);
      setRenameName(name);
      setRenameError(error instanceof Error ? error.message : "Could not rename item");
    } finally {
      setRenaming(false);
    }
  };

  const createFolder = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!folderDraft || creatingFolder) return;
    const name = folderDraft.name.trim();
    if (!name) {
      setFolderCreateError("Enter a folder name.");
      return;
    }
    setCreatingFolder(true);
    setFolderCreateError("");
    try {
      const response = await authFetch(`${API_BASE}/api/folders`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ parent_path: folderDraft.parentPath, name }) });
      if (response.status === 409) throw new Error("A folder with that name already exists");
      if (response.status === 403) throw new Error("You do not have permission to create folders here");
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      await refreshLibraryEntries();
      flash(`Created ${name}`);
      setFolderDraft(null);
    } catch (error) {
      setFolderCreateError(error instanceof Error ? error.message : "Could not create folder");
    } finally {
      setCreatingFolder(false);
    }
  };
  const createLibrary = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!libraryDraft || creatingLibrary) return;
    const name = libraryDraft.name.trim();
    if (!name) { setLibraryCreateError("Enter a library name."); return; }
    setCreatingLibrary(true);
    setLibraryCreateError("");
    try {
      const response = await authFetch(`${API_BASE}/api/libraries`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, content_type: libraryDraft.contentType }) });
      if (response.status === 409) throw new Error("A folder or library with that name already exists");
      if (response.status === 403) throw new Error("Only administrators can create libraries");
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const config: LibraryConfig = { content_type: libraryDraft.contentType, members: [{ name: sessionUser?.name ?? "", can_view: true, can_delete: true, can_move: true, can_create_folders: true, can_upload: true, can_download: true, can_rename: true }], title_folders: [], folder_structure_static: false };
      setLibraries((current) => ({ ...current, [name]: config }));
      updateLibraryCache((current) => ({ ...current, libraries: { ...current.libraries, [name]: config } }));
      await refreshLibraryEntries();
      setLibraryDraft(null);
      flash(`Created ${name} library`);
    } catch (error) {
      setLibraryCreateError(error instanceof Error ? error.message : "Could not create library");
    } finally {
      setCreatingLibrary(false);
    }
  };
  const requestDelete = async (item: MediaItem) => {
    const path = mediaPath(item);
    if (!path) return;
    setContextItem(null);
    try {
      const response = await authFetch(`${API_BASE}/api/delete-requests`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path }),
      });
      if (!response.ok) throw new Error(response.status === 404 ? "This item is no longer available" : `Server returned ${response.status}`);
      setRequestedDeletePaths((current) => new Set(current).add(path));
      flash(`Asked an admin to delete ${item.name}`);
    } catch (error) {
      flash(error instanceof Error ? `Could not request deletion: ${error.message}` : "Could not request deletion");
    }
  };

  const deleteMedia = async () => {
    const targetPath = deleteTarget ? mediaPath(deleteTarget) : null;
    if (!targetPath || deletingMedia) {
      flash("Could not delete: item path is unavailable");
      return;
    }
    const target = deleteTarget;
    const started = performance.now();
    const deletedName = target.name;
    const deletedPath = targetPath;
    setItems((current) => current.filter((item) => item.path !== deletedPath && !item.path?.startsWith(`${deletedPath}/`)));
    updateLibraryCache((current) => ({ ...current, entries: current.entries.filter((entry) => entry.path !== deletedPath && !entry.path.startsWith(`${deletedPath}/`)) }));
    if (currentFolder === deletedPath || currentFolder?.startsWith(`${deletedPath}/`)) setCurrentFolder(target.parent ?? null);
    setDeleteTarget(null);
    setDeletingMedia(true);
    try {
      const response = await authFetch(`${API_BASE}/api/media`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: targetPath }) });
      if (response.status === 403) throw new Error("You do not have permission to delete this file");
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      reportClientPerformance("media_delete", performance.now() - started, { outcome: "success", item_kind: target.kind });
      if (preview) {
        const previewPath = mediaPath(preview);
        if (previewPath === deletedPath || previewPath?.startsWith(`${deletedPath}/`)) {
          setPreview(null);
        }
      }
      await loadTrash();
      flash(`Moved ${deletedName} to Trash`);
    } catch (error) {
      reportClientPerformance("media_delete", performance.now() - started, { outcome: "error", item_kind: target.kind });
      reportClientError(error, { kind: "media-delete", source: targetPath });
      void refreshLibraryEntries();
      const targetKind = target.kind === "folder" ? "folder" : "item";
      flash(error instanceof Error ? `Could not move ${targetKind} to Trash: ${error.message}` : `Could not move ${targetKind} to Trash`);
    } finally {
      setDeletingMedia(false);
    }
  };
  const deleteLibrary = async () => {
    const libraryName = deleteLibraryTarget;
    if (!libraryName || deletingLibrary) return;
    setDeletingLibrary(true);
    try {
      const response = await authFetch(`${API_BASE}/api/libraries/${encodeURIComponent(libraryName)}`, { method: "DELETE" });
      if (response.status === 403) throw new Error("Only administrators can delete libraries");
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      setItems((current) => current.filter((item) => !(item.kind === "folder" && !item.parent && item.name === libraryName) && item.parent !== libraryName && !item.parent?.startsWith(`${libraryName}/`)));
      setLibraries((current) => { const next = { ...current }; delete next[libraryName]; return next; });
      setFolderCovers((current) => Object.fromEntries(Object.entries(current).filter(([path]) => path !== libraryName && !path.startsWith(`${libraryName}/`))));
      updateLibraryCache((current) => ({ ...current, entries: current.entries.filter((entry) => entry.path !== libraryName && !entry.path.startsWith(`${libraryName}/`)), libraries: Object.fromEntries(Object.entries(current.libraries).filter(([path]) => path !== libraryName)), folderCovers: Object.fromEntries(Object.entries(current.folderCovers).filter(([path]) => path !== libraryName && !path.startsWith(`${libraryName}/`))) }));
      if (currentFolder === libraryName || currentFolder?.startsWith(`${libraryName}/`)) setCurrentFolder(null);
      setDeleteLibraryTarget(null);
      await loadTrash();
      flash(`Moved ${libraryName} and its contents to Trash`);
    } catch (error) {
      flash(error instanceof Error ? `Could not delete library: ${error.message}` : "Could not delete library");
    } finally {
      setDeletingLibrary(false);
    }
  };
  const restoreTrashItem = async (item: MediaItem) => {
    if (!item.trashId) return;
    try {
      const response = await authFetch(`${API_BASE}/api/trash/${encodeURIComponent(item.trashId)}/restore`, { method: "POST" });
      if (response.status === 409) throw new Error("The original location is already occupied");
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      await Promise.all([loadTrash(), refreshLibraryEntries()]);
      flash(`Restored ${item.name}`);
    } catch (error) { flash(error instanceof Error ? `Could not restore: ${error.message}` : "Could not restore item"); }
  };
  const permanentlyDeleteTrashItem = async () => {
    if (!permanentDeleteTarget?.trashId) return;
    try {
      const response = await authFetch(`${API_BASE}/api/trash/${encodeURIComponent(permanentDeleteTarget.trashId)}`, { method: "DELETE" });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const name = permanentDeleteTarget.name;
      setTrashItems((current) => current.filter((item) => item.trashId !== permanentDeleteTarget.trashId));
      setPermanentDeleteTarget(null);
      flash(`Permanently deleted ${name}`);
    } catch (error) { flash(error instanceof Error ? `Could not delete: ${error.message}` : "Could not permanently delete item"); }
  };
  const emptyTrash = async () => {
    if (emptyingTrash) return;
    const started = performance.now();
    const itemCount = trashItems.length;
    setTrashItems([]);
    setEmptyTrashOpen(false);
    setEmptyingTrash(true);
    try {
      const response = await authFetch(`${API_BASE}/api/trash`, { method: "DELETE" });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      reportClientPerformance("trash_empty", performance.now() - started, { outcome: "success", item_count: itemCount });
      flash("Trash permanently emptied");
    } catch (error) {
      reportClientPerformance("trash_empty", performance.now() - started, { outcome: "error", item_count: itemCount });
      reportClientError(error, { kind: "trash-empty" });
      void loadTrash();
      flash(error instanceof Error ? `Could not empty trash: ${error.message}` : "Could not empty trash");
    }
    finally { setEmptyingTrash(false); }
  };
  const bulkDeleteMedia = async () => {
    const targets = selectedDeletableItems.filter((item) => !item.trashed);
    if (!targets.length || bulkDeleting) return;
    setBulkDeleting(true);
    let deletedCount = 0;
    let failedCount = 0;
    for (const item of targets) {
      const targetPath = mediaPath(item);
      if (!targetPath) {
        failedCount += 1;
        continue;
      }
      try {
        const response = await authFetch(`${API_BASE}/api/media`, { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: targetPath }) });
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        const deletedPath = targetPath;
        setItems((current) => current.filter((entry) => entry.path !== deletedPath && !entry.path?.startsWith(`${deletedPath}/`)));
        updateLibraryCache((current) => ({ ...current, entries: current.entries.filter((entry) => entry.path !== deletedPath && !entry.path.startsWith(`${deletedPath}/`)) }));
        deletedCount += 1;
      } catch {
        failedCount += 1;
      }
    }
    if (preview) {
      const previewPath = mediaPath(preview);
      if (previewPath && targets.some((item) => {
        const path = mediaPath(item);
        return path === previewPath || previewPath.startsWith(`${path}/`);
      })) {
        setPreview(null);
      }
    }
    if (currentFolder && targets.some((item) => {
      const path = mediaPath(item);
      return path === currentFolder || currentFolder.startsWith(`${path}/`);
    })) {
      setCurrentFolder(targets[0]?.parent ?? null);
    }
    setBulkDeleteOpen(false);
    exitSelectionMode();
    await loadTrash();
    if (failedCount) flash(`Moved ${deletedCount} item${deletedCount === 1 ? "" : "s"} to Trash · ${failedCount} failed`);
    else flash(`Moved ${deletedCount} item${deletedCount === 1 ? "" : "s"} to Trash`);
    setBulkDeleting(false);
  };
  const bulkMoveMedia = async (autoRename = false, targetsOverride: MediaItem[] | null = null, destinationOverride: string | null = null) => {
    const targets = targetsOverride ?? selectedMovableItems;
    const destination = destinationOverride ?? moveDestination;
    if (!targets.length || !destination || bulkMoving) return;
    const started = performance.now();
    setBulkMoving(true);
    setMoveError("");
    const sourcePaths = targets.map(mediaPath).filter((path): path is string => Boolean(path));
    if (sourcePaths.length !== targets.length || sourcePaths.some((path) => path === destination || destination.startsWith(`${path}/`))) {
      setMoveError("One or more selected items cannot be moved there");
      setBulkMoving(false);
      return;
    }
    setBulkMoveOpen(false);
    const sourcePathSet = new Set(sourcePaths);
    setItems((current) => current.filter((item) => !item.path || (!sourcePathSet.has(item.path) && ![...sourcePathSet].some((path) => item.path?.startsWith(`${path}/`)))));
    updateLibraryCache((current) => ({
      ...current,
      entries: current.entries.filter((entry) => !sourcePathSet.has(entry.path) && ![...sourcePathSet].some((path) => entry.path.startsWith(`${path}/`))),
    }));
    exitSelectionMode();
    try {
      const response = await authFetch(`${API_BASE}/api/move/batch`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ source_paths: sourcePaths, destination_path: destination, ...(autoRename ? { conflict_strategy: "auto_rename" } : {}) }) });
      if (response.status === 403) throw new Error("You do not have permission to move there");
      if (response.status === 409 && !autoRename) {
        void refreshLibraryEntries();
        setNameConflict({
          action: "move",
          name: "One or more selected items",
          retry: () => void bulkMoveMedia(true, targets, destination),
        });
        return;
      }
      if (response.status === 409) throw new Error("Could not find available conflict names");
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      const result = await response.json() as { moved_count: number };
      await refreshAfterMediaMove();
      reportClientPerformance("media_move", performance.now() - started, { outcome: "success", item_kind: "batch", item_count: result.moved_count, auto_renamed: autoRename });
      flash(`Moved ${result.moved_count} item${result.moved_count === 1 ? "" : "s"}${autoRename ? " with conflict-safe names" : ""}`);
    } catch (error) {
      reportClientPerformance("media_move", performance.now() - started, { outcome: "error", item_kind: "batch", item_count: sourcePaths.length, auto_renamed: autoRename });
      reportClientError(error, { kind: "media-move-batch", destination });
      void refreshLibraryEntries();
      setMoveError(error instanceof Error ? error.message : "Could not move selected items");
      flash(error instanceof Error ? `Could not move: ${error.message}` : "Could not move selected items");
    }
    setBulkMoving(false);
  };

  const bulkRestoreTrash = async () => {
    const targets = selectedItems.filter((item) => item.trashId);
    if (!targets.length || bulkRestoring) return;
    setBulkRestoring(true);
    let restoredCount = 0;
    let failedCount = 0;
    for (const item of targets) {
      if (!item.trashId) continue;
      try {
        const response = await authFetch(`${API_BASE}/api/trash/${encodeURIComponent(item.trashId)}/restore`, { method: "POST" });
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        restoredCount += 1;
      } catch {
        failedCount += 1;
      }
    }
    await Promise.all([loadTrash(), refreshLibraryEntries()]);
    exitSelectionMode();
    if (failedCount) flash(`Restored ${restoredCount} item${restoredCount === 1 ? "" : "s"} · ${failedCount} failed`);
    else flash(`Restored ${restoredCount} item${restoredCount === 1 ? "" : "s"}`);
    setBulkRestoring(false);
  };
  const bulkPermanentDeleteTrash = async () => {
    const targets = selectedItems.filter((item) => item.trashId);
    if (!targets.length || bulkPermanentDeleting) return;
    setBulkPermanentDeleting(true);
    let deletedCount = 0;
    let failedCount = 0;
    const deletedIds = new Set<string>();
    for (const item of targets) {
      if (!item.trashId) continue;
      try {
        const response = await authFetch(`${API_BASE}/api/trash/${encodeURIComponent(item.trashId)}`, { method: "DELETE" });
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        deletedIds.add(item.trashId);
        deletedCount += 1;
      } catch {
        failedCount += 1;
      }
    }
    setTrashItems((current) => current.filter((item) => !item.trashId || !deletedIds.has(item.trashId)));
    setBulkPermanentDeleteOpen(false);
    exitSelectionMode();
    if (failedCount) flash(`Permanently deleted ${deletedCount} item${deletedCount === 1 ? "" : "s"} · ${failedCount} failed`);
    else flash(`Permanently deleted ${deletedCount} item${deletedCount === 1 ? "" : "s"}`);
    setBulkPermanentDeleting(false);
  };
  const savePassword = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!newPassword || savingPassword) return;
    setSavingPassword(true);
    setSettingsError("");
    try {
      const response = await authFetch(`${API_BASE}/api/profile`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }) });
      if (response.status === 401) throw new Error("Your current password is incorrect");
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
      clearSession();
      window.location.replace("/login");
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : "Could not change password");
    } finally {
      setSavingPassword(false);
    }
  };
  const saveImageSeconds = async (seconds: number) => {
    const normalized = normalizeImageSeconds(seconds);
    const previous = playbackPreferences;
    const next = { ...previous, image_seconds: normalized };
    setPlaybackPreferences(next);
    setSavingImageSeconds(true);
    setSettingsError("");
    try {
      const response = await authFetch(`${API_BASE}/api/playback-preferences`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
    } catch (error) {
      setPlaybackPreferences(previous);
      setSettingsError(error instanceof Error ? error.message : "Could not save image duration");
    } finally {
      setSavingImageSeconds(false);
    }
  };
  const saveLoadAllItems = async (enabled: boolean) => {
    const previous = playbackPreferences;
    const next = { ...previous, load_all_items: enabled };
    setPlaybackPreferences(next);
    setSettingsError("");
    try {
      const response = await authFetch(`${API_BASE}/api/playback-preferences`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(next),
      });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
    } catch (error) {
      setPlaybackPreferences(previous);
      setSettingsError(error instanceof Error ? error.message : "Could not save load all items preference");
    }
  };
  const revokeDeviceSession = async (session: DeviceSession) => {
    if (revokingDeviceSession) return;
    const current = session.current;
    if (!window.confirm(current ? "Log out this device?" : `Log out ${session.device}?`)) return;
    setRevokingDeviceSession(session.token);
    setSettingsError("");
    try {
      const response = await authFetch(`${API_BASE}/api/profile/sessions/${encodeURIComponent(session.token)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not log out that device");
      if (current) { clearSession(); window.location.replace("/login"); return; }
      setDeviceSessions((sessions) => sessions.filter((candidate) => candidate.token !== session.token));
    } catch (error) {
      setSettingsError(error instanceof Error ? error.message : "Could not log out that device");
    } finally { setRevokingDeviceSession(""); }
  };
  const openMagnetFromDownloads = () => {
    const [destination] = magnetDestinations;
    if (!destination) {
      flash("No Movies & TV folder is available for a magnet download.");
      return;
    }
    setMagnetTarget(destination);
  };
  const controlMagnetDownload = async (hash: string, action: "pause" | "resume" | "cancel" | "cap" | "uncap") => {
    if (action === "cancel" && !window.confirm("Cancel this download and remove its partial files?")) return;
    setMagnetControlHash(hash);
    try {
      const response = await authFetch(`${API_BASE}/api/downloads/magnet/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hash, action }),
      });
      const result = await response.json() as { message?: string };
      if (!response.ok) throw new Error(result.message || "Could not control the download.");
      if (action === "cancel") {
        ignoredMagnetCompletionHashes.current.add(hash);
        setBackgroundMagnetDownloads((current) => current.filter((download) => download.hash !== hash));
        setHiddenMagnetHashes((current) => current.filter((item) => item !== hash));
      } else if (action === "cap" || action === "uncap") {
        setBackgroundMagnetDownloads((current) => current.map((download) =>
          download.hash === hash ? { ...download, speed_cap_enabled: action === "cap" } : download,
        ));
      }
      flash(result.message || "Download updated.");
    } catch (error) {
      flash(error instanceof Error ? error.message : "Could not control the download.");
    } finally {
      setMagnetControlHash(null);
    }
  };
  const startServerDownload = (parentPath: string) => {
    if (section !== "library" || !parentPath || !canDownloadToPath(parentPath)) {
      flash("You do not have permission to start server downloads here");
      return;
    }
    setLibraryContext(null);
    setServerDownloadTarget(parentPath);
  };
  const controlYtDlpJob = async (id: string, action: "cancel" | "interrupt" | "retry" | "refresh" | "refresh_cookies_and_retry") => {
    setYtDlpControlId(id);
    try {
      const response = await authFetch(`${API_BASE}/api/downloads/yt-dlp/${id}/control`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action }),
      });
      const result = await response.json() as YtDlpJob & { message?: string };
      if (!response.ok) throw new Error(result.message || "Could not update this download.");
      setYtDlpJobs((current) => {
        const next = current.filter((job) => job.id !== id);
        return ["complete", "completed", "cancelled"].includes(result.status) ? next : [result, ...next];
      });
    } catch (reason) {
      flash(reason instanceof Error ? reason.message : "Could not update this download.");
    } finally {
      setYtDlpControlId(null);
    }
  };
  const dismissIncomingMagnet = () => {
    setIncomingMagnet(null);
  };
  // The queue ref is the source of truth for the upload workers; React state
  // mirrors it for rendering.
  const commitUploadQueue = (update: (current: UploadQueueItem[]) => UploadQueueItem[]) => {
    const next = update(uploadQueueRef.current);
    uploadQueueRef.current = next;
    setUploadQueue(next);
  };
  const updateUploadItem = (id: string, patch: Partial<UploadQueueItem>) =>
    commitUploadQueue((current) => current.map((item) => item.id === id ? { ...item, ...patch } : item));
  const clearUploadInputs = () => {
    if (uploadInput.current) uploadInput.current.value = "";
    if (uploadFolderInput.current) uploadFolderInput.current.value = "";
  };
  const startUpload = (parentPath: string) => {
    if (!canUploadToPath(parentPath)) {
      flash("You do not have permission to upload here");
      return;
    }
    setLibraryContext(null);
    setUploadTarget(parentPath);
    setUploadPickerOpen(false);
    if (!uploadWorkerCount.current) commitUploadQueue((current) => current.filter((item) => item.status !== "complete"));
  };
  const finishUploadBatch = async () => {
    const completed = uploadBatchCompleted.current;
    uploadBatchCompleted.current = 0;
    setUploadingFiles(false);
    setUploadsActive(false);
    setBackgroundUploadTarget(null);
    if (completed > 0) {
      await refreshLibraryEntries();
      flash(`Upload complete: ${completed} file${completed === 1 ? "" : "s"}`);
    }
  };
  const runUploadWorker = async () => {
    uploadWorkerCount.current += 1;
    try {
      while (true) {
        const item = uploadQueueRef.current.find((queued) => queued.status === "pending" && queued.file && !uploadControllers.current.has(queued.id));
        if (!item?.file) return;
        const controller = new AbortController();
        uploadControllers.current.set(item.id, controller);
        updateUploadItem(item.id, { status: "uploading", speed: 0, error: undefined });
        let sessionId = item.sessionId;
        try {
          await uploadFileResumably({
            file: item.file,
            parentPath: item.parentPath,
            relativePath: item.relativePath,
            signal: controller.signal,
            onSession: (session) => {
              sessionId = session.id;
              updateUploadItem(item.id, { sessionId: session.id });
            },
            onProgress: (uploaded, speed) => updateUploadItem(item.id, {
              uploadedBytes: uploaded,
              speed,
              progress: Math.min(99, Math.floor((uploaded / item.size) * 100)),
            }),
          });
          uploadBatchCompleted.current += 1;
          updateUploadItem(item.id, { status: "complete", progress: 100, uploadedBytes: item.size, speed: 0, sessionId: undefined });
        } catch (error) {
          const reason = uploadStopReasons.current.get(item.id);
          uploadStopReasons.current.delete(item.id);
          if (reason === "pause") updateUploadItem(item.id, { status: "paused", speed: 0 });
          else if (reason === "remove") {
            if (sessionId) void cancelUploadSession(sessionId);
          } else {
            updateUploadItem(item.id, {
              status: "error",
              speed: 0,
              error: isUploadAbort(error) ? "Stopped." : error instanceof Error ? error.message : "Upload failed.",
            });
          }
        } finally {
          uploadControllers.current.delete(item.id);
        }
      }
    } finally {
      uploadWorkerCount.current -= 1;
      if (!uploadWorkerCount.current) void finishUploadBatch();
    }
  };
  const ensureUploadWorkers = () => {
    let waiting = uploadQueueRef.current.filter((item) => item.status === "pending" && item.file && !uploadControllers.current.has(item.id)).length;
    if (!waiting) return;
    if (!uploadWorkerCount.current) {
      setUploadingFiles(true);
      setUploadsActive(true);
      setBackgroundUploadTarget((current) => current ?? uploadTarget ?? uploadQueueRef.current.find((item) => item.status === "pending")?.parentPath ?? null);
    }
    while (waiting > 0 && uploadWorkerCount.current < UPLOAD_CONCURRENCY) {
      void runUploadWorker();
      waiting -= 1;
    }
  };
  const addUploadFiles = (candidates: UploadCandidate[], parentPath: string | null, autoStart = false) => {
    if (!parentPath || !candidates.length) return;
    const libraryType = libraries[parentPath.split("/")[0]]?.content_type;
    const videoFormats = supportedFormats.video as readonly string[];
    const mediaFormats: readonly string[] = [...supportedFormats.video, ...supportedFormats.audio, ...supportedFormats.image];
    const queuedPaths = new Set(uploadQueueRef.current
      .filter((item) => item.status !== "complete" && item.status !== "needs-file")
      .map((item) => `${item.parentPath}/${item.relativePath}`.toLowerCase()));
    const reattached = new Map<string, File>();
    const additions: UploadQueueItem[] = [];
    let skipped = 0;
    candidates.forEach(({ file, relativePath: suppliedPath }) => {
      if (isIgnoredUploadFile(file.name)) return;
      // The same file from an interrupted upload reconnects to its server
      // session and continues from the bytes already there.
      const interrupted = uploadQueueRef.current.find((item) => item.status === "needs-file"
        && !reattached.has(item.id)
        && item.name === file.name
        && item.size === file.size
        && item.lastModified === file.lastModified);
      if (interrupted) {
        reattached.set(interrupted.id, file);
        return;
      }
      const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
      const relativePath = (suppliedPath || (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name)
        .replaceAll("\\", "/")
        .replace(/^\/+/, "");
      const key = `${parentPath}/${relativePath}`.toLowerCase();
      const duplicate = queuedPaths.has(key);
      queuedPaths.add(key);
      if (
        duplicate
        || (libraryType !== "files" && !mediaFormats.includes(extension))
        || (libraryType === "movies_tv" && !videoFormats.includes(extension))
        || file.size <= 0
      ) {
        skipped += 1;
        return;
      }
      additions.push({
        id: `${key}:${file.size}:${file.lastModified}:${Date.now()}:${additions.length}`,
        file,
        name: file.name,
        size: file.size,
        lastModified: file.lastModified,
        parentPath,
        relativePath,
        status: "pending",
        progress: 0,
        uploadedBytes: 0,
        speed: 0,
      });
    });
    commitUploadQueue((current) => [
      ...current.map((item) => {
        const file = reattached.get(item.id);
        return file ? { ...item, file, status: "pending" as const, error: undefined } : item;
      }),
      ...additions,
    ]);
    const notes = [
      reattached.size ? `Resuming ${reattached.size} interrupted upload${reattached.size === 1 ? "" : "s"}.` : "",
      skipped ? `Skipped ${skipped} unsupported, empty, or duplicate file${skipped === 1 ? "" : "s"}.` : "",
    ].filter(Boolean);
    if (notes.length) flash(notes.join(" "));
    setUploadPickerOpen(false);
    clearUploadInputs();
    if (autoStart || reattached.size || uploadWorkerCount.current > 0) ensureUploadWorkers();
  };
  const selectUploadFiles = (candidates: UploadCandidate[]) => addUploadFiles(candidates, uploadTarget);
  const beginUploads = () => ensureUploadWorkers();
  const pauseUploadItem = (id: string) => {
    const controller = uploadControllers.current.get(id);
    if (controller) {
      uploadStopReasons.current.set(id, "pause");
      controller.abort();
    } else if (uploadQueueRef.current.some((item) => item.id === id && item.status === "pending")) {
      updateUploadItem(id, { status: "paused" });
    }
  };
  // Resumes a paused file or retries a failed one from the server's offset.
  const resumeUploadItem = (id: string) => {
    const item = uploadQueueRef.current.find((queued) => queued.id === id);
    if (!item?.file || item.status === "uploading" || item.status === "complete") return;
    updateUploadItem(id, { status: "pending", error: undefined });
    ensureUploadWorkers();
  };
  const removeUploadItem = (id: string) => {
    const item = uploadQueueRef.current.find((queued) => queued.id === id);
    if (!item) return;
    const controller = uploadControllers.current.get(id);
    if (controller) {
      // The worker cancels the server session once its request has stopped.
      uploadStopReasons.current.set(id, "remove");
      controller.abort();
    } else if (item.sessionId && item.status !== "complete") {
      void cancelUploadSession(item.sessionId);
    }
    commitUploadQueue((current) => current.filter((queued) => queued.id !== id));
  };
  const pauseAllUploads = () => {
    uploadQueueRef.current
      .filter((item) => item.status === "uploading" || item.status === "pending")
      .forEach((item) => pauseUploadItem(item.id));
  };
  const resumeAllUploads = () => {
    commitUploadQueue((current) => current.map((item) => item.file && (item.status === "paused" || item.status === "error")
      ? { ...item, status: "pending" as const, error: undefined }
      : item));
    ensureUploadWorkers();
  };
  const cancelUploads = () => {
    uploadQueueRef.current
      .filter((item) => item.status !== "complete")
      .forEach((item) => removeUploadItem(item.id));
  };
  const closeUpload = () => {
    setUploadTarget(null);
    setUploadPickerOpen(false);
    clearUploadInputs();
    // Partially uploaded files stay queued so they can be resumed later;
    // finished rows and never-started selections are cleared.
    if (!uploadWorkerCount.current) {
      commitUploadQueue((current) => current.filter((item) => item.status === "needs-file" || (item.status !== "complete" && item.sessionId)));
    }
  };
  const contextMenuPosition = (event: ReactMouseEvent) => ({
    x: Math.min(event.clientX, window.innerWidth - 160),
    y: Math.min(event.clientY, window.innerHeight - 250),
  });
  const openItemContextMenu = (event: ReactMouseEvent, item: MediaItem) => {
    event.preventDefault();
    event.stopPropagation();
    setLibraryContext(null);
    setLibrariesContext(null);
    setContextItem({ item, ...contextMenuPosition(event) });
  };
  const toggleItemContextMenu = (event: ReactMouseEvent, item: MediaItem) => {
    event.preventDefault();
    event.stopPropagation();
    setLibraryContext(null);
    setLibrariesContext(null);
    const anchor = event.currentTarget.getBoundingClientRect();
    setContextItem((current) =>
      current?.item.id === item.id ? null : { item, x: anchor.right - 220, y: anchor.bottom + 4 },
    );
  };
  const openLibraryContextMenu = (event: ReactMouseEvent) => {
    if (section !== "library") return;
    if (!currentFolder) {
      openLibrariesContextMenu(event);
      return;
    }
    event.preventDefault();
    setContextItem(null);
    setLibraryContext({ path: currentFolder, x: Math.min(event.clientX, window.innerWidth - 205), y: Math.min(event.clientY, window.innerHeight - 190) });
  };
  const openLibrariesContextMenu = (event: ReactMouseEvent) => {
    event.preventDefault();
    setContextItem(null);
    setLibraryContext(null);
    setLibrariesContext({ x: Math.min(event.clientX, window.innerWidth - 205), y: Math.min(event.clientY, window.innerHeight - 145) });
  };
  const rememberSearch = (value: string) => {
    const clean = value.trim();
    if (clean) setPreviousSearches((current) => [clean, ...current.filter((item) => item.toLowerCase() !== clean.toLowerCase())].slice(0, 6));
  };
  const clearSearch = () => {
    setQuery("");
    setActiveSearch("");
  };
  const openPlaylistOverview = () => {
    setSection("playlists");
    setActivePlaylistId(null);
    setCurrentFolder(null);
    setActiveTags([]);
    clearSearch();
    setRailDrawerOpen(false);
  };
  const openPlaylist = (id: string) => {
    setSection("playlists");
    setActivePlaylistId(id);
    setCurrentFolder(null);
    setActiveTags([]);
    clearSearch();
    setRailDrawerOpen(false);
  };
  const isPlaylistOverview = section === "playlists" && !activePlaylistId;
  const tagBrowseSection: Section = backendState === "offline" ? "offline" : "library";
  const submitSearch = (value?: string) => {
    const clean = (value ?? query).trim();
    setSearchFocused(false);
    searchInput.current?.blur();
    if (!clean) {
      clearSearch();
      return;
    }
    rememberSearch(clean);
    setQuery(clean);
    setActiveSearch(clean);
    setSection("library");
    setCurrentFolder(null);
    setActiveTags([]);
    setActivePlaylistId(null);
  };
  const chooseSearchSuggestion = (suggestion: SearchSuggestion) => {
    const path = suggestion.item ? searchSuggestionItemPath(suggestion.item) : suggestion.path;
    if ((suggestion.item || suggestion.path) && !canSuggestLibraryPath(path, libraries, sessionUser)) return;
    if (suggestion.kind === "search") {
      setQuery(suggestion.label);
      setSearchCaret(suggestion.label.length);
      setSelectedSuggestion(null);
      rememberSearch(suggestion.label);
      return;
    }
    if (suggestion.kind === "filter" && suggestion.value) {
      const completed = completeSearchToken(query, searchCaret, suggestion.value, suggestion.field);
      setQuery(completed.query);
      setSearchCaret(completed.caret);
      setSelectedSuggestion(null);
      window.setTimeout(() => {
        searchInput.current?.focus();
        searchInput.current?.setSelectionRange(completed.caret, completed.caret);
      }, 0);
      return;
    }
    if (suggestion.kind === "tag") {
      clearSearch();
      setSection("library");
      setCurrentFolder(null);
      setActiveTags([suggestion.label]);
      setSearchFocused(false);
      return;
    }
    if (suggestion.kind === "folder" && suggestion.path) {
      clearSearch();
      setSection("library");
      restoreFolderBrowsePrefs(suggestion.path);
      setCurrentFolder(suggestion.path);
      setExpandedFolders(suggestion.path.split("/").map((_, index, parts) => parts.slice(0, index + 1).join("/")));
      rememberFolder(suggestion.path);
      setSearchFocused(false);
      return;
    }
    if (suggestion.item) {
      rememberSearch(activeSearch || query || suggestion.label);
      openItem(suggestion.item);
      setSearchFocused(false);
    }
  };
  const title = activeSearch.trim()
    ? "Search"
    : section === "library"
      ? "Libraries"
      : section === "playlists"
        ? (activePlaylistId ? playlists[activePlaylistId]?.name : null) ?? "Playlists"
        : nav.find((item) => item.id === section)?.label ?? "Libraries";
  const getFolderItemCount = (folder: MediaItem) => {
    if (folder.itemCount !== undefined) return folder.itemCount;
    const path = folder.parent ? `${folder.parent}/${folder.name}` : folder.name;
    return items.filter((item) => !item.trashed && item.parent === path).length;
  };

  // Movies remain available in the main grid, but do not turn the library
  // navigation into a list of individual film folders.
  const sidebarEvidenceItems = Object.values(sidebarTreeEntries).flat();
  const isSidebarFolder = (folder: MediaItem, parentPath?: string) => {
    if (!parentPath || libraries[parentPath]?.content_type !== "movies_tv") return true;
    const path = `${parentPath}/${folder.name}`;
    return mediaEvidenceForFolder(sidebarEvidenceItems, path).kind !== "movie";
  };

  const renderFolderNodes = (parentPath?: string): ReactNode => (sidebarTreeEntries[parentPath ?? ""] ?? (parentPath === currentFolder ? items : []))
    .filter((item) => item.kind === "folder" && item.parent === parentPath && !item.trashed && isSidebarFolder(item, parentPath) && (Boolean(parentPath) || sessionUser?.is_admin || libraries[item.name]?.members.some((member) => member.can_view && member.name.toLowerCase() === sessionUser?.name.toLowerCase())))
    .map((folder) => {
      const path = parentPath ? `${parentPath}/${folder.name}` : folder.name;
      const isLibrary = !parentPath;
      const isExpanded = expandedFolders.includes(path);
      const childEntries = sidebarTreeEntries[path];
      const hasChildren = childEntries
        ? childEntries.some((item) => item.kind === "folder" && item.parent === path && !item.trashed && isSidebarFolder(item, path))
        : false;
      const isActiveBranch = currentFolder === path || currentFolder?.startsWith(`${path}/`);
      const displayName = titleCollectionForPath(path)?.label ?? folder.name;
      return <div className={`folder-tree-group ${isLibrary ? "library-tree-group" : ""}`} key={folder.id}>
        <div className="folder-tree-entry">
          {hasChildren ? <button type="button" className="folder-tree-expand" aria-label={`${isExpanded ? "Collapse" : "Expand"} ${displayName}`} aria-expanded={isExpanded} onClick={() => setExpandedFolders(current => current.includes(path) ? current.filter(p => p !== path) : [...current, path])}><MenuIcon name={isExpanded ? "chevronDown" : "chevronRight"} /></button> : <span className="folder-tree-slot" aria-hidden="true" />}
          <button aria-label={railCollapsed ? displayName : undefined} title={railCollapsed ? displayName : undefined} data-initial={displayName.slice(0, 1).toUpperCase()} draggable={canMoveItem(folder)} onDragStart={(event) => startMoveDrag(event, folder)} onDragEnd={() => { setDraggedItem(null); setDragTarget(null); }} onDragOver={(event) => allowDrop(event, path)} onDragLeave={() => setDragTarget((current) => current === path ? null : current)} onDrop={(event) => void moveToFolder(event, path)} onContextMenu={(event) => openItemContextMenu(event, folder)} className={`${isActiveBranch ? "active" : ""} ${dragTarget === path ? "drag-target" : ""}`} onClick={() => openFolderFromTree(folder)}>
            <span aria-hidden="true" />
            <span className="folder-label">{displayName}</span>
            <em aria-label={isLibrary ? libraryTypeLabel(libraries[path]?.content_type ?? "mixed") : `${getFolderItemCount(folder)} ${/^Season \d+/i.test(folder.name) ? "episodes" : "items"}`}>{isLibrary ? libraryTypeLabel(libraries[path]?.content_type ?? "mixed") : getFolderItemCount(folder)}</em>
          </button>
        </div>
        {isExpanded && hasChildren && <div className="folder-children">{renderFolderNodes(path)}</div>}
      </div>;
    });

  const renderMoveDestinationNodes = (parentPath?: string): ReactNode => {
    const childNames = new Set<string>();
    for (const destination of moveDestinationPaths) {
      if (!parentPath) {
        childNames.add(destination.split("/")[0]);
      } else if (destination === parentPath || destination.startsWith(`${parentPath}/`)) {
        const remainder = destination === parentPath ? "" : destination.slice(parentPath.length + 1);
        const segment = remainder.split("/")[0];
        if (segment) childNames.add(segment);
      }
    }
    return [...childNames].sort((left, right) => left.localeCompare(right)).map((name) => {
      const path = parentPath ? `${parentPath}/${name}` : name;
      const isExpanded = moveExpandedDestinations.includes(path);
      const isSelected = moveDestination === path;
      const isLibrary = !parentPath;
      const hasChildren = moveDestinationPaths.some((destination) => destination.startsWith(`${path}/`));
      return <div className={`folder-tree-group ${isLibrary ? "library-tree-group" : ""}`} key={path}>
        <button type="button" className={isSelected ? "active" : ""} onClick={() => {
          setMoveDestination(path);
          if (hasChildren && !isExpanded) setMoveExpandedDestinations([...moveExpandedDestinations, path]);
        }}>
          <span className={isExpanded ? "expanded" : ""} onClick={(e) => {
            if (hasChildren) {
              e.stopPropagation();
              setMoveExpandedDestinations((current) => current.includes(path) ? current.filter((entry) => entry !== path) : [...current, path]);
            }
          }}>{hasChildren ? <MenuIcon name="chevronRight" /> : null}</span>
          <span className="folder-label">{name}</span>
        </button>
        {isExpanded && hasChildren && <div className="folder-children">{renderMoveDestinationNodes(path)}</div>}
      </div>;
    });
  };

  const renderItemContextMenu = () => {
    if (!contextItem) return null;
    const item = contextItem.item;
    const itemPath = mediaPath(item) ?? "";
    const isDownloaded = Boolean(item.offline) || section === "offline";
    const isLibrary = item.kind === "folder" && !item.parent && !isDownloaded;
    const catalogTitle = catalogTitleForItem(item);
    const isTitle = Boolean(catalogTitle);
    const titleCardPath = catalogTitle?.path ?? itemPath;
    const evidence = catalogTitle?.evidence ?? null;
    const episodeId = item.kind === "video" ? episodeNumbers(`${item.parent ?? ""}/${item.name}`) : null;
    const seriesPath = titlePathForVideo(item);
    const episodeInfo = episodeId && seriesPath ? resolveEpisodeMetadata(titleMetadata[titleMetadataKey(seriesPath, "series")]?.videos, episodeId.season, episodeId.episode) : undefined;
    const menuTitle = episodeInfo && episodeId ? `Episode ${episodeId.episode} · ${episodeInfo.name ?? episodeInfo.title}` : item.name.replace(/\.[a-z0-9]+$/i, "");
    const titleKindLabel =
      isTitle && evidence
        ? evidence.kind === "movie"
          ? "Movie"
          : "Show"
        : null;
    const offlineBundle = item.offline
      ? offlineBundles.find((bundle) => bundle.id === item.offline!.bundleId)
      : undefined;
    const openContextItem = () => {
      if (isTitle && evidence?.kind === "series" && !item.trashed) openFolder(item);
      else if (isTitle && evidence && item.kind === "folder" && !item.trashed) playCatalogTitle(titleCardPath, evidence.kind);
      else if (item.kind === "folder") openFolder(item);
      else openItem(item);
      setContextItem(null);
    };
    return (
      <div
        ref={itemMenuRef}
        className="card-menu"
        role="dialog" aria-modal="true" aria-label={`Actions for ${menuTitle}`}
        style={{
          left: contextItem.x,
          top: contextItem.y,
          position: "fixed",
          margin: 0,
          zIndex: 160,
        }}
        onClick={(event) => event.stopPropagation()}
        onContextMenu={(event) => event.preventDefault()}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !compactScreen) {
            event.preventDefault();
            event.stopPropagation();
            setContextItem(null);
          }
        }}
      >
        <div className="card-menu-title">{menuTitle}</div>
        {isTitle && evidence && <button onClick={() => { playCatalogTitle(titleCardPath, evidence.kind); setContextItem(null); }}><MenuIcon name="play" />Play title</button>}
        {isTitle && evidence && trailerYoutubeId(titleMetadata[titleMetadataKey(titleCardPath, evidence.kind)]) && <button onClick={() => { setTrailer({ title: catalogTitle?.title ?? item.name, youtubeId: trailerYoutubeId(titleMetadata[titleMetadataKey(titleCardPath, evidence.kind)])! }); setContextItem(null); }}><MenuIcon name="play" />Trailer</button>}
        {!isLibrary && !item.trashed && <button onClick={() => { void toggleFavorite(item); setContextItem(null); }}><MenuIcon name="star" />{item.favorite ? "Remove from favorites" : "Add to favorites"}</button>}
        <button onClick={openContextItem} disabled={Boolean(item.offline?.status && item.offline.status !== "ready")}>
          {titleKindLabel || item.kind === "video" || item.kind === "audio" ? <><MenuIcon name="play" />Play</> : <><MenuIcon name="open" />Open</>}
        </button>
        {!item.trashed && mediaPath(item) && (
          <button
            disabled={isDownloaded || offlineBusy}
            onClick={() => {
              void saveItemOffline(item);
              setContextItem(null);
            }}
          >
            {isDownloaded || offlineBundles.some((bundle) => bundle.path === mediaPath(item) && bundle.status === "ready") ? <><MenuIcon name="check" />Available offline</> : <><MenuIcon name="offline" />Save offline on this device</>}
          </button>
        )}
        <details className="media-management"><summary><MenuIcon name="chevronRight" />Organize & file actions</summary>
        {!item.offline && !item.trashed && item.parent && (section !== "library" || activeSearch.trim()) && (
          <button onClick={() => {
            navigateApp(`/?${new URLSearchParams({ folder: item.parent! })}`);
          }}><MenuIcon name="folder" />Go to location</button>
        )}
        {!item.trashed && (
          <button
            disabled={isDownloaded}
            onClick={() => {
              createHomeScreenShortcut(item);
              setContextItem(null);
            }}
          >
            <MenuIcon name="grid" />Add to Home screen
          </button>
        )}
        {item.trashed && (
          <button
            onClick={() => {
              restoreTrashItem(item);
              setContextItem(null);
            }}
          >
            <MenuIcon name="restore" />Restore
          </button>
        )}
        {!item.trashed && canSelectItem(item) && (
          <button onClick={() => { enterSelectionMode(item); setContextItem(null); }}><MenuIcon name="select" />Select</button>
        )}
        {item.kind !== "folder" && !item.trashed && (
          <button
            disabled={isDownloaded}
            onClick={() => {
              downloadPreview(item);
              setContextItem(null);
            }}
          >
            <MenuIcon name="download" />Export file
          </button>
        )}
        {item.kind === "folder" && !item.trashed && (
          <button
            disabled={isDownloaded}
            onClick={() => {
              void downloadFolder(item);
              setContextItem(null);
            }}
          >
            <MenuIcon name="download" />Download folder
          </button>
        )}
        {!item.trashed && item.path && (
          <button onClick={() => startOrganizing(item)}>
            {item.kind === "folder" ? <><MenuIcon name="tag" />Folder tags</> : <><MenuIcon name="tag" />Tags & playlists</>}
          </button>
        )}
        {showDevicePath &&
          item.devicePath &&
          !item.trashed && (
            <button
              onClick={() => {
                navigator.clipboard
                  .writeText(item.devicePath!)
                  .catch(() => {});
                flash("Copied device path");
                setContextItem(null);
              }}
            >
              <MenuIcon name="copy" />Copy device path
            </button>
          )}
        {(canMoveItem(item) || isDownloaded) && (
          <button disabled={isDownloaded || !canMoveItem(item)} onClick={() => openMoveForItem(item)}>
            <MenuIcon name="move" />Move
          </button>
        )}
        {(canRenameItem(item) || isDownloaded) && (
          <button disabled={isDownloaded || !canRenameItem(item)} onClick={() => startRename(item)}>
            <MenuIcon name="rename" />Rename
          </button>
        )}
        </details>
        {(item.kind !== "folder" && (canDeleteItem(item) || isDownloaded)) && (
          <button
            className="danger"
            disabled={isDownloaded || !canDeleteItem(item)}
            onClick={() => {
              setDeleteTarget(item);
              setContextItem(null);
            }}
          >
            <MenuIcon name="trash" />Delete
          </button>
        )}
        {item.kind === "folder" &&
          !isLibrary &&
          (canDeleteItem(item) || isDownloaded) && (
            <button
              className="danger"
              disabled={isDownloaded || !canDeleteItem(item)}
              onClick={() => {
                setDeleteTarget(item);
                setContextItem(null);
              }}
            >
              <MenuIcon name="trash" />Delete folder
            </button>
          )}
        {!item.trashed && !isDownloaded && !isLibrary && !canDeleteItem(item) && itemPath && !sessionUser?.is_admin && !(item.kind === "folder" && libraries[itemPath.split("/")[0]]?.folder_structure_static) && (
          <button onClick={() => void requestDelete(item)}>
            {requestedDeletePaths.has(itemPath) ? <><MenuIcon name="check" />Delete requested</> : <><MenuIcon name="trash" />Request delete</>}
          </button>
        )}
        {item.trashed && (
          <button
            className="danger"
            onClick={() => {
              setPermanentDeleteTarget(item);
              setContextItem(null);
            }}
          >
            <MenuIcon name="trash" />Delete permanently
          </button>
        )}
        {item.kind === "folder" &&
          (canCreateFolderAtPath(itemPath) || isDownloaded) && (
            <button
              disabled={isDownloaded || !canCreateFolderAtPath(itemPath)}
              onClick={() => {
                startFolderCreation(itemPath);
                setContextItem(null);
              }}
            >
              <MenuIcon name="plus" />New folder
            </button>
          )}
        {item.kind === "folder" &&
          (canUploadToPath(itemPath) || isDownloaded) && (
            <button
              disabled={isDownloaded || !canUploadToPath(itemPath)}
              onClick={() => {
                startUpload(itemPath);
                setContextItem(null);
              }}
            >
              <MenuIcon name="upload" />Upload media
            </button>
          )}
        {item.kind === "folder" &&
          (canDownloadToPath(itemPath) || isDownloaded) && (
            <button
              disabled={isDownloaded || !canDownloadToPath(itemPath)}
              onClick={() => {
                startServerDownload(itemPath);
                setContextItem(null);
              }}
            >
              <MenuIcon name="download" />Download from URL
            </button>
          )}
        {item.kind === "folder" &&
          canManageLibraries &&
          !item.trashed &&
          !isDownloaded && (
            <button
              onClick={() => {
                chooseFolderCover(item);
                setContextItem(null);
              }}
            >
              ▧ Upload cover
            </button>
          )}
        {item.kind === "folder" &&
          canManageLibraries &&
          !item.trashed &&
          !isDownloaded && (
            <button
              onClick={() => {
                void changeFolderCover(item);
                setContextItem(null);
              }}
            >
              ↻ Change cover
            </button>
          )}
        {isLibrary &&
          canManageLibraries &&
          !item.trashed && (
            <button
              className="danger"
              onClick={() => {
                setDeleteLibraryTarget(item.name);
                setContextItem(null);
              }}
            >
              × Delete library
            </button>
          )}
        {isDownloaded && item.offline?.root && offlineBundle?.status === "error" && (
          <button
            disabled={offlineBusy}
            onClick={() => {
              void retryOfflineDownload(offlineBundle);
              setContextItem(null);
            }}
          >
            ↻ Try again
          </button>
        )}
        {isDownloaded && item.offline?.root && offlineBundle && (
          <button
            className="danger"
            disabled={offlineBusy}
            onClick={() => {
              void removeOfflineDownload(offlineBundle);
              setContextItem(null);
            }}
          >
            × Remove offline copy
          </button>
        )}
      </div>
    );
  };

  const completedUploadCount = uploadQueue.filter((item) => item.status === "complete").length;
  const activeUpload = uploadQueue.find((item) => item.status === "uploading");
  const activeUploadCount = uploadQueue.filter((item) => item.status === "uploading").length;
  const totalUploadSpeed = uploadQueue.reduce((total, item) => total + (item.status === "uploading" ? item.speed : 0), 0);
  const totalUploadBytes = uploadQueue.reduce((total, item) => total + item.size, 0);
  const uploadedBytes = uploadQueue.reduce((total, item) => total + (item.status === "complete" ? item.size : item.uploadedBytes), 0);
  const uploadProgress = totalUploadBytes ? uploadedBytes / totalUploadBytes : 0;
  const pendingUploadCount = uploadQueue.filter((item) => item.status === "pending").length;
  const pausedUploadCount = uploadQueue.filter((item) => item.status === "paused").length;
  const failedUploadCount = uploadQueue.filter((item) => item.status === "error").length;
  const interruptedUploadCount = uploadQueue.filter((item) => item.status === "needs-file").length;
  const resumableUploadCount = uploadQueue.filter((item) => item.file && (item.status === "paused" || item.status === "error")).length;
  const waitingUploadCount = pausedUploadCount + interruptedUploadCount + uploadQueue.filter((item) => item.status === "error" && item.sessionId).length;
  const uploadReturnTarget = backgroundUploadTarget ?? uploadQueue.find((item) => item.status !== "complete")?.parentPath ?? null;
  const uploadDropTarget = uploadTarget ?? (canUploadHere ? folderActionPath : null);

  // Unfinished uploads survive reloads on the server. Bring them back so the
  // user can add the same files again and continue where they stopped.
  useEffect(() => {
    if (!sessionUser) return;
    let cancelled = false;
    void listUploadSessions().then((sessions) => {
      if (cancelled || !sessions.length) return;
      const known = new Set(uploadQueueRef.current.map((item) => item.sessionId).filter(Boolean));
      const restored = sessions.filter((session) => !known.has(session.id)).map((session): UploadQueueItem => ({
        id: `session:${session.id}`,
        file: null,
        name: session.file_name,
        size: session.size,
        lastModified: session.last_modified ?? 0,
        parentPath: session.parent_path,
        relativePath: session.relative_path,
        status: "needs-file",
        progress: Math.min(99, Math.floor((session.received_bytes / session.size) * 100)),
        uploadedBytes: session.received_bytes,
        speed: 0,
        sessionId: session.id,
      }));
      if (!restored.length) return;
      const next = [...uploadQueueRef.current, ...restored];
      uploadQueueRef.current = next;
      setUploadQueue(next);
    }).catch(() => undefined);
    return () => { cancelled = true; };
  }, [sessionUser]);

  // Leaving the page aborts running uploads; ask first.
  useEffect(() => {
    if (!uploadingFiles) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [uploadingFiles]);

  useEffect(() => {
    uploadDropHandler.current = {
      target: uploadDropTarget,
      drop: (dataTransfer) => {
        if (!uploadDropTarget) {
          flash("Open a folder you can upload to, then drop files there.");
          return;
        }
        const target = uploadDropTarget;
        // Entries must be read synchronously while the drop event is live.
        void collectDroppedUploadFiles(dataTransfer).then((candidates) => {
          if (!candidates.length) return;
          setLibraryContext(null);
          setUploadTarget(target);
          addUploadFiles(candidates, target, true);
        });
      },
    };
  });

  // Files and folders dragged from the desktop can be dropped anywhere on the
  // page; they upload into the open folder (or the open uploader's folder).
  useEffect(() => {
    let depth = 0;
    const carriesFiles = (event: globalThis.DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const enter = (event: globalThis.DragEvent) => {
      if (!carriesFiles(event)) return;
      depth += 1;
      setUploadDragTarget({ path: uploadDropHandler.current.target });
    };
    const over = (event: globalThis.DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = uploadDropHandler.current.target ? "copy" : "none";
    };
    const leave = (event: globalThis.DragEvent) => {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setUploadDragTarget(null);
    };
    const drop = (event: globalThis.DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      depth = 0;
      setUploadDragTarget(null);
      if (event.dataTransfer) uploadDropHandler.current.drop(event.dataTransfer);
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragover", over);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragover", over);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);

  const imageLoadReportedRef = useRef<number>(-1);
  useEffect(() => {
    if ((backendState !== "online" && backendState !== "cached") || items.length === 0) return;
    if (imageLoadReportedRef.current === loadStartedRef.current) return;
    
    let cancelled = false;
    const finish = (loadMs: number, visibleImages: HTMLImageElement[], timedOut = false) => {
      if (cancelled || imageLoadReportedRef.current === loadStartedRef.current) return;
      const loadedImages = visibleImages.filter((image) => image.complete && image.naturalWidth > 0);
      const failedImages = visibleImages.filter((image) => image.complete && image.naturalWidth === 0);
      const load = debugInfoRef.current;
      // A fully painted cache hit is the completed user-visible startup. The
      // authoritative refresh continues in the background and keeps its own
      // Server timing instead of making an already usable screen look slow.
      const totalWaitMs = performance.now() - totalStartedRef.current;
      debugInfoRef.current = { ...load, imageLoadTimeMs: loadMs, totalWaitMs };
      setDebugInfo(debugInfoRef.current);
      imageLoadReportedRef.current = loadStartedRef.current;
      reportClientPerformance("library_load_complete", totalWaitMs, {
        cache_hit: load.cacheState === "hit",
        cache_state: load.cacheState ?? "unknown",
        cache_read_ms: load.cacheLoadTimeMs === undefined ? null : Math.round(load.cacheLoadTimeMs),
        server_connected: backendState !== "offline",
        api_wait_ms: load.serverLoadTimeMs === undefined ? null : Math.round(load.serverLoadTimeMs),
        image_load_ms: Math.round(loadMs),
        total_wait_ms: Math.round(totalWaitMs),
        folder: load.folder || "root",
        visible_images: visibleImages.length,
        loaded_images: loadedImages.length,
        failed_images: failedImages.length,
        pending_images: visibleImages.length - loadedImages.length - failedImages.length,
        timed_out: timedOut,
      });
    };
    const interval = window.setInterval(() => {
      const container = document.querySelector('.main-workspace, .media-grid, .media-list');
      if (!container) return;
      const images = Array.from(container.querySelectorAll('img')) as HTMLImageElement[];
      const visibleImages = images.filter(img => {
        const rect = img.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
      });
      
      if (images.length === 0) {
        clearInterval(interval);
        finish(performance.now() - loadStartedRef.current, []);
        return;
      }

      // `complete` is also true for a failed image. Count it only after it has
      // decoded into real pixels; otherwise the debug line lies while cards
      // still show their placeholders on Android WebView.
      if (visibleImages.length > 0 && visibleImages.every(img => img.complete)) {
        clearInterval(interval);
        // Two frames ensures this is painted, rather than merely downloaded.
        window.requestAnimationFrame(() => window.requestAnimationFrame(() => finish(performance.now() - loadStartedRef.current, visibleImages)));
      }
    }, 150);

    const timeout = window.setTimeout(() => {
      clearInterval(interval);
      const container = document.querySelector('.main-workspace, .media-grid, .media-list');
      const visibleImages = container
        ? (Array.from(container.querySelectorAll('img')) as HTMLImageElement[]).filter((img) => {
          const rect = img.getBoundingClientRect();
          return rect.width > 0 && rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0;
        })
        : [];
      finish(performance.now() - loadStartedRef.current, visibleImages, true);
    }, 30000);
    return () => {
      cancelled = true;
      clearInterval(interval);
      clearTimeout(timeout);
    };
  }, [items, backendState]);

  return (
    <main
      className={`app-shell concept-hub unified-layout section-${section} ${activeSearch ? "aggregate-results" : ""} ${railCollapsed ? "rail-collapsed" : ""} ${railDrawerOpen ? "rail-drawer-open" : ""} ${railDrawerOpen || railDrawerVisible ? "rail-drawer-visible" : ""} ${!railDrawerOpen && railDrawerVisible ? "rail-drawer-closing" : ""} ${section === "notes" ? "notes-section" : ""}`}
      onTouchStart={(event) => {
        // Player gestures, including seeking, must never open the library rail.
        if (event.target instanceof Element && event.target.closest(".miniplayer")) {
          sidebarSwipeStart.current = null;
          return;
        }
        const touch = event.touches[0];
        sidebarSwipeStart.current = event.touches.length === 1 && touch ? { x: touch.clientX, y: touch.clientY, time: performance.now() } : null;
      }}
      onTouchEnd={(event) => {
        const start = sidebarSwipeStart.current;
        sidebarSwipeStart.current = null;
        const touch = event.changedTouches[0];
        if (!start || !touch) return;
        const deltaX = touch.clientX - start.x;
        const deltaY = touch.clientY - start.y;
        const distance = Math.abs(deltaX);
        const quickSwipe = performance.now() - start.time <= 250 && distance >= 12;
        if ((quickSwipe || distance >= 28) && distance > Math.abs(deltaY) * 1.25) {
          if (deltaX > 0) setRailDrawerOpen(true);
          else if (railDrawerOpen) setRailDrawerOpen(false);
        }
      }}
      onTouchCancel={() => { sidebarSwipeStart.current = null; }}
      onLoadCapture={(event) => {
        if (event.target instanceof HTMLImageElement) {
          reportImageResult(event.target, "loaded");
          recordBatchImageFinished(event.target, "loaded");
        }
      }}
      onErrorCapture={(event) => {
        if (event.target instanceof HTMLImageElement) {
          reportImageResult(event.target, "failed");
          recordBatchImageFinished(event.target, "failed");
        }
      }}
      onClick={() => {
        setLibraryContext(null);
        setLibrariesContext(null);
        setSidebarContext(null);
        setAccountMenuOpen(false);
        setContextItem(null);
      }}
    >
      <input
        className="folder-cover-input"
        ref={coverInput}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
        onChange={(event) => void uploadFolderCover(event.target.files?.[0])}
      />
      <input
        className="upload-file-input"
        ref={uploadInput}
        type="file"
        multiple
        accept={
          uploadTarget &&
          libraries[uploadTarget.split("/")[0]]?.content_type === "movies_tv"
            ? "video/*,.mkv,.m4v,.avi,.wmv,.ts"
            : undefined
        }
        onChange={(event) =>
          selectUploadFiles(Array.from(event.target.files ?? []).map((file) => ({ file })))
        }
      />
      <input
        className="upload-file-input"
        ref={uploadFolderInput}
        type="file"
        multiple
        webkitdirectory=""
        accept={
          uploadTarget &&
          libraries[uploadTarget.split("/")[0]]?.content_type === "movies_tv"
            ? "video/*,.mkv,.m4v,.avi,.wmv,.ts"
            : undefined
        }
        onChange={(event) =>
          selectUploadFiles(Array.from(event.target.files ?? []).map((file) => ({ file })))
        }
      />
      <MobileNavigation active={section === "trash" ? "admin" : section} admin={canOpenAdminPanel} online={backendState !== "offline"} onNavigate={(nextSection) => {
        setSection(nextSection);
        if (nextSection === "library" || nextSection === "offline") restoreFolderBrowsePrefs(null);
        setCurrentFolder(null); clearSearch();
        if (nextSection === "offline") void refreshOfflineDownloads();
        window.scrollTo(0, 0);
      }} />
      <aside className="sidebar">
        <div style={{ display: 'contents' }}>
          <button
            type="button"
            className="logo"
            aria-label="TMS — Tariq’s Media Server"
            onClick={() => {
              setSection("library");
              restoreFolderBrowsePrefs(null);
              setCurrentFolder(null);
              clearSearch();
              window.scrollTo(0, 0);
            }}
          >
            <span className="logo-badge" aria-hidden="true" />
            <strong>TMS</strong>
          </button>
        </div>
        <nav>
          {nav.filter((item) => item.id === "offline" || backendState !== "offline").map((item) => (
            <a href={`/?section=${item.id}`} key={item.id} onClick={(e) => e.preventDefault()} style={{ display: 'contents' }}>
              <button
                className={section === item.id ? "active" : ""}
                onClick={() => {
                  const nextSection = item.id;
                  setSection(nextSection);
                  if (nextSection === "library" || nextSection === "offline") {
                    restoreFolderBrowsePrefs(null);
                  }
                  setCurrentFolder(null);
                  clearSearch();
                  if (nextSection === "offline") void refreshOfflineDownloads();
                  window.scrollTo(0, 0);
                }}
              >
                <i>{item.icon}</i>
                {item.label}
              </button>
            </a>
          ))}
          {backendState !== "offline" && canOpenAdminPanel && (
            <a href={sessionUser?.is_admin ? "/admin?section=notifications" : "/admin"} onClick={(event) => event.preventDefault()} style={{ display: "contents" }}>
              <button onClick={() => window.location.assign(sessionUser?.is_admin ? "/admin?section=notifications" : "/admin")}>
                <i>▦</i>Admin
                {sessionUser?.is_admin && pendingAdminNotifications > 0 && <em>{pendingAdminNotifications}</em>}
              </button>
            </a>
          )}
        </nav>
        <div className="profile">
          <span>
            {sessionInitials}
          </span>
          <div>
            <b>{sessionUser?.name ?? "User"}</b>
            <small>{sessionUser?.is_admin ? "Full administrator" : canOpenAdminPanel ? "Limited administrator" : "Member"}</small>
          </div>
        </div>
        <header className="topbar">
          <button
            type="button"
            className="rail-drawer-open-btn"
            aria-label={railDrawerOpen ? "Close browse panel" : "Open browse panel"}
            aria-expanded={railDrawerOpen}
            onClick={(event) => {
              event.stopPropagation();
              setRailDrawerOpen((open) => !open);
            }}
          >
            <span aria-hidden="true">☰</span>
            <span>Browse</span>
          </button>
          <div className="search-shell">
            <div className="search" onClick={() => searchInput.current?.focus()}>
              <span className="search-icon" aria-hidden="true"><MenuIcon name="search" /></span>
              <input
                ref={searchInput}
                aria-label={section === "discover" ? "Search Discover" : "Search library"}
                placeholder={section === "discover" ? "Search Discover" : "Search library"}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                value={section === "discover" ? discoverHeaderQuery : query}
                role="combobox"
                aria-autocomplete="list"
                aria-expanded={searchFocused}
                aria-controls="search-suggestions"
                aria-activedescendant={searchFocused && searchSuggestions.some((suggestion) => suggestion.id === selectedSuggestion) ? `suggestion-${selectedSuggestion}` : undefined}
                onFocus={() => setSearchFocused(section !== "discover")}
                onSelect={(event) => { setSearchCaret(event.currentTarget.selectionStart ?? query.length); }}
                onBlur={() =>
                  window.setTimeout(() => setSearchFocused(false), 120)
                }
                onChange={(event) => {
                  if (section === "discover") { setDiscoverHeaderQuery(event.target.value); return; }
                  setQuery(event.target.value);
                  setSearchCaret(event.target.selectionStart ?? event.target.value.length);
                  setSelectedSuggestion(null);
                  setSearchFocused(true);
                }}
                onKeyDown={(event) => {
                  if (event.nativeEvent.isComposing) return;
                  if (section === "discover") { if (event.key === "Enter") { event.preventDefault(); event.currentTarget.blur(); } return; }
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setSearchFocused(true);
                    const index = searchSuggestions.findIndex((suggestion) => suggestion.id === selectedSuggestion);
                    const next = event.key === "ArrowDown" ? (index + 1) % searchSuggestions.length : (index < 0 ? searchSuggestions.length - 1 : (index - 1 + searchSuggestions.length) % searchSuggestions.length);
                    setSelectedSuggestion(searchSuggestions[next]?.id ?? null);
                  }
                  if (event.key === "Enter" || (event.key === "Tab" && searchFocused && (selectedSuggestion || completionContext.field))) {
                    const suggestion = searchFocused ? searchSuggestions.find((suggestion) => suggestion.id === selectedSuggestion)
                      ?? (completionContext.field ? searchSuggestions[0] : undefined) : undefined;
                    if (suggestion) { event.preventDefault(); chooseSearchSuggestion(suggestion); }
                    else if (event.key === "Enter") { event.preventDefault(); submitSearch(); }
                  }
                  if (event.key === "Escape") {
                    setSearchFocused(false);
                    searchInput.current?.blur();
                  }
                }}
              />
              <kbd>Ctrl K</kbd>
              <button type="button" className="search-submit" onClick={event => { event.stopPropagation(); if (section === "discover") searchInput.current?.focus(); else submitSearch(); }} aria-label="Search">
                <MenuIcon name="search" />
              </button>
            </div>
            {searchFocused && section !== "discover" && (
              <div
                ref={searchSuggestionsPanel}
                id="search-suggestions"
                className="search-suggestions"
                role="listbox"
                aria-label="Search suggestions"
              >
                <div className="suggestion-heading">
                  <b>{completionContext.field ? searchFields.find((filter) => filter.field === completionContext.field)?.label : query ? "Search suggestions" : "Recent"}</b>
                  <span>
                    {/^#[^\s&/]*$/.test(query.trim())
                      ? "Tag search only"
                      : query
                        ? "& AND · / OR · ! NOT"
                        : "Choose a filter or type title words"}
                  </span>
                </div>
                {[
                  { kind: "filter" as SuggestionKind, label: completionContext.field === "in" ? "Locations" : "Filters" },
                  {
                    kind: "search" as SuggestionKind,
                    label: "Recent searches",
                  },
                  { kind: "tag" as SuggestionKind, label: "Tags" },
                  { kind: "folder" as SuggestionKind, label: "Folders" },
                  { kind: "media" as SuggestionKind, label: "Items" },
                ].map((group) => {
                  const groupItems = searchSuggestions.filter(
                    (suggestion) => suggestion.kind === group.kind,
                  );
                  return (
                    groupItems.length > 0 && (
                      <section className="suggestion-group" key={group.kind}>
                        <h4>
                          <span>{group.label}</span>
                          <em>{groupItems.length}</em>
                        </h4>
                        {groupItems.map((suggestion) => (
                          <div className="suggestion-item" key={suggestion.id}>
                            <button
                              id={`suggestion-${suggestion.id}`}
                              className="suggestion-row"
                              role="option"
                              aria-selected={suggestion.id === selectedSuggestion || (!selectedSuggestion && Boolean(completionContext.field) && suggestion.id === searchSuggestions[0]?.id)}
                              onMouseDown={(event) => event.preventDefault()}
                              onClick={() => chooseSearchSuggestion(suggestion)}
                            >
                              <i>
                                {suggestion.kind === "search"
                                  ? "↺"
                                  : suggestion.kind === "filter"
                                    ? suggestion.field === "in" || suggestion.value === "in:" ? "#" : "ƒ"
                                    : suggestion.kind === "tag"
                                      ? "#"
                                      : suggestion.kind === "folder"
                                        ? <MenuIcon name="folder" />
                                        : <MenuIcon name="play" />}
                              </i>
                              <span>
                                <b>
                                  {suggestion.kind === "tag"
                                    ? `#${suggestion.label}`
                                    : (() => { const item = suggestion.item; if (!item || item.kind !== "video") return suggestion.label.replace(/\.(mkv|mp4|m4v|avi|mov|webm)$/i, ""); const numbers = episodeNumbers(`${item.parent ?? ""}/${item.name}`); const path = titlePathForVideo(item); const episode = numbers && path ? resolveEpisodeMetadata(titleMetadata[titleMetadataKey(path, "series")]?.videos, numbers.season, numbers.episode) : undefined; return numbers && (episode?.name || episode?.title) ? `S${numbers.season} E${numbers.episode} · ${episode.name || episode.title}` : item.name.replace(/\.(mkv|mp4|m4v|avi|mov|webm)$/i, ""); })()}
                                </b>
                                <small>{suggestion.item ? suggestion.item.parent?.split("/").slice(-2).join(" · ") : suggestion.detail}</small>
                              </span>
                              <em>{suggestion.kind}</em>
                            </button>
                            {suggestion.item && suggestion.kind === "media" ? (
                              <button
                                type="button"
                                className={`suggestion-fav${suggestion.item.favorite ? " on" : ""}`}
                                aria-label={`${suggestion.item.favorite ? "Remove" : "Add"} ${suggestion.label} ${suggestion.item.favorite ? "from" : "to"} favorites`}
                                aria-pressed={Boolean(suggestion.item.favorite)}
                                title={suggestion.item.favorite ? "Favorited" : "Add to favorites"}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  void toggleFavorite(suggestion.item!);
                                }}
                              >
                                <span aria-hidden="true">{suggestion.item.favorite ? "★" : "☆"}</span>
                              </button>
                            ) : null}
                          </div>
                        ))}
                      </section>
                    )
                  );
                })}
                {searchSuggestions.length === 0 && (
                  <div className="suggestion-empty">
                    <b>{completionContext.field ? "No matching values" : query.trim() ? "No close matches yet" : "No recent searches"}</b>
                    <span>{completionContext.field ? "Keep typing a value, or press Space to add title words." : "Search titles, episodes, folders or #tags."}</span>
                  </div>
                )}
                {query.trim() && <button type="button" className="suggestion-show-all" onMouseDown={event => event.preventDefault()} onClick={() => submitSearch()}>See all results</button>}
                <div className="search-syntax-help">
                  <span>↑ ↓ to navigate · Tab to complete · Enter to search</span>
                  <details><summary onMouseDown={(event) => event.preventDefault()}>Advanced search</summary>
                    <p>Combine filters and title words: <code>{'in:Movies "star" type:video'}</code></p>
                    <p>Quote locations with spaces. Use <code>&amp;</code> for AND, <code>/</code> for OR and <code>!</code> to exclude.</p>
                  </details>
                </div>
              </div>
            )}
          </div>
          <div
            className="account-menu"
            onClick={(event) => event.stopPropagation()}
          >
            <button
              type="button"
              className="avatar"
              aria-label="Account menu"
              aria-expanded={accountMenuOpen}
              onClick={() => setAccountMenuOpen((open) => !open)}
            >
              {sessionInitials}
            </button>
            {accountMenuOpen && (
              <div className="account-popover">
                <div>
                  <b>{sessionUser?.name ?? "User"}</b>
                  <small>
                    {sessionUser?.is_admin ? "Full administrator" : canOpenAdminPanel ? "Limited administrator" : "Member"}
                  </small>
                </div>
                {canOpenAdminPanel && (
                  <a href="/admin" className="account-admin-link" onClick={(e) => e.preventDefault()} style={{ display: 'contents' }}>
                    <button
                      type="button"
                      className="account-admin-link"
                      onClick={() => window.location.assign("/admin")}
                    >
                      Admin Dashboard
                    </button>
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setAccountMenuOpen(false);
                    setSettingsError("");
                    setSettingsOpen(true);
                  }}
                >
                  Settings
                </button>
                <button
                  type="button"
                  className="danger"
                  onClick={() =>
                    void logOut().then(() => window.location.replace("/login"))
                  }
                >
                  Log out
                </button>
              </div>
            )}
          </div>
        </header>
      </aside>

      <section className="workspace">

        <div className="content">
          {(railDrawerOpen || railDrawerVisible) && (
            <button
              type="button"
              className="rail-drawer-backdrop"
              aria-label="Close browse panel"
              onClick={(event) => {
                event.stopPropagation();
                setRailDrawerOpen(false);
              }}
            />
          )}
          <aside
            className={`hub-folder-rail ${railCollapsed ? "collapsed" : ""}`}
            role={railDrawerOpen ? "dialog" : undefined} aria-modal={railDrawerOpen ? true : undefined} aria-label={railDrawerOpen ? "Browse library" : undefined}
            onContextMenu={openLibrariesContextMenu}
            onClick={(event) => event.stopPropagation()}
          >
            <div className="folder-rail-head">
              <small>{railCollapsed ? "" : backendState === "offline" ? "OFFLINE" : "LIBRARIES"}</small>
              <button
                type="button"
                className="rail-collapse-toggle"
                onClick={(event) => {
                  event.stopPropagation();
                  toggleRailCollapsed();
                }}
                title={
                  railCollapsed
                    ? "Expand left sidebar"
                    : "Minimize left sidebar"
                }
                aria-label={
                  railCollapsed
                    ? "Expand left sidebar"
                    : "Minimize left sidebar"
                }
              >
                {railCollapsed ? "»" : "«"}
              </button>
            </div>
            {backendState !== "offline" && <>
            <button
              className={
                !currentFolder && section === "library" ? "active" : ""
              }
              title="All libraries"
              onClick={() => {
                setSection("library");
                restoreFolderBrowsePrefs(null);
                setCurrentFolder(null);
              }}
            >
              <span>▣</span>
              <span className="folder-label">All libraries</span>
            </button>
            {renderFolderNodes()}
            </>}
            <section className="sidebar-collection-section" onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSidebarContext({ kind: "playlists", x: event.clientX, y: event.clientY });
            }}>
              <div className="sidebar-collection-header sidebar-collection-inline-header">
                <button
                  type="button"
                  className="sidebar-collection-collapse"
                  aria-expanded={sidebarExpanded.playlists}
                  aria-label={`${sidebarExpanded.playlists ? "Collapse" : "Expand"} playlists`}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setSidebarContext({ kind: "playlists", x: event.clientX, y: event.clientY });
                  }}
                  onClick={() => setSidebarExpanded((current) => ({ ...current, playlists: !current.playlists }))}
                >
                  <span className={sidebarExpanded.playlists ? "expanded" : ""}>›</span>
                </button>
                <button
                  type="button"
                  className="sidebar-collection-heading"
                  title={`${sidebarPlaylists.length} playlist${sidebarPlaylists.length === 1 ? "" : "s"}`}
                  onClick={openPlaylistOverview}
                >
                  <b>PLAYLISTS</b>
                </button>
                <details className="collection-sort-menu"><summary aria-label="Sort playlists">Sort</summary><select
                  className="sidebar-collection-inline-sort"
                  aria-label="Sort sidebar playlists by"
                  value={playlistSidebarSort}
                  onChange={(event) => setPlaylistSidebarSort(event.target.value as CollectionSidebarSort)}
                >
                  <option value="count">Most items</option>
                  <option value="opened">Last opened</option>
                  <option value="name">Name</option>
                </select></details>
                <button
                  type="button"
                  className="sidebar-collection-create"
                  title="Create playlist"
                  aria-label="Create playlist"
                  onClick={() => {
                    setPlaylistError("");
                    setPlaylistDraft("");
                  }}
                >
                  +
                </button>
              </div>
              {sidebarExpanded.playlists && (
                <>
                  <div className="sidebar-collection-items">
                    {visibleSidebarPlaylists.map((playlist) => (
                      <a href="/?section=playlists" key={playlist.id} onClick={(e) => e.preventDefault()} style={{ display: 'contents' }}>
                        <button
                          type="button"
                          className={section === "playlists" && activePlaylistId === playlist.id ? "active" : ""}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setSidebarContext({ kind: "playlist", playlist, x: event.clientX, y: event.clientY });
                          }}
                          onClick={() => openPlaylist(playlist.id)}
                        >
                          <span aria-hidden="true">≡</span>
                          <span className="folder-label">{playlist.name}</span>
                          <em>{playlist.paths.length}</em>
                        </button>
                      </a>
                    ))}
                    {!sidebarPlaylists.length && <p>No playlists yet</p>}
                  </div>
                  {sidebarPlaylists.length > 4 && (
                    <button type="button" className="sidebar-collection-more" onClick={() => setSidebarShowAll((current) => ({ ...current, playlists: !current.playlists }))}>
                      {sidebarShowAll.playlists ? "Show less" : `Show all (${sidebarPlaylists.length})`}
                    </button>
                  )}
                </>
              )}
            </section>
            <section className="sidebar-collection-section" onContextMenu={(event) => {
              event.preventDefault();
              event.stopPropagation();
              setSidebarContext({ kind: "tags", x: event.clientX, y: event.clientY });
            }}>
              <div className="sidebar-collection-header sidebar-collection-inline-header">
                <button
                  type="button"
                  className="sidebar-collection-collapse"
                  aria-expanded={sidebarExpanded.tags}
                  aria-label={`${sidebarExpanded.tags ? "Collapse" : "Expand"} tags`}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    setSidebarContext({ kind: "tags", x: event.clientX, y: event.clientY });
                  }}
                  onClick={() => setSidebarExpanded((current) => ({ ...current, tags: !current.tags }))}
                >
                  <span className={sidebarExpanded.tags ? "expanded" : ""}>›</span>
                </button>
                <button
                  type="button"
                  className="sidebar-collection-heading"
                  title={`${sidebarTags.length} tag${sidebarTags.length === 1 ? "" : "s"}`}
                  onClick={() => {
                    setSection(tagBrowseSection);
                    setActiveTags([]);
                    setCurrentFolder(null);
                    setQuery("");
                  }}
                >
                  <b>TAGS</b>
                </button>
                <details className="collection-sort-menu"><summary aria-label="Sort tags">Sort</summary><select
                  className="sidebar-collection-inline-sort"
                  aria-label="Sort sidebar tags by"
                  value={tagSidebarSort}
                  onChange={(event) => setTagSidebarSort(event.target.value as CollectionSidebarSort)}
                >
                  <option value="count">Most items</option>
                  <option value="opened">Last opened</option>
                  <option value="name">Name</option>
                </select></details>
                <button
                  type="button"
                  className="sidebar-collection-create"
                  title="Create tag"
                  aria-label="Create tag"
                  onClick={() => {
                    setTagError("");
                    setTagDraft("");
                  }}
                >
                  +
                </button>
              </div>
              {sidebarExpanded.tags && (
                <>
                  <div className="sidebar-collection-items">
                    {visibleSidebarTags.map((tagItem) => (
                      <a href={`/?section=library&tag=${encodeURIComponent(tagItem.name)}`} key={tagItem.name} onClick={(e) => e.preventDefault()} style={{ display: 'contents' }}>
                        <button
                          type="button"
                          className={section === tagBrowseSection && activeTags.includes(tagItem.name) ? "active" : ""}
                          onContextMenu={(event) => {
                            event.preventDefault();
                            event.stopPropagation();
                            setSidebarContext({ kind: "tag", tagName: tagItem.name, x: event.clientX, y: event.clientY });
                          }}
                          onClick={() => {
                            setSection(tagBrowseSection);
                            const saved = readLibraryBrowsePrefs(null);
                            setSort(saved.sort);
                            setSortDirection(saved.sortDirection);
                            setActiveTags([tagItem.name]);
                            setCurrentFolder(null);
                            setQuery("");
                          }}
                        >
                          <span aria-hidden="true">#</span>
                          <span className="folder-label">{tagItem.name}</span>
                          <em>{tagItem.count}</em>
                        </button>
                      </a>
                    ))}
                    {!sidebarTags.length && <p>No tags yet</p>}
                  </div>
                  {sidebarTags.length > 4 && (
                    <button type="button" className="sidebar-collection-more" onClick={() => setSidebarShowAll((current) => ({ ...current, tags: !current.tags }))}>
                      {sidebarShowAll.tags ? "Show less" : `Show all (${sidebarTags.length})`}
                    </button>
                  )}
                </>
              )}
            </section>
            <div className="sidebar-utility-nav">
              <small>USER</small>
              <button
                title="Settings"
                onClick={() => {
                  setSettingsError("");
                  setSettingsOpen(true);
                }}
              >
                <span aria-hidden="true">⚙</span>
                <span className="folder-label">Settings</span>
              </button>
              <button
                className="sign-out-button"
                title="Log out"
                onClick={() =>
                  void logOut().then(() => window.location.replace("/login"))
                }
              >
                <span aria-hidden="true">⇥</span>
                <span className="folder-label">Log out</span>
              </button>
            </div>
          </aside>
          <div className="heading-row">
            <div>

              <p className={currentFolder ? "browse-breadcrumb" : "browse-breadcrumb root"}>
                <a href={section === "offline" ? "/?section=offline" : `/?section=${section}`} onClick={(e) => e.preventDefault()} style={{ display: 'contents' }}>
                  <button onClick={() => {
                    if (section === "playlists") {
                      openPlaylistOverview();
                      return;
                    }
                    if (section === "offline") {
                      setCurrentFolder(null);
                      clearSearch();
                      return;
                    }
                    restoreFolderBrowsePrefs(null);
                    setCurrentFolder(null);
                    clearSearch();
                  }}>
                    {activeSearch.trim() ? "SEARCH" : section === "playlists" ? "PLAYLISTS" : title.toUpperCase()}
                  </button>
                </a>
                {!activeSearch.trim() && currentFolder?.split("/").map((part, index, parts) => {
                  const path = parts.slice(0, index + 1).join("/");
                  const href = section === "offline"
                    ? `/?section=offline&folder=${encodeURIComponent(path)}`
                    : `/?folder=${encodeURIComponent(path)}`;
                  return (
                    <span key={`${part}-${index}`}>
                      {" "}
                      /{" "}
                      <a href={href} onClick={(e) => e.preventDefault()} style={{ display: 'contents' }}>
                        <button
                          className={dragTarget === path ? "drag-target" : ""}
                          onDragOver={section === "offline" ? undefined : (event) => allowDrop(event, path)}
                          onDragLeave={section === "offline" ? undefined : () =>
                            setDragTarget((current) =>
                              current === path ? null : current,
                            )
                          }
                          onDrop={section === "offline" ? undefined : (event) => void moveToFolder(event, path)}
                          onClick={() => {
                            const saved = readLibraryBrowsePrefs(path);
                            setSort(saved.sort);
                            setSortDirection(saved.sortDirection);
                            setLibraryView(saved.view);
                            setCurrentFolder(path);
                          }}
                        >
                          {(titleCollectionForPath(path)?.label ?? part).toUpperCase()}
                        </button>
                      </a>
                    </span>
                  );
                })}
              </p>
              <div className="library-heading-main">
                <div className="library-heading-copy">
                  <div className={`library-heading-title${currentFolder ? " has-parent" : ""}`}>
                {currentFolder && <button className="mobile-parent-link" type="button" aria-label={`Back to ${currentFolder.split("/").slice(-2,-1)[0] || "Libraries"}`} onClick={() => { const parent = currentFolder.split("/").slice(0,-1).join("/") || null; restoreFolderBrowsePrefs(parent); setCurrentFolder(parent); }}><MenuIcon name="chevronLeft" /></button>}
                <h1>
                  {activeSearch.trim()
                    ? `Results for “${activeSearch.trim()}”`
                    : currentFolder
                    ? (titleCollectionForPath(currentFolder)?.label ??
                      currentFolder.split("/").at(-1))
                    : title}
                </h1>
              {section === "library" && currentFolder && (canCreateFolderHere || canUploadHere || canServerDownloadHere) && (
                <div className="folder-tools">
                  <button type="button" aria-label="Add media" aria-expanded={folderToolsOpen} aria-controls="folder-tools-menu" onClick={() => setFolderToolsOpen(!folderToolsOpen)}><MenuIcon name="plus" /><span className="folder-tools-label">Add media</span></button>
                  {folderToolsOpen && <div id="folder-tools-menu" role="dialog" aria-modal="true" aria-label="Add media" className="folder-tools-menu" onClick={(event) => { if ((event.target as HTMLElement).closest("button")) setFolderToolsOpen(false); }}>
                  {!currentLibrary?.folder_structure_static && <button
                    className="toolbar-create"
                    type="button"
                    onClick={() =>
                      folderActionPath && startFolderCreation(folderActionPath)
                    }
                    disabled={!canCreateFolderHere}
                    title={canCreateFolderHere ? "Create a folder here" : "Open a library folder with folder permission to use this"}
                  >
                    <MenuIcon name="plus" />New folder
                  </button>}
                  {canUploadHere && <button
                    type="button"
                    onClick={() =>
                      folderActionPath && startUpload(folderActionPath)
                    }
                    title="Upload into this folder"
                  >
                    <MenuIcon name="upload" />Upload media
                  </button>}
                  {canServerDownloadHere && (
                    <button
                      type="button"
                      className="toolbar-magnet"
                      onClick={() =>
                        folderActionPath &&
                        startServerDownload(folderActionPath)
                      }
                      title="Download media on the server"
                    >
                      <MenuIcon name="download" />Download from URL
                    </button>
                  )}
                  </div>}
                </div>
              )}
                {activeSearch.trim() && <span className="search-result-actions">
                  <button type="button" aria-label="Edit search" onClick={() => { setQuery(activeSearch); searchInput.current?.focus(); }}><MenuIcon name="search" /></button>
                  <button type="button" aria-label="Clear search" onClick={clearSearch}><MenuIcon name="close" /></button>
                </span>}
                {section === "recent" && !selectionMode && playableVisible.length > 0 && <div className="recent-play-actions">
                  <button type="button" aria-label="Play all recent media" onClick={() => playVisibleQueue(false)}><MenuIcon name="play" /></button>
                  <button type="button" aria-label="Shuffle recent media" onClick={() => playVisibleQueue(true)}><MenuIcon name="shuffle" /></button>
                </div>}
                {!isPlaylistOverview && section !== "notes" && section !== "offline" && section !== "discover" && (
                  <span className={`library-connection ${backendState}`} role="status" title={backendState === "offline" ? backendError || "Server unavailable" : undefined}>
                    {backendState === "loading" || backendState === "cached" ? (
                      <i className="library-loading-spinner" aria-hidden="true" />
                    ) : (
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        {backendState === "online" ? <><path d="M4 9a12 12 0 0 1 16 0M7 12a7.5 7.5 0 0 1 10 0M10 15a3 3 0 0 1 4 0" /><circle cx="12" cy="18" r=".7" fill="currentColor" stroke="none" /></> : <><path d="m3 3 18 18M4 9a12 12 0 0 1 3-2M10 6a12 12 0 0 1 10 3M7 12a7.5 7.5 0 0 1 3-1M14 11a7.5 7.5 0 0 1 3 1M10 15a3 3 0 0 1 4 0" /><circle cx="12" cy="18" r=".7" fill="currentColor" stroke="none" /></>}
                      </svg>
                    )}
                    {backendState === "online" ? "Server connected" : backendState === "offline" ? "Server offline" : "Connecting…"}
                  </span>
                )}
                {section === "offline" && (
                  <div className="library-settings">
                    <button
                      type="button"
                      onClick={() => void chooseOfflineDownloadLocation()}
                      disabled={offlineBusy}
                    >
                      {offlineBusy ? "Choosing…" : offlineLocationName ? "Change offline folder" : "Choose offline folder"}
                    </button>
                    {offlineBundles.some((bundle) => bundle.kind === "folder") && (
                      <button type="button" onClick={() => void syncOfflineFolders()} disabled={offlineBusy || backendState !== "online"}>
                        Sync offline folders
                      </button>
                    )}
                    {offlineSyncError && <small role="status">{offlineSyncError} Use Sync offline folders to retry.</small>}
                    {backendState === "offline" && (
                      <button type="button" onClick={() => void openConfiguredTmsServer()}>
                        Try server
                      </button>
                    )}
                  </div>
                )}
                  {/* The connection badge owns loading/offline state; the count appears once connected. */}
                  {(isPlaylistOverview || section === "notes" || section === "offline" || section === "discover" || backendState === "online") && (
                  <span className="library-status">
                {!isPlaylistOverview && isFetchingNewFolder && section !== "notes" && section !== "offline" && section !== "discover" && (
                  <i className="library-loading-spinner" aria-hidden="true" />
                )}
                {isPlaylistOverview
                  ? `${filteredPlaylistCards.length}${filteredPlaylistCards.length !== sidebarPlaylists.length ? ` of ${sidebarPlaylists.length}` : ""} playlist${sidebarPlaylists.length === 1 ? "" : "s"}`
                  : section === "offline"
                  ? `${visible.length} items${offlineLocationName ? ` · ${offlineLocationName}` : ""}${backendState === "offline" ? " · Server offline" : ""}`
                  : section === "notes"
                  ? sharedTodoSyncState === "saving"
                    ? "Saving notes…"
                    : sharedTodoSyncState === "saved"
                      ? "Notes saved · Shared across users"
                      : ""
                  : section === "discover"
                  ? "Movies and series to explore"
                  : isFetchingNewFolder
                  ? "Loading folder…"
                  : currentFolder?.includes("/") && !/^Season \d+/i.test(currentFolder.split("/").at(-1) ?? "") && mediaEvidenceForFolder(items, currentFolder).kind === "series" ? `${visibleTotalCount} seasons` : currentFolder && /Season \d+/i.test(currentFolder) ? [currentFolder.split("/").at(-2), `${visibleTotalCount} episodes`].filter(Boolean).join(" · ") : `${visibleTotalCount} items`}
                  </span>
                  )}
              {section === "library" &&
                !currentFolder &&
                !activeSearch.trim() &&
                canManageLibraries && !selectionMode && (
                  <button
                    className="library-create"
                    type="button"
                    onClick={startLibraryCreation}
                  >
                    New library
                  </button>
                )}
              </div>
                </div>
                {!isPlaylistOverview && section !== "notes" && section !== "discover" && (section === "offline" || section === "playlists" ? visible.length > 0 && filterTags.length > 1 : currentLibraryType !== "movies_tv" && !activeSearch.trim() && filterTags.length > 1) && (
                  <div className="tag-strip">
                    <span>Filter by</span>
                    {filterTags.map((item) => (
                      <button
                        key={item}
                        data-label={item}
                        className={item === "All" ? activeTags.length === 0 ? "active" : "" : activeTags.includes(item) ? "active" : ""}
                        aria-pressed={item === "All" ? activeTags.length === 0 : activeTags.includes(item)}
                        onClick={() => setActiveTags((current) => item === "All" || current[0] === item ? [] : [item])}
                      >
                        <span>{item === "Video" ? "Videos" : item === "Photos" ? "Images" : item === "File" ? "Files" : item}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>

          {!isPlaylistOverview && section !== "notes" && section !== "discover" && (
          <div className="toolbar">
            <div>
              {!activeSearch.trim() && (section === "playlists" || (section === "offline" && currentFolder)) && <span>
                {section === "playlists"
                  ? "Playlist items"
                  : section === "offline"
                    ? currentFolder ? "Folder content" : "Offline library"
                  : null}
              </span>}
              {selectionMode ? (
                <>
                  <strong className="toolbar-selection-count">
                    {selectedIds.length} selected
                  </strong>
                  <button
                    type="button"
                    onClick={selectAllVisible}
                    disabled={!selectableVisible.length || selectedIds.length === selectableVisible.length}
                  >
                    Select all
                  </button>
                  <button
                    type="button"
                    onClick={clearSelection}
                    disabled={!selectedIds.length}
                  >
                    Clear
                  </button>
                  {selectedIds.length > 0 && section !== "trash" && canBulkOrganize && (
                    <button
                      type="button"
                      onClick={startBulkOrganizing}
                    >
                      <MenuIcon name="tag" />Tags & playlists
                    </button>
                  )}
                  {selectedTaggableFolderPaths.length > 0 && (
                    <span className="toolbar-selection-note" role="status">
                      Folder tags are inherited by everything inside them
                    </span>
                  )}
                  {selectedIds.length > 0 && section !== "trash" && selectedMovableItems.length > 0 && (
                    <button
                      type="button"
                      onClick={() => {
                        setMoveDestination(currentFolder ?? "");
                        setMoveExpandedDestinations(currentFolder ? movePathAncestors(currentFolder) : []);
                        setMoveError("");
                        setBulkMoveOpen(true);
                      }}
                    >
                      <MenuIcon name="move" />Move {selectedMovableItems.length}
                    </button>
                  )}
                  {selectedIds.length > 0 && section !== "trash" && selectedDeletableItems.length > 0 && (
                    <button
                      type="button"
                      className="danger"
                      onClick={() => setBulkDeleteOpen(true)}
                    >
                      Delete {selectedDeletableItems.length}
                    </button>
                  )}
                  {selectedIds.length > 0 && section === "trash" && (
                    <>
                      <button
                        type="button"
                        onClick={() => void bulkRestoreTrash()}
                        disabled={bulkRestoring}
                      >
                        {bulkRestoring ? "Restoring…" : `Restore ${selectedItems.length}`}
                      </button>
                      <button
                        type="button"
                        className="danger"
                        onClick={() => setBulkPermanentDeleteOpen(true)}
                      >
                        Delete {selectedItems.length} permanently
                      </button>
                    </>
                  )}
                  <button type="button" onClick={exitSelectionMode}>
                    Done
                  </button>
                </>
              ) : (
                <>
              {section !== "recent" && playableVisible.length > 0 && (section === "offline" || currentLibraryType !== "movies_tv") && (
                <>
                  <button
                    className="toolbar-queue"
                    type="button"
                    onClick={() => playVisibleQueue(false)}
                  >
                    <MenuIcon name="play" />Play all
                  </button>
                  <button
                    className="toolbar-queue"
                    type="button"
                    onClick={() => playVisibleQueue(true)}
                  >
                    <MenuIcon name="shuffle" />Shuffle
                  </button>
                </>
              )}
              {section === "playlists" && (
                <button
                  className="toolbar-create"
                  type="button"
                  onClick={() => {
                    setPlaylistError("");
                    setPlaylistDraft("");
                  }}
                >
                  <MenuIcon name="plus" />New playlist
                </button>
              )}
              {section !== "playlists" && selectableVisible.length > 0 && !selectionMode && (
                <button
                  className="toolbar-select"
                  type="button"
                  onClick={() => enterSelectionMode()}
                >
                  ☑ Select
                </button>
              )}
                </>
              )}
            </div>
            <div className="view-tools">
              {section === "playlists" && Object.keys(playlists).length > 0 && (
                <>
                  <button type="button" onClick={openPlaylistOverview}>All playlists</button>
                  <select
                    aria-label="Choose playlist"
                    value={activePlaylistId ?? ""}
                    onChange={(event) =>
                      setActivePlaylistId(event.target.value)
                    }
                  >
                    {Object.values(playlists)
                      .sort((left, right) =>
                        left.name.localeCompare(right.name),
                      )
                      .map((playlist) => (
                        <option key={playlist.id} value={playlist.id}>
                          {playlist.name} ({playlist.paths.length})
                        </option>
                      ))}
                  </select>
                  <button
                    className="danger"
                    type="button"
                    onClick={() => void deleteActivePlaylist()}
                    disabled={!activePlaylistId || savingPlaylist}
                  >
                    Delete playlist
                  </button>
                </>
              )}
              {section === "trash" && trashItems.length > 0 && (
                <button
                  className="danger empty-trash-action"
                  type="button"
                  onClick={() => setEmptyTrashOpen(true)}
                  disabled={!trashItems.length}
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polyline points="3 6 5 6 21 6"></polyline>
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                    <line x1="10" y1="11" x2="10" y2="17"></line>
                    <line x1="14" y1="11" x2="14" y2="17"></line>
                  </svg>{" "}
                  Empty trash
                </button>
              )}
              {visible.length > 0 && <>{section !== "recent" && section !== "trash" && section !== "new" && !(visible.length <= 2 && visible.every(item => item.kind === "folder")) && <select aria-label="Sort files" value={`${sort}:${sortDirection}`} onChange={event => { const [field, direction] = event.target.value.split(":"); setSort(field as SortField); setSortDirection(direction as SortDirection); }}>
                {([['opened','Recently opened','Least recently opened'],['date','Newest added','Oldest added'],['name','Name A–Z','Name Z–A'],['size','Largest','Smallest'],['length','Longest','Shortest'],['type','File type A–Z','File type Z–A']] as const).flatMap(([field,first,second]) => { const natural = field === 'name' || field === 'type' ? 'asc' : 'desc'; return (['asc','desc'] as const).map(direction => <option key={`${field}:${direction}`} value={`${field}:${direction}`}>{direction === natural ? first : second}</option>); })}
              </select>}
              {(section === "offline" || ((currentLibraryType === "mixed" || currentLibraryType === "music") && (currentFolder || activeSearch.trim() || query.trim()))) ? (
                <div className="view-toggle" role="group" aria-label="Library view">
                  <button
                    type="button"
                    className={libraryView === "grid" ? "active" : ""}
                    aria-pressed={libraryView === "grid"}
                    aria-label="Grid view"
                    onClick={() => selectLibraryView("grid")}
                  >
                    <MenuIcon name="grid" /><span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}>Grid view</span>
                  </button>
                  <button
                    type="button"
                    className={libraryView === "list" ? "active" : ""}
                    aria-pressed={libraryView === "list"}
                    aria-label="List view"
                    onClick={() => selectLibraryView("list")}
                  >
                    <MenuIcon name="list" /><span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}>List view</span>
                  </button>
                </div>
              ) : null}</>}
            </div>
          </div>
          )}

          {hasMoreVisible && (
            <div className="library-load-more library-load-more-mobile" aria-live="polite">
              {serverPageLoading && <><span className="library-load-more-spinner" aria-hidden="true" /><strong>Loading more…</strong></>}
              <b>
                Showing {renderedVisible.length} of {visibleTotalCount}
              </b>
              <button type="button" onClick={() => handleLoadMore()} disabled={serverPageLoading}>Load more</button>
              <button type="button" onClick={() => handleLoadMore(true)} disabled={serverPageLoading}>Load all</button>
            </div>
          )}

          {section === "discover" ? (
            <Discover query={discoverHeaderQuery} onQueryChange={setDiscoverHeaderQuery} />
          ) : section === "notes" ? (
            <div className="shared-notes-page">
              <RichTextEditor
                html={sharedTodoText}
                saveStatus={sharedTodoSyncState === "saving" ? "Saving…" : sharedTodoSyncState === "error" ? "Could not save" : "Saved"}
                onRetrySave={sharedTodoSyncState === "error" ? () => void saveSharedTodo(sharedTodoTextRef.current) : undefined}
                placeholder="Write down issues, bugs, notes, or todos… (You can format text, insert lists, tables, and paste images)"
                onChange={(nextText) => {
                  sharedTodoTextRef.current = nextText;
                  setSharedTodoText(nextText);
                  queueSharedTodoSave(nextText);
                }}
              />
            </div>
          ) : isPlaylistOverview ? (
            <section className="playlist-overview" aria-label="Your playlists">
              <div className="playlist-overview-tools">
                <button type="button" onClick={() => { setPlaylistError(""); setPlaylistDraft(""); }}>+ Create playlist</button>
                <input type="search" aria-label="Search playlists" placeholder="Search playlists…" value={playlistBrowseQuery} onChange={(event) => setPlaylistBrowseQuery(event.target.value)} />
                <select aria-label="Sort playlists by" value={playlistBrowseSort} onChange={(event) => setPlaylistBrowseSort(event.target.value as SidebarSort)}>
                  <option value="count">Item count</option>
                  <option value="recent">Recently updated</option>
                  <option value="name">Name</option>
                </select>
                <select aria-label="Playlist sort direction" value={playlistBrowseDirection} onChange={(event) => setPlaylistBrowseDirection(event.target.value as "asc" | "desc")}>
                  <option value="desc">Descending</option>
                  <option value="asc">Ascending</option>
                </select>
                <div className="playlist-overview-views" aria-label="Playlist view">
                  <button type="button" aria-label="Playlist grid view" aria-pressed={playlistBrowseView === "grid"} onClick={() => setPlaylistBrowseView("grid")}>▦</button>
                  <button type="button" aria-label="Playlist list view" aria-pressed={playlistBrowseView === "list"} onClick={() => setPlaylistBrowseView("list")}>☷</button>
                </div>
              </div>
              {playlistBrowseAvailableTags.length > 0 && (
                <div className="tag-strip playlist-overview-filters" aria-label="Filter playlists by tag">
                  <span>Tags</span>
                  <button type="button" className={!playlistBrowseTags.length ? "active" : ""} aria-pressed={!playlistBrowseTags.length} onClick={() => setPlaylistBrowseTags([])}>All</button>
                  {playlistBrowseAvailableTags.map((tag) => (
                    <button key={tag} type="button" className={playlistBrowseTags.includes(tag) ? "active" : ""} aria-pressed={playlistBrowseTags.includes(tag)} onClick={() => setPlaylistBrowseTags((current) => current.includes(tag) ? current.filter((value) => value !== tag) : [...current, tag])}>{tag}</button>
                  ))}
                </div>
              )}
              {filteredPlaylistCards.length ? (
                <ul className={`playlist-overview-list ${playlistBrowseView}`}>
                  {filteredPlaylistCards.map(({ playlist, tags, cover }) => (
                    <li key={playlist.id} className="media-card playlist-overview-card">
                      <a href={`/?section=playlists&playlist=${encodeURIComponent(playlist.id)}`} onClick={(event) => { event.preventDefault(); openPlaylist(playlist.id); }}>
                        <div className="thumb playlist-overview-cover">
                          {cover?.kind === "image" ? <img className="thumb-video folder-cover" src={cover.thumbSrc ?? cover.src} alt={`${playlist.name} playlist cover`} loading="lazy" />
                            : cover?.kind === "video" ? <VideoPreviewThumb src={cover.src!} className="thumb-video folder-cover" videoPath={cover.path} />
                            : <div className="folder-shape"><span>{playlist.name.slice(0, 1).toUpperCase()}</span></div>}
                          <span className="playlist-overview-badge">PLAYLIST</span>
                        </div>
                        <div className="playlist-overview-details">
                          <strong className="playlist-overview-name">{playlist.name}</strong>
                          <span className="playlist-overview-count">{playlist.paths.length} item{playlist.paths.length === 1 ? "" : "s"}</span>
                          {tags.length > 0 && <div className="playlist-overview-tags">{tags.map((tag) => <span key={tag}>{tag}</span>)}</div>}
                        </div>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="playlist-overview-empty" role="status">
                  <p>{sidebarPlaylists.length ? "No playlists match your filters" : backendState === "loading" || backendState === "cached" ? "Loading playlists…" : "No playlists yet"}</p>
                  {(playlistBrowseQuery || playlistBrowseTags.length > 0) && <button type="button" onClick={() => { setPlaylistBrowseQuery(""); setPlaylistBrowseTags([]); }}>Clear filters</button>}
                </div>
              )}
            </section>
          ) : displayVisible.length ? (
            <>
              <div
                className={useMixedListView ? "media-list" : `media-grid${!currentFolder && section === "library" && !activeSearch.trim() ? " library-home-grid" : ""}`}
                onContextMenu={openLibraryContextMenu}
              >
                {currentFolder && !activeSearch.trim() && section === "library" && mediaEvidenceForFolder(items, currentFolder).kind === "series" && (() => {
                  const metadata = titleMetadata[titleMetadataKey(currentFolder, "series")];
                  if (!metadata?.description) return null;
                  const facts = [metadata.releaseInfo?.replace(/^(\d{4})[–-]$/, "$1–present"), metadata.imdbRating ? `★ ${metadata.imdbRating}` : ""].filter(Boolean).join(" · ");
                  return <section className={`show-overview${metadata.poster ? " has-poster" : ""}`}>
                    {metadata.poster && <CachedArtworkImage className="show-overview-poster" src={metadata.poster} alt="" loading="lazy" />}
                    {(facts || metadata.genres?.length) ? <div className="show-overview-facts">{facts && <b>{facts}</b>}{metadata.genres?.length ? <span>{metadata.genres.join(" · ")}</span> : null}</div> : null}
                    {metadata?.description && <p>{metadata.description}</p>}
                    <button type="button" onClick={() => playCatalogTitle(currentFolder, "series")}><MenuIcon name="play" />Play first episode</button>
                  </section>;
                })()}
                {renderedVisible.map((item) => {
                  const itemPath =
                    item.kind === "folder"
                      ? item.parent
                        ? `${item.parent}/${item.name}`
                        : item.name
                      : item.path ?? "";
                  const isLibrary = item.kind === "folder" && !item.parent && !item.offline;
                  const catalogTitle = catalogTitleForItem(item);
                  const isTitle = Boolean(catalogTitle);
                  const titleCardPath = catalogTitle?.path ?? itemPath;
                  const evidence = catalogTitle?.evidence ?? null;
                  const titleKindLabel =
                    isTitle && evidence
                      ? evidence.kind === "movie"
                        ? "Movie"
                        : "Show"
                      : null;
                  const metadata =
                    isTitle && evidence
                      ? titleMetadata[titleMetadataKey(titleCardPath, evidence.kind)]
                      : undefined;
                  const youtubeTrailerId = trailerYoutubeId(metadata);
                  const metadataPending = Boolean(isTitle && evidence && !metadata && pendingTitleMetadata.has(titleMetadataKey(titleCardPath, evidence.kind)));
                  const titleCollection = itemPath
                    ? titleCollectionForPath(itemPath)
                    : null;
                  let displayName =
                    metadata?.name ?? (isTitle ? catalogTitle?.title : titleCollection?.label) ?? (item.kind === "folder" ? item.name : fileNameStem(item.name));
                  const displayTags = item.tags.filter((tag) => !commonTags.has(tag) && !["Video", "Photos", "Audio", "File"].includes(tag));
                  const artworkPath = isTitle ? titleCardPath : itemPath;
                  const autoCover = artworkPath
                    ? automaticFolderCover(artworkPath)
                    : null;
                  const customCover = artworkPath
                    ? folderCovers[artworkPath] && `${API_BASE}/folder-covers/${encodeURIComponent(folderCovers[artworkPath])}`
                    : undefined;
                  const collectionSeriesPath = titleCollection && itemPath
                    ? itemPath.slice(0, itemPath.lastIndexOf("/"))
                    : null;
                  const seasonNumber = titleCollection?.season ?? null;
                  const seriesMetadata = collectionSeriesPath
                    ? titleMetadata[titleMetadataKey(collectionSeriesPath, "series")]
                    : undefined;
                  const seasonArtwork = seasonNumber === null
                    ? undefined
                    : seriesMetadata?.videos?.find((episode) => episode.season === seasonNumber)?.thumbnail;
                  const seriesCustomCover = collectionSeriesPath
                    ? folderCovers[collectionSeriesPath] && `${API_BASE}/folder-covers/${encodeURIComponent(folderCovers[collectionSeriesPath])}`
                    : undefined;
                  const seriesAutoCover = collectionSeriesPath
                    ? automaticFolderCover(collectionSeriesPath)
                    : null;
                  const folderPreviewImage = item.kind === "folder" && item.previewKind === "image" ? item.previewThumbSrc ?? item.previewSrc : undefined;
                  const folderPreviewVideo = item.kind === "folder" && item.previewKind === "video" && item.previewSrc
                    ? { ...item, src: item.previewSrc, thumbSrc: item.previewThumbSrc ?? item.previewSrc, path: item.previewPath }
                    : null;
                  // Random descendant previews are right for ordinary folders,
                  // but not for movie/show title cards or their seasons. Those
                  // must stay on the fetched catalog artwork (with an explicit
                  // user-uploaded cover still allowed as an override).
                  const isCatalogFolder = Boolean(isTitle || titleCollection);
                  const coverImage = isCatalogFolder
                    ? customCover
                      ?? (titleCollection
                        ? seasonArtwork ?? seriesMetadata?.poster ?? seriesCustomCover
                        : metadata?.poster)
                    : customCover
                      ?? folderPreviewImage
                      ?? (autoCover?.kind === "image" ? autoCover.src : undefined)
                      ?? (seriesAutoCover?.kind === "image" ? seriesAutoCover.src : undefined);
                  const coverVideo = !isCatalogFolder && !coverImage
                    ? folderPreviewVideo
                      ?? (autoCover?.kind === "video" ? autoCover : null)
                      ?? (seriesAutoCover?.kind === "video" ? seriesAutoCover : null)
                    : null;
                  const episodeNumbersForItem = item.kind === "video"
                    ? episodeNumbers(`${item.parent ?? ""}/${item.name}`)
                    : null;
                  const episodeTitlePath = item.kind === "video"
                    ? titlePathForVideo(item) ?? ""
                    : "";
                  const episodeMetadata = episodeNumbersForItem && episodeTitlePath
                    ? resolveEpisodeMetadata(
                        titleMetadata[titleMetadataKey(episodeTitlePath, "series")]?.videos,
                        episodeNumbersForItem.season,
                        episodeNumbersForItem.episode
                      )
                    : undefined;
                  const episodeTitle = episodeMetadata?.name ?? episodeMetadata?.title;
                  const episodePlayback = episodeNumbersForItem ? playback[item.path ?? ""] : undefined;
                  const episodeProgress = episodePlayback?.completed ? 100 : episodePlayback?.duration ? Math.min(100, Math.max(0, episodePlayback.position / episodePlayback.duration * 100)) : 0;
                  if (!isTitle && episodeNumbersForItem && episodeTitle) {
                    displayName = (currentFolder === item.parent && !activeSearch.trim())
                      ? `Episode ${episodeNumbersForItem.episode} · ${episodeTitle}`
                      : `${titleMetadata[titleMetadataKey(episodeTitlePath, "series")]?.name ?? episodeTitlePath.split("/").pop()} · S${String(episodeNumbersForItem.season).padStart(2,"0")}E${String(episodeNumbersForItem.episode).padStart(2,"0")} · ${episodeTitle}`;
                  }
                  const folderItemCount =
                    item.kind === "folder" ? getFolderItemCount(item) : 0;
                  const openMixedListItem = () => {
                    // A show card is navigation: open its seasons (or its only
                    // season's episode list). The explicit play control remains
                    // the shortcut for starting the first episode.
                    if (isTitle && evidence?.kind === "series" && !item.trashed) openFolder(item);
                    else if (isTitle && evidence && item.kind === "folder" && !item.trashed) playCatalogTitle(titleCardPath, evidence.kind);
                    else if (item.kind === "folder") openFolder(item);
                    else openItem(item);
                  };

                  const getItemUrl = () => {
                    if (item.offline) {
                      if (item.kind === "folder") {
                        const path = item.parent ? `${item.parent}/${item.name}` : item.name;
                        return `/?section=offline&folder=${encodeURIComponent(path)}`;
                      }
                      if (item.src && (item.kind === "video" || item.kind === "image")) {
                        const returnParams = new URLSearchParams({ section: "offline" });
                        if (currentFolder) returnParams.set("folder", currentFolder);
                        const params = new URLSearchParams({
                          src: item.src,
                          name: item.name,
                          size: item.size,
                          folder: item.parent ?? "Offline",
                          kind: item.kind,
                          play: "1",
                          return: `/?${returnParams.toString()}`,
                        });
                        if (item.offline.fileId) {
                          params.set("offlineBundle", item.offline.bundleId);
                          params.set("offlineFile", item.offline.fileId);
                        }
                        if (item.path) params.set("path", item.path);
                        return `/watch?${params.toString()}`;
                      }
                      if (!item.offline.fileId) return "/?section=offline";
                      const returnParams = new URLSearchParams({ section: "offline" });
                      if (currentFolder) returnParams.set("folder", currentFolder);
                      const params = new URLSearchParams({
                        offlineBundle: item.offline.bundleId,
                        offlineFile: item.offline.fileId,
                        path: item.path ?? "",
                        name: item.name,
                        size: item.size,
                        folder: item.parent ?? "Offline",
                        kind: item.kind,
                        play: "1",
                        return: `/?${returnParams.toString()}`,
                      });
                      return `/watch?${params.toString()}`;
                    }
                    if (isTitle && evidence?.kind === "series") return `/?folder=${encodeURIComponent(item.path!)}`;
                    if (isTitle && evidence && item.kind === "folder") return `/watch?path=${encodeURIComponent(titleCardPath)}`;
                    if (item.kind === "folder") return `/?folder=${encodeURIComponent(item.path!)}`;
                    if (!item.src) return "/";
                    const params = new URLSearchParams({
                      src: item.src,
                      name: item.name,
                      size: item.size,
                      folder: item.parent ?? "My library",
                      kind: item.kind,
                      play: "1",
                      return: `${window.location.pathname}${window.location.search}`,
                    });
                    if (item.path) params.set("path", item.path);
                    if (episodeMetadata && episodeNumbersForItem && episodeTitlePath) {
                      params.set("catalog", "movies_tv");
                      params.set("series", episodeTitlePath);
                      params.set("season", String(episodeNumbersForItem.season));
                      params.set("episode", String(episodeNumbersForItem.episode));
                    }
                    writeQueueSource(params, queueSourceForItem(currentQueueSource("item"), item));
                    return `/watch?${params.toString()}`;
                  };

                  if (useMixedListView) {
                    const audioNowPlaying = Boolean(miniplayerItem && item.kind === "audio" && (
                      (item.path && miniplayerItem.path === item.path) || miniplayerItem.id === item.id
                    ));
                    return (
                      <MixedMediaListRow
                        key={item.id}
                        item={item}
                        episodeThumbnail={episodeMetadata?.thumbnail}
                        playbackProgress={episodeProgress}
                        watched={episodePlayback?.completed}
                        displayName={displayName}
                        openedLabel={section === "recent" && item.lastOpenedAt ? `Opened ${new Date(item.lastOpenedAt * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}` : undefined}
                        displayTags={displayTags}
                        itemPath={itemPath}
                        isLibrary={isLibrary}
                        coverImage={coverImage}
                        folderItemCount={folderItemCount}
                        folderDescription={evidence?.kind === "series" ? `Series · ${folderItemCount} season${folderItemCount === 1 ? "" : "s"}` : titleKindLabel ?? undefined}
                        durationLabel={formatListDuration(item.duration)}
                        dragTarget={dragTarget === itemPath}
                        canMove={canMoveItem(item)}
                        selectionMode={selectionMode}
                        selected={selectedIds.includes(item.id)}
                        canSelect={canSelectItem(item)}
                        onToggleSelect={() => toggleItemSelection(item)}
                        onEnterSelection={() => enterSelectionMode(item)}
                        onOpen={openMixedListItem}
                        onFavorite={() => void toggleFavorite(item)}
                        onMenu={(event) => toggleItemContextMenu(event, item)}
                        onContextMenu={(event) => openItemContextMenu(event, item)}
                        onDragStart={(event) => startMoveDrag(event, item)}
                        onDragEnd={() => {
                          setDraggedItem(null);
                          setDragTarget(null);
                        }}
                        onDragOver={item.kind === "folder" && !isLibrary ? (event) => allowDrop(event, itemPath) : undefined}
                        onDragLeave={item.kind === "folder" ? () => setDragTarget((current) => current === itemPath ? null : current) : undefined}
                        onDrop={item.kind === "folder" && !isLibrary ? (event) => void moveToFolder(event, itemPath) : undefined}
                        menuOpen={contextItem?.item.id === item.id}
                        nowPlaying={audioNowPlaying}
                        nowPlayingActive={audioNowPlaying && miniplayerPlaying}
                      />
                    );
                  }
                  const cardAspectRatio = !isTitle && item.path
                    ? (item.aspectRatio ?? readCachedAspectRatio(item.path) ?? undefined)
                    : item.aspectRatio;
                  const imageBatchId = item.path ? imageBatchByPath[item.path] : undefined;
                  const onBatchPreviewResult = imageBatchId && item.path
                    ? (outcome: "loaded" | "failed") => recordBatchImageResult(imageBatchId, item.path!, outcome)
                    : undefined;
                  const cardPlaybackLabel = episodePlayback?.completed ? "Watched" : episodeProgress > 0 ? `${Math.round(episodeProgress)} percent watched` : "";
                  const openCard = (event: ReactMouseEvent) => {
                    event.preventDefault();
                    if (selectionMode && canSelectItem(item)) toggleItemSelection(item);
                    else if (isTitle && evidence?.kind === "series" && !item.trashed) openFolder(item);
                    else if (isTitle && evidence && item.kind === "folder" && !item.trashed) playCatalogTitle(titleCardPath, evidence.kind);
                    else if (item.kind === "folder") openFolder(item);
                    else openItem(item);
                  };
                  const audioNowPlaying = Boolean(miniplayerItem && item.kind === "audio" && (
                    (item.path && miniplayerItem.path === item.path) || miniplayerItem.id === item.id
                  ));
                  return (
                    <article
                      draggable={!selectionMode && canMoveItem(item)}
                      onDragStart={(event) => startMoveDrag(event, item)}
                      onDragEnd={() => {
                        setDraggedItem(null);
                        setDragTarget(null);
                      }}
                      onDragOver={
                        item.kind === "folder" && !isLibrary
                          ? (event) => allowDrop(event, itemPath)
                          : undefined
                      }
                      onDragLeave={
                        item.kind === "folder"
                          ? () =>
                              setDragTarget((current) =>
                                current === itemPath ? null : current,
                              )
                          : undefined
                      }
                      onDrop={
                        item.kind === "folder" && !isLibrary
                          ? (event) => void moveToFolder(event, itemPath)
                          : undefined
                      }
                      className={`media-card ${isLibrary ? "library-card" : ""} ${item.kind === "folder" ? "folder-card" : ""} ${isTitle ? "catalog-title-card" : ""} ${dragTarget === itemPath ? "drag-target" : ""} ${selectedIds.includes(item.id) ? "selected" : ""}${audioNowPlaying ? " now-playing" : ""}${audioNowPlaying && miniplayerPlaying ? " is-playing" : ""}`}
                      aria-current={audioNowPlaying ? "true" : undefined}
                      data-image-batch-id={imageBatchId}
                      data-image-batch-path={imageBatchId ? item.path : undefined}
                      data-image-batch-kind={imageBatchId ? item.kind : undefined}
                      key={item.id}
                      onContextMenu={(event) =>
                        openItemContextMenu(event, item)
                      }
                    >
                      <a href={getItemUrl()} aria-label={[displayName, cardPlaybackLabel].filter(Boolean).join(", ")} onClick={(event) => {
                        // Video files have a complete native destination. Keep
                        // that fallback intact if React is busy or unavailable.
                        if (item.kind === "folder" || isTitle) event.preventDefault();
                      }} style={{ display: 'contents' }}>
                        <div
                          className={`thumb ${item.tone} ${isTitle ? "catalog-poster" : ""} ${cardAspectRatio && !isTitle ? "native-video-ratio" : ""}`}
                          style={
                            cardAspectRatio && !isTitle
                              ? { aspectRatio: cardAspectRatio }
                              : undefined
                          }
                          onClick={openCard}
                        >
                        {isTitle ? (
                          <CatalogArtwork
                            src={coverImage}
                            name={displayName}
                            initial={displayName.slice(0, 1)}
                            metadataPending={metadataPending}
                          />
                        ) : item.kind === "folder" ? (
                          coverImage ? (
                            <CachedArtworkImage
                              key={coverImage}
                              className={metadata?.poster ? "catalog-poster-image" : "thumb-video folder-cover"}
                              src={coverImage}
                              alt={`${displayName} folder cover`}
                              loading="lazy"
                            />
                          ) : coverVideo ? (
                            <VideoPreviewThumb
                              src={coverVideo.src!}
                              className="thumb-video folder-cover"
                              videoPath={coverVideo.path}
                            />
                          ) : (
                            <div className="folder-shape">
                              <span>
                                {titleCollection?.label ?? item.name.slice(0, 1)}
                              </span>
                            </div>
                          )
                        ) : item.kind === "audio" ? (
                          <>
                            <div className={`wave${audioNowPlaying && miniplayerPlaying ? " playing" : ""}`} style={{ gap: "3px" }}>
                              {audioWaveformFor(item.name).map((h, i) => (
                                <i
                                  key={i}
                                  style={{ height: `${h}px`, width: "3px", animationDelay: audioNowPlaying && miniplayerPlaying ? `${(i % 7) * 0.08}s` : undefined }}
                                />
                              ))}
                            </div>
                            {audioNowPlaying ? <span className="now-playing-badge">{miniplayerPlaying ? "Playing" : "Paused"}</span> : null}
                          </>
                        ) : (
                          <>
                            {metadata?.poster ? (
                              <CachedArtworkImage
                                className="catalog-poster-image"
                                src={metadata.poster}
                                alt={`${metadata.name} poster`}
                                loading="lazy"
                              />
                            ) : item.kind === "video" && item.src && (
                              <EpisodeVideoPreview
                                item={item}
                                episode={episodeMetadata}
                                onPreviewResult={onBatchPreviewResult}
                                onRatio={(ratio) =>
                                  rememberVideoRatio(item, ratio)
                                }
                                onDuration={(duration) =>
                                  rememberMediaDuration(item, duration)
                                }
                              />
                            )}{" "}
                            {item.kind === "image" && item.src && (
                              <ViewportImageThumb
                                src={item.thumbSrc ?? item.src}
                                path={item.path}
                                onRatio={(ratio) => rememberVideoRatio(item, ratio)}
                              />
                            )}
                            {item.kind !== "image" && (
                              <span className="scene-label" aria-hidden="true">
                                {item.kind === "video" ? "▶" : item.kind === "file" ? "FILE" : "◉"}
                              </span>
                            )}
                          </>
                        )}
                        {item.kind === "folder" && !isLibrary && (
                          <span className={`folder-badge ${isTitle && evidence ? "catalog-kind-badge" : ""}`}>
                            {isTitle && evidence && (evidence.kind === "movie" || evidence.kind === "series")
                              ? <CatalogBadgeIcon kind={evidence.kind} />
                              : <i className={`badge-icon ${isTitle && evidence ? evidence.kind : "folder"}`} aria-hidden="true" />}
                            {isLibrary
                              ? "Library"
                              : (titleKindLabel ??
                                (titleCollection?.kind === "soundtrack" ? "Soundtrack" : titleCollection?.kind === "extras" ? "Extras" : titleCollection ? "Season" : "Folder"))}
                          </span>
                        )}
                        {item.kind !== "folder" && isTitle && evidence && (
                          <span className="folder-badge catalog-kind-badge">
                            {evidence.kind === "movie" || evidence.kind === "series"
                              ? <CatalogBadgeIcon kind={evidence.kind} />
                              : null}
                            {titleKindLabel}
                          </span>
                        )}
                        {isTitle && metadata && evidence && !item.trashed && (
                          <button
                            className="catalog-play"
                            aria-label={`Play ${metadata.name}`}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              if (item.kind === "folder") playCatalogTitle(titleCardPath, evidence.kind);
                              else openItem(item);
                            }}
                          >
                            <span aria-hidden="true">▶</span>
                          </button>
                        )}
                        {youtubeTrailerId && (
                          <button
                            className="catalog-trailer"
                            aria-label={`Watch ${displayName} trailer`}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              setTrailer({ title: displayName, youtubeId: youtubeTrailerId });
                            }}
                          >
                            Trailer
                          </button>
                        )}
                        {!isLibrary && canSelectItem(item) && (
                          <button
                            type="button"
                            className={`card-select ${selectedIds.includes(item.id) ? "on" : ""}`}
                            aria-label={`Select ${displayName}`}
                            aria-pressed={selectedIds.includes(item.id)}
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              if (!selectionMode) enterSelectionMode(item);
                              else toggleItemSelection(item);
                            }}
                          />
                        )}
                        {!isLibrary && (
                          <button
                            className={`star ${item.favorite ? "on" : ""}`}
                            aria-label={`${item.favorite ? "Remove" : "Add"} ${displayName} ${item.favorite ? "from" : "to"} favorites`}
                            aria-pressed={Boolean(item.favorite)}
                            title={
                              item.favorite ? "Favorited" : "Add to favorites"
                            }
                            onClick={(event) => {
                              event.preventDefault();
                              event.stopPropagation();
                              void toggleFavorite(item);
                            }}
                          >
                            <span aria-hidden="true">{item.favorite ? "★" : "☆"}</span>
                          </button>
                        )}
                        {episodeNumbersForItem && episodePlayback && <>
                          {episodeProgress > 0 && <progress className="episode-progress" aria-label={`${displayName}, ${Math.round(episodeProgress)} percent watched`} aria-valuetext={`${Math.round(episodeProgress)} percent watched`} value={Math.round(episodeProgress)} max={100} />}
                          {episodePlayback.completed && <span className="episode-watched"><span aria-hidden="true">✓</span> Watched</span>}
                        </>}
                        {item.offline?.status === "downloading" && (
                          <span className="offline-card-status">
                            <strong>Downloading {item.offline.percent ?? 0}%</strong>
                            <small title={item.offline.currentFileName}>{item.offline.currentFileName ? `Now: ${item.offline.currentFileName}` : "Preparing download…"}</small>
                            <small>Current file: {formatBytes(item.offline.currentFileDownloadedBytes ?? 0)} / {formatBytes(item.offline.currentFileTotalBytes ?? 0)}</small>
                            <small>{formatBytes(item.offline.completedBytes ?? 0)} / {formatBytes(item.offline.totalBytes ?? 0)} · {formatUploadRate(item.offline.downloadSpeedBytes ?? 0)}</small>
                            <small>{item.offline.completedFiles ?? 0}/{item.offline.totalFiles ?? item.itemCount ?? 0} files complete · {magnetEtaLabel(item.offline.etaSeconds ?? 0)}</small>
                          </span>
                        )}
                        {item.offline?.status === "error" && (
                          <span className="offline-card-status error">Needs attention</span>
                        )}
                        </div>
                      </a>
                      <div className="card-details">
                        <div>
                          <a className="card-label-link" href={getItemUrl()} onClick={openCard} aria-label={[displayName, cardPlaybackLabel].filter(Boolean).join(", ")}>
                          <strong className={displayName.length > 110 ? "media-title-very-long" : displayName.length > 70 ? "media-title-long" : undefined} title={displayName}>{mediaTitleContent(displayName)}</strong>{activeSearch.trim() && item.kind === "folder" && <span>{folderItemCount} {evidence?.kind === "series" ? "season" : "item"}{folderItemCount === 1 ? "" : "s"}{item.favorite ? " · ★ Favorite" : ""}{displayTags.length ? ` · ${displayTags.join(" · ")}` : ""}</span>}
                          {metadataPending ? (
                            <span className="catalog-details-loading">Loading details…</span>
                          ) : metadata ? (
                            <span>{[metadata.type === "movie" ? "Movie" : "Series"].filter(Boolean).join(" · ")}</span>
                          ) : (
                            <span>
                              {(isLibrary
                                ? `${libraryTypeLabel(libraries[item.name]?.content_type ?? "mixed")} · ${folderItemCount} item${folderItemCount === 1 ? "" : "s"}`
                                : titleCollection
                                  ? `${titleCollection.itemCount} ${titleCollection.kind === "soundtrack" ? `track${titleCollection.itemCount === 1 ? "" : "s"}` : `${titleCollection.kind === "season" ? "episode" : "video"}${titleCollection.itemCount === 1 ? "" : "s"}`}`
                                  : item.kind === "folder"
                                    ? `${titleKindLabel ?? "Folder"} · ${folderItemCount} item${folderItemCount === 1 ? "" : "s"}`
                                    : [item.kind === "video" ? "" : item.kind === "audio" ? "Audio" : item.kind === "image" ? "Image" : "File", formatListDuration(item.duration), item.kind === "video" || item.kind === "audio" ? "" : item.size].filter(Boolean).join(" · ")).replace(/(\d) (?=[A-Za-z])/g, "$1\u00a0")}
                            </span>
                          )}
                          </a>
                        </div>
                        <div className={metadata?.id.startsWith("tt") ? "catalog-card-actions" : "card-actions"}>
                          {metadata?.id.startsWith("tt") && (
                            <a
                              className="imdb-link"
                              href={`https://www.imdb.com/title/${metadata.id}/`}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(event) => event.stopPropagation()}
                            >
                              IMDb ↗
                            </a>
                          )}
                          {isTitle && metadata && evidence && !item.trashed && (
                            <button
                              type="button"
                              className="card-inline-action card-inline-play"
                              aria-label={`Play ${metadata.name}`}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                if (item.kind === "folder") playCatalogTitle(titleCardPath, evidence.kind);
                                else openItem(item);
                              }}
                            >
                              <svg width="12" height="12" viewBox="0 0 12 12" style={{ width: 12, height: 12, flex: "0 0 12px" }} aria-hidden="true"><path d="M2 1l9 5-9 5z" fill="currentColor" /></svg>Play
                            </button>
                          )}
                          {youtubeTrailerId && (
                            <button
                              type="button"
                              className="card-inline-action"
                              aria-label={`Watch ${displayName} trailer`}
                              onClick={(event) => {
                                event.preventDefault();
                                event.stopPropagation();
                                setTrailer({ title: displayName, youtubeId: youtubeTrailerId });
                              }}
                            >
                              Trailer
                            </button>
                          )}
                          <button
                            type="button"
                            aria-label={`More actions for ${displayName}`}
                            aria-expanded={contextItem?.item.id === item.id}
                            onClick={(event) => toggleItemContextMenu(event, item)}
                          >
                            •••
                          </button>
                        </div>
                      </div>
                      {!metadata && (
                        <div className="card-meta">
                          <span>{section === "recent" ? item.lastPlayed : item.updated}</span>
                          <div>
                            {displayTags.map((itemTag) => (
                              <em key={itemTag}>{itemTag}</em>
                            ))}
                          </div>
                        </div>
                      )}
                      {item.trashed && (
                        <div className="trash-card-actions">
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              void restoreTrashItem(item);
                            }}
                          >
                            Restore
                          </button>
                          <button
                            type="button"
                            className="danger"
                            onClick={(event) => {
                              event.stopPropagation();
                              setPermanentDeleteTarget(item);
                            }}
                          >
                            Delete permanently
                          </button>
                        </div>
                      )}
                    </article>
                  );
                })}
              </div>
              {serverPageLoading && (
                <div className="library-page-loading" role="status">
                  <i className="library-loading-spinner" aria-hidden="true" />
                  Loading more…
                </div>
              )}
              {hasMoreVisible && (
                <div className="library-load-more library-load-more-bottom" aria-live="polite">
                  {serverPageLoading && <><span className="library-load-more-spinner" aria-hidden="true" /><strong>Loading more…</strong></>}
                  <b>
                    Showing {renderedVisible.length} of {visibleTotalCount}
                  </b>
                  <small>More items load as you scroll</small>
                  <button type="button" onClick={() => handleLoadMore()} disabled={serverPageLoading}>Load more</button>
                  <button type="button" onClick={() => handleLoadMore(true)} disabled={serverPageLoading}>Load all</button>
                </div>
              )}
            </>
          ) : section === "offline" ? (
            <div className="empty-state">
              <span aria-hidden="true"><MenuIcon name="download" /></span>
              <h2>{query.trim() || activeTags.length ? "No matches found" : currentFolder ? "This folder is empty" : "No offline downloads yet"}</h2>
              <p>{query.trim() || activeTags.length ? "Try a different search or clear the active filters." : "Open a media menu and choose Save offline on this device."}</p><button type="button" onClick={() => setSection("library")}>Browse library</button>
            </div>
          ) : backendState === "loading" || isFetchingNewFolder ? (
            <div className="media-grid">
              {Array.from({ length: 8 }).map((_, i) => (
                <article key={i} className="media-card skeleton">
                  <div className="thumb skeleton-pulse"></div>
                  <div className="card-details">
                    <div>
                      <strong className="skeleton-pulse"></strong>
                      <span className="skeleton-pulse"></span>
                    </div>
                  </div>
                  <div className="card-meta">
                    <span className="skeleton-pulse"></span>
                  </div>
                </article>
              ))}
            </div>
          ) : isRestoringMemoryCache ? (
            <div className="media-grid" style={{ opacity: 0 }} />
          ) : (
            <div className="empty-state">
              <span
                className={
                  backendState === "loading"
                    ? "library-loading-spinner large"
                    : ""
                }
              >
                {backendState === "loading" ? null : <MenuIcon name={section === "trash" ? "trash" : section === "favorites" ? "star" : section === "recent" ? "history" : section === "new" ? "plus" : section === "playlists" ? "list" : "folder"} />}
              </span>
              <h2>
                {backendState === "loading" || backendState === "cached"
                  ? "Loading your library"
                  : backendState === "offline" && section !== "playlists"
                    ? "Server unavailable"
                    : activeSearch.trim() || query.trim() || activeTags.length > 0
                      ? "No matches found"
                      : section === "favorites"
                        ? "No favorites yet"
                      : section === "recent"
                        ? "Nothing played yet"
                        : section === "new"
                          ? "Nothing new in the last 24 hours"
                        : section === "playlists"
                            ? activePlaylistId
                              ? "This playlist is empty"
                              : "No playlists yet"
                            : section === "trash"
                              ? "Trash is empty"
                              : currentFolder
                                ? "This folder is empty"
                                : "No libraries yet"}
              </h2>
              <p>
                {playlistsOffline
                  ? "Only downloaded items appear in playlists while the server is offline."
                  : backendState === "offline"
                  ? backendError
                  : backendState === "loading"
                    ? "Reading your media…"
                    : activeSearch.trim() || query.trim() || activeTags.length > 0
                      ? "Try a different search or clear the active filters."
                      : section === "favorites"
                        ? "Use the star on any item to keep it close."
                        : section === "recent"
                          ? "Media you play will appear here."
                          : section === "new"
                            ? "Items added to your libraries in the last day will appear here."
                          : section === "playlists"
                            ? activePlaylistId
                              ? "Use Tags & playlists from any media card to add something here."
                              : "Create a playlist, then add media from its action menu."
                            : section === "trash"
                              ? "Deleted files will stay here until you remove them permanently."
                              : currentFolder
                                ? "Add a file or create a folder to get started."
                                : "Create your first library to start organizing media."}
              </p>
              {(backendState === "online" || backendState === "cached" || playlistsOffline) &&
                (activeSearch.trim() || query.trim() || activeTags.length > 0) && (
                  <button
                    onClick={() => {
                      clearSearch();
                      setActiveTags([]);
                    }}
                  >
                    Clear filters
                  </button>
                )}
              {(backendState === "online" || playlistsOffline) &&
                section === "playlists" &&
                !activePlaylistId && (
                  <button
                    onClick={() => {
                      setPlaylistError("");
                      setPlaylistDraft("");
                    }}
                  >
                    Create playlist
                  </button>
                )}
              {backendState === "online" &&
                section === "library" &&
                !currentFolder &&
                canManageLibraries && (
                  <button onClick={startLibraryCreation}>Create library</button>
                )}
              {backendState === "online" &&
                section === "library" &&
                currentFolder &&
                canUploadToPath(currentFolder) && (
                  <button onClick={() => startUpload(currentFolder)}>
                    Upload media
                  </button>
                )}
            </div>
          )}
        </div>
      </section>

      {renderItemContextMenu()}
      {sidebarContext && (
        <div
          className="folder-context-menu sidebar-context-menu"
          style={{ left: sidebarContext.x, top: sidebarContext.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          {sidebarContext.kind === "playlists" || sidebarContext.kind === "tags" ? (
            <>
              <div><b>{sidebarContext.kind === "playlists" ? "Playlists" : "Tags"}</b><small>Create a new personal collection</small></div>
              <button onClick={() => {
                setSidebarContext(null);
                if (sidebarContext.kind === "playlists") { setPlaylistError(""); setPlaylistDraft(""); }
                else { setTagError(""); setTagDraft(""); }
              }}><span>＋</span>Create {sidebarContext.kind === "playlists" ? "playlist" : "tag"}</button>
            </>
          ) : sidebarContext.kind === "playlist" ? (
            <>
              <div><b>{sidebarContext.playlist.name}</b><small>{sidebarContext.playlist.paths.length} item{sidebarContext.playlist.paths.length === 1 ? "" : "s"}</small></div>
              <button onClick={() => {
                setSection("playlists");
                setActivePlaylistId(sidebarContext.playlist.id);
                setCurrentFolder(null);
                clearSearch();
                setSidebarContext(null);
              }}><span>≡</span>Open playlist</button>
              <button className="danger" onClick={() => {
                const playlist = sidebarContext.playlist;
                setSidebarContext(null);
                setDeletePlaylistTarget(playlist);
              }}><span>×</span>Delete playlist</button>
            </>
          ) : sidebarContext.kind === "tag" ? (
            <>
              <div><b>#{sidebarContext.tagName}</b><small>Personal tag</small></div>
              <button onClick={() => {
                setSection("library");
                setActiveTags([sidebarContext.tagName]);
                setCurrentFolder(null);
                setQuery("");
                setSidebarContext(null);
              }}><span>#</span>Show tagged items</button>
              <button className="danger" onClick={() => {
                const tagName = sidebarContext.tagName;
                setSidebarContext(null);
                setDeleteTagTarget(tagName);
              }}><span>×</span>Delete tag</button>
            </>
          ) : null}
        </div>
      )}
      {libraryContext && (
        <div
          className="folder-context-menu"
          style={{ left: libraryContext.x, top: libraryContext.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div>
            <b>{libraryContext.path.split("/").at(-1)}</b>
            <small>{libraryContext.path}</small>
          </div>
          <button onClick={() => startOrganizing(apiEntryToMediaItem({
            path: libraryContext.path,
            name: libraryContext.path.split("/").at(-1) ?? libraryContext.path,
            kind: "folder",
            size: 0,
            created_at: 0,
          })!)}>
            <MenuIcon name="tag" />{libraryContext.path.includes("/") ? "Folder tags" : "Library tags"}
          </button>
          {canCreateFolderAtPath(libraryContext.path) && (
            <button onClick={() => startFolderCreation(libraryContext.path)}>
              <MenuIcon name="plus" />New folder
            </button>
          )}
          {canUploadToPath(libraryContext.path) && (
            <button onClick={() => startUpload(libraryContext.path)}>
              <MenuIcon name="upload" />Upload media
            </button>
          )}
          {canDownloadToPath(libraryContext.path) && (
            <button onClick={() => startServerDownload(libraryContext.path)}>
              <MenuIcon name="download" />Download from URL
            </button>
          )}
          {!libraryContext.path.includes("/") && canManageLibraries && !libraries[libraryContext.path]?.folder_structure_static && (
            <button
              className="danger"
              onClick={() => {
                setLibraryContext(null);
                setDeleteLibraryTarget(libraryContext.path);
              }}
            >
              <span>×</span>Delete library
            </button>
          )}
        </div>
      )}
      {librariesContext && (
        <div
          className="folder-context-menu"
          style={{ left: librariesContext.x, top: librariesContext.y }}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.preventDefault()}
        >
          <div>
            <b>Libraries</b>
            <small>Top-level folders on this server</small>
          </div>
          {canManageLibraries ? (
            <button onClick={startLibraryCreation}>
              <span>＋</span>Create library
            </button>
          ) : (
            <small className="context-permission-note">
              You do not have permission to create libraries.
            </small>
          )}
        </div>
      )}
      {folderDraft && (
        <div
          className="folder-create-backdrop profile-settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !creatingFolder)
              setFolderDraft(null);
          }}
        >
          <form className="folder-create-modal" onSubmit={createFolder}>
            <div>
              <p>NEW FOLDER</p>
              <h2>Create folder</h2>
              <small>Inside {folderDraft.parentPath}</small>
            </div>
            <label>
              Folder name
              <input
                value={folderDraft.name}
                onChange={(event) => {
                  setFolderDraft((current) =>
                    current
                      ? { ...current, name: event.target.value }
                      : current,
                  );
                  setFolderCreateError("");
                }}
                autoFocus
                placeholder="e.g. Vacation photos"
              />
            </label>
            {folderCreateError && (
              <p className="folder-create-error" role="alert">
                {folderCreateError}
              </p>
            )}
            <div className="folder-create-actions">
              <button
                type="button"
                onClick={() => setFolderDraft(null)}
                disabled={creatingFolder}
              >
                Cancel
              </button>
              <button type="submit" disabled={creatingFolder}>
                {creatingFolder ? "Creating…" : "Create folder"}
              </button>
            </div>
          </form>
        </div>
      )}
      {renameTarget && (
        <div
          className="folder-create-backdrop profile-settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !renaming)
              setRenameTarget(null);
          }}
        >
          <form className="folder-create-modal" onSubmit={renameMedia}>
            <div>
              <p>RENAME {renameTarget.kind.toUpperCase()}</p>
              <h2>Rename {renameTarget.kind === "folder" ? renameTarget.name : fileNameStem(renameTarget.name)}</h2>
              <small>{renameTarget.parent ?? "My library"}</small>
            </div>
            <label>
              New name
              <input
                value={renameName}
                onChange={(event) => {
                  setRenameName(event.target.value);
                  setRenameError("");
                }}
                autoFocus
                maxLength={renameTarget.kind === "folder" ? 255 : 255 - fileNameExtension(renameTarget.name).length}
              />
            </label>
            {renameError && (
              <p className="folder-create-error" role="alert">
                {renameError}
              </p>
            )}
            <div className="folder-create-actions">
              <button
                type="button"
                onClick={() => setRenameTarget(null)}
                disabled={renaming}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={
                  !renameName.trim() ||
                  (renameTarget.kind === "folder" ? renameName.trim() : `${renameName.trim()}${fileNameExtension(renameTarget.name)}`) === renameTarget.name ||
                  renaming
                }
              >
                {renaming ? "Renaming…" : "Rename"}
              </button>
            </div>
          </form>
        </div>
      )}
      {libraryDraft && (
        <div
          className="folder-create-backdrop profile-settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !creatingLibrary)
              setLibraryDraft(null);
          }}
        >
          <form className="folder-create-modal" onSubmit={createLibrary}>
            <div>
              <p>NEW LIBRARY</p>
              <h2>Create library</h2>
              <small>
                This creates a matching top-level folder on the server.
              </small>
            </div>
            <label>
              Library name
              <input
                value={libraryDraft.name}
                onChange={(event) => {
                  setLibraryDraft((current) =>
                    current
                      ? { ...current, name: event.target.value }
                      : current,
                  );
                  setLibraryCreateError("");
                }}
                autoFocus
                placeholder="e.g. Family videos"
              />
            </label>
            <label>
              Library type
              <select
                value={libraryDraft.contentType}
                onChange={(event) =>
                  setLibraryDraft((current) =>
                    current
                      ? {
                          ...current,
                          contentType: event.target.value as LibraryContentType,
                        }
                      : current,
                  )
                }
              >
                <option value="mixed">Mixed media</option>
                <option value="movies_tv">Movies & TV shows</option>
                <option value="music">Music</option>
                <option value="files">Any files</option>
              </select>
            </label>
            {libraryCreateError && (
              <p className="folder-create-error" role="alert">
                {libraryCreateError}
              </p>
            )}
            <div className="folder-create-actions">
              <button
                type="button"
                onClick={() => setLibraryDraft(null)}
                disabled={creatingLibrary}
              >
                Cancel
              </button>
              <button type="submit" disabled={creatingLibrary}>
                {creatingLibrary ? "Creating…" : "Create library"}
              </button>
            </div>
          </form>
        </div>
      )}
      {tagDraft !== null && (
        <div
          className="folder-create-backdrop profile-settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !savingTag) setTagDraft(null);
          }}
        >
          <form className="folder-create-modal" onSubmit={createTag}>
            <div>
              <p>NEW TAG</p>
              <h2>Create tag</h2>
              <small>Tags are private to your TMS account.</small>
            </div>
            <label>
              Tag name
              <input
                value={tagDraft}
                onChange={(event) => {
                  setTagDraft(event.target.value);
                  setTagError("");
                }}
                autoFocus
                maxLength={32}
                placeholder="e.g. Weekend"
              />
            </label>
            {tagError && (
              <p className="folder-create-error" role="alert">
                {tagError}
              </p>
            )}
            <div className="folder-create-actions">
              <button type="button" onClick={() => setTagDraft(null)} disabled={savingTag}>
                Cancel
              </button>
              <button type="submit" disabled={!tagDraft.trim() || savingTag}>
                {savingTag ? "Creating…" : "Create tag"}
              </button>
            </div>
          </form>
        </div>
      )}
      {playlistDraft !== null && (
        <div
          className="folder-create-backdrop profile-settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !savingPlaylist)
              setPlaylistDraft(null);
          }}
        >
          <form className="folder-create-modal" onSubmit={createPlaylist}>
            <div>
              <p>NEW PLAYLIST</p>
              <h2>Create playlist</h2>
              <small>Playlists are private to your TMS account.</small>
            </div>
            <label>
              Playlist name
              <input
                value={playlistDraft}
                onChange={(event) => {
                  setPlaylistDraft(event.target.value);
                  setPlaylistError("");
                }}
                autoFocus
                maxLength={80}
                placeholder="e.g. Weekend watchlist"
              />
            </label>
            {playlistError && (
              <p className="folder-create-error" role="alert">
                {playlistError}
              </p>
            )}
            <div className="folder-create-actions">
              <button
                type="button"
                onClick={() => setPlaylistDraft(null)}
                disabled={savingPlaylist}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!playlistDraft.trim() || savingPlaylist}
              >
                {savingPlaylist ? "Creating…" : "Create playlist"}
              </button>
            </div>
          </form>
        </div>
      )}
      {organizeTarget && (
        <div
          className="folder-create-backdrop profile-settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !savingOrganization)
              setOrganizeTarget(null);
          }}
        >
          <form
            className="folder-create-modal organize-media-modal"
            onSubmit={saveOrganization}
          >
            <div>
              <p>{organizeTarget.kind === "folder" ? (organizeTarget.path?.includes("/") ? "FOLDER TAGS" : "LIBRARY TAGS") : "ORGANIZE MEDIA"}</p>
              <h2>{organizeTarget.name}</h2>
              <small>
                {organizeTarget.kind === "folder"
                  ? "Everything inside this folder, including anything added later, inherits these tags."
                  : "Add searchable tags and choose the playlists that include this item."}
              </small>
            </div>
            <div className="organize-field">
              Tags
              <TagInput
                value={organizeTags}
                onChange={(v) => {
                  setOrganizeTags(v);
                  setOrganizeError("");
                }}
                allTags={allSystemTags}
                autoFocus
              />
              <small>
                Start typing to search existing tags, or press Enter to add a
                new one.
              </small>
              {ancestorTags(organizeTarget.path, customTags).length > 0 && (
                <small>
                  Inherited from parent folders: {ancestorTags(organizeTarget.path, customTags).join(", ")}
                </small>
              )}
            </div>
            {organizeTarget.kind !== "folder" && (
            <fieldset className="playlist-checklist">
              <legend>Playlists</legend>
              {Object.values(playlists).length ? (
                Object.values(playlists)
                  .sort((left, right) => left.name.localeCompare(right.name))
                  .map((playlist) => (
                    <label key={playlist.id}>
                      <input
                        type="checkbox"
                        checked={organizePlaylists.includes(playlist.id)}
                        onChange={(event) =>
                          setOrganizePlaylists((current) =>
                            event.target.checked
                              ? [...current, playlist.id]
                              : current.filter((id) => id !== playlist.id),
                          )
                        }
                      />
                      <span>{playlist.name}</span>
                      <small>
                        {playlist.paths.length} item
                        {playlist.paths.length === 1 ? "" : "s"}
                      </small>
                    </label>
                  ))
              ) : (
                <small>
                  No playlists yet. You can still save tags, then create a
                  playlist from the sidebar.
                </small>
              )}
              <div className="inline-playlist-create">
                <input
                  type="text"
                  value={inlinePlaylistName}
                  onChange={(e) => {
                    setInlinePlaylistName(e.target.value);
                    setOrganizeError("");
                  }}
                  placeholder="Create a new playlist…"
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      createPlaylistInline(inlinePlaylistName);
                      setInlinePlaylistName("");
                    }
                  }}
                />
                <button
                  type="button"
                  disabled={!inlinePlaylistName.trim() || savingPlaylist}
                  onClick={() => {
                    createPlaylistInline(inlinePlaylistName);
                    setInlinePlaylistName("");
                  }}
                >
                  ＋
                </button>
              </div>
            </fieldset>
            )}
            {organizeError && (
              <p className="folder-create-error" role="alert">
                {organizeError}
              </p>
            )}
            <div className="folder-create-actions">
              <button
                type="button"
                onClick={() => setOrganizeTarget(null)}
                disabled={savingOrganization}
              >
                Cancel
              </button>
              <button type="submit" disabled={savingOrganization}>
                {savingOrganization ? "Saving…" : "Save changes"}
              </button>
            </div>
          </form>
        </div>
      )}
      {bulkOrganizeOpen && (
        <div
          className="folder-create-backdrop profile-settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget)
              setBulkOrganizeOpen(false);
          }}
        >
          <form
            className="folder-create-modal organize-media-modal bulk-organize-modal"
            onSubmit={saveBulkOrganization}
          >
            <div>
              <p>ORGANIZE SELECTION</p>
              <h2>
                {bulkTagTargetPaths.length} item
                {bulkTagTargetPaths.length === 1 ? "" : "s"}
              </h2>
              <small>
                Add tags and playlists to selected items. Existing tags and playlist
                membership are kept.
              </small>
            </div>
            {selectedTaggableFolderPaths.length > 0 && (
              <p className="bulk-organize-note" role="status">
                {selectedTaggableFolderPaths.length} folder{selectedTaggableFolderPaths.length === 1 ? "" : "s"} will be tagged. Everything inside, including anything added later, inherits these tags. Playlists only apply to directly selected files.
              </p>
            )}
            <div className="organize-field">
              Tags to add
              <TagInput
                value={bulkOrganizeTags}
                onChange={(value) => {
                  setBulkOrganizeTags(value);
                  setBulkOrganizeError("");
                }}
                allTags={allSystemTags}
                autoFocus
              />
              <small>
                These tags are added to each selected item alongside any tags it already has.
              </small>
            </div>
            <fieldset className="playlist-checklist">
              <legend>Add to playlists</legend>
              {selectedOrganizableItems.length === 0 ? (
                <small>Select files directly to add them to playlists. Folders are tags only.</small>
              ) : Object.values(playlists).length ? (
                Object.values(playlists)
                  .sort((left, right) => left.name.localeCompare(right.name))
                  .map((playlist) => (
                    <label key={playlist.id}>
                      <input
                        type="checkbox"
                        checked={bulkOrganizePlaylists.includes(playlist.id)}
                        onChange={(event) =>
                          setBulkOrganizePlaylists((current) =>
                            event.target.checked
                              ? [...current, playlist.id]
                              : current.filter((id) => id !== playlist.id),
                          )
                        }
                      />
                      <span>{playlist.name}</span>
                      <small>
                        {playlist.paths.length} item
                        {playlist.paths.length === 1 ? "" : "s"}
                      </small>
                    </label>
                  ))
              ) : (
                <small>No playlists yet. Create one below, then add your selection.</small>
              )}
              {selectedOrganizableItems.length > 0 && (
              <div className="inline-playlist-create">
                <input
                  type="text"
                  value={inlinePlaylistName}
                  onChange={(event) => {
                    setInlinePlaylistName(event.target.value);
                    setBulkOrganizeError("");
                  }}
                  placeholder="Create a new playlist…"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void createPlaylistInline(inlinePlaylistName);
                      setInlinePlaylistName("");
                    }
                  }}
                />
                <button
                  type="button"
                  disabled={!inlinePlaylistName.trim() || savingPlaylist}
                  onClick={() => {
                    void createPlaylistInline(inlinePlaylistName);
                    setInlinePlaylistName("");
                  }}
                >
                  ＋
                </button>
              </div>
              )}
            </fieldset>
            {bulkOrganizeError && (
              <p className="folder-create-error" role="alert">
                {bulkOrganizeError}
              </p>
            )}
            <div className="folder-create-actions">
              <button
                type="button"
                onClick={() => setBulkOrganizeOpen(false)}
              >
                Cancel
              </button>
              <button type="submit">
                Apply to selection
              </button>
            </div>
          </form>
        </div>
      )}
      {uploadTarget && (
        <div
          className="folder-create-backdrop profile-settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget)
              closeUpload();
          }}
        >
          <section className="folder-create-modal magnet-download-modal upload-queue-modal" role="dialog" aria-modal="true" aria-labelledby="upload-title">
            <header className="magnet-modal-header">
              <span className="magnet-lock-mark ready" aria-hidden="true">↑</span>
              <div>
                <p>MEDIA UPLOAD</p>
                <h2 id="upload-title">{uploadingFiles ? activeUploadCount > 1 ? `${activeUploadCount} files uploading` : activeUpload?.name || "Uploading media" : uploadQueue.length ? `${uploadQueue.length} item${uploadQueue.length === 1 ? "" : "s"} ready` : "Choose media"}</h2>
                <small><span aria-hidden="true">⌂</span>Upload to {uploadTarget}. Recognized TV episodes are grouped into their show and season folders automatically.</small>
              </div>
              <button type="button" className="magnet-close" onClick={closeUpload} aria-label="Minimize uploader">×</button>
            </header>

            <div className="magnet-stepper" aria-label="Upload steps">
              <span className={uploadQueue.length ? "done" : "active"}><i>{uploadQueue.length ? "✓" : "1"}</i>Select</span>
              <b />
              <span className={uploadingFiles ? "active" : completedUploadCount ? "done" : ""}><i>{completedUploadCount ? "✓" : "2"}</i>Upload</span>
              <b />
              <span className={uploadQueue.length > 0 && completedUploadCount === uploadQueue.length ? "done" : uploadingFiles ? "active" : ""}><i>{uploadQueue.length > 0 && completedUploadCount === uploadQueue.length ? "✓" : "3"}</i>Organize</span>
            </div>

            <section className="upload-modal-body">
            {uploadingFiles && (
              <div className="magnet-progress-view upload-progress-view" aria-live="polite">
                <div className="magnet-progress-hero">
                  <div
                    className="magnet-progress-ring"
                    style={{ "--magnet-progress": `${uploadProgress * 360}deg` } as CSSProperties}
                  >
                    <span><strong>{Math.round(uploadProgress * 100)}%</strong><small>UPLOADED</small></span>
                  </div>
                  <div>
                    <em>Uploading locally</em>
                    <h3>{activeUpload?.name || "Finishing uploads"}</h3>
                    <p>Your media is being copied into TMS. Interrupted transfers resume where they stopped. Recognized Movies & TV episodes are organized into show and season folders immediately.</p>
                  </div>
                </div>
                <div className="magnet-progress-track" aria-label={`${Math.round(uploadProgress * 100)}% uploaded`}>
                  <i style={{ width: `${uploadProgress * 100}%` }} />
                </div>
                <div className="magnet-transfer-line">
                  <span>{formatUploadSize(uploadedBytes)} of {formatUploadSize(totalUploadBytes)}</span>
                  <span>{completedUploadCount} of {uploadQueue.length} complete</span>
                </div>
                <div className="magnet-stat-grid upload-stat-grid">
                  <article><span>↑</span><div><small>UPLOAD SPEED</small><strong>{formatUploadRate(totalUploadSpeed)}</strong></div></article>
                  <article><span>▣</span><div><small>CURRENT FILE</small><strong>{formatUploadSize(activeUpload?.size ?? 0)}</strong></div></article>
                  <article><span>✓</span><div><small>QUEUE</small><strong>{completedUploadCount} / {uploadQueue.length}</strong></div></article>
                </div>
              </div>
            )}
            {interruptedUploadCount > 0 && (
              <p className="upload-resume-note">
                <b>{interruptedUploadCount} interrupted upload{interruptedUploadCount === 1 ? "" : "s"}</b>
                The server kept what was already sent. Choose or drop the same files again to continue where they stopped.
              </p>
            )}
            {!uploadingFiles && pendingUploadCount > 0 && (
              <section className="magnet-readiness ready upload-readiness">
                <div className="magnet-readiness-heading">
                  <span>✓</span>
                  <div>
                    <b>Ready to upload</b>
                    <small>New files join this queue while uploads are already running.</small>
                  </div>
                </div>
                <div className="magnet-check-grid">
                  <div className="ready"><i>✓</i><span><b>Destination</b><small>{uploadTarget}</small></span></div>
                  <div className="ready"><i>✓</i><span><b>{uploadQueue.length} selected</b><small>Files and folders are preserved</small></span></div>
                  <div className="ready"><i>✓</i><span><b>Library workflow</b><small>Recognized TV episodes group into show and season folders</small></span></div>
                </div>
              </section>
            )}
            {uploadQueue.length ? (
              <div className="upload-queue-list">
                {uploadQueue.map((item) => (
                  <div
                    className={`upload-queue-row ${item.status}`}
                    key={item.id}
                  >
                    <span aria-hidden="true">
                      {item.status === "complete"
                        ? "✓"
                        : item.status === "error" || item.status === "needs-file"
                          ? "!"
                          : item.status === "uploading"
                            ? "↑"
                            : item.status === "paused"
                              ? "❚❚"
                              : "·"}
                    </span>
                    <div>
                      <b>{item.name}</b>
                      <small>
                        {item.relativePath !== item.name ? `${item.relativePath} · ` : ""}{formatUploadSize(item.size)} ·{" "}
                        {item.status === "uploading"
                          ? `${item.progress}% uploaded · ${formatUploadRate(item.speed)}`
                          : item.status === "complete"
                            ? "Uploaded"
                            : item.status === "paused"
                              ? `Paused at ${item.progress}%`
                              : item.status === "needs-file"
                                ? `Interrupted at ${item.progress}% · add this file again to resume`
                                : item.status === "error"
                                  ? (item.error ?? "Upload failed.")
                                  : item.uploadedBytes > 0 ? `Waiting · resumes at ${item.progress}%` : "Ready"}
                      </small>
                      {(item.status === "uploading" || ((item.status === "paused" || item.status === "needs-file" || item.status === "error") && item.uploadedBytes > 0)) && (
                        <progress
                          aria-label={`${item.name} upload progress`}
                          max="100"
                          value={item.progress}
                        />
                      )}
                    </div>
                    <div className="upload-row-actions">
                      {(item.status === "uploading" || item.status === "pending") && (
                        <button type="button" aria-label={`Pause ${item.name}`} title="Pause" onClick={() => pauseUploadItem(item.id)}>❚❚</button>
                      )}
                      {item.status === "paused" && (
                        <button type="button" aria-label={`Resume ${item.name}`} title="Resume" onClick={() => resumeUploadItem(item.id)}>▶</button>
                      )}
                      {item.status === "error" && item.file && (
                        <button type="button" className="upload-retry" aria-label={`Retry ${item.name}`} title="Retry" onClick={() => resumeUploadItem(item.id)}>↻ Retry</button>
                      )}
                      {item.status !== "complete" && (
                        <button type="button" aria-label={`Remove ${item.name}`} title="Remove" onClick={() => removeUploadItem(item.id)}>×</button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <button
                className="upload-empty-picker"
                type="button"
                onClick={() => setUploadPickerOpen((current) => !current)}
              >
                <span>↑</span>
                <b>Select media</b>
                <small>Choose files or a folder from Explorer, or drag files and folders anywhere onto this page.</small>
              </button>
            )}
            {uploadPickerOpen && (
              <div className="upload-picker-menu" role="menu" aria-label="Choose media to upload">
                <button type="button" role="menuitem" onClick={() => { setUploadPickerOpen(false); uploadInput.current?.click(); }}>
                  <span>↑</span><div><b>Choose files</b><small>Select one or more media files.</small></div>
                </button>
                <button type="button" role="menuitem" onClick={() => { setUploadPickerOpen(false); uploadFolderInput.current?.click(); }}>
                  <span>▣</span><div><b>Choose folder</b><small>Keep its folders and subfolders exactly as selected.</small></div>
                </button>
              </div>
            )}
            <div className="upload-summary">
              <span>
                {
                  uploadQueue.filter((item) => item.status === "complete")
                    .length
                }{" "}
                complete
              </span>
              <span>
                {pendingUploadCount}{" "}
                ready
              </span>
              {pausedUploadCount > 0 && <span>{pausedUploadCount} paused</span>}
              {failedUploadCount + interruptedUploadCount > 0 && (
                <span className="error">
                  {failedUploadCount + interruptedUploadCount}{" "}
                  need attention
                </span>
              )}
            </div>
            <div className="folder-create-actions magnet-actions upload-actions">
              {uploadingFiles ? (
                <>
                  <button type="button" onClick={closeUpload}>Run in background</button>
                  <button type="button" onClick={pauseAllUploads}>Pause all</button>
                  <button
                    type="button"
                    className="delete-confirm"
                    onClick={cancelUploads}
                  >
                    Cancel transfer
                  </button>
                </>
              ) : (
                <button type="button" onClick={closeUpload}>
                  Close
                </button>
              )}
              <button
                type="button"
                onClick={() => setUploadPickerOpen((current) => !current)}
              >
                ＋ Add media
              </button>
              <button
                type="button"
                className="upload-start"
                onClick={() => pendingUploadCount > 0 ? beginUploads() : resumeAllUploads()}
                disabled={uploadingFiles || (pendingUploadCount === 0 && resumableUploadCount === 0)}
              >
                {uploadingFiles
                  ? "Uploading…"
                  : pendingUploadCount === 0 && resumableUploadCount > 0
                    ? `Resume ${resumableUploadCount}`
                    : `Upload ${pendingUploadCount || ""}`.trim()}
              </button>
            </div>
            </section>
          </section>
        </div>
      )}
      {!uploadTarget && (uploadingFiles || waitingUploadCount > 0) && (
        <aside
          className="magnet-background-downloads upload-background-transfer"
          aria-live="polite"
          aria-label="Uploads"
        >
          <article>
            <div>
              <span>{uploadingFiles ? "UPLOAD RUNNING" : "UPLOADS WAITING"}</span>
              <b>
                {uploadingFiles
                  ? activeUploadCount > 1 ? `${activeUploadCount} files uploading` : activeUpload?.name || "Finishing uploads"
                  : `${waitingUploadCount} upload${waitingUploadCount === 1 ? "" : "s"} paused or interrupted`}
              </b>
              <small>
                {uploadingFiles
                  ? `${Math.round(uploadProgress * 100)}% complete · ${formatUploadRate(totalUploadSpeed)}`
                  : "Open the uploader to resume where they stopped."}
              </small>
            </div>
            <div className="magnet-background-progress" aria-label={`${Math.round(uploadProgress * 100)}% uploaded`}>
              <i style={{ width: `${uploadProgress * 100}%` }} />
            </div>
            <div className="magnet-background-actions">
              <button type="button" onClick={() => uploadReturnTarget && setUploadTarget(uploadReturnTarget)}>{uploadingFiles ? "Show progress" : "Open uploader"}</button>
              {uploadingFiles && <button type="button" onClick={pauseAllUploads}>Pause</button>}
              {uploadingFiles && <button type="button" className="danger" onClick={cancelUploads}>Cancel</button>}
            </div>
          </article>
        </aside>
      )}
      {uploadDragTarget && (
        <div className={`upload-drop-overlay${uploadDragTarget.path ? "" : " blocked"}`} aria-hidden="true">
          <div>
            <span>{uploadDragTarget.path ? "↑" : "⊘"}</span>
            <b>{uploadDragTarget.path ? "Drop to upload" : "Uploads aren't available here"}</b>
            <small>
              {uploadDragTarget.path
                ? `Files and folders start uploading into ${uploadDragTarget.path} as soon as you let go.`
                : "Open a library folder you can upload to, then drop files there."}
            </small>
          </div>
        </div>
      )}
      {incomingMagnet && (
        <MagnetDownloader
          destination={defaultIncomingMagnetDestination}
          destinations={magnetDestinations}
          initialMagnetLink={incomingMagnet}
          onClose={dismissIncomingMagnet}
        />
      )}
      {serverDownloadTarget && !incomingMagnet && (
        <ServerDownloadDialog
          destination={serverDownloadTarget}
          destinations={serverDownloadDestinations}
          playlists={playlists}
          allTags={allSystemTags}
          onClose={() => setServerDownloadTarget(null)}
          onQueued={(job) => {
            activeYtDlpJobIds.current.add(job.id);
            activeYtDlpJobTitles.current.set(job.id, job.title);
            setYtDlpJobs((current) => [job, ...current.filter((item) => item.id !== job.id)]);
          }}
        />
      )}
      {magnetTarget && !incomingMagnet && (
        <MagnetDownloader
          destination={magnetTarget}
          destinations={magnetDestinations}
          onClose={() => setMagnetTarget(null)}
        />
      )}
      {downloadModalHash && !incomingMagnet && !magnetTarget && (
        <MagnetDownloader
          activeDownloadHash={downloadModalHash}
          onClose={() => setDownloadModalHash(null)}
        />
      )}
      {visibleBackgroundMagnetDownloads.length > 0 && (
        <aside
          className="magnet-background-downloads"
          aria-live="polite"
          aria-label="Active downloads"
        >
          {visibleBackgroundMagnetDownloads.length > MAGNET_GROUP_AFTER && (() => {
            const group = visibleBackgroundMagnetDownloads;
            const summary = magnetGroupSummary(group);
            const percent = Math.round(summary.progress * 100);
            const allPaused = summary.paused === group.length;
            const groupAction = allPaused ? "resume" : "pause";
            return (
              <article key="magnet-group" className="magnet-background-group">
                <div>
                  <span>
                    {allPaused ? "Paused" : "Downloading"} · {group.length} downloads
                    {summary.paused > 0 && !allPaused ? ` · ${summary.paused} paused` : ""}
                  </span>
                  <b>{magnetGroupTitle(group) || `${group.length} downloads`}</b>
                  <small>
                    {percent}% ·{" "}
                    {backgroundMagnetStatus
                      ? backgroundMagnetStatus
                      : allPaused
                      ? "Paused"
                      : magnetRateLabel(summary.speed)}{" "}
                    ·{" "}
                    {backgroundMagnetStatus
                      ? "Recovery in progress"
                      : allPaused ? "Ready to resume" : magnetEtaLabel(summary.eta)}
                  </small>
                </div>
                <div
                  className="magnet-background-progress"
                  aria-label={`${percent}% downloaded`}
                >
                  <i style={{ width: `${percent}%` }} />
                </div>
                <div className="magnet-background-actions">
                  <button
                    type="button"
                    aria-expanded={magnetGroupExpanded}
                    onClick={() => setMagnetGroupExpanded((current) => !current)}
                  >
                    {magnetGroupExpanded ? "Hide each" : "Show each"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      const hashes = group.map((download) => download.hash);
                      setHiddenMagnetHashes((current) => [...new Set([...current, ...hashes])]);
                      if (downloadModalHash && hashes.includes(downloadModalHash)) setDownloadModalHash(null);
                    }}
                  >
                    Hide
                  </button>
                  <button type="button" onClick={openMagnetFromDownloads}>
                    Add magnet
                  </button>
                  <button
                    type="button"
                    disabled={magnetControlHash !== null}
                    onClick={() => {
                      void (async () => {
                        for (const download of group) {
                          if (magnetIsPaused(download) === allPaused) await controlMagnetDownload(download.hash, groupAction);
                        }
                      })();
                    }}
                  >
                    {magnetControlHash !== null ? "Working…" : allPaused ? "Resume all" : "Pause all"}
                  </button>
                </div>
              </article>
            );
          })()}
          {(visibleBackgroundMagnetDownloads.length <= MAGNET_GROUP_AFTER || magnetGroupExpanded) && visibleBackgroundMagnetDownloads.map((download) => {
            const percent = Math.round(
              Math.max(0, Math.min(1, download.progress)) * 100,
            );
            const paused = magnetIsPaused(download);
            const busy = magnetControlHash === download.hash;
            return (
              <article
                key={download.hash}
              >
                <div>
                  <span>{paused ? "Paused" : "Downloading"}</span>
                  <b>{download.name}</b>
                  <small>
                    {percent}% ·{" "}
                    {backgroundMagnetStatus
                      ? backgroundMagnetStatus
                      : paused
                      ? "Paused"
                      : magnetRateLabel(download.download_speed)}{" "}
                    ·{" "}
                    {backgroundMagnetStatus
                      ? "Recovery in progress"
                      : paused ? "Ready to resume" : magnetEtaLabel(download.eta)}
                  </small>
                </div>
                <div
                  className="magnet-background-progress"
                  aria-label={`${percent}% downloaded`}
                >
                  <i style={{ width: `${percent}%` }} />
                </div>
                <div className="magnet-background-actions">
                  <button
                    type="button"
                    onClick={() => {
                      setHiddenMagnetHashes((current) =>
                        current.includes(download.hash) ? current : [...current, download.hash],
                      );
                      if (downloadModalHash === download.hash) setDownloadModalHash(null);
                    }}
                  >
                    Hide
                  </button>
                  <button type="button" onClick={openMagnetFromDownloads}>
                    Add magnet
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      void controlMagnetDownload(
                        download.hash,
                        paused ? "resume" : "pause",
                      );
                    }}
                    disabled={busy}
                  >
                    {busy ? "Working…" : paused ? "Resume" : "Pause"}
                  </button>
                  {sessionUser?.is_admin && typeof download.speed_cap_enabled === "boolean" && !download.complete && (
                    <button
                      type="button"
                      title={download.speed_cap_enabled ? "Remove this download's speed cap" : "Share the 5 MiB/s cap while the PC is unlocked; full speed while locked"}
                      disabled={busy}
                      onClick={() => void controlMagnetDownload(download.hash, download.speed_cap_enabled ? "uncap" : "cap")}
                    >
                      {download.speed_cap_enabled ? "Uncap speed" : "Cap speed"}
                    </button>
                  )}
                  <button
                    className="danger"
                    type="button"
                    onClick={() => {
                      void controlMagnetDownload(download.hash, "cancel");
                    }}
                    disabled={busy}
                  >
                    Cancel & remove
                  </button>
                </div>
              </article>
            );
          })}
        </aside>
      )}
      {ytDlpJobs.length > 0 && (
        <aside className={`magnet-background-downloads yt-dlp-background-downloads ${visibleBackgroundMagnetDownloads.length > 0 ? "has-magnets" : ""}`} aria-live="polite" aria-label="yt-dlp server downloads">
          {ytDlpJobs.map((job) => {
            const busy = ytDlpControlId === job.id;
            const failed = ["failed", "interrupted"].includes(job.status);
            const retryable = failed;
            return (
              <article key={job.id} className={failed ? "is-failed" : undefined}>
                <div>
                  <span>
                    {job.status.replace("_", " ")}
                    {job.status === "interrupted" && job.updated_at
                      ? ` · Stopped ${formatJobStoppedTime(job.updated_at)}`
                      : ""}
                  </span>
                  <b>{job.current_item || job.title}</b>
                  <small>{Math.round(job.progress * 100)}% · {job.speed || "Waiting"} · {job.eta ? `${job.eta} remaining` : job.extractor}</small>
                </div>
                <div className="magnet-background-progress" aria-label={`${Math.round(job.progress * 100)}% downloaded`}>
                  <i style={{ width: `${Math.max(0, Math.min(100, job.progress * 100))}%` }} />
                </div>
                {job.error && <small className="yt-dlp-failure-note">{job.error}</small>}
                <div className="magnet-background-actions">
                  <button type="button" disabled={busy} onClick={() => void controlYtDlpJob(job.id, "refresh")}>{busy && ytDlpControlId === job.id ? "Checking…" : "↻ Refresh"}</button>
                  {retryable && (
                    <>
                      <button type="button" disabled={busy} onClick={() => void controlYtDlpJob(job.id, "retry")}>{busy && ytDlpControlId === job.id ? "Working…" : "Retry now"}</button>
                      <button type="button" disabled={busy} onClick={() => void controlYtDlpJob(job.id, "refresh_cookies_and_retry")}>{busy && ytDlpControlId === job.id ? "Refreshing…" : "↻ Refresh Cookies & Retry"}</button>
                    </>
                  )}
                  {job.status === "running" && <button type="button" disabled={busy} onClick={() => void controlYtDlpJob(job.id, "interrupt")}>{busy ? "Stopping…" : "Interrupt"}</button>}
                  {!["cancelled"].includes(job.status) && <button className="danger" type="button" disabled={busy} onClick={() => void controlYtDlpJob(job.id, "cancel")}>Cancel</button>}
                </div>
              </article>
            );
          })}
        </aside>
      )}
      {deleteTarget && (
        <div
          className="folder-create-backdrop profile-settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !deletingMedia)
              setDeleteTarget(null);
          }}
        >
          <div className="folder-create-modal delete-media-modal">
            <div>
              <p>MOVE TO TRASH</p>
              <h2>Move {deleteTarget.name} to Trash?</h2>
              <small>You can restore it later from Trash.</small>
            </div>
            <div className="folder-create-actions">
              <button
                type="button"
                onClick={() => setDeleteTarget(null)}
                disabled={deletingMedia}
              >
                Cancel
              </button>
              <button
                type="button"
                className="delete-confirm"
                onClick={() => void deleteMedia()}
                disabled={deletingMedia}
              >
                {deletingMedia ? "Moving…" : "Move to Trash"}
              </button>
            </div>
          </div>
        </div>
      )}
      {bulkDeleteOpen && (
        <div
          className="folder-create-backdrop profile-settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !bulkDeleting)
              setBulkDeleteOpen(false);
          }}
        >
          <div className="folder-create-modal delete-media-modal">
            <div>
              <p>MOVE TO TRASH</p>
              <h2>Move {selectedDeletableItems.length} item{selectedDeletableItems.length === 1 ? "" : "s"} to Trash?</h2>
              <small>You can restore them later from Trash.</small>
            </div>
            <div className="folder-create-actions">
              <button
                type="button"
                onClick={() => setBulkDeleteOpen(false)}
                disabled={bulkDeleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="delete-confirm"
                onClick={() => void bulkDeleteMedia()}
                disabled={bulkDeleting}
              >
                {bulkDeleting ? "Moving…" : "Move to Trash"}
              </button>
            </div>
          </div>
        </div>
      )}
      {bulkPermanentDeleteOpen && (
        <div
          className="folder-create-backdrop profile-settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !bulkPermanentDeleting)
              setBulkPermanentDeleteOpen(false);
          }}
        >
          <div className="folder-create-modal delete-media-modal">
            <div>
              <p>DELETE PERMANENTLY</p>
              <h2>Delete {selectedItems.length} item{selectedItems.length === 1 ? "" : "s"} forever?</h2>
              <small>This removes them from Trash immediately and cannot be undone.</small>
            </div>
            <div className="folder-create-actions">
              <button
                type="button"
                onClick={() => setBulkPermanentDeleteOpen(false)}
                disabled={bulkPermanentDeleting}
              >
                Cancel
              </button>
              <button
                type="button"
                className="delete-confirm"
                onClick={() => void bulkPermanentDeleteTrash()}
                disabled={bulkPermanentDeleting}
              >
                {bulkPermanentDeleting ? "Deleting…" : "Delete permanently"}
              </button>
            </div>
          </div>
        </div>
      )}
      {deleteLibraryTarget && (
        <div
          className="folder-create-backdrop profile-settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !deletingLibrary)
              setDeleteLibraryTarget(null);
          }}
        >
          <div className="folder-create-modal delete-media-modal">
            <div>
              <p>MOVE LIBRARY TO TRASH</p>
              <h2>Move {deleteLibraryTarget} to Trash?</h2>
              <small>
                The library and everything inside it will be moved together.
              </small>
            </div>
            <p>
              You can restore it from Trash until it is permanently deleted.
            </p>
            <div className="folder-create-actions">
              <button
                type="button"
                onClick={() => setDeleteLibraryTarget(null)}
                disabled={deletingLibrary}
              >
                Cancel
              </button>
              <button
                type="button"
                className="delete-confirm"
                onClick={() => void deleteLibrary()}
                disabled={deletingLibrary}
              >
                {deletingLibrary ? "Moving…" : "Move to Trash"}
              </button>
            </div>
          </div>
        </div>
      )}
      {settingsOpen && (
        <div
          className="folder-create-backdrop profile-settings-backdrop"
          onMouseDown={(event) => {
            if (
              event.target === event.currentTarget &&
              !savingPassword && !revokingDeviceSession
            )
              setSettingsOpen(false);
          }}
        >
          <div className="folder-create-modal profile-settings-modal" role="dialog" aria-modal="true" aria-labelledby="profile-settings-title">
            <div className="profile-settings-header">
              <div>
                <p>USER SETTINGS</p>
                <h2 id="profile-settings-title">Settings</h2>
              </div>
              <button type="button" aria-label="Close user settings" onClick={() => setSettingsOpen(false)}>×</button>
            </div>
            <details className="profile-password-disclosure"><summary>Change password</summary><form className="profile-password-form" onSubmit={savePassword}>
              <div className="profile-settings-section-heading"><b>Change password</b></div>
              <div className="profile-password-fields">
              <label htmlFor="profile-current-password">
                Current password
                <input
                  id="profile-current-password" aria-label="Current password"
                  type="password"
                  value={currentPassword}
                  onChange={(event) => setCurrentPassword(event.target.value)}
                  autoComplete="current-password"
                  placeholder={
                    sessionUser?.password_set
                      ? "Required to change password"
                      : "Not required if you have none"
                  }
                />
              </label>
              <label htmlFor="profile-new-password">
                New password
                <input
                  id="profile-new-password" aria-label="New password"
                  type="password"
                  placeholder="Enter a new password"
                  value={newPassword}
                  onChange={(event) => setNewPassword(event.target.value)}
                  autoComplete="new-password"
                  required
                />
              </label>
              {settingsError && (
                <p className="folder-create-error" role="alert">
                  {settingsError}
                </p>
              )}
              <small className="profile-password-note">
                Changing your password signs you out on all devices.
              </small>
              </div>
              <div className="folder-create-actions">
                <button type="submit" disabled={!newPassword || savingPassword}>
                  {savingPassword ? "Saving…" : "Change password"}
                </button>
              </div>
            </form></details>
            <section className="profile-storage-usage">
              <div className="profile-settings-section-heading"><b>Storage</b></div>
              {storageQuota ? storageQuota.unlimited || !storageQuota.storage_quota_bytes ? (
                <p className="profile-storage-unlimited"><strong>{formatUploadSize(storageQuota.used_bytes)}</strong> used · Unlimited storage</p>
              ) : (
                <>
                  <div className="profile-storage-summary"><strong>{formatUploadSize(storageQuota.used_bytes)}</strong><span>used of {formatUploadSize(storageQuota.storage_quota_bytes ?? 0)}</span><em>{formatUploadSize(storageQuota.available_bytes ?? 0)} free</em></div>
                  <progress max={Math.max(1, storageQuota.storage_quota_bytes ?? 1)} value={Math.min(storageQuota.storage_quota_bytes ?? 0, storageQuota.used_bytes + storageQuota.reserved_bytes)} />
                  {storageQuota.reserved_bytes > 0 && <small>{formatUploadSize(storageQuota.reserved_bytes)} reserved for active uploads or downloads.</small>}
                </>
              ) : <small>Loading storage usage…</small>}
              <small>Storage is returned when you permanently delete an item from Trash.</small>
            </section>
            <section className="profile-preferences">
              <div className="profile-settings-section-heading"><b>Preferences</b></div>
              <LibraryPlaybackSettings libraries={Object.keys(libraries)} />
              <label className="profile-playback-option">
                <span>Time per image</span>
                <ImageDurationControl idPrefix="profile-image-seconds" value={playbackPreferences.image_seconds} disabled={savingImageSeconds} onChange={(seconds) => void saveImageSeconds(seconds)} />
                <small>Seconds each image stays on screen during a slideshow.</small>
              </label>
              <div className="profile-playback-option profile-offline-location">
                <span>Offline download folder</span>
                <button
                  type="button"
                  onClick={() => void chooseOfflineDownloadLocation()}
                  disabled={offlineBusy}
                >
                  {offlineBusy ? "Choosing…" : offlineLocationName ? "Change folder" : "Choose folder"}
                </button>
                <small>
                  {offlineLocationName
                    ? `Downloads on this device are saved in ${offlineLocationName}.`
                    : "Choose where offline copies are saved on this device."}
                </small>
              </div>
              <label className="profile-device-path-option">
                <input
                  type="checkbox"
                  aria-label="Show ‘Copy device path’ in media menus" aria-checked={showDevicePath} checked={showDevicePath}
                  onChange={(e) => {
                    setShowDevicePath(e.target.checked);
                    try { localStorage.setItem("framebox-show-device-path", String(e.target.checked)); } catch {}
                  }}
                />
                <span>Show ‘Copy device path’ in media menus</span>
              </label>
              <details className="profile-advanced"><summary>Advanced library loading<MenuIcon name="chevronDown" /></summary>
              <label className="profile-device-path-option">
                <input
                  type="checkbox"
                  aria-label="Load every item in large folders" aria-checked={Boolean(playbackPreferences.load_all_items)} checked={playbackPreferences.load_all_items || false}
                  onChange={(e) => void saveLoadAllItems(e.target.checked)}
                />
                <span>Load every item in large folders<small>Loads all items together; large folders use more memory and open more slowly.</small></span>
              </label>
              </details>
            </section>
            <section className="profile-device-sessions">
              <div className="profile-settings-section-heading"><b>Signed-in devices</b></div>
              {deviceSessions.length ? deviceSessions.map((session) => {
                const isCurrent = session.current;
                return <div className="profile-device-row" key={session.token}>
                  <div><b>{session.device || session.user_agent || "Unknown device"}{isCurrent && <em>This device</em>}</b><small>Signed in {new Date(session.created_at * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })}{session.ip_address ? ` · ${session.ip_address}` : ""}</small></div>
                  <button type="button" className="danger" aria-label={`Log out ${session.device || session.user_agent || "Unknown device"}`} disabled={Boolean(revokingDeviceSession)} onClick={() => void revokeDeviceSession(session)}>{revokingDeviceSession === session.token ? "Logging out…" : "Log out"}</button>
                </div>;
              }) : <small>No remembered devices.</small>}
            </section>
          </div>
        </div>
      )}
      {permanentDeleteTarget && (
        <div
          className="folder-create-backdrop profile-settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget)
              setPermanentDeleteTarget(null);
          }}
        >
          <div className="folder-create-modal delete-media-modal">
            <div>
              <p>DELETE PERMANENTLY</p>
              <h2>Delete {permanentDeleteTarget.name} forever?</h2>
              <small>
                This removes it from Trash immediately, returns its storage to the owner, and cannot be undone.
              </small>
            </div>
            <div className="folder-create-actions">
              <button
                type="button"
                onClick={() => setPermanentDeleteTarget(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="delete-confirm"
                onClick={() => void permanentlyDeleteTrashItem()}
              >
                Delete permanently
              </button>
            </div>
          </div>
        </div>
      )}
      {nameConflict && (
        <div className="folder-create-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setNameConflict(null);
        }}>
          <div className="folder-create-modal delete-media-modal">
            <div>
              <p>NAME CONFLICT</p>
              <h2>{nameConflict.name} already exists</h2>
              <small>
                Automatically use the next available name, such as {nameConflict.name.replace(/(\.[^.]*)?$/, " (1)$&")}, or cancel this {nameConflict.action}.
              </small>
            </div>
            <div className="folder-create-actions">
              <button type="button" onClick={() => setNameConflict(null)}>Cancel</button>
              <button type="button" onClick={() => { const retry = nameConflict.retry; setNameConflict(null); retry(); }}>Auto-name and continue</button>
            </div>
          </div>
        </div>
      )}
      {emptyTrashOpen && (
        <div
          className="folder-create-backdrop profile-settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !emptyingTrash)
              setEmptyTrashOpen(false);
          }}
        >
          <div className="folder-create-modal delete-media-modal">
            <div>
              <p>EMPTY TRASH</p>
              <h2>
                Permanently delete {trashItems.length} item
                {trashItems.length === 1 ? "" : "s"}?
              </h2>
              <small>
                Everything in Trash will be removed immediately and cannot be
                restored.
              </small>
            </div>
            <div className="folder-create-actions">
              <button
                type="button"
                onClick={() => setEmptyTrashOpen(false)}
                disabled={emptyingTrash}
              >
                Cancel
              </button>
              <button
                type="button"
                className="delete-confirm"
                onClick={() => void emptyTrash()}
                disabled={emptyingTrash}
              >
                {emptyingTrash ? "Emptying..." : "Empty trash"}
              </button>
            </div>
          </div>
        </div>
      )}
      {deletePlaylistTarget && (
        <div
          className="folder-create-backdrop profile-settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !savingPlaylist)
              setDeletePlaylistTarget(null);
          }}
        >
          <div className="folder-create-modal delete-media-modal">
            <div>
              <p>DELETE PLAYLIST</p>
              <h2>Delete {deletePlaylistTarget.name}?</h2>
              <small>
                The items inside this playlist will not be deleted from your library.
              </small>
            </div>
            <div className="folder-create-actions">
              <button
                type="button"
                onClick={() => setDeletePlaylistTarget(null)}
                disabled={savingPlaylist}
              >
                Cancel
              </button>
              <button
                type="button"
                className="delete-confirm"
                onClick={() => void deletePlaylist(deletePlaylistTarget.id)}
                disabled={savingPlaylist}
              >
                {savingPlaylist ? "Deleting…" : "Delete playlist"}
              </button>
            </div>
          </div>
        </div>
      )}
      {deleteTagTarget && (
        <div
          className="folder-create-backdrop profile-settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !savingTag)
              setDeleteTagTarget(null);
          }}
        >
          <div className="folder-create-modal delete-media-modal">
            <div>
              <p>DELETE TAG</p>
              <h2>Delete #{deleteTagTarget}?</h2>
              <small>
                This tag will be removed from every item. Your media files will not be deleted.
              </small>
            </div>
            <div className="folder-create-actions">
              <button
                type="button"
                onClick={() => setDeleteTagTarget(null)}
                disabled={savingTag}
              >
                Cancel
              </button>
              <button
                type="button"
                className="delete-confirm"
                onClick={() => void deleteTag(deleteTagTarget)}
                disabled={savingTag}
              >
                {savingTag ? "Deleting…" : "Delete tag"}
              </button>
            </div>
          </div>
        </div>
      )}
      {moveTarget && (
        <div
          className="folder-create-backdrop profile-settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !movingMedia)
              setMoveTarget(null);
          }}
        >
          <form
            className="folder-create-modal move-media-modal"
            onSubmit={(event) => {
              event.preventDefault();
              void moveMedia();
            }}
          >
            <div>
              <p>MOVE ITEM</p>
              <h2>Move {moveTarget.name}</h2>
              <small>Select destination folder</small>
            </div>
            <label>
              Destination
              {moveDestination && <small>{moveDestination}</small>}
              <div className="move-tree-container">
                {renderMoveDestinationNodes()}
              </div>
            </label>
            {moveError && (
              <p className="folder-create-error" role="alert">
                {moveError}
              </p>
            )}
            <div className="folder-create-actions">
              <button
                type="button"
                onClick={() => setMoveTarget(null)}
                disabled={movingMedia}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={
                  !moveDestination ||
                  movingMedia ||
                  moveDestination ===
                    (moveTarget.kind === "folder"
                      ? moveTarget.parent
                        ? `${moveTarget.parent}/${moveTarget.name}`
                        : moveTarget.name
                      : moveTarget.parent) ||
                  moveDestination.startsWith(
                    (moveTarget.kind === "folder"
                      ? moveTarget.parent
                        ? `${moveTarget.parent}/${moveTarget.name}`
                        : moveTarget.name
                      : moveTarget.path) + "/",
                  )
                }
              >
                {movingMedia ? "Moving…" : "Move"}
              </button>
            </div>
          </form>
        </div>
      )}
      {bulkMoveOpen && (
        <div
          className="folder-create-backdrop profile-settings-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !bulkMoving)
              setBulkMoveOpen(false);
          }}
        >
          <form
            className="folder-create-modal move-media-modal"
            onSubmit={(event) => {
              event.preventDefault();
              void bulkMoveMedia();
            }}
          >
            <div>
              <p>MOVE ITEMS</p>
              <h2>Move {selectedMovableItems.length} item{selectedMovableItems.length === 1 ? "" : "s"}</h2>
              <small>Select destination folder</small>
            </div>
            <label>
              Destination
              {moveDestination && <small>{moveDestination}</small>}
              <div className="move-tree-container">
                {renderMoveDestinationNodes()}
              </div>
            </label>
            {moveError && (
              <p className="folder-create-error" role="alert">
                {moveError}
              </p>
            )}
            <div className="folder-create-actions">
              <button
                type="button"
                onClick={() => setBulkMoveOpen(false)}
                disabled={bulkMoving}
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={
                  !moveDestination ||
                  bulkMoving ||
                  selectedMovableItems.some((item) => {
                    const sourcePath = mediaPath(item);
                    return !sourcePath || sourcePath === moveDestination || moveDestination.startsWith(`${sourcePath}/`);
                  })
                }
              >
                {bulkMoving ? "Moving…" : "Move"}
              </button>
            </div>
          </form>
        </div>
      )}
      {toast && (
        <div className="success-toast">
          <span>✓</span>
          {toast}
        </div>
      )}

      {preview && (
        <div className="preview-backdrop" onClick={() => setPreview(null)}>
          <div
            className="preview-panel"
            onClick={(event) => event.stopPropagation()}
          >
            <button onClick={() => setPreview(null)}>×</button>
            <div className={`preview-media ${preview.tone}`}>
              {preview.kind === "image" && preview.src ? (
                <img
                  className="preview-video"
                  src={preview.src}
                  alt={preview.name}
                />
              ) : preview.kind === "audio" && preview.src ? (
                <PreviewAudioPlayer src={preview.src} name={preview.name} />
              ) : (
                <span>◉</span>
              )}
            </div>
            <div className="preview-info">
              <div>
                <em>{preview.kind}</em>
                <h2>{preview.name}</h2>
                <p>
                  {preview.size} · From {preview.owner}
                </p>
              </div>
              <button onClick={() => downloadPreview(preview)}>
                ↓ Download
              </button>
            </div>
            <div className="preview-tags">
              <span>Tags</span>
              {preview.tags.map((item) => (
                <b key={item}>#{item}</b>
              ))}
            </div>
          </div>
        </div>
      )}

      {trailer && (
        <div className="preview-backdrop" onClick={() => setTrailer(null)}>
          <div className="trailer-modal" onClick={(event) => event.stopPropagation()}>
            <button className="trailer-close" aria-label="Close trailer" onClick={() => setTrailer(null)}>×</button>
            <iframe
              src={`https://www.youtube-nocookie.com/embed/${trailer.youtubeId}?autoplay=1&rel=0`}
              title={`${trailer.title} trailer`}
              allow="autoplay; encrypted-media; picture-in-picture"
              allowFullScreen
            />
            <h2>{trailer.title}</h2>
            <p>Trailer from YouTube</p>
          </div>
        </div>
      )}


    </main>
  );
}




