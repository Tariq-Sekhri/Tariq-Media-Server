import { formatBytes, inheritedTags, stableId, type Kind, type MediaItem } from "./media";
import type { OfflineBundle, OfflineFile } from "./offline";

export type OfflineBrowseLocation = { bundleId: string; relativePath: string };

const builtInTag = (kind: MediaItem["kind"]) =>
  kind === "image" ? "Photos" : kind === "audio" ? "Audio" : kind === "video" ? "Video" : kind === "file" ? "File" : "";

const displayDate = (timestamp: number) =>
  new Date(timestamp).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

const normalizePath = (path: string) => path.replace(/\\/g, "/");

export const offlinePathCandidates = (path?: string, relativePath?: string, bundlePath?: string) => {
  const candidates: string[] = [];
  const add = (value?: string) => {
    if (!value) return;
    const normalized = normalizePath(value);
    if (!candidates.includes(normalized)) candidates.push(normalized);
  };
  add(path);
  if (bundlePath && relativePath) add(`${bundlePath}/${relativePath}`);
  if (bundlePath && path && !normalizePath(path).startsWith(`${normalizePath(bundlePath)}/`)) {
    const name = normalizePath(path).split("/").pop();
    if (name) add(`${bundlePath}/${name}`);
  }
  return candidates;
};

export const resolveOfflineUserMeta = ({
  path,
  relativePath,
  bundlePath,
  kind,
  customTags,
  favoritePaths,
  libraryByPath,
}: {
  path?: string;
  relativePath?: string;
  bundlePath?: string;
  kind: Kind;
  customTags: Record<string, string[]>;
  favoritePaths: Set<string>;
  libraryByPath?: Map<string, MediaItem>;
}) => {
  const candidates = offlinePathCandidates(path, relativePath, bundlePath);
  // Recovered Android catalogs from older app versions only have a
  // `relativePath`.  Treat it as the item identity too, so their saved
  // server-side favorites and tags can still be matched by filename.
  const name = (path ?? relativePath) ? normalizePath(path ?? relativePath ?? "").split("/").pop() : undefined;
  if (name) {
    for (const key of Object.keys(customTags)) {
      if (normalizePath(key).endsWith(`/${name}`)) candidates.push(normalizePath(key));
    }
    for (const key of favoritePaths) {
      if (normalizePath(key).endsWith(`/${name}`)) candidates.push(normalizePath(key));
    }
    if (libraryByPath) {
      for (const key of libraryByPath.keys()) {
        if (normalizePath(key).endsWith(`/${name}`)) candidates.push(normalizePath(key));
      }
    }
  }
  const unique = [...new Set(candidates)];
  let tags = kind === "folder" ? [] : [builtInTag(kind)].filter(Boolean);
  let favorite = false;
  // Keep a stable local path even if this is a legacy recovered item without
  // the original server path. It lets it participate in filters and queues;
  // an exact metadata match below replaces it with the canonical server path.
  let resolvedPath = path ?? candidates[0];
  for (const candidate of unique) {
    const custom = inheritedTags(candidate, customTags);
    if (custom?.length) {
      tags = [...new Set([...tags, ...custom])];
      resolvedPath = candidate;
    }
    if (favoritePaths.has(candidate)) {
      favorite = true;
      resolvedPath = candidate;
    }
    const libraryItem = libraryByPath?.get(candidate);
    if (libraryItem) {
      tags = [...new Set([...tags, ...libraryItem.tags])];
      if (libraryItem.favorite) favorite = true;
      resolvedPath = libraryItem.path ?? candidate;
    }
  }
  return { tags, favorite, resolvedPath };
};

const artworkFor = (bundle: OfflineBundle, file?: OfflineFile, preview?: OfflineFile, folderPath?: string, root = false) => {
  const cover = folderPath ? bundle.covers?.[folderPath] : undefined;
  // Older recovered Android catalogs may retain the original bundle path while
  // the synced cover is keyed by the server path. A root bundle has one
  // primary cover, so use it as a safe fallback instead of losing the artwork.
  const syncedRootCover = root ? Object.values(bundle.covers ?? {})[0] : undefined;
  const candidate = cover ?? (root ? bundle.cover ?? syncedRootCover : undefined) ?? preview ?? ((file?.kind === "image" || file?.kind === "video") ? file : undefined);
  if (!candidate || (candidate.kind !== "image" && candidate.kind !== "video")) return undefined;
  return { artworkFileId: candidate.id, artworkKind: candidate.kind as "image" | "video" };
};

export const findOfflineBundleForFolder = (bundles: OfflineBundle[], folder: string | null) => {
  if (!folder) return null;
  const bundleName = folder.split("/")[0];
  const named = bundles.filter((bundle) => bundle.name === bundleName);
  if (named.length === 1) return named[0];
  if (named.length > 1) {
    return named.find((bundle) => bundle.path === bundleName || bundle.path.endsWith(`/${bundleName}`)) ?? named[0];
  }
  return bundles.find((bundle) => bundle.path === bundleName || bundle.path.endsWith(`/${bundleName}`)) ?? null;
};

export const offlineLocationFromFolder = (folder: string | null, bundles: OfflineBundle[]): OfflineBrowseLocation | null => {
  if (!folder) return null;
  const bundle = findOfflineBundleForFolder(bundles, folder);
  if (!bundle) return null;
  const relativePath = folder.slice(bundle.name.length).replace(/^\//, "");
  return { bundleId: bundle.id, relativePath };
};

export const offlineFolderFromLocation = (bundle: OfflineBundle, relativePath = "") =>
  relativePath ? `${bundle.name}/${relativePath}` : bundle.name;

export const buildOfflineBrowseItems = ({
  bundles,
  location,
  customTags,
  favoritePaths,
  durationsByPath,
  libraryByPath,
}: {
  bundles: OfflineBundle[];
  location: OfflineBrowseLocation | null;
  customTags: Record<string, string[]>;
  favoritePaths: Iterable<string>;
  durationsByPath?: Map<string, number>;
  libraryByPath?: Map<string, MediaItem>;
}): MediaItem[] => {
  const favorites = favoritePaths instanceof Set ? favoritePaths : new Set(favoritePaths);
  const durationFor = (path?: string) => (path && durationsByPath?.get(path)) || undefined;
  const metaFor = (path: string | undefined, relativePath: string | undefined, bundlePath: string | undefined, kind: Kind) =>
    resolveOfflineUserMeta({ path, relativePath, bundlePath, kind, customTags, favoritePaths: favorites, libraryByPath });

  if (!location) {
    return bundles.map((bundle) => {
      const rootActsAsFolder = bundle.kind === "folder" || bundle.files.length !== 1;
      const file = rootActsAsFolder ? undefined : bundle.files[0];
      const preview = bundle.files.find((candidate) => candidate.kind === "image" || candidate.kind === "video");
      const kind = rootActsAsFolder ? "folder" : (file?.kind ?? bundle.kind);
      const path = file?.path ?? bundle.path;
      const meta = metaFor(path, file?.relativePath, bundle.path, kind);
      const percent = bundle.totalBytes > 0 ? Math.min(100, Math.round(bundle.downloadedBytes / bundle.totalBytes * 100)) : 0;
      const completedFiles = bundle.completedFiles ?? bundle.files.filter((candidate) => Boolean(candidate.localUri)).length;
      const totalFiles = bundle.totalFiles ?? bundle.files.length;
      const currentFileIndex = bundle.currentFileIndex ?? (bundle.status === "downloading" ? Math.min(totalFiles, completedFiles + 1) : undefined);
      const currentFileName = bundle.currentFileName ?? bundle.files[completedFiles]?.name;
      const completedFileBytes = bundle.files.slice(0, completedFiles).reduce((total, candidate) => total + candidate.size, 0);
      const currentFileDownloadedBytes = bundle.currentFileDownloadedBytes ?? Math.max(0, bundle.downloadedBytes - completedFileBytes);
      const currentFileTotalBytes = bundle.currentFileTotalBytes ?? bundle.files[completedFiles]?.size;
      // A downloaded folder's server cover is indexed by its full source path.
      // Pass that path even at the offline root so the folder card uses the
      // synced cover instead of falling back to the generated letter tile.
      const art = artworkFor(bundle, file, preview, bundle.path, true);
      return {
        id: stableId(`offline:${bundle.id}`),
        path: meta.resolvedPath ?? path,
        name: bundle.name,
        kind,
        size: rootActsAsFolder ? "Folder" : formatBytes(file?.size ?? bundle.totalBytes),
        sizeBytes: bundle.totalBytes,
        addedAt: bundle.createdAt / 1000,
        updated: displayDate(bundle.createdAt),
        tags: meta.tags,
        owner: "Offline",
        tone: kind === "audio" ? "audio" : kind === "image" ? "gold" : kind === "video" ? "ocean" : "lavender",
        itemCount: rootActsAsFolder ? bundle.files.length : undefined,
        favorite: meta.favorite,
        duration: durationFor(file?.path) ?? durationFor(meta.resolvedPath),
        previewKind: art?.artworkKind,
        offline: {
          bundleId: bundle.id,
          fileId: file?.id,
          artworkFileId: art?.artworkFileId ?? ((file?.kind === "image" || file?.kind === "video") ? file.id : undefined),
          artworkKind: art?.artworkKind ?? ((file?.kind === "image" || file?.kind === "video") ? file.kind : undefined),
          relativePath: "",
          root: true,
          status: bundle.status,
          percent,
          completedBytes: bundle.downloadedBytes,
          totalBytes: bundle.totalBytes,
          completedFiles,
          totalFiles,
          currentFileIndex,
          currentFileName,
          currentFileDownloadedBytes,
          currentFileTotalBytes,
          downloadSpeedBytes: bundle.downloadSpeedBytes,
          etaSeconds: bundle.etaSeconds,
        },
      } satisfies MediaItem;
    });
  }

  const bundle = bundles.find((candidate) => candidate.id === location.bundleId);
  if (!bundle) return [];
  const current = location.relativePath;
  const browseParent = offlineFolderFromLocation(bundle, current);
  const folders = new Map<string, OfflineFile>();
  const result: MediaItem[] = [];

  for (const file of bundle.files) {
    const relative = (file.relativePath || file.name).replace(/\\/g, "/");
    if (current && relative !== current && !relative.startsWith(`${current}/`)) continue;
    const remainder = current ? relative.slice(current.length + 1) : relative;
    if (!remainder) continue;
    const slash = remainder.indexOf("/");
    if (slash >= 0) {
      const folderName = remainder.slice(0, slash);
      if (!folders.has(folderName)) folders.set(folderName, file);
      continue;
    }
    const meta = metaFor(file.path, relative, bundle.path, file.kind);
    const art = artworkFor(bundle, file);
    result.push({
      id: stableId(`offline:${bundle.id}:${file.id}`),
      path: meta.resolvedPath ?? file.path,
      name: file.name,
      kind: file.kind,
      size: formatBytes(file.size),
      sizeBytes: file.size,
      addedAt: bundle.createdAt / 1000,
      updated: displayDate(bundle.createdAt),
      tags: meta.tags,
      owner: "Offline",
      parent: browseParent,
      tone: file.kind === "audio" ? "audio" : file.kind === "image" ? "gold" : file.kind === "video" ? "ocean" : "slate",
      favorite: meta.favorite,
      duration: durationFor(file.path) ?? durationFor(meta.resolvedPath),
      previewKind: art?.artworkKind,
      offline: {
        bundleId: bundle.id,
        fileId: file.id,
        artworkFileId: art?.artworkFileId ?? ((file.kind === "image" || file.kind === "video") ? file.id : undefined),
        artworkKind: art?.artworkKind ?? ((file.kind === "image" || file.kind === "video") ? file.kind : undefined),
        relativePath: relative,
        root: false,
        status: "ready",
      },
    });
  }

  for (const [name, preview] of folders) {
    const relativePath = current ? `${current}/${name}` : name;
    const count = bundle.files.filter((file) => (file.relativePath || file.name).replace(/\\/g, "/").startsWith(`${relativePath}/`)).length;
    const folderPath = `${bundle.path}/${relativePath}`;
    const meta = metaFor(folderPath, relativePath, bundle.path, "folder");
    const art = artworkFor(bundle, undefined, preview, folderPath, false);
    result.push({
      id: stableId(`offline-folder:${bundle.id}:${relativePath}`),
      path: meta.resolvedPath ?? folderPath,
      name,
      kind: "folder",
      size: "Folder",
      sizeBytes: 0,
      addedAt: bundle.createdAt / 1000,
      updated: displayDate(bundle.createdAt),
      tags: [],
      owner: "Offline",
      parent: browseParent,
      tone: "lavender",
      itemCount: count,
      favorite: meta.favorite,
      previewKind: art?.artworkKind,
      offline: {
        bundleId: bundle.id,
        artworkFileId: art?.artworkFileId,
        artworkKind: art?.artworkKind,
        relativePath,
        root: false,
        status: "ready",
      },
    });
  }

  return result;
};

// The Offline root normally shows download bundles as folders.  Filters and
// queue actions, however, need the actual downloaded media underneath every
// bundle so they behave exactly like their library counterparts.
export const buildOfflineAllMediaItems = ({
  bundles,
  customTags,
  favoritePaths,
  durationsByPath,
  libraryByPath,
}: Omit<Parameters<typeof buildOfflineBrowseItems>[0], "location">): MediaItem[] => {
  const favorites = favoritePaths instanceof Set ? favoritePaths : new Set(favoritePaths);
  const durationFor = (path?: string) => (path && durationsByPath?.get(path)) || undefined;

  return bundles.flatMap((bundle) => bundle.files.map((file) => {
    const relativePath = (file.relativePath || file.name).replace(/\\/g, "/");
    const parentRelativePath = relativePath.includes("/") ? relativePath.slice(0, relativePath.lastIndexOf("/")) : "";
    const meta = resolveOfflineUserMeta({
      path: file.path,
      relativePath,
      bundlePath: bundle.path,
      kind: file.kind,
      customTags,
      favoritePaths: favorites,
      libraryByPath,
    });
    const art = artworkFor(bundle, file);
    return {
      id: stableId(`offline:${bundle.id}:${file.id}`),
      path: meta.resolvedPath ?? file.path,
      name: file.name,
      kind: file.kind,
      size: formatBytes(file.size),
      sizeBytes: file.size,
      addedAt: bundle.createdAt / 1000,
      updated: displayDate(bundle.createdAt),
      tags: meta.tags,
      owner: "Offline",
      parent: offlineFolderFromLocation(bundle, parentRelativePath),
      tone: file.kind === "audio" ? "audio" : file.kind === "image" ? "gold" : file.kind === "video" ? "ocean" : "slate",
      favorite: meta.favorite,
      duration: durationFor(file.path) ?? durationFor(meta.resolvedPath),
      previewKind: art?.artworkKind,
      offline: {
        bundleId: bundle.id,
        fileId: file.id,
        artworkFileId: art?.artworkFileId ?? ((file.kind === "image" || file.kind === "video") ? file.id : undefined),
        artworkKind: art?.artworkKind ?? ((file.kind === "image" || file.kind === "video") ? file.kind : undefined),
        relativePath,
        root: false,
        status: "ready",
      },
    } satisfies MediaItem;
  }));
};

export const offlineArtworkKey = (item: Pick<MediaItem, "offline" | "kind">) => {
  const offline = item.offline;
  if (!offline) return null;
  if (item.kind === "folder") {
    return offline.artworkFileId ? `${offline.bundleId}:${offline.artworkFileId}` : null;
  }
  if (item.kind === "image" || item.kind === "video") {
    const fileId = offline.artworkFileId ?? offline.fileId;
    return fileId ? `${offline.bundleId}:${fileId}` : null;
  }
  return null;
};

export const offlinePlaybackKey = (item: Pick<MediaItem, "offline" | "kind">) => {
  const offline = item.offline;
  if (!offline?.fileId) return null;
  if (item.kind === "audio" || item.kind === "video" || item.kind === "image") {
    return `${offline.bundleId}:${offline.fileId}`;
  }
  return null;
};
