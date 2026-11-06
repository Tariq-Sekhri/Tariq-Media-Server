import { Capacitor, registerPlugin } from "@capacitor/core";
import { authFetch, getSessionToken, getSessionUser } from "./auth";
import type { MediaItem } from "./media";
import {
  OFFLINE_PLAYLIST_PREFIX, cleanPlaylistName, cleanTagName, finishPendingSync, hasPendingChanges, normalizePendingChanges,
  syncPendingChanges, withFavorite, withOrganization, withPlaylistCreated, withPlaylistDeleted, withTagCreated, withTagDeleted,
  withoutFavorite, withoutOrganization,
  type OrganizationPlaylist, type OrganizationTag, type PendingCatalogChange, type PendingFavorite, type PendingOfflineChanges, type PendingOrganization,
} from "./offline-organization";

export type OfflineFile = {
  id: string;
  path: string;
  name: string;
  kind: MediaItem["kind"];
  size: number;
  url: string;
  relativePath: string;
  localUri?: string;
};

export type OfflineBundle = {
  id: string;
  ownerId: number;
  ownerName: string;
  path: string;
  name: string;
  kind: MediaItem["kind"];
  status: "downloading" | "ready" | "error";
  createdAt: number;
  downloadedBytes: number;
  totalBytes: number;
  completedFiles?: number;
  totalFiles?: number;
  currentFileIndex?: number;
  currentFileName?: string;
  currentFileDownloadedBytes?: number;
  currentFileTotalBytes?: number;
  downloadSpeedBytes?: number;
  etaSeconds?: number;
  updatedAt?: number;
  files: OfflineFile[];
  // Folder art is kept outside files so it can be displayed locally without
  // appearing as a playable item in the downloaded library.
  cover?: OfflineFile;
  covers?: Record<string, OfflineFile>;
  error?: string;
  directoryHandle?: FileSystemDirectoryHandle;
};

type OfflineNativePlugin = {
  getLocation(): Promise<{ configured: boolean; name?: string }>;
  chooseLocation(): Promise<{ configured: boolean; name?: string }>;
  serverUrl(): Promise<{ url: string }>;
  openServer(): Promise<void>;
  list(options: { ownerId: number }): Promise<{ bundles: OfflineBundle[]; locationName?: string }>;
  download(options: { bundle: OfflineBundle; token: string }): Promise<{ bundle: OfflineBundle }>;
  reconcile(options: { bundle: OfflineBundle }): Promise<{ bundle: OfflineBundle }>;
  remove(options: { id: string; ownerId: number }): Promise<void>;
  open(options: { uri: string; mimeType?: string }): Promise<void>;
  saveOfflineUserState(options: { ownerId: number; state: Record<string, unknown> }): Promise<void>;
  getOfflineUserState(options: { ownerId: number }): Promise<{ state?: Record<string, unknown> }>;
  // Older app builds return no catalog and ignore it when saving.
  getPendingOfflineChanges(options: { ownerId: number }): Promise<{ organization?: PendingOrganization[]; favorites?: PendingFavorite[]; catalog?: PendingCatalogChange[] }>;
  replacePendingOfflineChanges(options: { ownerId: number } & PendingOfflineChanges): Promise<void>;
};

const NativeOffline = registerPlugin<OfflineNativePlugin>("TmsOffline");
const DB_NAME = "tms-offline-v1";
const DB_VERSION = 1;
const BUNDLES = "bundles";
const SETTINGS = "settings";
const DIRECTORY_KEY = "directory";
const METADATA_ROOT = ".tms_data";

type DirectoryPickerWindow = Window & {
  showDirectoryPicker?: (options?: { id?: string; mode?: "read" | "readwrite" }) => Promise<FileSystemDirectoryHandle>;
};

const openDb = () => new Promise<IDBDatabase>((resolve, reject) => {
  const request = indexedDB.open(DB_NAME, DB_VERSION);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains(BUNDLES)) db.createObjectStore(BUNDLES, { keyPath: "id" });
    if (!db.objectStoreNames.contains(SETTINGS)) db.createObjectStore(SETTINGS);
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error("Could not open offline storage"));
});

const transactionRequest = async <T>(storeName: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>) => {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(storeName, mode);
      const request = action(transaction.objectStore(storeName));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onabort = () => reject(transaction.error ?? new Error("Offline storage transaction was aborted"));
      transaction.onerror = () => reject(transaction.error ?? new Error("Offline storage transaction failed"));
      request.onerror = () => reject(request.error ?? new Error("Offline storage request failed"));
    });
  } finally {
    db.close();
  }
};

const currentOwner = () => {
  const user = getSessionUser();
  return { id: user?.id ?? 0, name: user?.name ?? "User" };
};

const directoryPermission = async (handle: FileSystemDirectoryHandle, request: boolean) => {
  const permissionHandle = handle as FileSystemDirectoryHandle & {
    queryPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
    requestPermission(options: { mode: "readwrite" }): Promise<PermissionState>;
  };
  const current = await permissionHandle.queryPermission({ mode: "readwrite" });
  if (current === "granted" || !request) return current;
  return permissionHandle.requestPermission({ mode: "readwrite" });
};

const storedDirectory = () => transactionRequest<FileSystemDirectoryHandle | undefined>(SETTINGS, "readonly", (store) => store.get(DIRECTORY_KEY));

const offlineMimeType = (file: Pick<OfflineFile, "name" | "kind">) => {
  const extension = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  const known: Record<string, string> = {
    mp4: "video/mp4", webm: "video/webm", mov: "video/quicktime", m4v: "video/mp4",
    mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", wav: "audio/wav", flac: "audio/flac", ogg: "audio/ogg", opus: "audio/ogg",
    jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp", avif: "image/avif",
  };
  return known[extension] ?? (file.kind === "video" ? "video/*" : file.kind === "audio" ? "audio/*" : file.kind === "image" ? "image/*" : "application/octet-stream");
};

const findOwnedBundle = async (bundleId: string) => {
  const owner = currentOwner();
  if (Capacitor.isNativePlatform()) {
    const result = await NativeOffline.list({ ownerId: owner.id });
    return result.bundles.find((bundle) => bundle.id === bundleId);
  }
  const bundle = await transactionRequest<OfflineBundle | undefined>(BUNDLES, "readonly", (store) => store.get(bundleId));
  return bundle?.ownerId === owner.id ? bundle : undefined;
};

export const resolveOfflineFileUrl = async (bundleId: string, fileId: string) => {
  const bundle = await findOwnedBundle(bundleId);
  const file = bundle?.files.find((candidate) => candidate.id === fileId)
    ?? (bundle?.cover?.id === fileId ? bundle.cover : undefined)
    ?? Object.values(bundle?.covers ?? {}).find((candidate) => candidate.id === fileId);
  if (!bundle || !file || bundle.status !== "ready") throw new Error("This downloaded file is not available.");
  if (Capacitor.isNativePlatform()) {
    if (!file.localUri) throw new Error("The downloaded file is missing from this device.");
    return { url: Capacitor.convertFileSrc(file.localUri), bundle, file, mimeType: offlineMimeType(file) };
  }
  const root = bundle.directoryHandle ?? await storedDirectory();
  if (!root || await directoryPermission(root, false) !== "granted") throw new Error("Reconnect the original download folder to open this file.");
  let directory = await root.getDirectoryHandle("TMS Offline");
  directory = await directory.getDirectoryHandle(`${safeSegment(bundle.name)}-${bundle.id.slice(0, 8)}`);
  const handle = await browserFileHandle(directory, file, root);
  const blob = await handle.getFile();
  return { url: URL.createObjectURL(blob), bundle, file, mimeType: blob.type || offlineMimeType(file) };
};

export const openOfflineFile = async (bundleId: string, fileId: string) => {
  const resolved = await resolveOfflineFileUrl(bundleId, fileId);
  if (Capacitor.isNativePlatform() && resolved.file.localUri) {
    await NativeOffline.open({ uri: resolved.file.localUri, mimeType: resolved.mimeType });
    return;
  }
  window.open(resolved.url, "_blank", "noopener,noreferrer");
};

export const openConfiguredTmsServer = async () => {
  if (Capacitor.isNativePlatform()) {
    await NativeOffline.openServer();
    return;
  }
  window.location.assign("/");
};

const PENDING_ORGANIZATION_KEY = "tms:offline-organization:v1";
const PENDING_FAVORITES_KEY = "tms:offline-favorites:v1";
const PENDING_CATALOG_KEY = "tms:offline-catalog:v1";

const ownerIdForOfflineState = () => currentOwner().id;

export const saveOfflineUserState = (state: Record<string, unknown>) => {
  if (!Capacitor.isNativePlatform() || ownerIdForOfflineState() === 0) return;
  void NativeOffline.saveOfflineUserState({ ownerId: ownerIdForOfflineState(), state }).catch(() => undefined);
};

export const readOfflineUserState = async <T extends Record<string, unknown>>() => {
  if (!Capacitor.isNativePlatform()) return undefined;
  const result = await NativeOffline.getOfflineUserState({ ownerId: ownerIdForOfflineState() }).catch(() => ({}));
  return result.state as T | undefined;
};

const readStoredList = (key: string) => {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

const writeStoredList = (key: string, values: unknown[]) => {
  if (values.length) localStorage.setItem(key, JSON.stringify(values));
  else localStorage.removeItem(key);
};

// The queue in this origin's localStorage. On Android the offline shell and
// the connected app are different origins, so the device store is the shared
// copy and this one is refreshed from it (hydratePendingOfflineChanges).
export const readPendingOfflineChanges = (): PendingOfflineChanges => normalizePendingChanges({
  organization: readStoredList(PENDING_ORGANIZATION_KEY),
  favorites: readStoredList(PENDING_FAVORITES_KEY),
  catalog: readStoredList(PENDING_CATALOG_KEY),
});

const writeLocalPending = (pending: PendingOfflineChanges) => {
  writeStoredList(PENDING_ORGANIZATION_KEY, pending.organization);
  writeStoredList(PENDING_FAVORITES_KEY, pending.favorites);
  writeStoredList(PENDING_CATALOG_KEY, pending.catalog);
};

const readNativePending = async () => {
  const result = await NativeOffline.getPendingOfflineChanges({ ownerId: ownerIdForOfflineState() });
  return { pending: normalizePendingChanges(result), storesCatalog: Array.isArray(result.catalog) };
};

// Device-store updates run one at a time, each against the device's current
// queue, so one origin never overwrites changes queued by the other.
let nativePendingUpdates: Promise<void> = Promise.resolve();
const updatePending = (change: (pending: PendingOfflineChanges) => PendingOfflineChanges) => {
  writeLocalPending(change(readPendingOfflineChanges()));
  if (!Capacitor.isNativePlatform()) return nativePendingUpdates;
  nativePendingUpdates = nativePendingUpdates.then(async () => {
    const next = change((await readNativePending()).pending);
    await NativeOffline.replacePendingOfflineChanges({ ownerId: ownerIdForOfflineState(), ...next });
  }).catch(() => undefined);
  return nativePendingUpdates;
};

export const hydratePendingOfflineChanges = async () => {
  if (!Capacitor.isNativePlatform()) return readPendingOfflineChanges();
  await nativePendingUpdates;
  try {
    const { pending, storesCatalog } = await readNativePending();
    // An older app build keeps no catalog changes; keep this origin's copy.
    writeLocalPending(storesCatalog ? pending : { ...pending, catalog: readPendingOfflineChanges().catalog });
  } catch {
    // Keep this origin's queue when the device store is unavailable.
  }
  return readPendingOfflineChanges();
};

export const queueOfflineOrganization = (path: string, tags: string[], playlistIds: string[]) => {
  void updatePending((pending) => withOrganization(pending, { path, tags, playlist_ids: playlistIds, updatedAt: Date.now() }));
};

export const clearPendingOfflineOrganization = (path: string) => {
  if (!Capacitor.isNativePlatform() && !readPendingOfflineChanges().organization.some((entry) => entry.path === path)) return;
  void updatePending((pending) => withoutOrganization(pending, path));
};

export const pendingOfflineFavoriteOverrides = () =>
  Object.fromEntries(readPendingOfflineChanges().favorites.map(({ path, favorite }) => [path, favorite])) as Record<string, boolean>;

export const queueOfflineFavorite = (path: string, favorite: boolean) => {
  void updatePending((pending) => withFavorite(pending, { path, favorite, updatedAt: Date.now() }));
};

export const clearPendingOfflineFavorite = (path: string) => {
  if (!Capacitor.isNativePlatform() && !readPendingOfflineChanges().favorites.some((entry) => entry.path === path)) return;
  void updatePending((pending) => withoutFavorite(pending, path));
};

const nameTaken = (names: Iterable<string>, name: string) => [...names].some((existing) => existing.toLowerCase() === name.toLowerCase());

// Create a playlist locally. It gets its server id when the queue syncs.
export const queueOfflinePlaylistCreate = (name: string, existingNames: Iterable<string> = []): OrganizationPlaylist => {
  const cleaned = cleanPlaylistName(name);
  if (!cleaned) throw new Error("Use a playlist name of up to 80 characters without slashes");
  if (nameTaken(existingNames, cleaned)) throw new Error("A playlist with that name already exists");
  const now = Date.now();
  const id = `${OFFLINE_PLAYLIST_PREFIX}${crypto.randomUUID()}`;
  void updatePending((pending) => withPlaylistCreated(pending, id, cleaned, now));
  const created = Math.floor(now / 1000);
  return { id, name: cleaned, paths: [], created_at: created, updated_at: created };
};

export const queueOfflinePlaylistDelete = (id: string) => {
  void updatePending((pending) => withPlaylistDeleted(pending, id, Date.now()));
};

export const queueOfflineTagCreate = (name: string, existingNames: Iterable<string> = []): OrganizationTag => {
  const cleaned = cleanTagName(name);
  if (!cleaned) throw new Error("Use a name of up to 32 characters");
  if (nameTaken(existingNames, cleaned)) throw new Error("A tag with that name already exists");
  const now = Date.now();
  void updatePending((pending) => withTagCreated(pending, cleaned, now));
  const created = Math.floor(now / 1000);
  return { name: cleaned, created_at: created, updated_at: created };
};

export const queueOfflineTagDelete = (name: string) => {
  void updatePending((pending) => withTagDeleted(pending, name, Date.now()));
};

export const syncPendingOfflineOrganization = async () => {
  const pending = await hydratePendingOfflineChanges();
  if (!hasPendingChanges(pending)) {
    return { processed: 0, synced: 0, favoritesSynced: 0, catalogSynced: 0, playlistIds: {} as Record<string, string | null>, remaining: 0, favoritesRemaining: 0 };
  }
  const result = await syncPendingChanges(pending, (path, init) => authFetch(path, init));
  await updatePending((current) => finishPendingSync(current, result));
  const remaining = readPendingOfflineChanges();
  return {
    processed: result.processed.length,
    synced: result.organizationSynced,
    favoritesSynced: result.favoritesSynced,
    catalogSynced: result.catalogSynced,
    playlistIds: result.playlistIds,
    remaining: remaining.organization.length + remaining.catalog.length,
    favoritesRemaining: remaining.favorites.length,
  };
};

export const offlineLocation = async () => {
  if (Capacitor.isNativePlatform()) return NativeOffline.getLocation();
  const handle = await storedDirectory();
  return { configured: Boolean(handle), name: handle?.name };
};

export const chooseOfflineLocation = async () => {
  if (Capacitor.isNativePlatform()) return NativeOffline.chooseLocation();
  const picker = (window as DirectoryPickerWindow).showDirectoryPicker;
  if (!picker) throw new Error("Offline folders require the installed TMS app or a Chromium browser such as Edge or Chrome.");
  const handle = await picker({ id: "tms-offline-library", mode: "readwrite" });
  if (await directoryPermission(handle, true) !== "granted") throw new Error("TMS needs access to the selected folder.");
  // Pin legacy bundles to the previous location before changing the default.
  const previous = await storedDirectory();
  if (previous) {
    const bundles = await transactionRequest<OfflineBundle[]>(BUNDLES, "readonly", (store) => store.getAll());
    for (const bundle of bundles) {
      if (!bundle.directoryHandle) {
        bundle.directoryHandle = previous;
        await transactionRequest(BUNDLES, "readwrite", (store) => store.put(bundle));
      }
    }
  }
  await transactionRequest(SETTINGS, "readwrite", (store) => store.put(handle, DIRECTORY_KEY));
  return { configured: true, name: handle.name };
};

export const listOfflineBundles = async (): Promise<{ bundles: OfflineBundle[]; locationName?: string }> => {
  const owner = currentOwner();
  localStorage.setItem("tms:offline-owner-id", String(owner.id));
  localStorage.setItem("tms:offline-owner-name", owner.name);
  if (Capacitor.isNativePlatform()) return NativeOffline.list({ ownerId: owner.id });
  const all = await transactionRequest<OfflineBundle[]>(BUNDLES, "readonly", (store) => store.getAll());
  const location = await offlineLocation();
  return {
    bundles: all.filter((bundle) => bundle.ownerId === owner.id).sort((left, right) => right.createdAt - left.createdAt),
    locationName: location.name,
  };
};

const safeSegment = (value: string) => value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/[. ]+$/g, "").slice(0, 150) || "item";

const browserFileHandle = async (root: FileSystemDirectoryHandle, file: OfflineFile, location?: FileSystemDirectoryHandle) => {
  if (file.localUri?.startsWith(`${METADATA_ROOT}/`)) {
    if (!location) throw new Error("Reconnect the offline metadata folder.");
    root = location;
  }
  const parts = (file.localUri || file.relativePath || file.name).split("/").filter(Boolean).map(safeSegment);
  const name = parts.pop();
  if (!name) throw new Error("The downloaded filename is missing.");
  for (const part of parts) root = await root.getDirectoryHandle(part);
  return root.getFileHandle(name);
};

const completeBrowserFile = async (root: FileSystemDirectoryHandle, file: OfflineFile, location?: FileSystemDirectoryHandle) => {
  if (!file.localUri) return false;
  try {
    const saved = await (await browserFileHandle(root, file, location)).getFile();
    return file.size > 0 ? saved.size === file.size : saved.size > 0;
  } catch (error) {
    if (error instanceof DOMException && error.name === "NotFoundError") return false;
    throw error;
  }
};

const writeBrowserBundle = async (bundle: OfflineBundle, onProgress?: (bundle: OfflineBundle) => void) => {
  const root = bundle.directoryHandle;
  if (!root || await directoryPermission(root, true) !== "granted") throw new Error("Choose or reconnect the offline download folder.");
  const tmsRoot = await root.getDirectoryHandle("TMS Offline", { create: true });
  const bundleRoot = await tmsRoot.getDirectoryHandle(`${safeSegment(bundle.name)}-${bundle.id.slice(0, 8)}`, { create: true });
  let downloadedBytes = 0;
  bundle.completedFiles = 0;
  bundle.totalFiles = bundle.files.length;
  for (const file of [...bundle.files, ...(bundle.cover ? [bundle.cover] : []), ...Object.values(bundle.covers ?? {})]) {
    const isCover = !bundle.files.includes(file);
    // Copy legacy cover art before changing its catalog reference. The old
    // copy is removed only after the new reference has committed.
    if (isCover && file.localUri && !file.localUri.startsWith(`${METADATA_ROOT}/`) && await completeBrowserFile(bundleRoot, file, root)) {
      const saved = await (await browserFileHandle(bundleRoot, file, root)).getFile();
      const metadata = await root.getDirectoryHandle(METADATA_ROOT, { create: true });
      const folder = await metadata.getDirectoryHandle(safeSegment(bundle.id), { create: true });
      const name = safeSegment(file.relativePath || file.name);
      const writable = await (await folder.getFileHandle(name, { create: true })).createWritable();
      try { await writable.write(saved); await writable.close(); }
      catch (error) { await writable.abort(error).catch(() => undefined); throw error; }
      file.localUri = `${METADATA_ROOT}/${safeSegment(bundle.id)}/${name}`;
      await transactionRequest(BUNDLES, "readwrite", (store) => store.put(bundle));
      // Keep the old copy until every replacement has succeeded. A later
      // failure may restore the previous catalog and its original paths.
    }
    if (await completeBrowserFile(bundleRoot, file, root)) {
      downloadedBytes += (await (await browserFileHandle(bundleRoot, file, root)).getFile()).size;
      bundle.downloadedBytes = downloadedBytes;
      if (bundle.files.includes(file)) bundle.completedFiles! += 1;
      continue;
    }
    let directory = isCover ? root : bundleRoot;
    const parts = isCover ? [METADATA_ROOT, safeSegment(bundle.id), safeSegment(file.relativePath || file.name)]
      : file.relativePath.split("/").filter(Boolean).map(safeSegment);
    const fileName = parts.pop() ?? safeSegment(file.name);
    for (const part of parts) directory = await directory.getDirectoryHandle(part, { create: true });
    const response = await authFetch(file.url);
    if (!response.ok || !response.body) throw new Error(`Could not download ${file.name} (${response.status})`);
    const target = await directory.getFileHandle(fileName, { create: true });
    const writable = await target.createWritable();
    const reader = response.body.getReader();
    let fileBytes = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writable.write(value);
        downloadedBytes += value.byteLength;
        fileBytes += value.byteLength;
        bundle.downloadedBytes = downloadedBytes;
        onProgress?.({ ...bundle });
      }
      if (file.size > 0 && fileBytes !== file.size) throw new Error(`Incomplete download: ${file.name} (${fileBytes} of ${file.size} bytes). Try again.`);
      await writable.close();
      file.localUri = parts.length ? `${parts.join("/")}/${fileName}` : fileName;
      if (bundle.files.includes(file)) bundle.completedFiles! += 1;
      await transactionRequest(BUNDLES, "readwrite", (store) => store.put(bundle));
    } catch (error) {
      await writable.abort(error).catch(() => undefined);
      throw error;
    }
  }
  return bundle;
};

export const makeAvailableOffline = async (
  item: MediaItem,
  files: OfflineFile[],
  covers?: Record<string, OfflineFile>,
  onProgress?: (bundle: OfflineBundle) => void,
) => {
  const owner = currentOwner();
  let bundle: OfflineBundle = {
    id: crypto.randomUUID(), ownerId: owner.id, ownerName: owner.name,
    path: item.path ?? item.name, name: item.name, kind: item.kind,
    status: "downloading", createdAt: Date.now(), downloadedBytes: 0,
    totalBytes: files.reduce((total, file) => total + file.size, 0) + Object.values(covers ?? {}).reduce((total, cover) => total + cover.size, 0), files, covers,
  };
  onProgress?.(bundle);
  try {
    if (Capacitor.isNativePlatform()) {
      bundle = (await NativeOffline.download({ bundle, token: getSessionToken() })).bundle;
    } else {
      bundle.directoryHandle = await storedDirectory();
      await transactionRequest(BUNDLES, "readwrite", (store) => store.put(bundle));
      bundle = await writeBrowserBundle(bundle, onProgress);
      bundle.status = "ready";
      bundle.downloadedBytes = bundle.totalBytes || bundle.downloadedBytes;
      await transactionRequest(BUNDLES, "readwrite", (store) => store.put(bundle));
    }
    onProgress?.({ ...bundle });
    return bundle;
  } catch (error) {
    bundle.status = "error";
    bundle.error = error instanceof Error ? error.message : "Offline download failed";
    if (!Capacitor.isNativePlatform()) await transactionRequest(BUNDLES, "readwrite", (store) => store.put(bundle));
    onProgress?.({ ...bundle });
    throw error;
  }
};

export const reconcileOfflineBundle = async (bundle: OfflineBundle, files: OfflineFile[], covers: Record<string, OfflineFile> = {}) => {
  const next: OfflineBundle = {
    ...bundle,
    status: "ready",
    files: files.map((file) => ({ ...file, localUri: undefined })),
    covers: Object.fromEntries(Object.entries(covers).map(([path, file]) => [path, { ...file, localUri: undefined }])),
    totalBytes: files.reduce((total, file) => total + file.size, 0) + Object.values(covers).reduce((total, file) => total + file.size, 0),
    downloadedBytes: 0,
    completedFiles: 0,
  };
  if (!Capacitor.isNativePlatform()) {
    const existing = await findOwnedBundle(bundle.id);
    if (!existing) throw new Error("Offline bundle no longer exists.");
    next.directoryHandle = existing.directoryHandle ?? await storedDirectory();
    if (!next.directoryHandle || await directoryPermission(next.directoryHandle, false) !== "granted") throw new Error("Reconnect the original download folder to sync these files.");
    const tmsRoot = await next.directoryHandle.getDirectoryHandle("TMS Offline");
    const bundleRoot = await tmsRoot.getDirectoryHandle(`${safeSegment(existing.name)}-${existing.id.slice(0, 8)}`);
    const retained = new Set<string>();
    for (const file of next.files) {
      const candidates = existing.files.filter((old) => old.size === file.size && (old.path === file.path || old.name === file.name));
      candidates.sort((a, b) => Number(b.path === file.path) - Number(a.path === file.path));
      for (const old of candidates) {
        if (old.localUri && !retained.has(old.localUri) && await completeBrowserFile(bundleRoot, old)) {
          file.localUri = old.localUri;
          retained.add(old.localUri);
          break;
        }
      }
    }
    for (const [path, cover] of Object.entries(next.covers ?? {})) {
      const old = existing.covers?.[path];
      if (old && old.url === cover.url && await completeBrowserFile(bundleRoot, old, next.directoryHandle)) cover.localUri = old.localUri;
    }
    next.name = existing.name;
    let updated: OfflineBundle;
    try {
      updated = await retryOfflineBundle(next);
    } catch (error) {
      // A failed background update must not replace a usable saved catalog.
      await transactionRequest(BUNDLES, "readwrite", (store) => store.put({
        ...existing, error: error instanceof Error ? error.message : "Offline sync failed",
      }));
      throw error;
    }
    // Delete stale media only after replacement downloads and catalog commit succeed.
    const usedPaths = new Set(updated.files.map((file) => file.localUri));
    for (const old of existing.files) {
      if (!old.localUri || usedPaths.has(old.localUri)) continue;
      try {
        const parts = old.localUri.split("/").filter(Boolean).map(safeSegment);
        const name = parts.pop();
        let directory = bundleRoot;
        for (const part of parts) directory = await directory.getDirectoryHandle(part);
        if (name) await directory.removeEntry(name);
      } catch {
        // A locked stale file may remain on disk; it is no longer in the catalog.
      }
    }
    return updated;
  }
  const reconciled = (await NativeOffline.reconcile({ bundle: next })).bundle;
  return (await NativeOffline.download({ bundle: reconciled, token: getSessionToken() })).bundle;
};

export const authorizeOfflineSync = async (bundle: OfflineBundle) => {
  if (Capacitor.isNativePlatform()) return;
  const root = bundle.directoryHandle ?? await storedDirectory();
  if (!root || await directoryPermission(root, true) !== "granted") throw new Error("Allow access to the original offline folder to sync its files.");
};

export const retryOfflineBundle = async (
  failedBundle: OfflineBundle,
  onProgress?: (bundle: OfflineBundle) => void,
) => {
  const retainedFiles = failedBundle.files.map((file) => ({ ...file }));
  const retainedCover = failedBundle.cover ? { ...failedBundle.cover } : undefined;
  const retainedCovers = failedBundle.covers ? Object.fromEntries(Object.entries(failedBundle.covers).map(([path, file]) => [path, { ...file }])) : undefined;
  const retainedBytes = [...retainedFiles, ...(retainedCover ? [retainedCover] : []), ...Object.values(retainedCovers ?? {})]
    .filter((file) => Boolean(file.localUri))
    .reduce((total, file) => total + file.size, 0);
  let bundle: OfflineBundle = {
    ...failedBundle,
    status: "downloading",
    downloadedBytes: retainedBytes,
    error: undefined,
    files: retainedFiles,
    cover: retainedCover,
    covers: retainedCovers,
  };
  onProgress?.({ ...bundle });
  try {
    if (Capacitor.isNativePlatform()) {
      bundle = (await NativeOffline.download({ bundle, token: getSessionToken() })).bundle;
    } else {
      await transactionRequest(BUNDLES, "readwrite", (store) => store.put(bundle));
      bundle = await writeBrowserBundle(bundle, onProgress);
      bundle.status = "ready";
      bundle.downloadedBytes = bundle.totalBytes || bundle.downloadedBytes;
      await transactionRequest(BUNDLES, "readwrite", (store) => store.put(bundle));
      const root = bundle.directoryHandle!;
      const tmsRoot = await root.getDirectoryHandle("TMS Offline");
      const bundleRoot = await tmsRoot.getDirectoryHandle(`${safeSegment(bundle.name)}-${bundle.id.slice(0, 8)}`);
      const oldCovers = [...(failedBundle.cover ? [failedBundle.cover] : []), ...Object.values(failedBundle.covers ?? {})];
      for (const cover of oldCovers) {
        if (cover.localUri && !cover.localUri.startsWith(`${METADATA_ROOT}/`)) {
          // Failed cleanup can be retried; it must not undo a usable catalog.
          await removeBrowserFile(bundleRoot, cover.localUri).catch(() => undefined);
        }
      }
    }
    onProgress?.({ ...bundle });
    return bundle;
  } catch (error) {
    bundle.status = "error";
    bundle.error = error instanceof Error ? error.message : "Offline download failed";
    if (!Capacitor.isNativePlatform()) await transactionRequest(BUNDLES, "readwrite", (store) => store.put(bundle));
    onProgress?.({ ...bundle });
    throw error;
  }
};

export const removeOfflineBundle = async (id: string) => {
  const owner = currentOwner();
  if (Capacitor.isNativePlatform()) return NativeOffline.remove({ id, ownerId: owner.id });
  const bundle = await transactionRequest<OfflineBundle | undefined>(BUNDLES, "readonly", (store) => store.get(id));
  if (!bundle) return;
  if (bundle.ownerId !== owner.id) throw new Error("This download belongs to another user.");
  const root = bundle.directoryHandle ?? await storedDirectory();
  if (!root || await directoryPermission(root, true) !== "granted") throw new Error("Reconnect the original download folder to remove these files.");
  try {
    const metadata = await root.getDirectoryHandle(METADATA_ROOT);
    await metadata.removeEntry(safeSegment(bundle.id), { recursive: true });
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
  }
  try {
    const tmsRoot = await root.getDirectoryHandle("TMS Offline");
    await tmsRoot.removeEntry(`${safeSegment(bundle.name)}-${bundle.id.slice(0, 8)}`, { recursive: true });
  } catch (error) {
    // Already absent is success; permissions, locks and I/O errors are retryable.
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
  }
  await transactionRequest(BUNDLES, "readwrite", (store) => store.delete(id));
};

const removeBrowserFile = async (root: FileSystemDirectoryHandle, path: string) => {
  const parts = path.split("/").filter(Boolean).map(safeSegment);
  const name = parts.pop();
  if (!name) return;
  try {
    for (const part of parts) root = await root.getDirectoryHandle(part);
    await root.removeEntry(name);
  } catch (error) {
    if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
  }
};

export const openOfflineLibrary = (bundleId?: string) => {
  const query = new URLSearchParams({ section: "offline" });
  if (bundleId) query.set("offline", bundleId);
  window.location.assign(`/?${query}`);
};
