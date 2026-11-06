export type Kind = "folder" | "video" | "image" | "audio" | "file";

export type OfflineBrowseMeta = {
  bundleId: string;
  fileId?: string;
  artworkFileId?: string;
  artworkKind?: "image" | "video";
  relativePath: string;
  root: boolean;
  status?: "downloading" | "ready" | "error";
  percent?: number;
  completedBytes?: number;
  totalBytes?: number;
  completedFiles?: number;
  totalFiles?: number;
  currentFileIndex?: number;
  currentFileName?: string;
  currentFileDownloadedBytes?: number;
  currentFileTotalBytes?: number;
  downloadSpeedBytes?: number;
  etaSeconds?: number;
};

export type MediaItem = {
  id: number;
  path?: string;
  devicePath?: string;
  name: string;
  kind: Kind;
  size: string;
  sizeBytes?: number;
  addedAt?: number;
  updated: string;
  tags: string[];
  owner: string;
  parent?: string;
  favorite?: boolean;
  trashed?: boolean;
  trashId?: string;
  lastPlayed?: string;
  lastOpenedAt?: number;
  src?: string;
  thumbSrc?: string;
  aspectRatio?: number;
  duration?: number;
  tone: string;
  previewSrc?: string;
  previewThumbSrc?: string;
  previewPath?: string;
  previewKind?: "image" | "video";
  itemCount?: number;
  catalogKind?: "movie" | "series" | "episode";
  catalogTitlePath?: string;
  offline?: OfflineBrowseMeta;
};

export type ApiLibraryEntry = {
  path: string;
  device_path?: string;
  name: string;
  kind: "folder" | "file";
  preview_path?: string | null;
  preview_kind?: "image" | "video" | null;
  item_count?: number | null;
  catalog_kind?: "movie" | "series" | "episode" | null;
  catalog_title_path?: string | null;
  size: number;
  created_at: number;
  duration?: number | null;
  thumbnail_aspect_ratio?: number | null;
};

// Keep browser requests on the same origin. The frontend server proxies TMS
// API and media paths to the private backend, including for Tailscale clients.
export const API_BASE = "";
const addedDateFormatter = new Intl.DateTimeFormat("en", { year: "numeric", month: "short", day: "numeric" });

export const supportedFormats = {
  video: ["mp4", "mkv", "webm", "mov", "avi", "m4v", "mpeg", "mpg", "wmv", "3gp", "ts", "m2ts"],
  audio: ["mp3", "m4a", "aac", "wav", "flac", "ogg", "oga", "opus", "wma", "aiff", "alac"],
  image: ["jpg", "jpeg", "png", "gif", "webp", "bmp", "tif", "tiff", "avif", "heic", "heif"],
} as const;

// Keep zero as mute; the first audible slider step is -20 dB.
const VOLUME_MIN_DB = -20;
const VOLUME_FIRST_AUDIBLE_POSITION = 0.01;
export const VOLUME_SLIDER_MAX = 2;
const VOLUME_BOOST_MAX_DB = 20;
const VOLUME_BOOST_MAX = 10 ** (VOLUME_BOOST_MAX_DB / 20);
export function volumeFromSlider(position: number): number {
  const clamped = Math.min(VOLUME_SLIDER_MAX, Math.max(0, position));
  if (clamped > 1) return 10 ** (VOLUME_BOOST_MAX_DB * (clamped - 1) / (VOLUME_SLIDER_MAX - 1) / 20);
  if (clamped === 0) return 0;
  const db = VOLUME_MIN_DB * (1 - Math.max(VOLUME_FIRST_AUDIBLE_POSITION, clamped)) / (1 - VOLUME_FIRST_AUDIBLE_POSITION);
  return 10 ** (db / 20);
}

export function sliderFromVolume(volume: number): number {
  const clamped = Math.min(VOLUME_BOOST_MAX, Math.max(0, volume));
  if (clamped > 1) return 1 + (VOLUME_SLIDER_MAX - 1) * 20 * Math.log10(clamped) / VOLUME_BOOST_MAX_DB;
  if (clamped === 0) return 0;
  const position = 1 - (1 - VOLUME_FIRST_AUDIBLE_POSITION) * 20 * Math.log10(clamped) / VOLUME_MIN_DB;
  return Math.min(1, Math.max(VOLUME_FIRST_AUDIBLE_POSITION, position));
}

export function volumeLabelFromSlider(position: number): string {
  const amplitude = volumeFromSlider(position);
  if (amplitude === 0) return "−∞ dB";
  // Gain relative to normal playback (0 dB), rather than measured loudness.
  const db = Number((20 * Math.log10(amplitude)).toFixed(1));
  return `${db > 0 ? "+" : ""}${db} dB`;
}

export function readStoredVolumePosition(): number {
  if (typeof window === "undefined") return 1;
  const stored = Number(window.localStorage.getItem("tms_volume") ?? 1);
  const position = Number.isFinite(stored) ? Math.min(VOLUME_SLIDER_MAX, Math.max(0, stored)) : 1;
  const curve = window.localStorage.getItem("tms_volume_curve");
  if (curve === "6") return position;
  // Decode saved curves before applying the new audible floor. Preserve mute
  // and supported loudness; quieter saved levels become -20 dB.
  const oldQuietAmplitude = (value: number) => {
    if (value === 0) return 0;
    const db = value <= 0.25 ? -80 + 40 * value / 0.25 : -40 * (1 - value) / 0.75;
    return 10 ** (db / 20);
  };
  let oldVolume: number;
  if (curve === "5") {
    oldVolume = position > 1 ? 10 ** (position - 1) : oldQuietAmplitude(position);
  } else if (curve === "4") {
    oldVolume = position > 1.5 ? 50 * 2 ** ((position - 1.5) * 2)
      : position > 1 ? 50 ** ((position - 1) * 2) : oldQuietAmplitude(position);
  } else if (curve === "3") {
    const oldPosition = Number.isFinite(stored) ? Math.min(3, Math.max(0, stored)) : 1;
    oldVolume = oldPosition > 1 ? oldPosition : oldQuietAmplitude(oldPosition);
  } else {
    const oldMinDb = curve === "2" ? -80 : -24;
    const oldPosition = Math.min(1, position);
    oldVolume = oldPosition === 0 ? 0 : 10 ** ((oldMinDb * (1 - oldPosition)) / 20);
  }
  const migrated = sliderFromVolume(oldVolume);
  window.localStorage.setItem("tms_volume", String(migrated));
  window.localStorage.setItem("tms_volume_curve", "6");
  return migrated;
}

type VolumeBoost = { context: AudioContext; source: MediaElementAudioSourceNode; gain: GainNode };
const volumeBoosts = new WeakMap<HTMLMediaElement, VolumeBoost>();

// HTMLMediaElement.volume stops at 1. Route boosted playback through a gain
// node, retaining the same source node across seeks and source changes.
export function applyMediaVolume(media: HTMLMediaElement, position: number): number {
  const amplitude = volumeFromSlider(position);
  let boost = volumeBoosts.get(media);
  if (amplitude > 1 && !boost && typeof window !== "undefined" && window.AudioContext) {
    let context: AudioContext | undefined;
    try {
      context = new window.AudioContext();
      const gain = context.createGain();
      gain.gain.value = amplitude;
      gain.connect(context.destination);
      const source = context.createMediaElementSource(media);
      source.connect(gain);
      boost = { context, source, gain };
      volumeBoosts.set(media, boost);
    } catch {
      // Keep ordinary playback usable when a device cannot create a graph.
      void context?.close().catch(() => undefined);
    }
  }
  if (boost) {
    boost.gain.gain.value = Math.max(1, amplitude);
    if (boost.context.state === "suspended") void boost.context.resume().catch(() => undefined);
  }
  media.volume = Math.min(1, amplitude);
  return readMediaVolumePosition(media);
}

export function readMediaVolumePosition(media: HTMLMediaElement): number {
  return sliderFromVolume(media.volume * (volumeBoosts.get(media)?.gain.gain.value ?? 1));
}

export function resumeMediaVolume(media: HTMLMediaElement): void {
  const boost = volumeBoosts.get(media);
  if (boost?.context.state === "suspended") void boost.context.resume().catch(() => undefined);
}

export function releaseMediaVolume(media: HTMLMediaElement): void {
  const boost = volumeBoosts.get(media);
  if (!boost) return;
  boost.source.disconnect();
  boost.gain.disconnect();
  void boost.context.close().catch(() => undefined);
  volumeBoosts.delete(media);
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "Unknown size";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = units[0];
  for (let index = 1; index < units.length && value >= 1024; index += 1) {
    value /= 1024;
    unit = units[index];
  }
  return `${value >= 10 ? value.toFixed(1) : value.toFixed(2)} ${unit}`;
}

export function stableId(value: string): number {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  return hash >>> 0;
}

export function mediaUrl(path: string): string {
  return `${API_BASE}/media/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function gridThumbUrl(path: string): string {
  return `${API_BASE}/api/grid-thumb?${new URLSearchParams({ path })}`;
}

export function mediaPathFromSrc(src: string): string | null {
  const prefix = `${API_BASE}/media/`;
  if (!src.startsWith(prefix)) return null;
  return decodeURIComponent(src.slice(prefix.length));
}

export function previewFrameUrl(videoPath: string, time = 0): string {
  return `${API_BASE}/api/preview-frame?${new URLSearchParams({ video_path: videoPath, time: time.toFixed(2) })}`;
}

export function inheritedTags(path: string | undefined, tagsByPath: Record<string, string[]> | undefined): string[] {
  if (!path || !tagsByPath) return [];
  const tags = new Set<string>();
  let current = path.replace(/\\/g, "/").replace(/\/+$/, "");
  while (current) {
    tagsByPath[current]?.forEach((tag) => tags.add(tag));
    const slash = current.lastIndexOf("/");
    current = slash < 0 ? "" : current.slice(0, slash);
  }
  return [...tags];
}

export function ancestorTags(path: string | undefined, tagsByPath: Record<string, string[]> | undefined): string[] {
  if (!path) return [];
  const normalized = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const slash = normalized.lastIndexOf("/");
  return slash < 0 ? [] : inheritedTags(normalized.slice(0, slash), tagsByPath);
}

function formatAddedDate(seconds: number): string {
  if (!seconds) return "Date unknown";
  return addedDateFormatter.format(new Date(seconds * 1000));
}

export function apiEntryToMediaItem(entry: ApiLibraryEntry): MediaItem | null {
  const slash = entry.path.lastIndexOf("/");
  const parent = slash < 0 ? undefined : entry.path.slice(0, slash);
  if (entry.kind === "folder") {
    return { id: stableId(`folder:${entry.path}`), path: entry.path, devicePath: entry.device_path, name: entry.name, kind: "folder", size: "Folder", sizeBytes: 0, addedAt: entry.created_at, updated: formatAddedDate(entry.created_at), tags: [], owner: "TMS library", parent, tone: "lavender", previewSrc: entry.preview_path ? mediaUrl(entry.preview_path) : undefined, previewThumbSrc: entry.preview_path ? gridThumbUrl(entry.preview_path) : undefined, previewPath: entry.preview_path ?? undefined, previewKind: entry.preview_kind ?? undefined, itemCount: entry.item_count ?? undefined, catalogKind: entry.catalog_kind ?? undefined, catalogTitlePath: entry.catalog_title_path ?? undefined };
  }

  const extension = entry.name.split(".").at(-1)?.toLowerCase() ?? "";
  const kind: Kind = (supportedFormats.video as readonly string[]).includes(extension) ? "video"
    : (supportedFormats.audio as readonly string[]).includes(extension) ? "audio"
      : (supportedFormats.image as readonly string[]).includes(extension) ? "image"
        : "file";
  return {
    id: stableId(`file:${entry.path}`), path: entry.path, devicePath: entry.device_path, name: entry.name, kind,
    size: formatBytes(entry.size), sizeBytes: entry.size, addedAt: entry.created_at, duration: entry.duration ?? undefined,
    updated: formatAddedDate(entry.created_at),
    tags: [kind === "image" ? "Photos" : kind === "audio" ? "Audio" : kind === "video" ? "Video" : "File"],
    owner: "TMS library", parent, src: mediaUrl(entry.path), thumbSrc: gridThumbUrl(entry.path), aspectRatio: entry.thumbnail_aspect_ratio ?? undefined,
    tone: kind === "audio" ? "audio" : kind === "image" ? "gold" : kind === "video" ? "ocean" : "slate", catalogKind: entry.catalog_kind ?? undefined, catalogTitlePath: entry.catalog_title_path ?? undefined,
  };
}

export function episodeNumbers(value: string): { season: number; episode: number } | null {
  const compact = value.match(/(?:^|[^a-z0-9])s(\d{1,3})[ ._-]*e(\d{1,4})(?:[^a-z0-9]|$)/i);
  const alternate = value.match(/(?:^|[^0-9])(\d{1,2})x(\d{1,3})(?:[^0-9]|$)/i);
  const match = compact ?? alternate;
  if (!match) {
    const filename = value.split(/[\\/]/).at(-1) ?? value;
    const anime = filename.match(/^(?:\[[^\]]+\]\s*)*.+? - (\d{1,3})(?=\s*(?:\[|\(|\.[a-z0-9]{2,5}$|$))/i);
    if (!anime || Number(anime[1]) === 0) return null;
    const season = value.match(/(?:^|[^a-z0-9])(?:season|s)[ ._-]*0*(\d{1,2})(?:[^a-z0-9]|$)/i);
    return { season: season ? Number(season[1]) : 1, episode: Number(anime[1]) };
  }
  const season = Number(match[1]);
  const episode = Number(match[2]);
  if (!compact && (episode === 264 || episode === 265 || episode === 266 || episode === 267)) return null;
  if (season > 50 || episode > 999) return null;
  return { season, episode };
}

export function isShowWatch(details: { kind: string; folder: string; series?: string; catalogKind?: "movie" | "series" | "episode"; moviesTv?: boolean; name?: string; src?: string }) {
  if (details.kind !== "video") return false;
  if (details.catalogKind === "movie") return false;
  
  const hasSeasonFolder = /(?:^|\/)(?:Season[ ._-]*\d{1,3}|Specials?)(?:\/|$)/i.test(details.folder);
  const hasEpisodeName = (details.name && episodeNumbers(details.name)) || (details.src && episodeNumbers(details.src));
  
  if (details.moviesTv && !hasSeasonFolder && !hasEpisodeName) return false;
  if (details.catalogKind === "episode" || details.catalogKind === "series") return true;
  if (hasSeasonFolder || hasEpisodeName) return true;
  if (!details.series) return false;
  const folder = details.folder;
  return folder === details.series || folder.startsWith(`${details.series}/`);
}

export function isMovieWatch(details: { kind: string; folder: string; series?: string; catalogKind?: "movie" | "series" | "episode"; moviesTv?: boolean; name?: string; src?: string }) {
  if (details.kind !== "video") return false;
  if (details.catalogKind === "movie") return true;
  if (details.catalogKind === "episode" || details.catalogKind === "series") return false;
  if (details.moviesTv) return !isShowWatch(details);
  return false;
}

export function seasonNumberForFolder(items: MediaItem[], path: string): number | null {
  const detected = items
    .filter((item) => item.kind === "video" && (item.parent === path || item.parent?.startsWith(`${path}/`)))
    .map((item) => episodeNumbers(`${item.parent ?? ""}/${item.name}`)?.season)
    .filter((season): season is number => season !== undefined);
  if (detected.length) {
    const counts = new Map<number, number>();
    detected.forEach((season) => counts.set(season, (counts.get(season) ?? 0) + 1));
    return [...counts].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0][0];
  }
  const folderMatch = path.match(/(?:^|[^a-z0-9])(?:season|s)[ ._-]*0*(\d{1,3})(?:[^a-z0-9]|$)/i);
  return folderMatch ? Number(folderMatch[1]) : null;
}

export type TitleCollection = {
  kind: "season" | "specials" | "extras" | "soundtrack";
  label: string;
  itemCount: number;
  season?: number;
};

// A TV release can include proper seasons alongside bonus videos and music.
// Only folders whose video filenames agree on a season number are seasons;
// this prevents a soundtrack or featurette directory from masquerading as one.
export function titleCollectionForFolder(items: MediaItem[], path: string): TitleCollection | null {
  const descendants = items.filter((item) => item.parent === path || item.parent?.startsWith(`${path}/`));
  const listedFolder = items.find((item) => item.kind === "folder" && item.path === path);
  const previewSeason = listedFolder?.previewKind === "video" && listedFolder.previewPath
    ? episodeNumbers(listedFolder.previewPath)?.season
    : undefined;
  if (previewSeason !== undefined) {
    return previewSeason === 0
      ? { kind: "specials", label: "Specials", itemCount: listedFolder?.itemCount ?? 0, season: previewSeason }
      : { kind: "season", label: `Season ${previewSeason}`, itemCount: listedFolder?.itemCount ?? 0, season: previewSeason };
  }
  const episodeSeasons = descendants
    .filter((item) => item.kind === "video")
    .map((item) => episodeNumbers(`${item.parent ?? ""}/${item.name}`)?.season)
    .filter((season): season is number => season !== undefined);
  if (episodeSeasons.length) {
    const counts = new Map<number, number>();
    episodeSeasons.forEach((season) => counts.set(season, (counts.get(season) ?? 0) + 1));
    const [season, count] = [...counts].sort((left, right) => right[1] - left[1] || left[0] - right[0])[0];
    if (count === episodeSeasons.length) {
      return season === 0
        ? { kind: "specials", label: "Specials", itemCount: count, season }
        : { kind: "season", label: `Season ${season}`, itemCount: count, season };
    }
  }
  const audioCount = descendants.filter((item) => item.kind === "audio").length;
  if (audioCount) return { kind: "soundtrack", label: "Soundtrack", itemCount: audioCount };
  const videoCount = descendants.filter((item) => item.kind === "video").length;
  if (videoCount) {
    const folderName = path.split("/").at(-1) ?? "Extras";
    return { kind: "extras", label: folderName, itemCount: videoCount };
  }
  return null;
}

export function titleCollectionSortOrder(collection: TitleCollection | null): number {
  if (!collection) return Number.MAX_SAFE_INTEGER;
  if (collection.kind === "specials") return 0;
  if (collection.kind === "season") return (collection.season ?? 0) + 1;
  if (collection.kind === "extras") return 1_000;
  return 1_001;
}

export function mediaEvidenceForFolder(items: MediaItem[], path: string) {
  const descendants = items.filter((item) => item.parent === path || item.parent?.startsWith(`${path}/`));
  const seasonNumbers = new Set<number>();
  // At the Movies & TV root the paged response contains the title folder
  // itself, not its child folders. Its server preview may still point to an
  // SxxEyy file, which is enough to identify the title as a series.
  const listedFolder = items.find((item) => item.kind === "folder" && item.path === path);
  const listedPreviewSeason = listedFolder?.previewKind === "video" && listedFolder.previewPath
    ? episodeNumbers(listedFolder.previewPath)?.season
    : undefined;
  if (listedPreviewSeason !== undefined) seasonNumbers.add(listedPreviewSeason);
  descendants.filter((item) => item.kind === "folder").forEach((item) => {
    const folderPath = item.parent ? `${item.parent}/${item.name}` : item.name;
    const season = seasonNumberForFolder(items, folderPath);
    if (season !== null) seasonNumbers.add(season);
  });
  // A title's child folders can similarly be present without their episode
  // rows. Use their server preview as the same series evidence.
  descendants
    .filter((item) => item.kind === "folder" && item.previewKind === "video" && item.previewPath)
    .forEach((item) => {
      const season = episodeNumbers(item.previewPath!)?.season;
      if (season !== undefined) seasonNumbers.add(season);
    });
  const episodeItems = descendants.filter((item) => item.kind === "video" && episodeNumbers(`${item.parent ?? ""}/${item.name}`));
  episodeItems.forEach((item) => {
    const season = episodeNumbers(`${item.parent ?? ""}/${item.name}`)?.season;
    if (season !== undefined) seasonNumbers.add(season);
  });
  const seasons = seasonNumbers.size;
  const episodes = episodeItems.length;
  const videos = descendants.filter((item) => item.kind === "video").length;
  const year = path.match(/\b((?:19|20)\d{2})\b/)?.[1];
  return { kind: seasons > 0 || episodes > 1 ? "series" as const : "movie" as const, seasons, episodes, videos, year };
}


export function resolveEpisodeMetadata<T extends { season: number; episode: number }>(
  videos: T[] | undefined,
  targetSeason: number,
  targetEpisode: number
): T | undefined {
  if (!videos || !videos.length) return undefined;
  const match = videos.find((video) => video.season === targetSeason && video.episode === targetEpisode);
  if (match) return match;
  if (targetSeason === 1) {
    const standardEpisodes = videos.filter((video) => video.season > 0).sort((a, b) => (a.season - b.season) || (a.episode - b.episode));
    return standardEpisodes[targetEpisode - 1];
  }
  return undefined;
}
