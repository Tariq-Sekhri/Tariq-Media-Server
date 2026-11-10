"use client";
import { closeTopBackLayer, useBackLayer } from "../lib/back-layers";

import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type CSSProperties, type VideoHTMLAttributes, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import { playsAlongside } from "../lib/library-playback";
import Hls from "hls.js";
import { cachedFragmentLoader, canDirectPlayVideo, preferredAudioTrack, preloadSegments, type VideoInfo } from "../lib/episode-preload";
import { canBufferQueueVideo, nearbyQueueItems, QUEUE_PRELOAD_BYTES } from "../lib/queue-preload";
import { authFetch, getSessionUser, reportClientError, reportClientPerformance } from "../lib/auth";
import { beginPlaybackTrace, playbackTracePhase, traceFromParams, writePlaybackTrace } from "../lib/playback-trace";
import { commonFolder, librarySubtreeUrl, playbackUserStateUrl, queueFetchScopes, sharedJson } from "../lib/watch-requests";
import { API_BASE, apiEntryToMediaItem, episodeNumbers, isMovieWatch, isShowWatch, readStoredVolumePosition, resolveEpisodeMetadata, applyMediaVolume, readMediaVolumePosition, resumeMediaVolume, releaseMediaVolume, stableId, supportedFormats, type ApiLibraryEntry, type MediaItem } from "../lib/media";
import { DEFAULT_CAPTION_PREFERENCES, DEFAULT_PLAYBACK_PREFERENCES, normalizeImageSeconds, playbackPreferencesFromState, type CaptionPreferences, type PlaybackPreferences } from "../lib/playback";
import { clearPlaybackHandoff, readPlaybackHandoff } from "../lib/playback-handoff";
import { savesWatchProgress, episodeFinished, mergeWatchProgress, readLocalWatchProgress, selectSeriesEpisode, writeLocalWatchProgress } from "../lib/watch-progress";
import { readReturnBrowseSnapshot, updateSnapshotOrganization, updateSnapshotPlayback } from "../lib/browse-cache";
import WatchPlayerControls from "../WatchPlayerControls";
import { WatchMiniControls, useMiniPlayerDrag } from "../WatchMiniPlayer";
import OrganizeMediaModal, { type OrganizeSavedState } from "../OrganizeMediaModal";
import { playbackClock as clock } from "../lib/player-ui";
import { clearNativeMediaSession, nativeMediaSessionAvailable, syncNativeMediaSession } from "../lib/native-media-session";
import { addNativePipActionListener, addNativePipStateListener, enterNativePip, exitNativePip, nativePipAvailable, syncNativePipState } from "../lib/native-pip";
import { Capacitor } from "@capacitor/core";
import { App } from "@capacitor/app";
import { StatusBar } from "@capacitor/status-bar";
import { NavigationBar } from "@capgo/capacitor-navigation-bar";
import { resolveOfflineFileUrl } from "../lib/offline";
import { endingSkipAdvancesEpisode } from "../lib/skip-action";
import { restorePlaybackSession as restoreSharedPlaybackSession, setPlaybackSession as setSharedPlaybackSession, startPlaybackSession as startSharedPlaybackSession, type PlaybackSession, selectPlaybackItem, playbackReturnUrl } from "../lib/playback-session";
import { loadPlaybackQueue, queueSourceForItem, readQueueSource, writeQueueSource, type QueueSource } from "../lib/playback-queue";
import { closeWatch as closeSharedWatch, expandWatch as expandSharedWatch, leaveWatch as leaveSharedWatch, minimizeWatch as minimizeSharedWatch, replaceWatchLocation as replaceSharedWatchLocation, setWatchBackHandler as setSharedWatchBackHandler, useWatchMode, watchLocationSearch as sharedWatchLocationSearch, updateCompanionWatch, closeCompanionWatch, minimizeCompanionWatch, expandCompanionWatch, type WatchInstance } from "../lib/app-shell";

type WatchDetails = { queueSource?: QueueSource; src: string; sourcePath?: string; offline?: boolean; offlineBundleId?: string; offlineFileId?: string; name: string; size: string; folder: string; series?: string; imdbId?: string; season?: number; episode?: number; customQueue: boolean; queueLabel?: string; queueFolder?: string; queueSort?: string; queueDirection?: string; queueShuffle: boolean; queueShuffleSeed?: string; startAt: number; playIntent: boolean; playAttemptId?: string; playAttemptStartedAt?: number; kind: string; moviesTv: boolean; catalogKind?: "movie" | "series" | "episode" };
type SubtitleTrack = { label: string; language: string; url: string; mode?: "burn_in"; stream_index?: number };
type AudioTrack = { stream_index: number; label: string; language: string; is_default: boolean };
type CaptionCue = { start: number; end: number; text: string };
type CaptionStatus = { state: "idle" | "loading" | "ready" | "error"; label: string };
type CaptionSource = "off" | "local" | "local_pgs" | "remote";
type CaptionSelection = { source: CaptionSource; track_label?: string };
type PlaybackState = { position: number; duration: number; updated: number; completed?: boolean };
type UserState = {
  favorites: string[];
  playback: Record<string, PlaybackState>;
  last_accessed?: Record<string, number>;
  tags?: Record<string, string[]>;
  tag_catalog?: Record<string, { name: string; created_at: number; updated_at?: number }>;
  playlists?: Record<string, { id: string; name: string; paths: string[]; created_at: number; updated_at?: number }>;
  playback_preferences?: PlaybackPreferences;
  caption_selections?: Record<string, CaptionSelection>;
};
type StoredPlaybackQueue = {
  paths: string[];
  createdAt: number;
  offlineEntries?: {
    path: string;
    bundleId: string;
    fileId: string;
    name: string;
    size: string;
    kind: string;
    parent?: string;
  }[];
};
type StoredQueueOrder = { scope: string; paths: string[]; createdAt: number };
type SkipSegmentDecision = { kind: "intro" | "recap" | "credits" | "preview"; start: number; end: number; confidence: number; agreement: number; providers: string[]; reason: string; auto_skip_safe: boolean };
type SkipSegmentEvidence = { kind: string; start: number; end: number; provider_confidence?: number; submission_count?: number; label?: string };
type SkipProviderEvidence = { provider: string; status: string; latency_ms: number; segments: SkipSegmentEvidence[]; error?: string; raw?: unknown };
type SkipSegmentsResponse = {
  identity: { video_path: string; imdb_id: string; season?: number; episode?: number; duration: number; file_size: number; modified_at: number };
  providers: SkipProviderEvidence[];
  segments: SkipSegmentDecision[];
  fetched_at: number;
  cache_status: string;
};
type EpisodeMetadata = { name?: string; title?: string; season: number; episode: number; thumbnail?: string };
type TitleMetadata = { id?: string; name: string; videos?: EpisodeMetadata[] };

const PLAYBACK_QUEUE_KEY = "tms:playback-queue:v1";
const LEGACY_PLAYBACK_QUEUE_KEY = "framebox:playback-queue:v1";
const PLAYBACK_QUEUE_ORDER_KEY = "tms:playback-queue-order:v1";
const TRANSCODE_AUDIO_BITRATE = 256_000;
const TRANSCODE_MIN_BUFFER_SECONDS = 90;
const TRANSCODE_MAX_BUFFER_SECONDS = 3_600;
const TAB_TITLE_SUFFIX = "TMS - Tariq's Media Server";

const isPhoneLayout = () => typeof window !== "undefined"
  && window.matchMedia("(max-width: 820px), (hover: none) and (pointer: coarse) and (orientation: landscape)").matches;

const controlsHideDelay = () => isPhoneLayout() ? 5_000 : 1_500;

const captionSelectionKey = (details: WatchDetails) => {
  if (details.series?.trim()) return `series:${details.series.trim().toLocaleLowerCase()}`;
  // Metadata enrichment can replace a provisional IMDb ID after this page
  // has loaded. The media folder does not change during that lookup, so it
  // keeps a user's source choice stable across refreshes.
  if (details.folder.trim()) return `folder:${details.folder.trim().toLocaleLowerCase()}`;
  return `imdb:${details.imdbId?.trim().toLocaleLowerCase() ?? details.src}`;
};

// Prefer the stable series path so every episode shares one choice. IMDb is a
// useful fallback for catalog entries where a series path is not available.
const autoSkipShowKey = (details: WatchDetails) => {
  if (details.series?.trim()) return `series:${details.series.trim().toLocaleLowerCase()}`;
  if (details.imdbId?.trim()) return `imdb:${details.imdbId.trim().toLocaleLowerCase()}`;
  if (details.folder.trim()) return `folder:${details.folder.trim().toLocaleLowerCase()}`;
  return null;
};

const autoSkipEnabledFor = (details: WatchDetails | null, preferences: PlaybackPreferences) => {
  const key = details && autoSkipShowKey(details);
  return key ? preferences.auto_skip_by_show[key] ?? preferences.auto_skip_enabled : preferences.auto_skip_enabled;
};

const captionSource = (track: SubtitleTrack): Exclude<CaptionSource, "off"> => {
  if (track.mode === "burn_in") return "local_pgs";
  if (track.url.startsWith("/api/remote-subtitle")) return "remote";
  return "local";
};


const PLAYBACK_SPEED_MIN = 0.25;
const PLAYBACK_SPEED_MAX = 16;
const PLAYBACK_SPEED_STEP = 0.25;
const WATCH_VIDEO_ENGINE_STYLES = ":host{position:absolute;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;left:-9999px;top:0}video{width:1px;height:1px}video::-webkit-media-controls{display:none!important}";

const paintVideoSurface = (video: HTMLVideoElement, canvas: HTMLCanvasElement) => {
  const surface = canvas.parentElement;
  if (!surface || video.readyState < 2 || !video.videoWidth || !video.videoHeight) return;
  const width = surface.clientWidth;
  const height = surface.clientHeight;
  if (width <= 0 || height <= 0) return;
  const dpr = window.devicePixelRatio || 1;
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }
  const scale = Math.min(pixelWidth / video.videoWidth, pixelHeight / video.videoHeight);
  const drawWidth = video.videoWidth * scale;
  const drawHeight = video.videoHeight * scale;
  const offsetX = (pixelWidth - drawWidth) / 2;
  const offsetY = (pixelHeight - drawHeight) / 2;
  const context = canvas.getContext("2d");
  if (!context) return;
  context.fillStyle = "#000";
  context.fillRect(0, 0, pixelWidth, pixelHeight);
  context.drawImage(video, offsetX, offsetY, drawWidth, drawHeight);
};

const pathLeaf = (value: string | undefined) => {
  const parts = (value ?? "").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
};

const fileLabel = (value: string) => value
  .replace(/\.[^/.]+$/, "")
  .replace(/[._]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

const episodeIdentity = (details: WatchDetails) => {
  const parsed = episodeNumbers(`${details.folder}/${details.name}`);
  const season = Number.isFinite(details.season) && (details.season ?? 0) > 0 ? details.season : parsed?.season;
  const episode = Number.isFinite(details.episode) && (details.episode ?? 0) > 0 ? details.episode : parsed?.episode;
  if (!season || !episode) return undefined;
  return { season, episode, code: `S${String(season).padStart(2, "0")}E${String(episode).padStart(2, "0")}` };
};

const movieTitleCandidate = (details: WatchDetails) => {
  const folderName = pathLeaf(details.folder);
  return folderName && !/^(?:movies?|media|videos?|downloads?)$/i.test(folderName)
    ? fileLabel(folderName)
    : fileLabel(details.name);
};

const transcodeBitrateForHeight = (height: number) => {
  if (height >= 1080) return 6_000_000;
  if (height >= 720) return 3_500_000;
  if (height >= 480) return 1_800_000;
  return 900_000;
};

const transcodeBufferSeconds = (quality: string, fallbackHeight: number, bufferSizeMb: PlaybackPreferences["buffer_size_mb"]) => {
  if (quality === "auto") return TRANSCODE_MIN_BUFFER_SECONDS;
  const height = Number(quality) || fallbackHeight || 720;
  const seconds = Math.floor(bufferSizeMb * 1_000_000 * 8 / (transcodeBitrateForHeight(height) + TRANSCODE_AUDIO_BITRATE));
  return Math.max(TRANSCODE_MIN_BUFFER_SECONDS, Math.min(TRANSCODE_MAX_BUFFER_SECONDS, seconds));
};

// `crypto.randomUUID()` is only exposed in secure browser contexts. Remote
// viewers can load TMS over plain HTTP, so keep transcode session cleanup
// working there too.
const createTranscodeSessionId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const values = new Uint32Array(4);
  if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
    crypto.getRandomValues(values);
    return Array.from(values, (value) => value.toString(16).padStart(8, "0")).join("");
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
};

const timeIsBuffered = (video: HTMLVideoElement, time: number) => {
  for (let index = 0; index < video.buffered.length; index += 1) {
    if (time >= video.buffered.start(index) - 0.25 && time <= video.buffered.end(index) + 0.25) return true;
  }
  return false;
};

const skipKindLabel = (kind: string) => kind === "credits" ? "Credits" : kind.charAt(0).toUpperCase() + kind.slice(1);

const cueTime = (value: string) => value.trim().split(":").reduce((total, part) => total * 60 + Number(part), 0);
const parseVtt = (source: string): CaptionCue[] => source.replace(/\r/g, "").split(/\n\n+/).flatMap((block) => {
  const lines = block.trim().split("\n");
  const timingIndex = lines.findIndex((line) => line.includes(" --> "));
  if (timingIndex < 0) return [];
  const [start, endPart] = lines[timingIndex].split(" --> ");
  return [{ start: cueTime(start), end: cueTime(endPart.split(" ")[0]), text: lines.slice(timingIndex + 1).join("\n").replace(/<[^>]+>/g, "") }];
});

const subtitleSource = (track: SubtitleTrack) => {
  if (track.mode === "burn_in") return "Local";
  if (track.url.startsWith("/api/remote-subtitle")) return "Remote";
  if (track.url.startsWith("/api/embedded-subtitle")) return "Embedded";
  return "Local";
};

const playMediaSafely = (video: HTMLMediaElement) => {
  void video.play().catch((error: unknown) => {
    if (!(error instanceof DOMException && error.name === "AbortError")) console.error("Video playback failed", error);
  });
};

const seededQueueRank = (seed: string, value: string) => {
  let hash = 2_166_136_261;
  for (const character of `${seed}\0${value}`) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
};

type MediaShadowHost = HTMLDivElement & { __tmsMediaShadowRoot?: ShadowRoot };

function getMediaShadowRoot(host: MediaShadowHost) {
  // Keep the media element out of the page layout, but leave the root open so
  // React Strict Mode and Vite hot reload can recover it after effect cleanup.
  // A closed root is permanently undiscoverable once the ref is cleared.
  host.__tmsMediaShadowRoot ||= host.shadowRoot || host.attachShadow({ mode: "open" });
  return host.__tmsMediaShadowRoot;
}

function ShadowMediaProbe({ tag, src, onLoadedMetadata }: { tag: "video" | "audio"; src: string; onLoadedMetadata: (duration: number) => void }) {
  const hostRef = useRef<MediaShadowHost>(null);
  const onLoadedMetadataRef = useRef(onLoadedMetadata);
  onLoadedMetadataRef.current = onLoadedMetadata;

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const shadow = getMediaShadowRoot(host);
    const media = document.createElement(tag);
    media.preload = "metadata";
    media.src = src;
    const handleLoaded = () => {
      if (Number.isFinite(media.duration) && media.duration > 0) onLoadedMetadataRef.current(media.duration);
    };
    media.addEventListener("loadedmetadata", handleLoaded, { once: true });
    shadow.appendChild(media);
    return () => {
      media.removeEventListener("loadedmetadata", handleLoaded);
      media.removeAttribute("src");
      media.load();
      media.remove();
    };
  }, [tag, src]);

  return <div ref={hostRef} />;
}

function QueueDurationProbe({ item, skip, onDuration }: { item: MediaItem; skip?: boolean; onDuration: (path: string, duration: number) => void }) {
  if (skip || !item.src || !item.path || item.duration || item.kind === "image") return null;
  const handleLoadedMetadata = (mediaDuration: number) => {
    if (Number.isFinite(mediaDuration) && mediaDuration > 0) onDuration(item.path!, mediaDuration);
  };
  return <ShadowMediaProbe tag={item.kind === "audio" ? "audio" : "video"} src={item.src} onLoadedMetadata={handleLoadedMetadata} />;
}

function QueueVideoSlot({ active, mediaRef, ...props }: VideoHTMLAttributes<HTMLVideoElement> & { active: boolean; mediaRef: (video: HTMLVideoElement | null) => void }) {
  const ref = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    const video = ref.current;
    if (video && !active && !props.src) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
  }, [active, props.src]);
  useEffect(() => {
    // Capture now: React clears the ref before this cleanup runs on unmount.
    const video = ref.current;
    return () => {
      if (video) { video.pause(); video.removeAttribute("src"); video.load(); releaseMediaVolume(video); }
    };
  }, []);
  const bind = (video: HTMLVideoElement | null) => { ref.current = video; mediaRef(video); };
  // Standby events must never affect the visible player's time, saved progress,
  // playing state, or telemetry. Its source stays identical when promoted.
  return active ? <video {...props} ref={bind} />
    : <video ref={bind} src={props.src} preload={props.src ? "auto" : "none"} muted playsInline />;
}

function QueueItemMain({ name, active, lengthLabel, onSelect }: { name: string; active: boolean; lengthLabel: string; onSelect: () => void }) {
  const nameRef = useRef<HTMLSpanElement>(null);
  const [tooltip, setTooltip] = useState<{ x: number; y: number } | null>(null);

  const updateTooltip = (clientX: number, clientY: number) => {
    const element = nameRef.current;
    if (!element || element.scrollWidth <= element.clientWidth + 0.5) {
      setTooltip(null);
      return;
    }
    setTooltip({ x: clientX, y: clientY });
  };

  return <>
    <button type="button" className="watch-queue-item-main" role="menuitem" aria-current={active ? "true" : undefined} onClick={onSelect} onMouseEnter={(event) => updateTooltip(event.clientX, event.clientY)} onMouseMove={(event) => updateTooltip(event.clientX, event.clientY)} onMouseLeave={() => setTooltip(null)}>
      <span ref={nameRef} className="watch-queue-item-name">{name}</span>
      <span className={`watch-queue-item-duration${lengthLabel === "…" ? " pending" : ""}`}>{lengthLabel}</span>
    </button>
    {tooltip && typeof document !== "undefined" ? createPortal(<span className="watch-queue-item-tooltip" role="tooltip" style={{ left: tooltip.x, top: tooltip.y }}>{name}</span>, document.body) : null}
  </>;
}

const parseWatchDetails = (search: string): WatchDetails | null => {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(search);
  const offlineBundleId = params.get("offlineBundle") ?? undefined;
  const offlineFileId = params.get("offlineFile") ?? undefined;
  const offline = Boolean(offlineBundleId && offlineFileId);
  const src = params.get("src") ?? (offline ? `offline:${offlineBundleId}:${offlineFileId}` : null);
  if (!src || (!offline && !src.startsWith(`${API_BASE}/media/`))) return null;
  const suppliedSeries = params.get("series") ?? undefined;
  const series = suppliedSeries?.match(/(?:^|\/)(?:Season[ ._-]*0*\d{1,3}|Specials?)$/i)
    ? suppliedSeries.slice(0, suppliedSeries.lastIndexOf("/"))
    : suppliedSeries;
  return {
    src,
    sourcePath: params.get("path") ?? undefined,
    offline,
    offlineBundleId,
    offlineFileId,
    name: params.get("name") ?? "Video",
    size: params.get("size") ?? "",
    folder: params.get("folder") ?? "My library",
    series,
    imdbId: params.get("imdb") ?? undefined,
    season: params.has("season") ? Number(params.get("season")) : undefined,
    episode: params.has("episode") ? Number(params.get("episode")) : undefined,
    queueSource: readQueueSource(params),
    customQueue: params.get("queue") === "custom",
    queueLabel: params.get("queueLabel") ?? undefined,
    queueFolder: params.get("queueFolder") ?? undefined,
    queueSort: params.get("queueSort") ?? undefined,
    queueDirection: params.get("queueDirection") ?? undefined,
    queueShuffle: params.get("queueShuffle") === "1",
    queueShuffleSeed: params.get("queueShuffleSeed") ?? undefined,
    startAt: Number(params.get("start") ?? 0) || 0,
    playIntent: params.get("play") === "1",
    playAttemptId: params.get("playAttempt") ?? (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`),
    playAttemptStartedAt: Number(params.get("playStartedAt") ?? 0) || Date.now(),
    kind: params.get("kind") ?? "video",
    moviesTv: params.get("catalog") === "movies_tv",
    catalogKind: params.get("catalogKind") === "movie" || params.get("catalogKind") === "series" || params.get("catalogKind") === "episode"
      ? params.get("catalogKind") as "movie" | "series" | "episode"
      : undefined,
  };
};

const detailsMediaPath = (details: WatchDetails) => details.sourcePath
  ?? (details.src.startsWith(`${API_BASE}/media/`) ? decodeURIComponent(details.src.slice(`${API_BASE}/media/`.length)) : "");

const browseReturnUrl = (details: WatchDetails | null, search: string) => {
  if (typeof window === "undefined") return "/";
  const explicit = new URLSearchParams(search).get("return");
  // Only accept an in-app browse route. A Watch URL may be opened directly,
  // so it must never turn the Back button into an external redirect.
  if (explicit?.startsWith("/") && !explicit.startsWith("//") && !explicit.startsWith("/watch")) return explicit;
  if (!details) return "/";
  const libraryRoot = details.folder.split("/").filter(Boolean)[0];
  // Catalog titles should return to their library's Movies & Shows top level;
  // ordinary media returns to the folder containing the actual file.
  const folder = details.moviesTv ? libraryRoot : details.folder;
  return folder ? `/?${new URLSearchParams({ folder })}` : "/";
};

const paramsForItem = (item: MediaItem, base: WatchDetails, search: string) => {
  const params = new URLSearchParams({ name: item.name, size: item.size, folder: item.parent ?? base.folder, kind: item.kind });
  if (typeof window !== "undefined") {
    const sessionId = new URLSearchParams(search).get("playbackSession");
    if (sessionId) params.set("playbackSession", sessionId);
  }
  if (item.offline?.bundleId && item.offline.fileId) {
    params.set("offlineBundle", item.offline.bundleId);
    params.set("offlineFile", item.offline.fileId);
  } else if (item.src) {
    params.set("src", item.src);
  }
  if (item.path) params.set("path", item.path);
  if (base.series) params.set("series", base.series);
  if (base.imdbId && (!base.series || item.path?.startsWith(`${base.series}/`))) {
    params.set("imdb", base.imdbId);
    if (base.series) {
      const episode = episodeNumbers(`${item.parent ?? ""}/${item.name}`);
      if (episode) {
        params.set("season", String(episode.season));
        params.set("episode", String(episode.episode));
      }
    }
  }
  if (base.queueSource) {
    writeQueueSource(params, base.queueSource);
    if (base.queueLabel) params.set("queueLabel", base.queueLabel);
  }
  if (base.customQueue) {
    params.set("queue", "custom");
    if (base.queueLabel) params.set("queueLabel", base.queueLabel);
  }
  if (base.queueFolder && !isMovieWatch(base)) {
    params.set("queueFolder", base.queueFolder);
    if (base.queueSort) params.set("queueSort", base.queueSort);
    if (base.queueDirection) params.set("queueDirection", base.queueDirection);
    if (base.queueShuffle) params.set("queueShuffle", "1");
    if (base.queueShuffleSeed) params.set("queueShuffleSeed", base.queueShuffleSeed);
    if (base.queueLabel) params.set("queueLabel", base.queueLabel);
  }
  if (base.moviesTv) params.set("catalog", "movies_tv");
  if (base.catalogKind) params.set("catalogKind", base.catalogKind);
  if (base.playIntent) params.set("play", "1");
  if (base.playAttemptId) params.set("playAttempt", base.playAttemptId);
  if (base.playAttemptStartedAt) params.set("playStartedAt", String(base.playAttemptStartedAt));
  if (!base.queueSource && typeof window !== "undefined") {
    const returnTo = new URLSearchParams(search).get("return");
    if (returnTo?.startsWith("/") && !returnTo.startsWith("//") && !returnTo.startsWith("/watch")) params.set("return", returnTo);
  }
  return params;
};

const watchDetailsFromItem = (item: MediaItem, base: WatchDetails): WatchDetails => {
  const next: WatchDetails = {
    ...base,
    queueSource: base.queueSource ? queueSourceForItem(base.queueSource, item) : undefined,
    src: item.src!,
    sourcePath: item.path,
    offline: Boolean(item.offline?.bundleId && item.offline.fileId),
    offlineBundleId: item.offline?.bundleId,
    offlineFileId: item.offline?.fileId,
    name: item.name,
    size: item.size,
    folder: item.parent ?? base.folder,
    startAt: 0,
    kind: item.kind,
    catalogKind: item.catalogKind,
    series: base.series && item.path?.startsWith(`${base.series}/`) ? base.series : undefined,
    imdbId: (base.series ? item.path?.startsWith(`${base.series}/`) : item.parent === base.folder) ? base.imdbId : undefined,
    season: undefined,
    episode: undefined,
  };
  if (base.series && item.path?.startsWith(`${base.series}/`)) {
    const episode = episodeNumbers(`${item.parent ?? ""}/${item.name}`);
    if (episode) {
      next.season = episode.season;
      next.episode = episode.episode;
    }
  }
  return next;
};

const sendPlaybackActivity = (details: WatchDetails, event: "started" | "resumed" | "paused" | "stopped" | "completed", position: number, duration: number) => {
  if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return;
  const path = detailsMediaPath(details);
  const completed = event === "completed" || (isShowWatch(details) && episodeFinished({ position, duration, updated: 0 }));
  const progress = { position: Math.max(0, position), duration, updated: Math.floor(Date.now() / 1000), completed };
  writeLocalWatchProgress(getSessionUser()?.id, path, progress);
  if (savesWatchProgress(path)) updateSnapshotPlayback(path, progress);
  if (details.offline) return;
  void authFetch(`${API_BASE}/api/activity`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ save_progress: savesWatchProgress(path), event: completed ? "completed" : event, media_name: details.name, path, position: Math.max(0, position), duration: Math.max(0, duration) }),
    keepalive: true,
  }).catch(() => undefined);
};

export default function WatchPage({ companionInstance, foregroundMedia = false }: { companionInstance?: WatchInstance; foregroundMedia?: boolean } = {}) {
  const sharedMode = useWatchMode();
  const watchMode = companionInstance?.mode ?? sharedMode;
  const companionRef = useRef(companionInstance);
  companionRef.current = companionInstance;
  const foregroundRef = useRef(foregroundMedia);
  foregroundRef.current = foregroundMedia;
  const privateSession = useRef<PlaybackSession | null>(companionInstance ? restoreSharedPlaybackSession(getSessionUser()?.id) : null);
  const watchLocationSearch = () => companionRef.current ? new URL(companionRef.current.url, "http://tms.local").search : sharedWatchLocationSearch();
  const detailsFromLocation = () => {
    const search = watchLocationSearch();
    traceFromParams(new URLSearchParams(search));
    return parseWatchDetails(search);
  };
  const browseReturnUrlFromLocation = (details: WatchDetails | null) => browseReturnUrl(details, watchLocationSearch());
  const watchParamsFromItem = (item: MediaItem, base: WatchDetails) => paramsForItem(item, base, watchLocationSearch());
  const replaceWatchLocation = (url: string) => companionRef.current ? updateCompanionWatch(url) : replaceSharedWatchLocation(url);
  const closeWatch = (url?: string) => companionRef.current ? closeCompanionWatch() : closeSharedWatch(url);
  const expandWatch = () => companionRef.current ? expandCompanionWatch() : expandSharedWatch();
  const leaveWatch = (url: string) => companionRef.current ? minimizeCompanionWatch() : leaveSharedWatch(url);
  const minimizeWatch = (url: string) => companionRef.current ? minimizeCompanionWatch() : minimizeSharedWatch(url);
  const setWatchBackHandler = (handler: (() => void) | null) => { if (!companionRef.current || companionRef.current.mode === "full") setSharedWatchBackHandler(handler); };
  const restorePlaybackSession = (userId?: number) => companionRef.current ? privateSession.current : restoreSharedPlaybackSession(userId);
  const setPlaybackSession = (session: PlaybackSession | null) => { if (companionRef.current) privateSession.current = session; else setSharedPlaybackSession(session); };
  const startPlaybackSession: typeof startSharedPlaybackSession = input => {
    if (!companionRef.current) return startSharedPlaybackSession(input);
    const session = { ...input, id: companionRef.current.id, returnUrl: input.returnUrl ?? "/", savedAt: Date.now() };
    privateSession.current = session;
    return session;
  };
  const watchModeRef = useRef(watchMode);
  useLayoutEffect(() => {
    watchModeRef.current = watchMode;
  }, [watchMode]);
  const watchTitleRef = useRef("");
  const mainRef = useRef<HTMLElement>(null);
  const [hydrated, setHydrated] = useState(false);
  const [details, setDetails] = useState<WatchDetails | null>(null);
  const [heading, setHeading] = useState<{ title: string; subtitle: string } | null>(null);
  const [seriesVideos, setSeriesVideos] = useState<TitleMetadata["videos"]>(undefined);
  const queueItemThumb = (item: { name: string; parent?: string; thumbSrc?: string }) => {
    const numbers = episodeNumbers(`${item.parent ?? ""}/${item.name}`);
    return (numbers && resolveEpisodeMetadata(seriesVideos, numbers.season, numbers.episode)?.thumbnail) || item.thumbSrc;
  };
  const queueItemLabel = (item: { name: string; parent?: string }) => {
    const fallback = item.name.replace(/\.(mkv|mp4|m4v|avi|mov|webm|wmv|ts)$/i, "");
    const numbers = episodeNumbers(`${item.parent ?? ""}/${item.name}`);
    if (!numbers) return fallback;
    const video = resolveEpisodeMetadata(seriesVideos, numbers.season, numbers.episode);
    const name = video?.name ?? video?.title;
    return name ? `${numbers.episode}. ${name}` : `Episode ${numbers.episode}`;
  };
  const [catalogResolveError, setCatalogResolveError] = useState("");
  const detailsRef = useRef<WatchDetails | null>(null);
  const exitingRef = useRef(false);
  const catalogResolutionStartedRef = useRef(false);
  const videoLoadStartedRef = useRef<number | null>(null);
  const reportedWatchLoadRef = useRef<string | null>(null);
  const reportedPlaybackAttemptRef = useRef<string | null>(null);
  detailsRef.current = details;
  // Playback quality per video: whether it started, and how often it stalled
  // once playing. Seeks and quality switches are not counted as stalls.
  const playbackQualityRef = useRef({ src: "", openedAt: 0, intent: false, started: false, failed: false, mode: "direct", quality: "", watchedMs: 0, lastTickAt: 0, stallCount: 0, stallMs: 0, stallStartedAt: 0 });
  const flushPlaybackQuality = useCallback(() => {
    const session = playbackQualityRef.current;
    if (session.stallStartedAt) {
      session.stallMs += performance.now() - session.stallStartedAt;
      session.stallStartedAt = 0;
    }
    if (session.started && session.watchedMs >= 5_000) {
      reportClientPerformance("playback_session", session.watchedMs, {
        watched_ms: Math.round(session.watchedMs),
        stall_count: session.stallCount,
        stall_ms: Math.round(session.stallMs),
        mode: session.mode,
        quality: session.quality,
      });
    }
    session.watchedMs = 0;
    session.stallCount = 0;
    session.stallMs = 0;
    session.lastTickAt = 0;
  }, []);
  useEffect(() => {
    if (!details?.src || details.kind !== "video") return;
    playbackQualityRef.current = { src: details.src, openedAt: performance.now(), intent: Boolean(details.playIntent), started: false, failed: false, mode: "direct", quality: "", watchedMs: 0, lastTickAt: 0, stallCount: 0, stallMs: 0, stallStartedAt: 0 };
    const flushWhenHidden = () => { if (document.visibilityState === "hidden") flushPlaybackQuality(); };
    document.addEventListener("visibilitychange", flushWhenHidden);
    return () => {
      document.removeEventListener("visibilitychange", flushWhenHidden);
      flushPlaybackQuality();
    };
  }, [details?.src, details?.kind, details?.playIntent, flushPlaybackQuality]);

  useEffect(() => {
    if (details?.src && details?.kind === "video") {
      videoLoadStartedRef.current = performance.now();
    }
  }, [details?.src, details?.kind]);

  useEffect(() => {
    if (details?.playAttemptId && details?.playAttemptStartedAt && reportedWatchLoadRef.current !== details.playAttemptId) {
      reportedWatchLoadRef.current = details.playAttemptId;
      reportClientPerformance("watch_page_loaded", Date.now() - details.playAttemptStartedAt, {
        attempt_id: details.playAttemptId,
        media_name: details.name,
      });
    }
  }, [details?.playAttemptId, details?.playAttemptStartedAt, details?.name]);

  const applyQueue = useCallback((next: MediaItem[] | ((current: MediaItem[]) => MediaItem[])) => {
    if (detailsRef.current && !detailsRef.current.queueSource && !detailsRef.current.customQueue && isMovieWatch(detailsRef.current)) {
      setQueue([]);
      return;
    }
    setQueue(next);
  }, []);
  const [ratio, setRatio] = useState(16 / 9);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [seekHover, setSeekHover] = useState<{ time: number; left: number; frameTime: number } | null>(null);
  const [volume, setVolume] = useState(readStoredVolumePosition);
  const [muted, setMuted] = useState(() => typeof window !== "undefined" ? window.localStorage.getItem("tms_muted") === "true" : false);
  const [playbackRate, setPlaybackRate] = useState(() => typeof window !== "undefined" ? Number(window.sessionStorage.getItem("tms_speed") ?? 1) : 1);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem("tms_volume", volume.toString());
      window.localStorage.setItem("tms_muted", muted.toString());
    }
  }, [volume, muted]);
  const [tracks, setTracks] = useState<SubtitleTrack[]>([]);
  const [audioTracks, setAudioTracks] = useState<AudioTrack[]>([]);
  const [selectedAudioStream, setSelectedAudioStream] = useState<number | null>(null);
  // Enabled captions are a per-account preference, loaded with user state.
  // A track index is not durable because each video exposes different tracks.
  const [caption, setCaption] = useState("off");
  const [burnedSubtitleStream, setBurnedSubtitleStream] = useState<number | null>(null);
  const [cues, setCues] = useState<CaptionCue[]>([]);
  const [captionStatus, setCaptionStatus] = useState<CaptionStatus>({ state: "idle", label: "Off" });
  const [captionSelection, setCaptionSelection] = useState<CaptionSelection | null>(null);
  const [captionSelectionLoaded, setCaptionSelectionLoaded] = useState(false);
  const [quality, setQuality] = useState("original");
  const [qualityLevels, setQualityLevels] = useState<number[]>([720, 480, 360]);
  const [sourceHeight, setSourceHeight] = useState(0);
  const [resolvedQuality, setResolvedQuality] = useState(0);
  const [qualityMenuOpen, setQualityMenuOpen] = useState(false);
  const [captionMenuOpen, setCaptionMenuOpen] = useState(false);
  const [captionSettingsOpen, setCaptionSettingsOpen] = useState(false);
  const [audioMenuOpen, setAudioMenuOpen] = useState(false);
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [volumeMenuOpen, setVolumeMenuOpen] = useState(false);
  const [playerFullscreen, setPlayerFullscreen] = useState(false);
  const [queueMenuOpen, setQueueMenuOpen] = useState(false);
  const [queueMenuPosition, setQueueMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const [qualityBusy, setQualityBusy] = useState(false);
  const [playbackError, setPlaybackError] = useState("");
  const [controlsVisible, setControlsVisible] = useState(true);
  const [captionControlsOffset, setCaptionControlsOffset] = useState(0);
  const [queue, setQueueState] = useState<MediaItem[]>([]);
  const setQueue = (update: MediaItem[] | ((current: MediaItem[]) => MediaItem[])) => setQueueState(current => {
    const next = typeof update === "function" ? update(current) : update;
    return companionRef.current ? next.filter(item => playsAlongside(item.path)) : next;
  });
  const [queueLoadStatus, setQueueLoadStatus] = useState<"idle" | "loading" | "error">("idle");
  const queueTimingRef = useRef<string | null>(null);
  useEffect(() => {
    if (!details?.playAttemptId || !details.playAttemptStartedAt) return;
    const trace = { id: details.playAttemptId, startedAt: details.playAttemptStartedAt };
    if (queueLoadStatus === "loading") {
      queueTimingRef.current = trace.id;
      playbackTracePhase("queue_loading", {}, trace);
      return;
    }
    if (queueTimingRef.current !== trace.id) return;
    if (queueLoadStatus === "error") {
      playbackTracePhase("queue_failed", {}, trace);
      return;
    }
    playbackTracePhase("queue_ready", { queue_items: queue.length }, trace);
    let painted = 0;
    // The second frame runs after the first committed queue could be painted.
    const frame = requestAnimationFrame(() => {
      painted = requestAnimationFrame(() => {
        queueTimingRef.current = null;
        playbackTracePhase("queue_presented", { queue_items: queue.length, visibility: document.visibilityState }, trace);
      });
    });
    return () => { cancelAnimationFrame(frame); cancelAnimationFrame(painted); };
  }, [details?.playAttemptId, details?.playAttemptStartedAt, queueLoadStatus, queue.length]);
  const [queueRetry, setQueueRetry] = useState(0);
  const draggedQueueIndexRef = useRef<number | null>(null);
  const [queueDropIndex, setQueueDropIndex] = useState<number | null>(null);
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [favorite, setFavorite] = useState(false);
  const [organizeOpen, setOrganizeOpen] = useState(false);
  const [organizeActive, setOrganizeActive] = useState(false);
  const [savedPlayback, setSavedPlayback] = useState<PlaybackState | null | undefined>(undefined);
  const [savedPlaybackLoaded, setSavedPlaybackLoaded] = useState(false);
  const [metadataLoaded, setMetadataLoaded] = useState(false);
  const [skipData, setSkipData] = useState<SkipSegmentsResponse | null>(null);
  const [skipDataLoading, setSkipDataLoading] = useState(false);
  const [skipDataError, setSkipDataError] = useState("");
  const [skipEvidenceOpen, setSkipEvidenceOpen] = useState(false);
  const [skipRefresh, setSkipRefresh] = useState(0);
  const [pip, setPip] = useState(false);
  const [canPip, setCanPip] = useState(false);

  useEffect(() => {
    if (typeof window !== "undefined") {
      // Playback speed applies only to this browser session. It intentionally
      // resets to 1× when the app is closed and started again.
      window.localStorage.removeItem("tms_speed");
      window.sessionStorage.setItem("tms_speed", playbackRate.toString());
      window.localStorage.removeItem("tms_caption");
      if (playerFullscreen) window.localStorage.setItem("tms_fullscreen", "true");
      else window.localStorage.removeItem("tms_fullscreen");
    }
  }, [playbackRate, caption, playerFullscreen]);

  useEffect(() => {
    // The next episode can start in the mini player; it must stay small.
    if (typeof window !== "undefined" && watchModeRef.current === "full" && window.localStorage.getItem("tms_fullscreen") === "true") {
      if (!document.fullscreenElement) {
        playerRef.current?.requestFullscreen().catch(() => {});
      }
    }
  }, [details?.src]);

  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    // TMS is always immersive on Android (see MainActivity). Never show the
    // system bars from the web layer, or they overlap the page header.
    const syncNativeBars = () => {
      StatusBar.hide().catch(console.error);
      NavigationBar.hide().catch(console.error);
    };

    syncNativeBars();

    const handleFocusOrResume = () => {
      syncNativeBars();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        syncNativeBars();
      }
    };

    window.addEventListener("focus", handleFocusOrResume);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    let appStateHandle: { remove: () => void } | null = null;
    let resumeHandle: { remove: () => void } | null = null;

    App.addListener("appStateChange", ({ isActive }) => {
      if (isActive) {
        syncNativeBars();
      }
    }).then((h) => {
      appStateHandle = h;
    }).catch(console.error);

    App.addListener("resume", () => {
      syncNativeBars();
    }).then((h) => {
      resumeHandle = h;
    }).catch(console.error);

    return () => {
      window.removeEventListener("focus", handleFocusOrResume);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      appStateHandle?.remove();
      resumeHandle?.remove();
    };
  }, [playerFullscreen]);
  const [playbackPreferences, setPlaybackPreferences] = useState<PlaybackPreferences>(DEFAULT_PLAYBACK_PREFERENCES);
  const [bufferedRanges, setBufferedRanges] = useState<Array<{ start: number; end: number }>>([]);
  const [loadingTarget, setLoadingTarget] = useState<number | null>(null);
  const [bufferingWithoutPosition, setBufferingWithoutPosition] = useState(false);
  // A buffering target is a requested position, not the position currently
  // playing. Using it here made a late event from the prior episode render the
  // new episode as if it were already at the end.
  const displayedTime = currentTime;
  const timelineSkipSegments = duration > 0 ? (skipData?.segments ?? []).flatMap((segment) => {
    const start = Math.max(0, Math.min(duration, segment.start));
    const end = Math.max(start, Math.min(duration, segment.end));
    return end > start ? [{ ...segment, start, end }] : [];
  }) : [];
  const timelineSections = duration > 0 ? (() => {
    let cursor = 0;
    const sections: Array<{ start: number; end: number }> = [];
    [...timelineSkipSegments].sort((a, b) => a.start - b.start).forEach((segment) => {
      if (segment.start > cursor) sections.push({ start: cursor, end: segment.start });
      if (segment.end > cursor) {
        sections.push({ start: Math.max(cursor, segment.start), end: segment.end });
        cursor = segment.end;
      }
    });
    if (cursor < duration) sections.push({ start: cursor, end: duration });
    return sections;
  })() : [];
  const videoRef = useRef<HTMLVideoElement>(null);
  const [loadStalled, setLoadStalled] = useState(false);
  const [videoLoadError, setVideoLoadError] = useState(false);
  const queueNavigationPathRef = useRef<string | null>(null);
  const videoSlotsRef = useRef<Array<HTMLVideoElement | null>>([null, null]);
  const [activeVideoSlot, setActiveVideoSlot] = useState(0);
  const [preparedVideo, setPreparedVideo] = useState<{ slot: number; src: string } | null>(null);
  const preparedVideoRef = useRef(preparedVideo);
  preparedVideoRef.current = preparedVideo;
  const backgroundAudioRef = useRef<HTMLAudioElement | null>(null);
  const backgroundAudioHlsRef = useRef<Hls | null>(null);
  const backgroundAudioHandoffAtRef = useRef(0);
  const backgroundAudioRestartingRef = useRef(false);
  const backgroundAudioStartingRef = useRef(false);
  const backgroundAudioGenerationRef = useRef(0);
  const nativeBackgroundRef = useRef(false);
  const audioOnlyRef = useRef(false);
  const continueBackgroundAudioRef = useRef(false);
  const backgroundAudioCallbacksRef = useRef<{
    timeupdate: (audio: HTMLAudioElement) => void;
    ended: (audio: HTMLAudioElement) => void;
    retry: () => void;
    start: (automatic?: boolean) => Promise<void>;
  } | null>(null);
  const [audioOnly, setAudioOnly] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoHostRef = useRef<MediaShadowHost>(null);
  const videoShadowRef = useRef<ShadowRoot | null>(null);
  const [videoShadow, setVideoShadow] = useState<ShadowRoot | null>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const queueTriggerRef = useRef<HTMLDivElement>(null);
  const queueMenuRef = useRef<HTMLDivElement>(null);
  const lastSavedAt = useRef(0);
  const hlsRef = useRef<Hls | null>(null);
  const controlsTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const controlsVisibleRef = useRef(controlsVisible);
  const preserveHiddenControlsRef = useRef(false);
  const volumeHoverRef = useRef(false);
  const volumeHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const streamOffsetRef = useRef(0);
  const sourceDurationRef = useRef(0);
  const qualityBusyRef = useRef(false);
  const shouldPlayRef = useRef(false);
  const qualityRequestRef = useRef(0);
  const activeTranscodeSessionRef = useRef<string | null>(null);
  const directPlaybackCompatibleRef = useRef(true);
  // The device decodes the source video, so HLS can copy it instead of re-encoding.
  const videoCopyableRef = useRef(false);
  const audioLanguageRef = useRef("en");
  const videoInfoCacheRef = useRef(new Map<string, VideoInfo>());
  const nextUserStateRef = useRef<{ path: string; userId: number | undefined; state: UserState } | null>(null);
  const preloadedFragmentsRef = useRef(new Map<string, ArrayBuffer>());
  const nextPreloadRef = useRef<{ path: string; session: string; quality: string; audio: number | null; subtitle: number | null; start: number } | null>(null);
  const [audioCompatibilityChecked, setAudioCompatibilityChecked] = useState(false);
  const [audioTracksLoaded, setAudioTracksLoaded] = useState(false);
  const pendingInitialTranscodeRef = useRef(false);
  const loadingTargetRef = useRef<number | null>(null);
  const sourceHeightRef = useRef(0);
  const initialResumeRef = useRef(0);
  const initialResumeAppliedRef = useRef("");
  const playbackHandoffRef = useRef<ReturnType<typeof readPlaybackHandoff>>(null);
  const lastActivityRef = useRef({ signature: "", sentAt: 0 });
  const lastRemoteSaveAt = useRef(0);
  const bufferedSignatureRef = useRef("");
  const autoSkippedRef = useRef(new Set<string>());
  useEffect(() => {
    controlsVisibleRef.current = controlsVisible;
  }, [controlsVisible]);
  useEffect(() => {
    let cancelled = false;
    const frame = window.requestAnimationFrame(() => {
      const initial = detailsFromLocation();
      if (initial?.offline && initial.offlineBundleId && initial.offlineFileId) {
        void resolveOfflineFileUrl(initial.offlineBundleId, initial.offlineFileId).then((resolved) => {
          if (!cancelled) setDetails({ ...initial, src: resolved.url, sourcePath: resolved.file.path });
        }).catch((error) => {
          if (!cancelled) setCatalogResolveError(error instanceof Error ? error.message : "Could not open this downloaded file.");
        }).finally(() => { if (!cancelled) setHydrated(true); });
      } else {
        setDetails(initial);
        setHydrated(true);
      }
      setCanPip(
        nativePipAvailable() || "pictureInPictureEnabled" in document ||
        "webkitSetPresentationMode" in HTMLVideoElement.prototype
      );
    });
    return () => { cancelled = true; window.cancelAnimationFrame(frame); };
  }, []);

  useEffect(() => {
    const params = new URLSearchParams(watchLocationSearch());
    const trace = traceFromParams(params);
    playbackTracePhase("watch_navigation_arrived", {}, trace);
    const catalogPath = params.get("catalogPath");
    const catalogKind = params.get("catalogKind");
    if (!catalogPath || (catalogKind !== "movie" && catalogKind !== "series") || catalogResolutionStartedRef.current) return;

    // The library page deliberately navigates before this work begins. That
    // keeps every Play action responsive even when a title has many seasons.
    catalogResolutionStartedRef.current = true;
    playbackTracePhase("catalog_resolution_started", {}, trace);
    const resolutionStartedAt = Date.now();
    let cancelled = false;
    void (async () => {
      const entries: ApiLibraryEntry[] = [];
      // Needed only after the title's files are known, so fetch it alongside them.
      const statePromise = sharedJson<UserState>(playbackUserStateUrl(API_BASE), authFetch)
        .catch((): UserState => ({ favorites: [], playback: {} }));
      const catalogExtension = catalogPath.split("/").at(-1)?.split(".").at(-1)?.toLowerCase() ?? "";
      if (catalogKind === "movie" && (supportedFormats.video as readonly string[]).includes(catalogExtension)) {
        const separator = catalogPath.lastIndexOf("/");
        const parent = separator >= 0 ? catalogPath.slice(0, separator) : "";
        const directQuery = new URLSearchParams({ folder: parent, sort: "name", direction: "asc", limit: "100000" });
        const directResponse = await authFetch(`${API_BASE}/api/library?${directQuery}`);
        if (directResponse.ok) {
          const siblings = await directResponse.json() as ApiLibraryEntry[];
          const directVideo = siblings.find((entry) => entry.kind !== "folder" && entry.path === catalogPath);
          if (directVideo) entries.push(directVideo);
        }
      }
      if (!entries.length) {
        // One recursive request covers every season. The queue reuses it.
        let subtree: ApiLibraryEntry[] = [];
        let failedStatus: number | undefined;
        try {
          subtree = await sharedJson<ApiLibraryEntry[]>(librarySubtreeUrl(API_BASE, catalogPath), authFetch);
        } catch (error) {
          failedStatus = (error as { status?: number }).status ?? 0;
        }
        const prefix = `${catalogPath}/`;
        for (const entry of subtree) {
          if (entry.kind !== "folder" && entry.path.startsWith(prefix)) entries.push(entry);
        }
        if (!entries.length && catalogKind === "movie") {
          // A movie stored directly in a library is itself the catalog title.
          // Resolve that exact file through its parent folder listing.
          const separator = catalogPath.lastIndexOf("/");
          const parent = separator >= 0 ? catalogPath.slice(0, separator) : "";
          const directQuery = new URLSearchParams({ folder: parent, sort: "name", direction: "asc", limit: "100000" });
          const directResponse = await authFetch(`${API_BASE}/api/library?${directQuery}`);
          if (directResponse.ok) {
            const siblings = await directResponse.json() as ApiLibraryEntry[];
            const directVideo = siblings.find((entry) => entry.kind !== "folder" && entry.path === catalogPath);
            if (directVideo) entries.push(directVideo);
          }
        }
        if (!entries.length && failedStatus !== undefined) {
          throw new Error(`Could not open this title (server returned ${failedStatus}).`);
        }
      }
      const videos = entries.map(apiEntryToMediaItem).filter((item): item is MediaItem => Boolean(item?.src && item.kind === "video"));
      if (!videos.length) throw new Error("No playable video was found for this title.");
      const state = await statePromise;
      const ordered = catalogKind === "movie"
        ? [...videos].sort((left, right) => (right.sizeBytes ?? 0) - (left.sizeBytes ?? 0))
        : [...videos].sort((left, right) => {
          const leftEpisode = episodeNumbers(`${left.parent ?? ""}/${left.name}`);
          const rightEpisode = episodeNumbers(`${right.parent ?? ""}/${right.name}`);
          const leftOrder = leftEpisode ? leftEpisode.season * 10000 + leftEpisode.episode : Number.MAX_SAFE_INTEGER;
          const rightOrder = rightEpisode ? rightEpisode.season * 10000 + rightEpisode.episode : Number.MAX_SAFE_INTEGER;
          return leftOrder - rightOrder || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
        });
      const playback = mergeWatchProgress(state.playback, readLocalWatchProgress(getSessionUser()?.id));
      const target = (catalogKind === "series" ? selectSeriesEpisode(ordered, playback) : undefined) ?? ordered[0];
      const targetProgress = playback[target.path ?? ""];
      const targetEpisode = episodeNumbers(`${target.parent ?? ""}/${target.name}`);
      const next = new URLSearchParams({ src: target.src!, name: target.name, size: target.size, folder: target.parent ?? catalogPath, kind: target.kind, catalog: "movies_tv", catalogKind: catalogKind === "series" ? "episode" : "movie", play: "1" });
      if (trace) writePlaybackTrace(next, trace);
      const returnTo = params.get("return");
      if (returnTo?.startsWith("/") && !returnTo.startsWith("//") && !returnTo.startsWith("/watch")) next.set("return", returnTo);
      const suppliedImdb = params.get("imdb");
      if (suppliedImdb?.startsWith("tt")) next.set("imdb", suppliedImdb);
      if (catalogKind === "series") {
        next.set("series", catalogPath);
        if (targetEpisode) {
          next.set("season", String(targetEpisode.season));
          next.set("episode", String(targetEpisode.episode));
        }
      }
      if (!next.get("imdb")) {
        const catalogTitle = pathLeaf(catalogPath);
        if (catalogTitle) {
          const metadataQuery = new URLSearchParams({ title: catalogTitle, kind: catalogKind === "series" ? "series" : "movie" });
          if (targetEpisode) {
            metadataQuery.set("seasons", String(targetEpisode.season));
            metadataQuery.set("episodes", String(targetEpisode.episode));
          }
          const metadataResponse = await authFetch(`${API_BASE}/api/title-metadata?${metadataQuery}`);
          if (metadataResponse.ok) {
            const metadata = await metadataResponse.json() as TitleMetadata;
            if (metadata.id?.startsWith("tt")) next.set("imdb", metadata.id);
          }
        }
      }
      if (targetProgress && !targetProgress.completed && !(catalogKind === "series" && episodeFinished(targetProgress))) next.set("start", String(Math.floor(targetProgress.position)));
      if (cancelled) return;
      playbackTracePhase("catalog_resolution_completed", { stage_duration_ms: Date.now() - resolutionStartedAt,
        library_entries: entries.length, playable_items: videos.length }, trace);
      replaceWatchLocation(`/watch?${next.toString()}`);
      setDetails(detailsFromLocation());
    })().catch((error: unknown) => {
      playbackTracePhase(cancelled ? "catalog_resolution_cancelled" : "catalog_resolution_failed", {
        stage_duration_ms: Date.now() - resolutionStartedAt,
        outcome: error instanceof Error ? error.name : "error",
      }, trace);
      if (!cancelled) setCatalogResolveError(error instanceof Error ? error.message : "Could not open this title.");
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const enterPip = () => setPip(true);
    const leavePip = () => setPip(false);
    // iOS Safari
    const presentationModeChange = () => {
      // @ts-ignore
      setPip(video.webkitPresentationMode === "picture-in-picture");
    };

    video.addEventListener("enterpictureinpicture", enterPip);
    video.addEventListener("leavepictureinpicture", leavePip);
    video.addEventListener("webkitpresentationmodechanged", presentationModeChange);
    return () => {
      video.removeEventListener("enterpictureinpicture", enterPip);
      video.removeEventListener("leavepictureinpicture", leavePip);
      video.removeEventListener("webkitpresentationmodechanged", presentationModeChange);
    };
  }, [videoShadow, activeVideoSlot]); // rebind when the buffered player becomes active

  useLayoutEffect(() => {
    const host = videoHostRef.current;
    if (!host || details?.kind === "image") {
      videoShadowRef.current = null;
      setVideoShadow(null);
      return;
    }
    if (!videoShadowRef.current) {
      const shadow = getMediaShadowRoot(host);
      const style = document.createElement("style");
      style.textContent = WATCH_VIDEO_ENGINE_STYLES;
      shadow.appendChild(style);
      videoShadowRef.current = shadow;
    }
    setVideoShadow(videoShadowRef.current);
    return () => {
      videoShadowRef.current = null;
      setVideoShadow(null);
    };
  }, [details?.kind, hydrated]);

  useEffect(() => {
    const video = videoRef.current;
    return () => { if (video) releaseMediaVolume(video); };
  }, [videoShadow, activeVideoSlot]);

  useEffect(() => {
    if (details?.kind === "image") return;
    let frameId = 0;
    const tick = () => {
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (video && canvas) paintVideoSurface(video, canvas);
      frameId = requestAnimationFrame(tick);
    };
    frameId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frameId);
  }, [details?.kind, videoShadow]);

  useEffect(() => {
    if (!details) return;
    const seriesName = pathLeaf(details.series);
    const episode = episodeIdentity(details);
    const isShow = Boolean(seriesName && episode);
    const baseTitle = isShow && episode
      ? `${seriesName} - ${episode.code} - ${TAB_TITLE_SUFFIX}`
      : details.moviesTv && details.kind === "video"
        ? `${movieTitleCandidate(details)} - ${TAB_TITLE_SUFFIX}`
        : `${fileLabel(details.name) || "Media"} - ${TAB_TITLE_SUFFIX}`;
    // The mini player shares the tab with the library, which keeps the app title.
    const showTitle = (title: string) => {
      watchTitleRef.current = title;
      if (watchModeRef.current === "full") document.title = title;
    };
    showTitle(baseTitle);
    const episodeLine = (name?: string) => episode ? [`S${episode.season} · E${episode.episode}`, name].filter(Boolean).join(" · ") : "";
    setHeading(isShow && episode
      ? { title: seriesName, subtitle: episodeLine() }
      : details.moviesTv && details.kind === "video"
        ? { title: movieTitleCandidate(details), subtitle: "" }
        : null);

    if (!details.moviesTv || details.kind !== "video") return () => {
      document.title = TAB_TITLE_SUFFIX;
    };

    const catalogTitle = isShow ? seriesName : movieTitleCandidate(details);
    if (!catalogTitle) return () => {
      document.title = TAB_TITLE_SUFFIX;
    };
    const params = new URLSearchParams({
      title: catalogTitle,
      kind: isShow ? "series" : "movie",
    });
    if (episode) {
      params.set("seasons", String(episode.season));
      params.set("episodes", String(episode.episode));
    }
    let cancelled = false;
    void fetch(`${API_BASE}/api/title-metadata?${params}`)
      .then((response) => response.ok ? response.json() as Promise<TitleMetadata> : Promise.reject(new Error(`HTTP ${response.status}`)))
      .then((metadata) => {
        if (cancelled) return;
        if (metadata.id?.startsWith("tt")) {
          setDetails((current) => {
            if (!current || current.imdbId === metadata.id) return current;
            const nextParams = new URLSearchParams(watchLocationSearch());
            nextParams.set("imdb", metadata.id!);
            replaceWatchLocation(`/watch?${nextParams.toString()}`);
            return { ...current, imdbId: metadata.id };
          });
        }
        if (isShow && episode) {
          const resolvedEpisode = resolveEpisodeMetadata(metadata.videos, episode.season, episode.episode);
          const episodeName = resolvedEpisode?.name ?? resolvedEpisode?.title;
          showTitle(`${metadata.name || seriesName} - ${episodeName || episode.code} - ${episode.code} - ${TAB_TITLE_SUFFIX}`);
          setHeading({ title: metadata.name || seriesName, subtitle: episodeLine(episodeName) });
          setSeriesVideos(metadata.videos);
          return;
        }
        showTitle(`${metadata.name || catalogTitle} - ${TAB_TITLE_SUFFIX}`);
        setHeading({ title: metadata.name || catalogTitle, subtitle: "" });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      document.title = TAB_TITLE_SUFFIX;
    };
  }, [details]);

  useEffect(() => {
    const stopTranscodeOnExit = () => {
      const warmSession = nextPreloadRef.current?.session;
      nextPreloadRef.current = null;
      if (warmSession) void fetch(`${API_BASE}/api/transcode?session=${encodeURIComponent(warmSession)}`, { method: "DELETE", keepalive: true }).catch(() => undefined);
      const session = activeTranscodeSessionRef.current;
      activeTranscodeSessionRef.current = null;
      if (session) {
        void fetch(`${API_BASE}/api/transcode?session=${encodeURIComponent(session)}`, {
          method: "DELETE",
          keepalive: true,
        }).catch(() => undefined);
      }
    };
    window.addEventListener("pagehide", stopTranscodeOnExit);
    return () => {
      window.removeEventListener("pagehide", stopTranscodeOnExit);
      stopTranscodeOnExit();
    };
  }, []);

  useEffect(() => {
    if (!details || details.kind === "image" || !details.moviesTv) {
      setTracks([]);
      setCaption("off");
      setBurnedSubtitleStream(null);
      setCues([]);
      setCaptionStatus({ state: "idle", label: "Off" });
      return;
    }
    // Tracks belong to the current video. Clear the prior selection before
    // loading this video's list so the saved on/off preference can choose a
    // valid track rather than reusing a stale index from the last episode.
    setTracks([]);
    setCaption("off");
    setBurnedSubtitleStream(null);
    setCues([]);
    setCaptionStatus({ state: "idle", label: "Off" });
    setCaptionSelection(null);
    setCaptionSelectionLoaded(false);
    const path = detailsMediaPath(details);
    let cancelled = false;
    void fetch(`${API_BASE}/api/subtitles?video_path=${encodeURIComponent(path)}`)
      .then((response) => response.ok ? response.json() as Promise<SubtitleTrack[]> : [])
      .then((next) => { if (!cancelled) setTracks(next); })
      .catch(() => { if (!cancelled) setTracks([]); });
    return () => { cancelled = true; hlsRef.current?.destroy(); };
  }, [details?.src, details?.kind, details?.moviesTv]);

  useEffect(() => {
    if (!details) return;
    const path = detailsMediaPath(details);
    if (details.kind === "image") {
      setSavedPlayback(null);
      setSavedPlaybackLoaded(true);
      setOrganizeActive(false);
      void authFetch(`${API_BASE}/api/user-state`)
        .then((response) => response.ok ? response.json() as Promise<UserState> : { favorites: [], playback: {} })
        .then((state) => {
          setFavorite(state.favorites.includes(path));
          const itemTags = state.tags?.[path] ?? [];
          const inPlaylists = Object.values(state.playlists ?? {}).some((playlist) => playlist.paths.includes(path));
          setOrganizeActive(itemTags.length > 0 || inPlaylists);
          setPlaybackPreferences(playbackPreferencesFromState(state.playback_preferences));
        })
        .catch(() => {
          setOrganizeActive(false);
        });
      return;
    }
    playbackHandoffRef.current = readPlaybackHandoff(details.src, "watch");
    const handoff = playbackHandoffRef.current;
    if (handoff) {
      initialResumeRef.current = handoff.currentTime;
      shouldPlayRef.current = handoff.playing;
      setVolume(handoff.volume);
      setMuted(handoff.muted);
      window.localStorage.setItem("tms_volume", String(handoff.volume));
      window.localStorage.setItem("tms_muted", String(handoff.muted));
      clearPlaybackHandoff();
    } else if (details.playIntent) {
      shouldPlayRef.current = true;
    }
    setFavorite(false);
    setOrganizeActive(false);
    let cancelled = false;
    let organizeTimer: ReturnType<typeof setTimeout> | undefined;
    const preparedState = nextUserStateRef.current;
    const cachedState = preparedState?.path === path && preparedState.userId === getSessionUser()?.id ? preparedState.state : null;
    if (cachedState) nextUserStateRef.current = null;
    // Playback only needs progress and preferences. Tags and playlists make the
    // full state ~10x larger, so they load afterwards for the organize button.
    void (cachedState ? Promise.resolve({ ...cachedState, playback_preferences: playbackPreferences }) : sharedJson<UserState>(playbackUserStateUrl(API_BASE), authFetch)
      .catch(() => ({ favorites: [], playback: {} }) as UserState))
      .then((state) => {
        if (cancelled) return;
        const playback = mergeWatchProgress(state.playback, readLocalWatchProgress(getSessionUser()?.id))[path] ?? null;
        setFavorite(state.favorites.includes(path));
        // Parsing the full state blocks the main thread, so wait until startup is done.
        organizeTimer = setTimeout(() => {
          void authFetch(`${API_BASE}/api/user-state`)
            .then((response) => response.ok ? response.json() as Promise<UserState> : null)
            .then((full) => {
              if (cancelled || !full) return;
              const itemTags = full.tags?.[path] ?? [];
              const inPlaylists = Object.values(full.playlists ?? {}).some((playlist) => playlist.paths.includes(path));
              setOrganizeActive(itemTags.length > 0 || inPlaylists);
            })
            .catch(() => undefined);
        }, 3_000);
        setPlaybackPreferences(playbackPreferencesFromState(state.playback_preferences));
        setCaptionSelection(state.caption_selections?.[captionSelectionKey(details)] ?? null);
        setCaptionSelectionLoaded(true);
        if (playback?.duration && Number.isFinite(playback.duration) && playback.duration > 0) {
          sourceDurationRef.current = playback.duration;
          setDuration(playback.duration);
        }
        if (!handoff) {
          initialResumeRef.current = !savesWatchProgress(path) ? 0 : playback ? (!playback.completed ? playback.position : 0) : Math.max(0, details.startAt);
        }
        setSavedPlayback(playback);
        setSavedPlaybackLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        const playback = readLocalWatchProgress(getSessionUser()?.id)[path] ?? null;
        if (!handoff) initialResumeRef.current = !savesWatchProgress(path) ? 0 : playback ? (!playback.completed ? playback.position : 0) : Math.max(0, details.startAt);
        setSavedPlayback(playback);
        setFavorite(false);
        setOrganizeActive(false);
        setCaptionSelection(null);
        setCaptionSelectionLoaded(true);
        setSavedPlaybackLoaded(true);
      });
    return () => { cancelled = true; clearTimeout(organizeTimer); };
  }, [details?.src, details?.kind, details?.startAt]);

  useEffect(() => {
    if (!details || details.kind !== "image") return;
    const path = detailsMediaPath(details);
    setFavorite(Boolean(queue.find((item) => item.path === path || item.src === details.src)?.favorite));
  }, [details?.src, details?.kind, queue]);

  const toggleFavorite = async () => {
    if (!details) return;
    const path = detailsMediaPath(details);
    const nextFavorite = !favorite;
    setFavorite(nextFavorite);
    setQueue((current) => current.map((item) => item.path === path ? { ...item, favorite: nextFavorite } : item));
    try {
      const response = await authFetch(`${API_BASE}/api/favorites`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, favorite: nextFavorite }),
      });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
    } catch (error) {
      setFavorite(!nextFavorite);
      setQueue((current) => current.map((item) => item.path === path ? { ...item, favorite: !nextFavorite } : item));
      setPlaybackError(error instanceof Error ? `Could not save favorite: ${error.message}` : "Could not save favorite");
    }
  };

  const openOrganize = () => {
    if (!details) return;
    setOrganizeOpen(true);
    setVolumeMenuOpen(false);
    setSettingsMenuOpen(false);
    setQualityMenuOpen(false);
    setCaptionMenuOpen(false);
    setQueueMenuOpen(false);
    setControlsVisible(true);
  };

  const handleOrganizeSaved = (state: OrganizeSavedState) => {
    if (!details) return;
    const path = detailsMediaPath(details);
    const itemTags = state.tags[path] ?? [];
    const inPlaylists = Object.values(state.playlists).some((playlist) => playlist.paths.includes(path));
    setOrganizeActive(itemTags.length > 0 || inPlaylists);
    updateSnapshotOrganization(path, {
      tags: state.tags,
      tagCatalog: state.tag_catalog,
      playlists: state.playlists,
    });
  };

  const toggleQueueItemFavorite = async (item: MediaItem, index: number) => {
    if (!item.path) return;
    const nextFavorite = !item.favorite;
    setQueue((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, favorite: nextFavorite } : entry));
    if (details && item.src === details.src) setFavorite(nextFavorite);
    try {
      const response = await authFetch(`${API_BASE}/api/favorites`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: item.path, favorite: nextFavorite }),
      });
      if (!response.ok) throw new Error(`Server returned ${response.status}`);
    } catch (error) {
      setQueue((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, favorite: !nextFavorite } : entry));
      if (details && item.src === details.src) setFavorite(!nextFavorite);
      setPlaybackError(error instanceof Error ? `Could not save favorite: ${error.message}` : "Could not save favorite");
    }
  };

  const playSafely = useCallback((media: HTMLMediaElement) => {
    // Android may refuse to start video while backgrounded. Prepare the final
    // stream normally, then start its audio directly without waiting for onPlay.
    if (media === videoRef.current && (continueBackgroundAudioRef.current || nativeBackgroundRef.current)) {
      if (!backgroundAudioRef.current) void backgroundAudioCallbacksRef.current?.start(true).catch((error: unknown) => {
        setPlaybackError(error instanceof Error ? error.message : "Could not continue background playback.");
      });
      return;
    }
    playMediaSafely(media);
  }, []);

  useEffect(() => {
    if (!details || quality !== "original" || !savedPlaybackLoaded || !metadataLoaded || !audioCompatibilityChecked || !audioTracksLoaded) return;
    if (!directPlaybackCompatibleRef.current) return;
    // Multi-audio files must start through HLS so the preferred English track
    // can be mapped and the adjacent Audio picker can switch tracks later.
    // Do not let the direct-play resume path claim startup first.
    if (audioTracks.length > 1) return;
    const video = videoRef.current;
    if (!video || initialResumeAppliedRef.current === details.src) return;

    initialResumeAppliedRef.current = details.src;
    const resumeAt = initialResumeRef.current;
    playbackHandoffRef.current = null;
    const target = resumeAt > 0 && resumeAt < video.duration - 0.25 ? resumeAt : 0;
    const startPlayback = () => {
      setCurrentTime(video.currentTime + streamOffsetRef.current);
      if (shouldPlayRef.current) playSafely(video);
      else setPlaying(false);
    };

    setCurrentTime(target);
    if (target > 0) {
      updateLoadingTarget(timeIsBuffered(video, target) ? null : target);
      video.addEventListener("seeked", startPlayback, { once: true });
      video.currentTime = target;
      return () => video.removeEventListener("seeked", startPlayback);
    }
    startPlayback();
  }, [audioCompatibilityChecked, audioTracks.length, audioTracksLoaded, details, metadataLoaded, quality, savedPlayback, savedPlaybackLoaded, videoShadow, details?.src, playSafely]);

  useEffect(() => {
    if (details?.kind === "image") return;
    initialResumeAppliedRef.current = "";
    pendingInitialTranscodeRef.current = false;
    sourceDurationRef.current = 0;
    setBufferingWithoutPosition(false);
    setMetadataLoaded(false);
    setCurrentTime(0);
    setDuration(0);
    bufferedSignatureRef.current = "";
    setBufferedRanges([]);
    // A promoted standby player already emitted loadedmetadata while inactive.
    // Read it now without assigning src or calling load(), which drops its buffer.
    const video = videoRef.current;
    if (video && video.getAttribute("src") === details?.src && video.readyState >= 1) {
      handleVideoMetadata(video);
    }
  }, [details?.src, details?.kind]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || details?.kind === "image") return;
    video.playbackRate = playbackRate;
  }, [playbackRate, details?.kind, details?.src]);

  useEffect(() => {
    autoSkippedRef.current.clear();
    void Promise.resolve().then(() => {
      setSkipData(null);
      setSkipDataError("");
    });
  }, [details?.src]);

  useEffect(() => {
    if (!details?.moviesTv || details.kind !== "video" || duration <= 0) return;
    const path = detailsMediaPath(details);
    if (!path) return;
    const params = new URLSearchParams({
      video_path: path,
      duration: duration.toFixed(3),
    });
    if (details.imdbId?.startsWith("tt")) params.set("imdb_id", details.imdbId);
    if (details.season && details.episode) {
      params.set("season", String(details.season));
      params.set("episode", String(details.episode));
    }
    if (skipRefresh > 0) params.set("refresh", "true");
    let cancelled = false;
    void Promise.resolve().then(() => {
      if (cancelled) return null;
      setSkipDataLoading(true);
      setSkipDataError("");
      return authFetch(`${API_BASE}/api/skip-segments?${params}`);
    })
      .then((response) => {
        if (!response || cancelled) return null;
        return response.ok ? response.json() as Promise<SkipSegmentsResponse> : Promise.reject(new Error(`HTTP ${response.status}`));
      })
      .then((data) => {
        if (data && !cancelled) setSkipData(data);
      })
      .catch(() => {
        if (!cancelled) setSkipDataError("Skip data unavailable");
      })
      .finally(() => {
        if (!cancelled) setSkipDataLoading(false);
      });
    return () => { cancelled = true; };
  }, [details, duration, skipRefresh]);


  const queueScopeKey = details ? `${details.src}\0${isShowWatch(details) ? "show" : "movie"}\0${details.series ?? ""}\0${details.customQueue}\0${details.queueFolder ?? ""}\0${details.queueSort ?? ""}\0${details.queueDirection ?? ""}\0${details.queueShuffle}\0${details.queueShuffleSeed ?? ""}\0${details.catalogKind ?? ""}\0${JSON.stringify(details.queueSource)}\0series-queue-v9` : "";

  useLayoutEffect(() => {
    if (!details || details.queueSource || details.customQueue || !isMovieWatch(details)) return;
    setQueue([]);
    try {
      sessionStorage.removeItem(PLAYBACK_QUEUE_KEY);
      sessionStorage.removeItem(LEGACY_PLAYBACK_QUEUE_KEY);
    } catch {
    }
  }, [details?.src, details?.folder, details?.series, details?.kind, details?.queueSource]);

  useEffect(() => {
    if (!details || details.queueSource || details.customQueue || !isMovieWatch(details)) return;
    const params = new URLSearchParams(watchLocationSearch());
    let dirty = false;
    if (details.customQueue) {
      dirty = true;
      params.delete("queue");
      params.delete("queueLabel");
    }
    if (params.has("season") || params.has("episode") || params.has("series")) {
      dirty = true;
      params.delete("season");
      params.delete("episode");
      params.delete("series");
    }
    if (!dirty) return;
    replaceWatchLocation(`/watch?${params.toString()}`);
    setDetails({
      ...details,
      customQueue: false,
      queueLabel: undefined,
      season: undefined,
        episode: undefined,
      series: undefined,
    });
  }, [details?.src, details?.customQueue, details?.series, details?.season, details?.episode, details?.kind, details?.queueSource]);

  useEffect(() => {
    if (!details || (!details.queueSource && !details.customQueue && isMovieWatch(details))) {
      setQueueLoadStatus("idle");
      return;
    }
    const shared = restorePlaybackSession(getSessionUser()?.id);
    const sameSource = details.queueSource && JSON.stringify(shared?.source) === JSON.stringify(details.queueSource);
    const sameSession = shared?.id === new URLSearchParams(watchLocationSearch()).get("playbackSession");
    // Moving within the loaded queue must not refetch the library: the full
    // listing is many megabytes, and parsing it during the player swap can
    // exhaust an Android WebView renderer.
    const queueNavigation = queueNavigationPathRef.current === detailsMediaPath(details);
    queueNavigationPathRef.current = null;
    if (shared?.complete && (sameSource || sameSession || queueNavigation) && shared.item.path === detailsMediaPath(details) && shared.queue.some((entry) => entry.path === detailsMediaPath(details))) {
      applyQueue(shared.queue);
      setQueueLoadStatus("idle");
      return;
    }
    let cancelled = false;

    if (details.queueSource) {
      const source = details.queueSource;
      const controller = new AbortController();
      setQueueLoadStatus("loading");
      void loadPlaybackQueue(source, authFetch, controller.signal, getSessionUser()).then(({ queue, state }) => {
        if (cancelled) return;
        setPlaybackPreferences(playbackPreferencesFromState(state.playback_preferences));
        applyQueue(queue);
        setQueueLoadStatus("idle");
      }).catch((error) => {
        if (!cancelled) {
          reportClientError(error, { kind: "playback-queue" });
          setQueueLoadStatus("error");
        }
      });
      return () => { cancelled = true; controller.abort(); };
    }

    if (details.offline && details.customQueue) {
      setQueueLoadStatus("loading");
      void (async () => {
        try {
          const stored = JSON.parse(sessionStorage.getItem(PLAYBACK_QUEUE_KEY) ?? sessionStorage.getItem(LEGACY_PLAYBACK_QUEUE_KEY) ?? "null") as StoredPlaybackQueue | null;
          if (!stored?.offlineEntries?.length || Date.now() - stored.createdAt >= 24 * 60 * 60 * 1000) return;
          const resolved = await Promise.all(stored.offlineEntries.map(async (entry) => {
            try {
              const file = await resolveOfflineFileUrl(entry.bundleId, entry.fileId);
              return {
                id: stableId(`offline:${entry.bundleId}:${entry.fileId}`),
                path: entry.path,
                name: entry.name,
                kind: entry.kind as MediaItem["kind"],
                size: entry.size,
                updated: "",
                tags: [],
                owner: "Offline",
                tone: entry.kind === "audio" ? "audio" : entry.kind === "image" ? "gold" : "ocean",
                src: file.url,
                parent: entry.parent,
                offline: {
                  bundleId: entry.bundleId,
                  fileId: entry.fileId,
                  relativePath: file.file.relativePath || file.file.name,
                  root: false,
                },
              } satisfies MediaItem;
            } catch {
              return null;
            }
          }));
          if (cancelled) return;
          const offlineQueue = resolved.filter((item): item is MediaItem => Boolean(item));
          const currentPath = detailsMediaPath(details);
          if (offlineQueue.some((item) => item.src === details.src || item.path === currentPath || item.path === details.sourcePath)) {
            try {
              sessionStorage.removeItem(PLAYBACK_QUEUE_ORDER_KEY);
            } catch {
            }
            applyQueue(offlineQueue);
          }
        } catch {
        } finally {
          if (!cancelled) setQueueLoadStatus("idle");
        }
      })();
      return () => { cancelled = true; };
    }

    setQueueLoadStatus("loading");
    const queueTrace = details.playAttemptId && details.playAttemptStartedAt
      ? { id: details.playAttemptId, startedAt: details.playAttemptStartedAt } : undefined;
    playbackTracePhase("queue_requests_started", {}, queueTrace);
    let queueBuildStartedAt = 0;
    const folderParam = details.folder ? `?folder=${encodeURIComponent(details.folder)}` : "";
    const fullQueueParam = details.queueFolder
      ? `?${new URLSearchParams({ folder: details.queueFolder, sort: details.queueSort ?? "name", direction: details.queueDirection === "asc" ? "asc" : "desc", offset: "0", limit: "999999" })}`
      : "";
    // Fetch only the subtrees the queue can draw from. The whole library is
    // tens of thousands of entries; a show's queue needs one folder tree.
    const broadScopes = (() => {
      const scopes: (string | undefined)[] = [];
      if (details.customQueue) {
        try {
          const stored = JSON.parse(sessionStorage.getItem(PLAYBACK_QUEUE_KEY) ?? sessionStorage.getItem(LEGACY_PLAYBACK_QUEUE_KEY) ?? "null") as StoredPlaybackQueue | null;
          if (stored && Array.isArray(stored.paths) && stored.paths.length) scopes.push(commonFolder(stored.paths));
        } catch {
        }
      }
      if (!details.queueFolder || details.customQueue) {
        const suppliedSeries = details.series?.match(/(?:^|\/)Season[ ._-]*0*\d{1,3}$/i)
          ? details.series.slice(0, details.series.lastIndexOf("/"))
          : details.series;
        const segments = details.folder.split("/").filter(Boolean);
        const seasonIndex = segments.findIndex((segment) => /^(?:Season[ ._-]*0*\d{1,3}|Specials?)$/i.test(segment));
        // Without a known show, series inference walks the folder's ancestors
        // up to the second level, so that ancestor bounds what it can need.
        scopes.push(suppliedSeries || (seasonIndex > 0 ? segments.slice(0, seasonIndex).join("/") : segments.length >= 2 ? segments.slice(0, 2).join("/") : undefined));
      }
      return queueFetchScopes(scopes);
    })();
    const broadEntries = Promise.all(broadScopes.map((scope) => (scope
      ? sharedJson<ApiLibraryEntry[]>(librarySubtreeUrl(API_BASE, scope), authFetch)
      : authFetch(`${API_BASE}/api/library`).then((response) => response.ok ? response.json() as Promise<ApiLibraryEntry[]> : []))
      .catch((): ApiLibraryEntry[] => []))).then((lists) => lists.flat());
    const folderEntries = () => authFetch(`${API_BASE}/api/library${folderParam}`)
      .then((response) => response.ok ? response.json() as Promise<ApiLibraryEntry[]> : [])
      .catch((): ApiLibraryEntry[] => []);
    // When a fetched subtree already contains the open folder, show the queue
    // from it right away; the folder listing only adds probed lengths later.
    const folderCovered = Boolean(details.folder) && broadScopes.some((scope) => scope && (details.folder === scope || details.folder.startsWith(`${scope}/`)));
    void Promise.all([
      broadEntries,
      folderCovered
        ? broadEntries.then((entries) => entries.length ? [] : folderEntries())
        : details.folder ? folderEntries() : Promise.resolve([]),
      details.queueFolder ? authFetch(`${API_BASE}/api/library${fullQueueParam}`).then((response) => response.ok ? response.json() as Promise<ApiLibraryEntry[]> : []) : Promise.resolve([]),
      sharedJson<UserState>(playbackUserStateUrl(API_BASE), authFetch).catch((): UserState => ({ favorites: [], playback: {} })),
    ])
      .then(([entries1, entries2, queueEntries, state]) => {
        queueBuildStartedAt = Date.now();
        playbackTracePhase("queue_data_received", {
          library_entries: entries1.length, folder_entries: entries2.length, sorted_entries: queueEntries.length,
        }, queueTrace);
        const entryMap = new Map<string, ApiLibraryEntry>();
        for (const entry of entries1) entryMap.set(entry.path, entry);
        for (const entry of entries2) entryMap.set(entry.path, entry);
        for (const entry of queueEntries) entryMap.set(entry.path, entry);
        const entries = Array.from(entryMap.values());
        setPlaybackPreferences(playbackPreferencesFromState(state.playback_preferences));
        const favoritePaths = new Set(state.favorites);
        const lastAccessed = state.last_accessed ?? {};
        const toQueueItem = (item: MediaItem) => {
          let next = item.path && favoritePaths.has(item.path) ? { ...item, favorite: true } : item;
          if (item.path && lastAccessed[item.path]) next = { ...next, lastOpenedAt: Math.max(next.lastOpenedAt ?? 0, lastAccessed[item.path]) };
          const playbackDuration = item.path ? state.playback[item.path]?.duration : undefined;
          if ((!next.duration || next.duration <= 0) && playbackDuration && playbackDuration > 0) next = { ...next, duration: playbackDuration };
          if (next.kind === "image" && (!next.duration || next.duration <= 0)) next = { ...next, duration: DEFAULT_PLAYBACK_PREFERENCES.image_seconds };
          return next;
        };
        const items = entries.map(apiEntryToMediaItem).filter((item): item is MediaItem => Boolean(item && (item.kind === "video" || item.kind === "audio" || item.kind === "image") && item.src))
          .map(toQueueItem);
        const watchDetails = (() => {
          const current = detailsRef.current ?? details;
          const path = current.src.startsWith(`${API_BASE}/media/`)
            ? decodeURIComponent(current.src.slice(`${API_BASE}/media/`.length))
            : (current.sourcePath ?? "");
          const catalogKind = items.find((item) => item.path === path)?.catalogKind ?? current.catalogKind;
          return catalogKind ? { ...current, catalogKind } : current;
        })();
        if (isMovieWatch(watchDetails)) return [];
        // Older episode clicks created a generic "Queue" from just the open
        // season. Recover the enclosing show from its episode paths so an
        // already-open finale can continue into the next season too.
        const seasonPathScope = (() => {
          const segments = watchDetails.folder.split("/").filter(Boolean);
          const seasonIndex = segments.findIndex((segment) => /^(?:Season[ ._-]*0*\d{1,3}|Specials?)$/i.test(segment));
          return seasonIndex > 0 ? segments.slice(0, seasonIndex).join("/") : undefined;
        })();
        const inferredSeriesScope = (() => {
          let candidate = watchDetails.folder;
          while (candidate) {
            const seasons = new Set(items.flatMap((item) => {
              if (item.kind !== "video" || !item.path?.startsWith(`${candidate}/`)) return [];
              if (!/(?:^|\/)(?:Season[ ._-]*\d{1,3}|Specials?)(?:\/|$)/i.test(item.parent ?? "")) return [];
              const episode = episodeNumbers(`${item.parent ?? ""}/${item.name}`);
              return episode ? [episode.season] : [];
            }));
            // A library root can contain many unrelated season numbers; it is
            // never a show's queue scope.
            if (seasons.size > 1 && candidate.includes("/")) return candidate;
            candidate = candidate.includes("/") ? candidate.slice(0, candidate.lastIndexOf("/")) : "";
          }
          return undefined;
        })();
        const suppliedSeriesScope = watchDetails.series?.match(/(?:^|\/)Season[ ._-]*0*\d{1,3}$/i)
          ? watchDetails.series.slice(0, watchDetails.series.lastIndexOf("/"))
          : watchDetails.series;
        // Prefer the broader path derived from the actual episode inventory.
        // Older links incorrectly supplied the Season NN folder as `series`.
        const seriesScope = suppliedSeriesScope ?? seasonPathScope ?? inferredSeriesScope;
        let customQueueBelongsToSeries = Boolean(seriesScope);
        if (watchDetails.customQueue) {
          try {
            const stored = JSON.parse(sessionStorage.getItem(PLAYBACK_QUEUE_KEY) ?? sessionStorage.getItem(LEGACY_PLAYBACK_QUEUE_KEY) ?? "null") as StoredPlaybackQueue | null;
            if (stored && Array.isArray(stored.paths) && Date.now() - stored.createdAt < 24 * 60 * 60 * 1000) {
              const itemsByPath = new Map(items.flatMap((item) => item.path ? [[item.path, item] as const] : []));
              const customQueue = stored.paths.flatMap((path) => {
                const item = itemsByPath.get(path);
                return item ? [item] : [];
              });
              customQueueBelongsToSeries = Boolean(seriesScope)
                && customQueue.length > 0
                && customQueue.every((item) => item.path?.startsWith(`${seriesScope}/`));
              const currentPath = detailsMediaPath(watchDetails);
              const queueContainsCurrent = customQueue.some((item) =>
                item.src === watchDetails.src
                || (currentPath.length > 0 && item.path === currentPath)
                || (watchDetails.sourcePath ? item.path === watchDetails.sourcePath : false)
              );
              const explicitPlaybackQueue = watchDetails.queueLabel === "Shuffled" || watchDetails.queueLabel === "Play all" || watchDetails.queueLabel === "Filtered";
              // Explicit Shuffle / Play all must keep the client-built order.
              // Otherwise a generic grid queue must not replace a TV show's episode order.
              if (queueContainsCurrent && (explicitPlaybackQueue || (!customQueueBelongsToSeries && !seriesScope))) {
                if (explicitPlaybackQueue) {
                  try {
                    sessionStorage.removeItem(PLAYBACK_QUEUE_ORDER_KEY);
                  } catch {
                  }
                }
                return customQueue;
              }
            }
          } catch {
          }
        }
        const useSeriesQueue = Boolean(seriesScope) && !watchDetails.queueFolder && (!watchDetails.customQueue || customQueueBelongsToSeries);
        if (isMovieWatch(watchDetails)) return [];
        const sortFolderQueue = (left: MediaItem, right: MediaItem) => {
          const sort = watchDetails.queueSort ?? "name";
          const direction = watchDetails.queueDirection === "asc" ? 1 : -1;
          const comparison = sort === "name" ? left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" })
            : sort === "size" ? (left.sizeBytes ?? 0) - (right.sizeBytes ?? 0)
            : sort === "length" ? (left.duration ?? 0) - (right.duration ?? 0)
              : sort === "type" ? left.kind.localeCompare(right.kind) || left.name.localeCompare(right.name, undefined, { numeric: true })
                : sort === "opened" ? (left.lastOpenedAt ?? left.addedAt ?? 0) - (right.lastOpenedAt ?? right.addedAt ?? 0)
                  : (left.addedAt ?? 0) - (right.addedAt ?? 0);
          return comparison * direction || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
        };
        const scoped = useSeriesQueue && seriesScope
          ? items.filter((item) => (item.kind === "video" || item.kind === "image") && item.path?.startsWith(`${seriesScope}/`))
          : watchDetails.queueFolder
            ? (() => {
              const itemsByPath = new Map(items.flatMap((item) => item.path ? [[item.path, item] as const] : []));
              const fromSortedFetch = queueEntries
                .map(apiEntryToMediaItem)
                .filter((item): item is MediaItem => Boolean(item && (item.kind === "video" || item.kind === "audio" || item.kind === "image") && item.src && item.parent === watchDetails.queueFolder))
                .map(toQueueItem);
              if (fromSortedFetch.length) {
                const seen = new Set(fromSortedFetch.map((item) => item.path));
                return [...fromSortedFetch, ...items.filter((item) => item.parent === watchDetails.queueFolder && item.path && !seen.has(item.path))];
              }
              return [...itemsByPath.values()].filter((item) => item.parent === watchDetails.queueFolder).sort(sortFolderQueue);
            })()
            : items.filter((item) => item.parent === watchDetails.folder);
        const sortedQueue = useSeriesQueue
          ? [...scoped].sort((left, right) => {
            const leftEpisode = episodeNumbers(`${left.parent ?? ""}/${left.name}`);
            const rightEpisode = episodeNumbers(`${right.parent ?? ""}/${right.name}`);
            const leftOrder = leftEpisode ? leftEpisode.season * 10000 + leftEpisode.episode : Number.MAX_SAFE_INTEGER;
            const rightOrder = rightEpisode ? rightEpisode.season * 10000 + rightEpisode.episode : Number.MAX_SAFE_INTEGER;
            if (leftOrder !== rightOrder) return leftOrder - rightOrder;
            return left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
          })
          : watchDetails.queueFolder
            ? scoped
            : [...scoped].sort((left, right) => left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" }));
        if (watchDetails.queueShuffle) {
          const currentPath = detailsMediaPath(watchDetails);
          const seed = watchDetails.queueShuffleSeed ?? "shuffle";
          const shuffled = [...sortedQueue].sort((left, right) => {
            const rankDifference = seededQueueRank(seed, left.path ?? left.src!) - seededQueueRank(seed, right.path ?? right.src!);
            return rankDifference || left.name.localeCompare(right.name, undefined, { numeric: true, sensitivity: "base" });
          });
          const currentIndex = shuffled.findIndex((item) =>
            item.src === watchDetails.src
            || (currentPath.length > 0 && item.path === currentPath)
            || (watchDetails.sourcePath ? item.path === watchDetails.sourcePath : false)
          );
          if (currentIndex <= 0) return shuffled;
          return [...shuffled.slice(currentIndex), ...shuffled.slice(0, currentIndex)];
        }
        try {
          const storedOrder = JSON.parse(sessionStorage.getItem(PLAYBACK_QUEUE_ORDER_KEY) ?? "null") as StoredQueueOrder | null;
          const orderScope = seriesScope ?? watchDetails.queueFolder ?? watchDetails.folder;
          const explicitPlaybackQueue = watchDetails.queueLabel === "Shuffled" || watchDetails.queueLabel === "Play all" || watchDetails.queueLabel === "Filtered";
          if (!explicitPlaybackQueue && !watchDetails.queueShuffle && storedOrder?.scope === orderScope && Array.isArray(storedOrder.paths) && Date.now() - storedOrder.createdAt < 24 * 60 * 60 * 1000) {
            const itemsByPath = new Map(sortedQueue.flatMap((item) => item.path ? [[item.path, item] as const] : []));
            const ordered = storedOrder.paths.flatMap((path) => {
              const item = itemsByPath.get(path);
              return item ? [item] : [];
            });
            const orderedPaths = new Set(ordered.map((item) => item.path));
            return [...ordered, ...sortedQueue.filter((item) => !orderedPaths.has(item.path))];
          }
          if (explicitPlaybackQueue || watchDetails.queueShuffle) {
            try {
              sessionStorage.removeItem(PLAYBACK_QUEUE_ORDER_KEY);
            } catch {
            }
          }
        } catch {
        }
        return sortedQueue;
      })
      .then((nextQueue) => {
        if (cancelled) return;
        playbackTracePhase("queue_built", { queue_items: nextQueue.length,
          stage_duration_ms: Date.now() - queueBuildStartedAt }, queueTrace);
        applyQueue(nextQueue);
        setQueueLoadStatus("idle");
        if (!folderCovered || !nextQueue.length) return;
        void folderEntries().then((entries) => {
          const durations = new Map(entries.flatMap((entry) => entry.duration && entry.duration > 0 ? [[entry.path, entry.duration] as const] : []));
          if (cancelled || !durations.size) return;
          applyQueue((current) => current.map((item) => {
            const known = item.path ? durations.get(item.path) : undefined;
            return known && (!item.duration || item.duration <= 0) ? { ...item, duration: known } : item;
          }));
        });
      })
      .catch((error: unknown) => {
        playbackTracePhase(cancelled ? "queue_cancelled" : "queue_resolution_failed", {
          outcome: error instanceof Error ? error.name : "error",
        }, queueTrace);
        if (!cancelled) {
          applyQueue([]);
          setQueueLoadStatus("error");
        }
      });
    return () => { cancelled = true; };
  }, [queueScopeKey, queueRetry, applyQueue]);

  const persistExitProgress = useEffectEvent(() => {
    const video = backgroundAudioRef.current ?? videoRef.current;
    if (!details || !video || exitingRef.current || playbackStartupPending() || qualityBusyRef.current) return;
    const position = video.currentTime + streamOffsetRef.current;
    if (loadingTargetRef.current !== null && Math.abs(position - loadingTargetRef.current) > 2) return;
    saveProgress(video, video.ended);
    sendPlaybackActivity(details, video.ended ? "completed" : "stopped", video.currentTime + streamOffsetRef.current, sourceDurationRef.current || video.duration || 0);
  });
  useEffect(() => {
    const stopped = () => persistExitProgress();
    const hidden = () => { if (document.visibilityState === "hidden") persistExitProgress(); };
    window.addEventListener("pagehide", stopped);
    document.addEventListener("visibilitychange", hidden);
    return () => {
      persistExitProgress();
      window.removeEventListener("pagehide", stopped);
      document.removeEventListener("visibilitychange", hidden);
    };
  }, []);

  useEffect(() => {
    if (caption === "off") return;
    const track = tracks[Number(caption)];
    if (!track) return;
    if (track.mode === "burn_in") {
      setCues([]);
      return;
    }
    const sourceLabel = subtitleSource(track);
    let cancelled = false;
    void fetch(`${API_BASE}${track.url}`).then((response) => {
      if (!response.ok) throw new Error("Subtitle request failed");
      return response.text();
    }).then((source) => {
      if (cancelled) return;
      setCues(parseVtt(source));
      setCaptionStatus({ state: "ready", label: `${sourceLabel} captions` });
    }).catch(() => {
      if (cancelled) return;
      setCues([]);
      setCaptionStatus({ state: "error", label: `${sourceLabel} captions failed` });
    });
    return () => { cancelled = true; };
  }, [caption, tracks]);

  useEffect(() => {
    if (!captionSelectionLoaded || caption !== "off" || tracks.length === 0) return;
    if (captionSelection?.source === "off") return;
    const selectedIndex = captionSelection
      ? tracks.findIndex((track) => captionSource(track) === captionSelection.source && track.label === captionSelection.track_label)
      : -1;
    const sourceIndex = captionSelection && selectedIndex < 0
      ? tracks.findIndex((track) => captionSource(track) === captionSelection.source)
      : selectedIndex;
    const fallbackIndex = playbackPreferences.captions_enabled
      ? tracks.findIndex((track) => track.mode !== "burn_in" && (/^en(?:-|$)/i.test(track.language) || /\benglish\b/i.test(track.label)))
      : -1;
    const index = sourceIndex >= 0 ? sourceIndex : fallbackIndex;
    if (index < 0) return;
    const track = tracks[index];
    setBurnedSubtitleStream(track.mode === "burn_in" ? track.stream_index ?? null : null);
    setCaption(String(index));
    setCaptionStatus(track.mode === "burn_in" ? { state: "ready", label: "Local PGS" } : { state: "loading", label: "Loading captions…" });
    if (track.mode === "burn_in" && details) {
      void changeQuality(quality, currentTime, true, shouldPlayRef.current, undefined, undefined, track.stream_index ?? null);
    }
  }, [caption, captionSelection, captionSelectionLoaded, currentTime, details, playbackPreferences.captions_enabled, playing, quality, tracks]);

  useEffect(() => {
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    if (!qualityMenuOpen && !queueMenuOpen && !captionMenuOpen && !settingsMenuOpen && !volumeMenuOpen) {
      controlsTimerRef.current = setTimeout(() => {
        setControlsVisible(false);
        if (Capacitor.isNativePlatform() && playerFullscreen) {
          StatusBar.hide().catch(console.error);
          NavigationBar.hide().catch(console.error);
        }
      }, controlsHideDelay());
    }
    return () => { if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current); };
  }, [playing, qualityMenuOpen, queueMenuOpen, captionMenuOpen, settingsMenuOpen, volumeMenuOpen, playerFullscreen]);

  const activeCue = caption === "off" ? undefined : cues.find((cue) => currentTime >= cue.start && currentTime <= cue.end);
  const captionPreferences = playbackPreferences.caption_preferences;

  // Move captions by exactly the bottom tray's height while it is visible.
  // Do not measure the caption itself here: its animated top value made the
  // previous collision calculation feed back into itself and caused hopping.
  useLayoutEffect(() => {
    if (!controlsVisible || !activeCue) {
      setCaptionControlsOffset((offset) => offset === 0 ? offset : 0);
      return;
    }

    let frame = 0;
    const syncControlsOffset = () => {
      const controlsElement = controlsRef.current;
      if (!controlsElement) return;
      const requiredOffset = -controlsElement.getBoundingClientRect().height;
      setCaptionControlsOffset((offset) => Math.abs(offset - requiredOffset) < 0.5 ? offset : requiredOffset);
    };
    const scheduleSync = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(syncControlsOffset);
    };

    scheduleSync();
    const observer = new ResizeObserver(scheduleSync);
    if (playerRef.current) observer.observe(playerRef.current);
    if (controlsRef.current) observer.observe(controlsRef.current);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [activeCue?.text, controlsVisible, playerFullscreen]);

  useEffect(() => {
    const syncFullscreenState = () => setPlayerFullscreen(document.fullscreenElement === playerRef.current);
    syncFullscreenState();
    document.addEventListener("fullscreenchange", syncFullscreenState);
    return () => document.removeEventListener("fullscreenchange", syncFullscreenState);
  }, []);

  useEffect(() => {
    if (!queueMenuOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || (!target.closest(".watch-queue-trigger") && !target.closest(".watch-queue-menu"))) setQueueMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [queueMenuOpen]);

  const updateQueueMenuPosition = useCallback(() => {
    const trigger = queueTriggerRef.current;
    const menu = queueMenuRef.current;
    if (!trigger || !menu) return;
    const margin = 12;
    const gap = 8;
    const triggerRect = trigger.getBoundingClientRect();
    const menuWidth = menu.offsetWidth;
    const menuHeight = menu.offsetHeight;
    let left = triggerRect.left;
    let top = triggerRect.top - menuHeight - gap;
    if (left + menuWidth > window.innerWidth - margin) left = window.innerWidth - margin - menuWidth;
    if (left < margin) left = margin;
    if (top < margin) top = triggerRect.bottom + gap;
    setQueueMenuPosition({ left, top });
  }, []);

  const scrollQueueMenuToActive = useCallback(() => {
    const menu = queueMenuRef.current;
    if (!menu) return;
    const activeItem = menu.querySelector<HTMLElement>(".watch-queue-item.active");
    if (!activeItem) {
      menu.scrollTop = 0;
      return;
    }
    const maxScroll = Math.max(0, menu.scrollHeight - menu.clientHeight);
    const menuTop = menu.getBoundingClientRect().top + menu.clientTop;
    const itemTop = activeItem.getBoundingClientRect().top;
    const nextScroll = menu.scrollTop + (itemTop - menuTop) - 4;
    menu.scrollTop = Math.max(0, Math.min(nextScroll, maxScroll));
  }, []);

  useLayoutEffect(() => {
    if (!queueMenuOpen) {
      setQueueMenuPosition(null);
      return;
    }
    updateQueueMenuPosition();
    window.addEventListener("resize", updateQueueMenuPosition);
    return () => window.removeEventListener("resize", updateQueueMenuPosition);
  }, [queueMenuOpen, queue.length, playerFullscreen, updateQueueMenuPosition]);

  useEffect(() => {
    if (!settingsMenuOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".watch-settings")) setSettingsMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [settingsMenuOpen]);

  useEffect(() => {
    if (!volumeMenuOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || !target.closest(".watch-volume-control")) setVolumeMenuOpen(false);
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [volumeMenuOpen]);

  const activeSkipSegment = skipData?.segments.find((segment) => currentTime >= segment.start && currentTime < segment.end - 0.25);
  const activeSkipPromptKey = details?.moviesTv && activeSkipSegment
    ? JSON.stringify([details.src, activeSkipSegment.kind, activeSkipSegment.start, activeSkipSegment.end])
    : null;
  const [initialSkipPromptKey, setInitialSkipPromptKey] = useState<string | null>(null);
  useEffect(() => {
    setInitialSkipPromptKey(activeSkipPromptKey);
    if (!activeSkipPromptKey) return;
    const timer = setTimeout(() => setInitialSkipPromptKey(null), 5_000);
    return () => clearTimeout(timer);
  }, [activeSkipPromptKey]);
  const autoSkipEnabled = autoSkipEnabledFor(details, playbackPreferences);
  const currentQueueIndex = queue.findIndex((item) => {
    if (!details) return false;
    if (item.src === details.src) return true;
    const path = detailsMediaPath(details);
    return Boolean((path && item.path === path) || (details.sourcePath && item.path === details.sourcePath));
  });
  const previousQueueItem = currentQueueIndex > 0 ? queue[currentQueueIndex - 1] : null;
  const nextQueueItem = currentQueueIndex >= 0 && currentQueueIndex < queue.length - 1 ? queue[currentQueueIndex + 1] : null;
  const nearbyItems = nearbyQueueItems(queue, currentQueueIndex);
  const imagePreloadsRef = useRef(new Map<string, HTMLImageElement>());
  const upcomingImagesKey = JSON.stringify(nearbyItems.filter((item) => item.kind === "image" && item.src && item.sizeBytes && item.sizeBytes <= QUEUE_PRELOAD_BYTES / 3).map((item) => item.src));
  useEffect(() => {
    const sources = JSON.parse(upcomingImagesKey) as string[];
    const cache = imagePreloadsRef.current;
    for (const [src, image] of cache) {
      if (!sources.includes(src)) { image.src = ""; cache.delete(src); }
    }
    for (const src of sources) {
      if (cache.has(src)) continue;
      const image = new Image();
      image.decoding = "async";
      image.src = src;
      cache.set(src, image);
      void image.decode().catch(() => undefined);
    }
  }, [upcomingImagesKey]);
  useEffect(() => () => {
    for (const image of imagePreloadsRef.current.values()) image.src = "";
    imagePreloadsRef.current.clear();
  }, []);
  const imageSeconds = playbackPreferences.image_seconds;

  useLayoutEffect(() => {
    if (!queueMenuOpen || !queueMenuPosition) return;
    scrollQueueMenuToActive();
  }, [queueMenuOpen, queueMenuPosition, currentQueueIndex, scrollQueueMenuToActive]);

  const rememberQueueDuration = useCallback((path: string, nextDuration: number) => {
    if (!Number.isFinite(nextDuration) || nextDuration <= 0) return;
    setQueue((current) => current.map((item) => item.path === path && (!item.duration || item.duration <= 0) ? { ...item, duration: nextDuration } : item));
  }, []);

  useEffect(() => {
    if (currentQueueIndex < 0 || duration <= 0) return;
    setQueue((current) => current.map((item, index) => index === currentQueueIndex && (!item.duration || item.duration <= 0) ? { ...item, duration } : item));
  }, [currentQueueIndex, duration]);

  useEffect(() => {
    if (details?.kind === "image") {
      setDuration(imageSeconds);
      setCurrentTime(0);
      setPlaying(shouldPlayRef.current);
      if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
      if (controlsVisibleRef.current && !qualityMenuOpen && !queueMenuOpen && !captionMenuOpen && !settingsMenuOpen && !volumeMenuOpen) controlsTimerRef.current = setTimeout(() => setControlsVisible(false), controlsHideDelay());
    }
  }, [details?.src, qualityMenuOpen, queueMenuOpen, captionMenuOpen, settingsMenuOpen, volumeMenuOpen, details?.kind]);

  useEffect(() => {
    if (details?.kind !== "image") return;
    setDuration(imageSeconds);
  }, [details?.kind, imageSeconds]);

  useEffect(() => {
    if (currentQueueIndex < 0) return;
    queue.slice(currentQueueIndex + 1, currentQueueIndex + 11)
      .filter((item) => item.kind === "image" && item.src)
      .forEach((item) => {
        const img = new Image();
        img.src = item.src!;
      });
  }, [queue, currentQueueIndex]);

  useEffect(() => {
    if (details?.kind !== "image" || !playing) return;
    const interval = setInterval(() => {
      setCurrentTime((current) => {
        if (current >= imageSeconds) {
          if (loopEnabled) return 0;
          clearInterval(interval);
          if (playbackPreferences.auto_next_enabled && nextQueueItem) goToQueueItem(nextQueueItem, true);
          return imageSeconds;
        }
        return current + 0.1;
      });
    }, 100);
    return () => clearInterval(interval);
  }, [details?.src, playing, loopEnabled, nextQueueItem, playbackPreferences.auto_next_enabled, details?.kind, imageSeconds]);

  const playbackStartupPending = () => !savedPlaybackLoaded
    || !metadataLoaded
    || !audioCompatibilityChecked
    || initialResumeAppliedRef.current !== details?.src
    || (!directPlaybackCompatibleRef.current && quality === "original");

  const resumePlayback = () => {
    if (details?.kind === "image") {
      setPlaying(true);
      return;
    }
    const video = backgroundAudioRef.current ?? videoRef.current;
    if (!video) return;
    setPlaybackError("");
    if (!backgroundAudioRef.current && (qualityBusyRef.current || playbackStartupPending())) {
      // The controls still show Play while startup or a replacement stream is
      // being prepared. Treat a click as a durable request to play when ready;
      // never let it start the temporary direct source at time zero.
      shouldPlayRef.current = true;
      return;
    }
    shouldPlayRef.current = true;
    if (video.paused) playSafely(video);
  };
  const pausePlayback = () => {
    if (details?.kind === "image") {
      setPlaying(false);
      return;
    }
    const video = backgroundAudioRef.current ?? videoRef.current;
    if (!video) return;
    shouldPlayRef.current = false;
    video.pause();
  };
  const togglePlayback = () => {
    const video = backgroundAudioRef.current ?? videoRef.current;
    if (details?.kind === "image") {
      setPlaying((current) => !current);
    } else if (video?.paused) {
      resumePlayback();
    } else {
      pausePlayback();
    }
  };
  const closePopups = () => {
    setVolumeMenuOpen(false);
    setQueueMenuOpen(false);
    setSettingsMenuOpen(false);
    setQualityMenuOpen(false);
    setCaptionMenuOpen(false);
  };
  const openVolumeMenu = () => {
    if (!controlsVisibleRef.current) return;
    if (volumeHoverTimerRef.current) clearTimeout(volumeHoverTimerRef.current);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    volumeHoverRef.current = true;
    setVolumeMenuOpen(true);
    setQueueMenuOpen(false);
    setSettingsMenuOpen(false);
    setQualityMenuOpen(false);
    setCaptionMenuOpen(false);
    setControlsVisible(true);
  };
  const scheduleVolumeMenuClose = () => {
    volumeHoverRef.current = false;
    if (volumeHoverTimerRef.current) clearTimeout(volumeHoverTimerRef.current);
    volumeHoverTimerRef.current = setTimeout(() => {
      if (!volumeHoverRef.current) setVolumeMenuOpen(false);
    }, 180);
  };
  const handleVolumeTriggerClick = (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (isPhoneLayout()) {
      setVolumeMenuOpen((open) => !open);
      setQueueMenuOpen(false);
      setSettingsMenuOpen(false);
      setQualityMenuOpen(false);
      setCaptionMenuOpen(false);
      setControlsVisible(true);
      return;
    }
    setMuted((value) => !value);
  };
  const popupsOpen = volumeMenuOpen || queueMenuOpen || settingsMenuOpen || qualityMenuOpen || captionMenuOpen;
  useBackLayer(popupsOpen, closePopups);
  const handlePlaybackSurfaceClick = () => {
    if (isPhoneLayout()) {
      toggleControlsVisibility();
      return;
    }
    if (popupsOpen) {
      closePopups();
      return;
    }
    togglePlayback();
  };
  const toggleFullscreen = () => {
    if (!document.fullscreenElement) void playerRef.current?.requestFullscreen();
    else void document.exitFullscreen();
  };
  const togglePip = () => {
    const video = videoRef.current;
    if (!video) return;
    if (nativePipAvailable()) {
      if (pip) void exitNativePip();
      else void enterNativePip().then(({ entered }) => setPip(entered));
      return;
    }
    if (document.pictureInPictureElement) {
      void document.exitPictureInPicture();
    } else if ("requestPictureInPicture" in video) {
      void video.requestPictureInPicture();
    // @ts-ignore
    } else if ("webkitSetPresentationMode" in video) {
      // @ts-ignore
      video.webkitSetPresentationMode(
        // @ts-ignore
        video.webkitPresentationMode === "picture-in-picture" ? "inline" : "picture-in-picture"
      );
    }
  };
  const hideControls = () => {
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    controlsVisibleRef.current = false;
    setControlsVisible(false);
    if (Capacitor.isNativePlatform() && playerFullscreen) {
      StatusBar.hide().catch(console.error);
      NavigationBar.hide().catch(console.error);
    }
  };
  const showControls = () => {
    preserveHiddenControlsRef.current = false;
    controlsVisibleRef.current = true;
    setControlsVisible(true);
    if (controlsTimerRef.current) clearTimeout(controlsTimerRef.current);
    if (!qualityMenuOpen && !queueMenuOpen && !captionMenuOpen && !settingsMenuOpen && !volumeMenuOpen) {
      controlsTimerRef.current = setTimeout(() => {
        // Keep controls up while nothing is playing (paused, loading or failed).
        const video = videoRef.current;
        if (video && (video.paused || video.readyState < 3)) return;
        setControlsVisible(false);
        if (Capacitor.isNativePlatform() && playerFullscreen) {
          StatusBar.hide().catch(console.error);
          NavigationBar.hide().catch(console.error);
        }
      }, controlsHideDelay());
    }
  };
  const toggleControlsVisibility = () => {
    if (popupsOpen) {
      closePopups();
      return;
    }
    if (controlsVisible && !showLoadingOverlay) hideControls();
    else showControls();
  };
  const handlePlayerPointer = () => {
    if (!isPhoneLayout()) showControls();
  };
  const setVolumeLevel = (value: number) => {
    setVolume(value);
    setMuted(false);
    if (videoRef.current) {
      setVolume(applyMediaVolume(videoRef.current, value));
      videoRef.current.muted = false;
    }
    if (backgroundAudioRef.current) {
      applyMediaVolume(backgroundAudioRef.current, value);
      backgroundAudioRef.current.muted = false;
    }
  };
  const clampPlaybackRate = (value: number) => Math.max(PLAYBACK_SPEED_MIN, Math.min(PLAYBACK_SPEED_MAX, value));
  const adjustPlaybackRate = (delta: number) => setPlaybackRate((current) => clampPlaybackRate(Number((current + delta).toFixed(2))));
  const resetPlaybackRate = () => setPlaybackRate(1);
  const cancelTranscodeSession = async (session: string) => {
    await fetch(`${API_BASE}/api/transcode?session=${encodeURIComponent(session)}`, {
      method: "DELETE",
      keepalive: true,
    }).catch(() => undefined);
  };
  const stopActiveTranscode = async () => {
    const session = activeTranscodeSessionRef.current;
    activeTranscodeSessionRef.current = null;
    if (session) await cancelTranscodeSession(session);
  };
  const updateLoadingTarget = (target: number | null) => {
    loadingTargetRef.current = target;
    setLoadingTarget(target);
    setBufferingWithoutPosition(false);
  };
  const markBuffering = (video: HTMLVideoElement) => {
    // Until the resume position is applied the element still reports 0, and
    // while a stream swaps it reports the old stream, so neither is a real position.
    if (playbackStartupPending() || qualityBusyRef.current) {
      if (loadingTargetRef.current === null) setBufferingWithoutPosition(true);
      return;
    }
    updateLoadingTarget(video.currentTime + streamOffsetRef.current);
  };
  const notePlaybackStall = (video: HTMLVideoElement) => {
    const session = playbackQualityRef.current;
    if (!session.started || session.stallStartedAt || video.paused || video.seeking || qualityBusyRef.current || playbackStartupPending()) return;
    session.stallStartedAt = performance.now();
    session.stallCount += 1;
  };
  const tickPlaybackQuality = (video: HTMLVideoElement) => {
    const session = playbackQualityRef.current;
    const now = performance.now();
    if (session.stallStartedAt && !video.paused && video.readyState >= HTMLMediaElement.HAVE_FUTURE_DATA) {
      session.stallMs += now - session.stallStartedAt;
      session.stallStartedAt = 0;
    }
    if (session.started && !session.stallStartedAt && !video.paused && !video.seeking && session.lastTickAt && now - session.lastTickAt < 2_000) {
      session.watchedMs += now - session.lastTickAt;
    }
    session.lastTickAt = now;
  };
  const finishLoadingTarget = (video: HTMLVideoElement) => {
    if (video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return;
    setBufferingWithoutPosition(false);
    const target = loadingTargetRef.current;
    if (target === null) return;
    const absoluteTime = video.currentTime + streamOffsetRef.current;
    if (Math.abs(absoluteTime - target) <= 2) updateLoadingTarget(null);
  };
  const changeQuality = async (
    nextQuality: string,
    resumeOverride?: number,
    force = false,
    playAfterSwitch?: boolean,
    bufferSizeOverride?: PlaybackPreferences["buffer_size_mb"],
    audioStreamOverride?: number | null,
    subtitleStreamOverride?: number | null,
  ) => {
    const video = videoRef.current;
    const requestedQuality = nextQuality === "original-aac" ? "original" : nextQuality;
    const selectedAudio = audioStreamOverride === undefined ? selectedAudioStream : audioStreamOverride;
    const selectedSubtitleStream = subtitleStreamOverride === undefined ? burnedSubtitleStream : subtitleStreamOverride;
    const originalWithAac = requestedQuality === "original" && (selectedSubtitleStream !== null || !directPlaybackCompatibleRef.current || audioTracks.length > 1);
    const selectedQuality = originalWithAac ? "original-aac" : requestedQuality;
    const streamQuality = originalWithAac ? String(sourceHeightRef.current || sourceHeight || qualityLevels[0] || 720) : requestedQuality;
    if (!video || !details || (!force && (qualityBusyRef.current || selectedQuality === quality))) { setQualityMenuOpen(false); return; }
    if (details.offline && requestedQuality !== "original") {
      setPlaybackError("Offline playback uses the original local file.");
      setQualityMenuOpen(false);
      return;
    }
    const requestId = ++qualityRequestRef.current;
    const resumeAt = resumeOverride ?? currentTime;
    const bufferSizeMb = bufferSizeOverride ?? playbackPreferences.buffer_size_mb;
    shouldPlayRef.current = playAfterSwitch ?? !video.paused;
    qualityBusyRef.current = true;
    setQualityBusy(true);
    setPlaybackError("");
    setQualityMenuOpen(false);
    stopActiveTranscode();
    hlsRef.current?.destroy();
    hlsRef.current = null;
    setQuality(selectedQuality);
    if (originalWithAac) setResolvedQuality(Number(streamQuality));
    else if (requestedQuality !== "auto" && requestedQuality !== "original") setResolvedQuality(Number(requestedQuality));
    if (streamQuality === "original") {
      streamOffsetRef.current = 0;
      video.src = details.src;
      video.load();
      video.addEventListener("loadedmetadata", () => {
        if (requestId !== qualityRequestRef.current) return;
        video.currentTime = resumeAt;
        setResolvedQuality(sourceHeight);
        qualityBusyRef.current = false;
        setQualityBusy(false);
        if (shouldPlayRef.current) playSafely(video);
      }, { once: true });
      return;
    }
    const path = detailsMediaPath(details);
    const warm = nextPreloadRef.current;
    const useWarmSession = warm?.path === path && warm.quality === streamQuality && warm.audio === selectedAudio
      && warm.subtitle === selectedSubtitleStream && warm.start === Math.max(0, Math.floor(resumeAt));
    const session = useWarmSession ? warm.session : createTranscodeSessionId();
    if (useWarmSession) nextPreloadRef.current = null;
    activeTranscodeSessionRef.current = session;
    try {
      const attemptParam = details.playAttemptId ? `&attempt_id=${encodeURIComponent(details.playAttemptId)}` : "";
      const audioParam = selectedAudio === null ? "" : `&audio_stream=${encodeURIComponent(selectedAudio)}`;
      const subtitleParam = selectedSubtitleStream === null ? "" : `&subtitle_stream=${encodeURIComponent(selectedSubtitleStream)}`;
      const copyParam = originalWithAac && videoCopyableRef.current ? "&copy_video=true" : "";
      const response = await fetch(`${API_BASE}/api/transcode?video_path=${encodeURIComponent(path)}&quality=${encodeURIComponent(streamQuality)}&start=${Math.max(0, Math.floor(resumeAt))}&buffer_size_mb=${bufferSizeMb}&session=${encodeURIComponent(session)}${attemptParam}${audioParam}${subtitleParam}${copyParam}`);
      if (!response.ok) throw new Error("Quality switch failed");
      const { url, offset } = await response.json() as { url: string; offset: number; session: string };
      if (requestId !== qualityRequestRef.current || activeTranscodeSessionRef.current !== session) {
        cancelTranscodeSession(session);
        return;
      }
      streamOffsetRef.current = offset;
    const streamUrl = `${API_BASE}${url}`;
    if (Hls.isSupported()) {
        video.pause();
        video.removeAttribute("src");
        video.load();
        const targetBufferSeconds = transcodeBufferSeconds(streamQuality, sourceHeightRef.current || sourceHeight, bufferSizeMb);
        const hls = new Hls({
          fLoader: cachedFragmentLoader(Hls.DefaultConfig.loader, preloadedFragmentsRef.current),
          // A copied stream begins at the keyframe before the resume point.
          // Starting on that keyframe avoids decoding hidden frames first. Stay
          // within the 2-second loading-target tolerance used by seeks.
          startPosition: resumeAt - offset > 2 ? resumeAt - offset : 0,
          enableWorker: true,
          // Fixed-quality media playlists do not advertise a BANDWIDTH value, so
          // hls.js cannot turn maxBufferSize into a forward-buffer duration itself.
          maxBufferLength: targetBufferSeconds,
          maxMaxBufferLength: 3600,
          maxBufferSize: bufferSizeMb * 1_000_000,
          backBufferLength: 30,
          manifestLoadingMaxRetry: 4,
          levelLoadingMaxRetry: 4,
          fragLoadingMaxRetry: 6,
        });
        hlsRef.current = hls;
        hls.loadSource(streamUrl);
        hls.attachMedia(video);
        hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
          if (selectedQuality === "auto") setResolvedQuality(hls.levels[data.level]?.height ?? 0);
        });
        let hlsPlaybackReady = false;
        const triggerHlsPlay = () => {
          if (hlsPlaybackReady || requestId !== qualityRequestRef.current || hlsRef.current !== hls) return;
          hlsPlaybackReady = true;
          qualityBusyRef.current = false;
          setQualityBusy(false);
          if (shouldPlayRef.current) playSafely(video); else video.pause();
        };

        let firstFragReported = false;
        hls.on(Hls.Events.FRAG_BUFFERED, () => {
          if (!firstFragReported && details.playAttemptId && details.playAttemptStartedAt) {
            firstFragReported = true;
            reportClientPerformance("hls_first_segment_buffered", Date.now() - details.playAttemptStartedAt, {
              attempt_id: details.playAttemptId,
              media_name: details.name,
              quality: streamQuality,
            });
          }
          triggerHlsPlay();
        });
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          if (requestId !== qualityRequestRef.current || hlsRef.current !== hls) return;
          if (details.playAttemptId && details.playAttemptStartedAt) {
            reportClientPerformance("hls_manifest_parsed", Date.now() - details.playAttemptStartedAt, {
              attempt_id: details.playAttemptId,
              media_name: details.name,
              quality: streamQuality,
            });
          }
          if (video.readyState >= 3) {
            triggerHlsPlay();
          } else {
            setTimeout(triggerHlsPlay, 800);
          }
        });
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal || requestId !== qualityRequestRef.current || hlsRef.current !== hls) return;
          qualityBusyRef.current = true;
          setQualityBusy(true);
          hls.destroy();
          hlsRef.current = null;
          streamOffsetRef.current = 0;
          if (!directPlaybackCompatibleRef.current || audioTracks.length > 1 || selectedSubtitleStream !== null) {
            qualityBusyRef.current = false;
            setQualityBusy(false);
            setPlaybackError(`${selectedQuality === "auto" ? "Automatic quality" : selectedQuality === "original-aac" ? "Original resolution" : `${streamQuality}p`} failed. Try another quality.`);
            video.removeAttribute("src");
            video.load();
            return;
          }
          setQuality("original");
          setResolvedQuality(sourceHeight);
          setPlaybackError(`${selectedQuality === "auto" ? "Automatic quality" : `${streamQuality}p`} failed. Restored the original video.`);
          video.src = details.src;
          video.load();
          video.addEventListener("loadedmetadata", () => {
            if (requestId !== qualityRequestRef.current) return;
            video.currentTime = resumeAt;
            qualityBusyRef.current = false;
            setQualityBusy(false);
            if (shouldPlayRef.current) playSafely(video);
          }, { once: true });
        });
      } else {
        video.src = streamUrl;
        video.load();
        video.addEventListener("loadedmetadata", () => {
          if (requestId !== qualityRequestRef.current) return;
          setResolvedQuality(Number(streamQuality) || 0);
          qualityBusyRef.current = false;
          setQualityBusy(false);
          if (shouldPlayRef.current) playSafely(video); else video.pause();
        }, { once: true });
      }
    } catch (error) {
      if (activeTranscodeSessionRef.current === session) {
        activeTranscodeSessionRef.current = null;
      }
      cancelTranscodeSession(session);
      if (requestId !== qualityRequestRef.current) return;
      if (!directPlaybackCompatibleRef.current || audioTracks.length > 1 || selectedSubtitleStream !== null) {
        streamOffsetRef.current = 0;
        qualityBusyRef.current = false;
        setQualityBusy(false);
        setPlaybackError(`${selectedQuality === "auto" ? "Automatic quality" : selectedQuality === "original-aac" ? "Original resolution" : `${streamQuality}p`} failed. Try another quality.`);
        video.removeAttribute("src");
        video.load();
        return;
      }
      setQuality("original");
      setResolvedQuality(sourceHeight);
      streamOffsetRef.current = 0;
      setPlaybackError(`${selectedQuality === "auto" ? "Automatic quality" : `${streamQuality}p`} failed. Restored the original video.`);
      video.src = details.src;
      video.load();
      video.addEventListener("loadedmetadata", () => {
        if (requestId !== qualityRequestRef.current) return;
        video.currentTime = resumeAt;
        qualityBusyRef.current = false;
        setQualityBusy(false);
        if (shouldPlayRef.current) playSafely(video);
      }, { once: true });
    }
  };

  const seekTo = (targetTime: number) => {
    setMediaSessionSyncId((id) => id + 1);
    const video = videoRef.current;
    if (!video) return;
    const target = Math.min(duration || 0, Math.max(0, targetTime));
    if (backgroundAudioRef.current) {
      backgroundAudioRef.current.currentTime = Math.max(0, target - streamOffsetRef.current);
      setCurrentTime(target);
      return;
    }
    if (quality === "original") {
      updateLoadingTarget(timeIsBuffered(video, target) ? null : target);
      video.currentTime = target;
    } else {
      const localTarget = target - streamOffsetRef.current;
      if (localTarget >= 0 && localTarget <= (video.duration || 0)) {
        const buffered = timeIsBuffered(video, localTarget);
        updateLoadingTarget(buffered ? null : target);
        video.currentTime = localTarget;
        if (hlsRef.current) {
          // Rebase the forward-buffer target after every explicit seek, including
          // seeks that land inside an already-buffered range.
          hlsRef.current.startLoad(localTarget, true);
        }
      } else {
        updateLoadingTarget(target);
        void changeQuality(quality, target, true);
      }
    }
    setCurrentTime(target);
  };

  const updateBufferedRanges = (video: HTMLVideoElement) => {
    const offset = streamOffsetRef.current;
    const next = Array.from({ length: video.buffered.length }, (_, index) => ({
      start: video.buffered.start(index) + offset,
      end: video.buffered.end(index) + offset,
    })).filter((range) => range.end > range.start);
    const signature = next.map((range) => `${range.start.toFixed(1)}:${range.end.toFixed(1)}`).join("|");
    if (signature !== bufferedSignatureRef.current) {
      bufferedSignatureRef.current = signature;
      setBufferedRanges(next);
    }
  };

  const seekBy = (seconds: number) => {
    if (details?.kind === "image") {
      goToQueueItem(seconds > 0 ? nextQueueItem : previousQueueItem);
      return;
    }
    seekTo(currentTime + seconds);
  };
  const performAutoSkip = useEffectEvent((segment: SkipSegmentDecision) => seekTo(segment.end));
  useEffect(() => {
    if (!details?.moviesTv || !autoSkipEnabled || !activeSkipSegment || !playing) return;
    const key = `${activeSkipSegment.kind}:${activeSkipSegment.start.toFixed(2)}:${activeSkipSegment.end.toFixed(2)}`;
    if (autoSkippedRef.current.has(key)) return;
    autoSkippedRef.current.add(key);
    performAutoSkip(activeSkipSegment);
  }, [autoSkipEnabled, activeSkipSegment, details?.moviesTv, playing]);

  const updateAutoSkip = (enabled: boolean) => {
    const showKey = details && autoSkipShowKey(details);
    const next = showKey
      ? { ...playbackPreferences, auto_skip_by_show: { ...playbackPreferences.auto_skip_by_show, [showKey]: enabled } }
      : { ...playbackPreferences, auto_skip_enabled: enabled };
    setPlaybackPreferences(next);
    void authFetch(`${API_BASE}/api/playback-preferences`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }).catch(() => {
      setPlaybackPreferences(playbackPreferences);
      setSkipDataError("Could not save auto-skip preference");
  });
};

  const updateAutoNext = (enabled: boolean) => {
    const next = { ...playbackPreferences, auto_next_enabled: enabled };
    setPlaybackPreferences(next);
    void authFetch(`${API_BASE}/api/playback-preferences`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }).catch(() => {
      setPlaybackPreferences(playbackPreferences);
      setPlaybackError("Could not save auto-next preference");
    });
  };

  const updateImageSeconds = (seconds: number) => {
    const previous = playbackPreferences;
    const next = { ...previous, image_seconds: normalizeImageSeconds(seconds) };
    setPlaybackPreferences(next);
    void authFetch(`${API_BASE}/api/playback-preferences`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }).catch(() => {
      setPlaybackPreferences(previous);
      setPlaybackError("Could not save image duration");
    });
  };

  const updateBufferSize = (buffer_size_mb: PlaybackPreferences["buffer_size_mb"]) => {
    const previous = playbackPreferences;
    const next = { ...previous, buffer_size_mb };
    setPlaybackPreferences(next);
    void authFetch(`${API_BASE}/api/playback-preferences`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (hlsRef.current) {
        const streamQuality = quality === "original-aac"
          ? String(sourceHeightRef.current || sourceHeight || qualityLevels[0] || 720)
          : quality;
        const targetBufferSeconds = transcodeBufferSeconds(streamQuality, sourceHeightRef.current || sourceHeight, buffer_size_mb);
        hlsRef.current.config.maxBufferLength = targetBufferSeconds;
        hlsRef.current.config.maxMaxBufferLength = TRANSCODE_MAX_BUFFER_SECONDS;
        hlsRef.current.config.maxBufferSize = buffer_size_mb * 1_000_000;
        hlsRef.current.startLoad(videoRef.current?.currentTime ?? 0, true);
      }
    }).catch(() => {
      setPlaybackPreferences(previous);
      setPlaybackError("Could not save buffer preference");
    });
  };

  useEffect(() => {
    if (!details || details.kind === "image") return;
    let cancelled = false;
    setAudioCompatibilityChecked(false);
    setAudioTracksLoaded(false);
    setAudioTracks([]);
    setSelectedAudioStream(null);
    if (details.offline) {
      directPlaybackCompatibleRef.current = true;
      setAudioCompatibilityChecked(true);
      setAudioTracksLoaded(true);
      return;
    }
    const path = detailsMediaPath(details);
    const cached = videoInfoCacheRef.current.get(path);
    void (cached ? Promise.resolve(cached) : fetch(`${API_BASE}/api/qualities?video_path=${encodeURIComponent(path)}`)
      .then((response) => response.ok ? response.json() as Promise<VideoInfo> : Promise.reject(new Error("Could not inspect this video's audio tracks"))))
      .then((info) => {
        if (cancelled || !info) return;
        sourceHeightRef.current = info.source_height;
        setSourceHeight(info.source_height);
        setQualityLevels(info.levels.filter((height) => height !== info.source_height));
        videoCopyableRef.current = canDirectPlayVideo(info, videoRef.current);
        directPlaybackCompatibleRef.current = info.audio_compatible && videoCopyableRef.current;
        const availableAudioTracks = info.audio_tracks ?? [];
        setAudioTracks(availableAudioTracks);
        setSelectedAudioStream(preferredAudioTrack(availableAudioTracks, audioLanguageRef.current)?.stream_index ?? null);
        // ffprobe already supplied HLS metadata; do not wait for the browser to
        // parse the temporary, often unsupported original HEVC/10-bit source.
        if (!directPlaybackCompatibleRef.current || availableAudioTracks.length > 1) setMetadataLoaded(true);
        setAudioTracksLoaded(true);
        if (Number.isFinite(info.duration) && info.duration! > 0) {
          sourceDurationRef.current = info.duration!;
          setDuration(info.duration!);
        }
        setAudioCompatibilityChecked(true);
        if (details.playAttemptId && details.playAttemptStartedAt) {
          reportClientPerformance("qualities_resolved", Date.now() - details.playAttemptStartedAt, {
            attempt_id: details.playAttemptId,
            media_name: details.name,
            audio_codec: info.audio_codec,
            audio_compatible: info.audio_compatible,
            video_codec: info.video_codec,
            video_profile: info.video_profile,
            mode: directPlaybackCompatibleRef.current ? "direct" : "transcode",
          });
        }
        if (!info.audio_compatible) {
          setPlaybackError(`Your browser cannot play ${info.audio_codec?.toUpperCase() ?? "this"} audio directly. Using AAC instead.`);
        }
      })
      .catch(() => {
        if (!cancelled) setPlaybackError("Could not inspect audio tracks. Reload to retry playback.");
      });
    return () => { cancelled = true; };
  }, [details?.src, details?.kind]);

  const startInitialFallback = useEffectEvent((source: WatchDetails) => {
    initialResumeAppliedRef.current = source.src;
    void changeQuality("original", initialResumeRef.current, true, shouldPlayRef.current);
  });

  useEffect(() => {
    if (!details || details.kind === "image" || !savedPlaybackLoaded || !metadataLoaded || !audioCompatibilityChecked || !audioTracksLoaded) return;
    if ((directPlaybackCompatibleRef.current && audioTracks.length <= 1) || quality !== "original" || qualityBusyRef.current) return;
    if (initialResumeAppliedRef.current === details.src) return;

    // Starting the AAC/HLS fallback before user-state finishes loading races
    // the saved resume position and permanently anchors the transcode at 0.
    // Coordinate all startup prerequisites here so the first request always
    // carries the authoritative resume point.
    startInitialFallback(details);
  }, [audioCompatibilityChecked, audioTracks.length, audioTracksLoaded, details, metadataLoaded, quality, savedPlaybackLoaded]);

  const changeAudioTrack = (streamIndex: number) => {
    if (streamIndex === selectedAudioStream || !details) return;
    const video = videoRef.current;
    // currentTime is already the absolute timeline position; adding the HLS
    // offset again makes every subsequent track switch jump forward.
    const resumeAt = currentTime;
    const shouldContinue = video ? !video.paused : playing;
    audioLanguageRef.current = audioTracks.find((track) => track.stream_index === streamIndex)?.language ?? "en";
    setSelectedAudioStream(streamIndex);
    void changeQuality(quality === "original" ? "original" : quality, resumeAt, true, shouldContinue, undefined, streamIndex);
  };

  useEffect(() => {
    if (!details || details.offline || details.kind !== "video" || !nextQueueItem?.path || nextQueueItem.kind !== "video" || nextQueueItem.offline || !playing) return;
    const path = nextQueueItem.path;
    const currentPath = detailsMediaPath(details);
    const language = audioTracks.find((track) => track.stream_index === selectedAudioStream)?.language ?? audioLanguageRef.current;
    const controller = new AbortController();
    let session: string | null = null;
    let timer: ReturnType<typeof setTimeout>;
    let refreshTimer: ReturnType<typeof setInterval> | undefined;
    const prepare = async () => {
      const video = videoRef.current;
      const bufferTarget = video ? Math.min(video.currentTime + 3, Math.max(0, video.duration - 0.1)) : 0;
      if (qualityBusyRef.current || !video || video.paused || !timeIsBuffered(video, bufferTarget)) {
        timer = setTimeout(() => { void prepare(); }, 2000);
        return;
      }
      try {
        const signal = controller.signal;
        const infoResponse = await fetch(`${API_BASE}/api/qualities?video_path=${encodeURIComponent(path)}`, { signal });
        if (!infoResponse.ok) return;
        const info = await infoResponse.json() as VideoInfo;
        if (info.duration && Number.isFinite(info.duration)) rememberQueueDuration(path, info.duration);
        videoInfoCacheRef.current.clear();
        videoInfoCacheRef.current.set(path, info);
        const audio = preferredAudioTrack(info.audio_tracks ?? [], language)?.stream_index ?? null;
        const stateResponse = await authFetch(playbackUserStateUrl(API_BASE), { signal });
        if (!stateResponse.ok) return;
        const state = await stateResponse.json() as UserState;
        const userId = getSessionUser()?.id;
        nextUserStateRef.current = { path, userId, state };
        // Keep the next episode's resume information fresh during long episodes,
        // so switching does not wait for another full user-state request.
        refreshTimer = setInterval(() => {
          void authFetch(playbackUserStateUrl(API_BASE), { signal }).then(async (response) => {
            if (!response.ok) return;
            const refreshed = await response.json() as UserState;
            if (!signal.aborted && nextUserStateRef.current?.path === path && getSessionUser()?.id === userId) {
              nextUserStateRef.current = { path, userId, state: refreshed };
            }
          }).catch(() => undefined);
        }, 30000);
        const progress = mergeWatchProgress(state.playback, readLocalWatchProgress(getSessionUser()?.id))[path];
        const start = Math.max(0, Math.floor(progress && !progress.completed ? progress.position : 0));
        let subtitle: number | null = null;
        if (burnedSubtitleStream !== null) {
          const response = await fetch(`${API_BASE}/api/subtitles?video_path=${encodeURIComponent(path)}`, { signal });
          if (!response.ok) return;
          const nextTracks = await response.json() as SubtitleTrack[];
          const label = tracks.find((track) => track.stream_index === burnedSubtitleStream)?.label;
          subtitle = nextTracks.find((track) => track.mode === "burn_in" && track.label === label)?.stream_index ?? null;
          if (subtitle === null) return;
        }
        // Queue navigation starts the new file at its original resolution.
        const streamQuality = String(info.source_height);
        if (quality === "original" && info.audio_compatible && canDirectPlayVideo(info, videoRef.current) && info.audio_tracks.length <= 1 && subtitle === null) {
          if (canBufferQueueVideo(nextQueueItem)) setPreparedVideo({ slot: 1 - activeVideoSlot, src: nextQueueItem.src! });
          return;
        }
        session = createTranscodeSessionId();
        nextPreloadRef.current = { path, session, quality: streamQuality, audio, subtitle, start };
        preloadedFragmentsRef.current.clear();
        const query = new URLSearchParams({ video_path: path, quality: streamQuality, start: String(start), session, preload: "true" });
        if (canDirectPlayVideo(info, videoRef.current)) query.set("copy_video", "true");
        if (audio !== null) query.set("audio_stream", String(audio));
        if (subtitle !== null) query.set("subtitle_stream", String(subtitle));
        const response = await fetch(`${API_BASE}/api/transcode?${query}`, { signal });
        if (!response.ok) throw new Error("Next episode preload failed");
        const result = await response.json() as { url: string };
        const playlistUrl = new URL(`${API_BASE}${result.url}`, window.location.href).href;
        const playlist = await fetch(playlistUrl, { signal }).then((response) => response.text());
        for (const url of preloadSegments(playlist, playlistUrl)) {
          const fragment = await fetch(url, { signal });
          if (!fragment.ok) throw new Error("Next episode segment unavailable");
          const bytes = await fragment.arrayBuffer();
          if (!signal.aborted) preloadedFragmentsRef.current.set(url, bytes);
        }
        reportClientPerformance("next_episode_preloaded", 0, { media_path: path, segments: preloadedFragmentsRef.current.size, audio_stream: audio });
      } catch {
        // Background preparation must not interrupt the current episode.
        if (session && activeTranscodeSessionRef.current !== session) void cancelTranscodeSession(session);
        if (nextPreloadRef.current?.session === session) nextPreloadRef.current = null;
      }
    };
    timer = setTimeout(() => { void prepare(); }, 500);
    return () => {
      clearTimeout(timer);
      if (refreshTimer) clearInterval(refreshTimer);
      // Keep the prefix and session when Next is pressed, until changeQuality
      // adopts it. A queue reorder, language change or exit cancels stale work.
      if (session && detailsMediaPath(detailsRef.current ?? details) === path && path !== currentPath) return;
      controller.abort();
      setPreparedVideo((current) => current?.src === nextQueueItem.src ? null : current);
      if (session && activeTranscodeSessionRef.current !== session) void cancelTranscodeSession(session);
      if (nextPreloadRef.current?.session === session) nextPreloadRef.current = null;
    };
  }, [details?.src, details?.offline, nextQueueItem?.path, nextQueueItem?.kind, playing, quality, selectedAudioStream, burnedSubtitleStream, activeVideoSlot]);

  const updateCaptionPreferences = (changes: Partial<CaptionPreferences>) => {
    const previous = playbackPreferences;
    const next = { ...previous, caption_preferences: { ...previous.caption_preferences, ...changes } };
    setPlaybackPreferences(next);
    void authFetch(`${API_BASE}/api/playback-preferences`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }).catch(() => {
      setPlaybackPreferences(previous);
      setPlaybackError("Could not save caption settings");
    });
  };

  const saveCaptionsEnabled = (enabled: boolean) => {
    const previous = playbackPreferences;
    const next = { ...previous, captions_enabled: enabled };
    setPlaybackPreferences(next);
    void authFetch(`${API_BASE}/api/playback-preferences`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }).catch(() => {
      setPlaybackPreferences(previous);
      setPlaybackError("Could not save caption preference");
    });
  };

  const saveCaptionSelection = (next: CaptionSelection) => {
    if (!details) return;
    setCaptionSelection(next);
    void authFetch(`${API_BASE}/api/caption-selection`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: captionSelectionKey(details), ...next }),
    }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }).catch(() => {
      setPlaybackError("Could not save caption choice");
    });
  };

  const resetCaptionPreferences = () => updateCaptionPreferences(DEFAULT_CAPTION_PREFERENCES);

  const dragCaption = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    const player = playerRef.current;
    if (!player) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    let latestPosition: Pick<CaptionPreferences, "position_x" | "position_y"> | null = null;
    const move = (pointer: PointerEvent) => {
      const bounds = player.getBoundingClientRect();
      latestPosition = {
        position_x: Math.max(5, Math.min(95, (pointer.clientX - bounds.left) / bounds.width * 100)),
        position_y: Math.max(5, Math.min(95, (pointer.clientY - bounds.top) / bounds.height * 100)),
      };
      setPlaybackPreferences((current) => ({ ...current, caption_preferences: { ...current.caption_preferences, ...latestPosition } }));
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      if (latestPosition) updateCaptionPreferences(latestPosition);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish, { once: true });
    window.addEventListener("pointercancel", finish, { once: true });
  };

  const seekByLatest = useEffectEvent(seekBy);

  const libraryReturnUrl = () => {
    const explicitReturn = new URLSearchParams(watchLocationSearch()).get("return");
    if (explicitReturn?.startsWith("/") && !explicitReturn.startsWith("//") && !explicitReturn.startsWith("/watch")) return explicitReturn;
    const snapshot = readReturnBrowseSnapshot(getSessionUser()?.id);
    return snapshot?.url && !snapshot.url.startsWith("/watch") ? snapshot.url : browseReturnUrlFromLocation(details);
  };

  const leaveToLibrary = async () => {
    if ((companionRef.current || details?.kind !== "audio") && !catalogResolveError) {
      // Like YouTube: touch screens keep the same player running in the
      // mini player; desktop stops it. Unmounting saves progress.
      leaveWatch(libraryReturnUrl());
      return;
    }
    persistExitProgress();
    exitingRef.current = true;
    if (details?.kind === "audio") {
      const audio = videoRef.current;
      const item = queue.find((entry) => entry.path === detailsMediaPath(details));
      const shared = restorePlaybackSession(getSessionUser()?.id);
      const session = shared?.item.path === item?.path ? shared : item ? startPlaybackSession({
        userId: getSessionUser()?.id ?? 0, item, queue, source: details.queueSource,
        label: details.queueLabel, returnUrl: browseReturnUrlFromLocation(details),
        complete: true, time: 0, playing: details.playIntent,
      }) : null;
      if (session) setPlaybackSession({ ...session,
        time: audio && !playbackStartupPending() ? audio.currentTime + streamOffsetRef.current : initialResumeRef.current,
        playing: playbackStartupPending() ? details.playIntent : audio ? !audio.paused : playing,
        handoff: true, watchEntry: true });
      audio?.pause();
    }
    // Do this before navigating without blocking page navigation.
    void stopActiveTranscode();
    hlsRef.current?.destroy();
    hlsRef.current = null;
    closeWatch(libraryReturnUrl());
  };
  const leaveToLibraryLatest = useEffectEvent(leaveToLibrary);
  const openMiniplayer = () => minimizeWatch(libraryReturnUrl());
  const toggleMiniplayerLatest = useEffectEvent(() => {
    if (watchModeRef.current === "mini") expandWatch();
    else openMiniplayer();
  });

  useEffect(() => {
    if (watchMode !== "full") return;
    setWatchBackHandler(() => { void leaveToLibraryLatest(); });
    return () => setWatchBackHandler(null);
  }, [watchMode]);

  // Legacy/shared audio Watch URLs recover their queue before moving to the
  // mini player, rather than stranding the user in the full-screen video UI.
  useEffect(() => {
    if (details?.kind !== "audio" || !savedPlaybackLoaded || queueLoadStatus !== "idle" || !queue.some((entry) => entry.path === detailsMediaPath(details))) return;
    void leaveToLibraryLatest();
  }, [details?.src, savedPlaybackLoaded, queueLoadStatus, queue]);


  useEffect(() => {
    const keyboard = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (["INPUT", "SELECT", "TEXTAREA"].includes(target?.tagName ?? "") || target?.isContentEditable) return;
      // "i" toggles the mini player, as on YouTube.
      if (event.key.toLowerCase() === "i" && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        toggleMiniplayerLatest();
        return;
      }
      // The library owns the rest of the keyboard while the video is small.
      if (watchModeRef.current !== "full") return;
      if (event.key === "Escape" && !document.fullscreenElement) {
        event.preventDefault();
        if (!closeTopBackLayer()) leaveToLibraryLatest();
      }
      else if (event.key === "ArrowLeft") { event.preventDefault(); seekByLatest(-10); }
      else if (event.key === "ArrowRight") { event.preventDefault(); seekByLatest(10); }
      else if (event.key === " " || event.key.toLowerCase() === "k") { event.preventDefault(); togglePlayback(); }
      else if (event.key.toLowerCase() === "m") setMuted((value) => !value);
      else if (event.key.toLowerCase() === "f") toggleFullscreen();
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, []);

  const saveProgress = (video: HTMLMediaElement, completed = false) => {
    const totalDuration = sourceDurationRef.current || duration;
    if (!details || !savesWatchProgress(detailsMediaPath(details)) || !Number.isFinite(totalDuration) || totalDuration <= 0) return;
    if (exitingRef.current || playbackStartupPending() || qualityBusyRef.current) return;
    const position = video.currentTime + streamOffsetRef.current;
    if (loadingTargetRef.current !== null && Math.abs(position - loadingTargetRef.current) > 2) return;
    completed ||= isShowWatch(details) && episodeFinished({ position, duration: totalDuration, updated: 0 });
    const progressState = { position: completed ? totalDuration : position, duration: totalDuration, updated: Math.floor(Date.now() / 1000), completed };
    setSavedPlayback(progressState);
    const path = detailsMediaPath(details);
    updateSnapshotPlayback(path, progressState);
    writeLocalWatchProgress(getSessionUser()?.id, path, progressState);
  };
  const goToQueueItem = (item: MediaItem | null, completed = false) => {
    if (!details || !item?.src) return;
    if (companionRef.current && !playsAlongside(item.path)) return;
    if (item.src === details.src) return;
    if (item.path && detailsMediaPath(details) && item.path === detailsMediaPath(details)) return;
    if (item.offline?.fileId && details.offlineFileId && item.offline.fileId === details.offlineFileId) return;
    const trace = beginPlaybackTrace({ trigger: completed ? "auto_next" : "queue_select", media_name: item.name });
    ++qualityRequestRef.current;
    const video = videoRef.current;
    const activeMedia = backgroundAudioRef.current ?? video;
    const continueBackgroundAudio = item.kind === "video" && (audioOnlyRef.current || continueBackgroundAudioRef.current || nativeBackgroundRef.current);
    preserveHiddenControlsRef.current = !controlsVisibleRef.current;
    if (details.kind !== "image" && video) {
      if (!completed) {
        saveProgress(activeMedia ?? video);
        sendPlaybackActivity(details, "stopped", (activeMedia ?? video).currentTime + streamOffsetRef.current, sourceDurationRef.current || video.duration || 0);
      }
      if (backgroundAudioRef.current) stopBackgroundAudio();
      stopActiveTranscode();
      hlsRef.current?.destroy();
      hlsRef.current = null;
      qualityBusyRef.current = false;
      setQualityBusy(false);
      video.pause();
    }
    continueBackgroundAudioRef.current = continueBackgroundAudio;
    const shared = restorePlaybackSession(getSessionUser()?.id);
    const audioProgress = readLocalWatchProgress(getSessionUser()?.id)[item.path ?? ""];
    const baseSession = shared ?? startPlaybackSession({ userId: getSessionUser()?.id ?? 0, item, queue, source: details.queueSource,
        label: details.queueLabel, returnUrl: browseReturnUrlFromLocation(details), complete: true, time: 0, playing: true });
    const nextSession = { ...selectPlaybackItem(baseSession, item), queue, source: details.queueSource ? queueSourceForItem(details.queueSource, item) : undefined, complete: true,
      time: item.kind === "audio" && audioProgress && !audioProgress.completed ? audioProgress.position : 0, handoff: item.kind === "audio", watchEntry: true };
    setPlaybackSession(nextSession);
    queueNavigationPathRef.current = item.path ?? null;
    if (item.kind === "audio" && !companionRef.current) {
      exitingRef.current = true;
      // Audio continues in the audio mini player. Leaving replaces or pops
      // the Watch entry, so Back never walks the queue.
      closeWatch(playbackReturnUrl(nextSession.returnUrl));
      return;
    }
    // Selecting another episode is a request to play it, even if the outgoing
    // media is paused or still preparing its stream.
    shouldPlayRef.current = true;
    initialResumeRef.current = 0;
    playbackHandoffRef.current = null;
    pendingInitialTranscodeRef.current = false;
    setPlaybackError("");
    setSavedPlaybackLoaded(false);
    setSavedPlayback(undefined);
    setMetadataLoaded(false);
    setCurrentTime(0);
    setDuration(0);
    updateLoadingTarget(null);
    setSeekHover(null);
    setBufferedRanges([]);
    bufferedSignatureRef.current = "";
    streamOffsetRef.current = 0;
    sourceDurationRef.current = 0;
    sourceHeightRef.current = 0;
    setSourceHeight(0);
    setResolvedQuality(0);
    setQuality("original");
    setCues([]);
    setCaptionStatus({ state: "idle", label: "Off" });
    setSkipData(null);
    setSkipDataError("");
    autoSkippedRef.current.clear();
    closePopups();
    setFavorite(Boolean(item.favorite));
    setAudioCompatibilityChecked(false);
    setAudioTracksLoaded(false);
    setAudioTracks([]);
    setSelectedAudioStream(null);
    const nextDetails: WatchDetails = {
      ...watchDetailsFromItem(item, details),
      playIntent: true,
      playAttemptId: trace.id,
      playAttemptStartedAt: trace.startedAt,
    };
    const prepared = preparedVideoRef.current;
    if (!pip && prepared?.src === item.src && (videoSlotsRef.current[prepared.slot]?.readyState ?? 0) >= 2) {
      setActiveVideoSlot(prepared.slot);
      setPreparedVideo(null);
    }
    setDetails(nextDetails);
    replaceWatchLocation(`/watch?${watchParamsFromItem(item, nextDetails).toString()}`);
    setPlaying(item.kind === "image");
    if (item.kind === "image") setDuration(imageSeconds);
  };
  useEffect(() => {
    if (!details || !queue.length) return;
    const item = queue.find((entry) => entry.path === detailsMediaPath(details));
    if (!item) return;
    const shared = restorePlaybackSession(getSessionUser()?.id);
    if (shared && shared.item.path === item.path) {
      setPlaybackSession({ ...shared, item, queue, source: details.queueSource, complete: true });
    } else {
      startPlaybackSession({ userId: getSessionUser()?.id ?? 0, item, queue, source: details.queueSource,
        label: details.queueLabel, returnUrl: browseReturnUrlFromLocation(details), watchEntry: true, complete: true, time: 0, playing: details.playIntent });
    }
  }, [queue, details?.src]);

  const reorderQueue = (fromIndex: number, toIndex: number) => {
    if (fromIndex === toIndex) return;
    applyQueue((current) => {
      if (fromIndex < 0 || toIndex < 0 || fromIndex >= current.length || toIndex >= current.length) return current;
      const next = [...current];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      if (detailsRef.current) {
        try {
          sessionStorage.setItem(PLAYBACK_QUEUE_ORDER_KEY, JSON.stringify({
            scope: detailsRef.current.series ?? detailsRef.current.queueFolder ?? detailsRef.current.folder,
            paths: next.flatMap((item) => item.path ? [item.path] : []),
            createdAt: Date.now(),
          } satisfies StoredQueueOrder));
        } catch {
        }
      }
      return next;
    });
  };
  const reportPlayback = (event: "started" | "resumed" | "paused" | "completed", video: HTMLMediaElement) => {
    if (!details || exitingRef.current || playbackStartupPending() || qualityBusyRef.current) return;
    const position = video.currentTime + streamOffsetRef.current;
    const signature = `${event}:${Math.floor(position)}`;
    if (lastActivityRef.current.signature === signature && Date.now() - lastActivityRef.current.sentAt < 750) return;
    lastActivityRef.current = { signature, sentAt: Date.now() };
    sendPlaybackActivity(details, event, position, sourceDurationRef.current || duration || video.duration || 0);
  };
  const handlePlaybackEnded = (video: HTMLMediaElement) => {
    const absolutePosition = video.currentTime + streamOffsetRef.current;
    const totalDuration = sourceDurationRef.current || duration || (quality === "original" ? video.duration : 0);
    const completed = totalDuration > 0 && absolutePosition >= totalDuration - 2;
    if (completed) {
      saveProgress(video, true);
      reportPlayback("completed", video);
      if (!loopEnabled && playbackPreferences.auto_next_enabled) goToQueueItem(nextQueueItem, true);
      return;
    }
    saveProgress(video);
    setPlaybackError("The stream ended early. Resuming from the same position…");
    void changeQuality(quality, absolutePosition, true, true);
  };
  const skipSegment = (segment: SkipSegmentDecision) => {
    if (details && isShowWatch(details) && nextQueueItem && endingSkipAdvancesEpisode(details, segment.kind)) {
      const media = backgroundAudioRef.current ?? videoRef.current;
      if (media) {
        saveProgress(media, true);
        reportPlayback("completed", media);
      }
      goToQueueItem(nextQueueItem, true);
      return;
    }
    seekTo(segment.end);
  };
  const seekPreviewUrl = seekHover && details && !details.offline ? `${API_BASE}/api/preview-frame?${new URLSearchParams({ video_path: detailsMediaPath(details), time: seekHover.frameTime.toFixed(2), ...(burnedSubtitleStream === null ? {} : { subtitle_stream: String(burnedSubtitleStream) }) })}` : "";
  const [mediaSessionSyncId, setMediaSessionSyncId] = useState(0);

  const stopBackgroundAudio = () => {
    ++backgroundAudioGenerationRef.current;
    const audio = backgroundAudioRef.current;
    backgroundAudioRef.current = null;
    audioOnlyRef.current = false;
    continueBackgroundAudioRef.current = false;
    backgroundAudioHandoffAtRef.current = 0;
    setAudioOnly(false);
    backgroundAudioHlsRef.current?.destroy();
    backgroundAudioHlsRef.current = null;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      releaseMediaVolume(audio);
      audio.remove();
    }
  };

  const restoreVideoFromBackgroundAudio = () => {
    continueBackgroundAudioRef.current = false;
    ++backgroundAudioGenerationRef.current;
    const audio = backgroundAudioRef.current;
    const video = videoRef.current;
    if (!audio || !video) return;
    const position = audio.currentTime;
    const resume = shouldPlayRef.current && !audio.ended;
    stopBackgroundAudio();
    video.currentTime = position;
    shouldPlayRef.current = resume;
    if (resume) playSafely(video);
    setCurrentTime(position + streamOffsetRef.current);
  };
  const restoreVideoLatest = useEffectEvent(restoreVideoFromBackgroundAudio);

  useEffect(() => {
    if (!nativePipAvailable()) return;
    const onVisible = () => {
      if (document.visibilityState === "visible") restoreVideoLatest();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const onBackgroundAudioTimeUpdate = (audio: HTMLAudioElement) => {
    if (backgroundAudioRef.current !== audio) return;
    const position = audio.currentTime + streamOffsetRef.current;
    setCurrentTime(position);
    if (Date.now() - lastSavedAt.current > 3_000) {
      lastSavedAt.current = Date.now();
      saveProgress(audio);
    }
  };
  const onBackgroundAudioEnded = (audio: HTMLAudioElement) => {
    if (backgroundAudioRef.current === audio) handlePlaybackEnded(audio);
  };
  const watchBackgroundAudio = (audio: HTMLAudioElement) => {
    audio.addEventListener("timeupdate", () => backgroundAudioCallbacksRef.current?.timeupdate(audio));
    audio.addEventListener("play", () => { resumeMediaVolume(audio); if (backgroundAudioRef.current === audio) setPlaying(true); });
    audio.addEventListener("pause", () => {
      if (backgroundAudioRef.current !== audio) return;
      if (!audio.ended && (nativeBackgroundRef.current || document.visibilityState === "hidden") && shouldPlayRef.current) {
        void restartBackgroundAudioAfterHide();
      } else {
        setPlaying(false);
      }
    });
    audio.addEventListener("ended", () => backgroundAudioCallbacksRef.current?.ended(audio));
  };

  const restartBackgroundAudioAfterHide = async () => {
    const previous = backgroundAudioRef.current;
    if (!previous || backgroundAudioRestartingRef.current) return;
    backgroundAudioRestartingRef.current = true;
    const generation = backgroundAudioGenerationRef.current;
    const previousHls = backgroundAudioHlsRef.current;
    const replacement = document.createElement("audio");
    replacement.preload = "auto";
    applyMediaVolume(replacement, readMediaVolumePosition(previous));
    replacement.muted = previous.muted;
    replacement.playbackRate = previous.playbackRate;
    document.body.appendChild(replacement);
    let replacementHls: Hls | null = null;
    try {
      const ready = new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(() => reject(new Error("Background audio did not load")), 15_000);
        replacement.addEventListener("loadedmetadata", () => { window.clearTimeout(timeout); resolve(); }, { once: true });
        replacement.addEventListener("error", () => { window.clearTimeout(timeout); reject(new Error("Background audio could not load")); }, { once: true });
      });
      if (previousHls && Hls.isSupported()) {
        const url = previousHls.url;
        if (!url) throw new Error("Background audio stream is not ready");
        replacementHls = new Hls({ enableWorker: true, startPosition: 0 });
        replacementHls.loadSource(url);
        replacementHls.attachMedia(replacement);
      } else {
        replacement.src = previous.currentSrc;
      }
      await ready;
      if (generation !== backgroundAudioGenerationRef.current || backgroundAudioRef.current !== previous || !shouldPlayRef.current) {
        replacementHls?.destroy();
        replacement.removeAttribute("src");
        replacement.load();
        releaseMediaVolume(replacement);
        replacement.remove();
        return;
      }
      replacement.currentTime = previous.currentTime;
      await replacement.play();
      if (generation !== backgroundAudioGenerationRef.current || backgroundAudioRef.current !== previous || !shouldPlayRef.current) {
        replacementHls?.destroy();
        replacement.pause();
        replacement.removeAttribute("src");
        replacement.load();
        releaseMediaVolume(replacement);
        replacement.remove();
        return;
      }
      backgroundAudioRef.current = replacement;
      backgroundAudioHlsRef.current = replacementHls;
      watchBackgroundAudio(replacement);
      previousHls?.destroy();
      previous.pause();
      previous.removeAttribute("src");
      previous.load();
      releaseMediaVolume(previous);
      previous.remove();
      setPlaying(true);
      setMediaSessionSyncId((id) => id + 1);
    } catch (error) {
      replacementHls?.destroy();
      replacement.pause();
      replacement.removeAttribute("src");
      replacement.load();
      releaseMediaVolume(replacement);
      replacement.remove();
      if (backgroundAudioRef.current === replacement) {
        backgroundAudioRef.current = previous;
        backgroundAudioHlsRef.current = previousHls;
      }
      if (generation === backgroundAudioGenerationRef.current) {
        setPlaybackError(error instanceof Error ? error.message : "Background audio stopped.");
        setPlaying(false);
      }
    } finally {
      backgroundAudioRestartingRef.current = false;
    }
  };

  const startBackgroundAudio = async (automatic = false) => {
    const video = videoRef.current;
    if (!video || backgroundAudioRef.current || backgroundAudioStartingRef.current) return;
    if (automatic && (details?.kind !== "video" || !shouldPlayRef.current)) return;
    backgroundAudioStartingRef.current = true;
    const generation = ++backgroundAudioGenerationRef.current;
    const source = video.currentSrc || video.src;
    const audio = document.createElement("audio");
    audio.preload = "auto";
    applyMediaVolume(audio, readMediaVolumePosition(video));
    audio.muted = video.muted;
    audio.playbackRate = video.playbackRate;
    document.body.appendChild(audio);
    const ready = new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error("Audio did not load")), 15_000);
      audio.addEventListener("loadedmetadata", () => { window.clearTimeout(timeout); resolve(); }, { once: true });
      audio.addEventListener("error", () => { window.clearTimeout(timeout); reject(new Error("Audio could not load")); }, { once: true });
    });
    try {
      if (hlsRef.current && Hls.isSupported()) {
        const url = hlsRef.current.url;
        if (!url) throw new Error("Audio stream is not ready");
        // Start loading at the current position instead of fetching from 0 and seeking.
        const hls = new Hls({ enableWorker: true, startPosition: video.currentTime });
        backgroundAudioHlsRef.current = hls;
        hls.loadSource(url);
        hls.attachMedia(audio);
      } else {
        audio.src = video.currentSrc || video.src;
      }
      await ready;
      // A quick unlock, explicit pause, or episode change can happen while
      // the second element is loading. Never revive stale playback.
      if (generation !== backgroundAudioGenerationRef.current || videoRef.current !== video || source !== (video.currentSrc || video.src) || (automatic && (!(nativeBackgroundRef.current || continueBackgroundAudioRef.current) || !shouldPlayRef.current))) {
        backgroundAudioHlsRef.current?.destroy();
        backgroundAudioHlsRef.current = null;
        audio.removeAttribute("src");
        audio.load();
        releaseMediaVolume(audio);
        audio.remove();
        return;
      }
      audio.currentTime = video.currentTime;
      await audio.play();
      if (generation !== backgroundAudioGenerationRef.current || (automatic && (!(nativeBackgroundRef.current || continueBackgroundAudioRef.current) || !shouldPlayRef.current))) {
        audio.pause();
        backgroundAudioHlsRef.current?.destroy();
        backgroundAudioHlsRef.current = null;
        audio.removeAttribute("src");
        audio.load();
        releaseMediaVolume(audio);
        audio.remove();
        return;
      }
      backgroundAudioRef.current = audio;
      audioOnlyRef.current = true;
      setAudioOnly(true);
      shouldPlayRef.current = true;
      backgroundAudioHandoffAtRef.current = Date.now();
      watchBackgroundAudio(audio);
      video.pause();
      setPlaying(true);
      setMediaSessionSyncId((id) => id + 1);
    } catch (error) {
      backgroundAudioHlsRef.current?.destroy();
      backgroundAudioHlsRef.current = null;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      releaseMediaVolume(audio);
      audio.remove();
      throw error;
    } finally {
      backgroundAudioStartingRef.current = false;
      if (generation !== backgroundAudioGenerationRef.current) backgroundAudioCallbacksRef.current?.retry();
    }
  };
  const retryBackgroundAudio = () => {
    const video = videoRef.current;
    if (video && shouldPlayRef.current && !qualityBusyRef.current && !playbackStartupPending()
      && (continueBackgroundAudioRef.current || nativeBackgroundRef.current)) playSafely(video);
  };
  // DOM listeners outlive renders; always use the current queue, preferences,
  // progress state and stream when they fire.
  useLayoutEffect(() => {
    backgroundAudioCallbacksRef.current = { timeupdate: onBackgroundAudioTimeUpdate, ended: onBackgroundAudioEnded, retry: retryBackgroundAudio, start: startBackgroundAudio };
  });
  const startBackgroundAudioLatest = useEffectEvent(startBackgroundAudio);

  useEffect(() => {
    if ((companionRef.current && foregroundRef.current) || !nativePipAvailable()) return;
    const video = videoRef.current;
    void syncNativePipState({
      active: Boolean(details?.kind === "video" && playing && !audioOnly),
      width: video?.videoWidth || Math.round(ratio * 1_000),
      height: video?.videoHeight || 1_000,
      playing,
      hasNext: Boolean(nextQueueItem),
    }).catch(console.error);
  }, [details?.kind, details?.src, playing, audioOnly, ratio, nextQueueItem?.src, foregroundMedia]);

  useEffect(() => () => {
    // Leaving the player (e.g. back to the library) must clear PiP eligibility,
    // otherwise Android auto-enters PiP on the next Home press with no video.
    if ((!companionRef.current || !foregroundRef.current) && nativePipAvailable()) void syncNativePipState({ active: false, width: 16, height: 9, playing: false, hasNext: false }).catch(console.error);
  }, []);

  useEffect(() => {
    let actionHandle: { remove: () => Promise<void> } | null = null;
    let stateHandle: { remove: () => Promise<void> } | null = null;
    void addNativePipActionListener(({ action }) => {
      if (companionRef.current && foregroundRef.current && action !== "background") return;
      if (action === "background") {
        nativeBackgroundRef.current = true;
        void startBackgroundAudioLatest(true).catch((error: unknown) => {
          setPlaybackError(error instanceof Error ? error.message : "Could not continue background playback.");
        });
      }
      else if (action === "foreground") {
        nativeBackgroundRef.current = false;
        restoreVideoLatest();
      }
      else if (action === "play-pause") togglePlayback();
      else if (action === "next" && nextQueueItem) goToQueueItem(nextQueueItem);
      else if (action === "audio-only") {
        void startBackgroundAudioLatest().catch((error: unknown) => {
          setPlaybackError(error instanceof Error ? error.message : "Could not switch to audio playback.");
        });
      }
      else if (action === "close") {
        pausePlayback();
        stopBackgroundAudio();
      }
    }).then((handle) => { actionHandle = handle; }).catch(console.error);
    void addNativePipStateListener(({ inPip }) => setPip(inPip))
      .then((handle) => { stateHandle = handle; }).catch(console.error);
    return () => {
      void actionHandle?.remove();
      void stateHandle?.remove();
    };
  }, [nextQueueItem?.src, details?.src]);

  const syncNativeSession = useEffectEvent(() => {
    if ((companionRef.current && foregroundRef.current) || !nativeMediaSessionAvailable() || !details || details.kind === "image") return;
    void syncNativeMediaSession({
      // Android sends distinct play and pause commands from the notification.
      // They must be idempotent: toggling here can turn a requested Play into a
      // Pause when the HTML media element and notification are briefly out of sync.
      onPlay: () => resumePlayback(),
      onPause: () => pausePlayback(),
      onSeekBackward: () => { const video = videoRef.current; if (video) seekTo(video.currentTime + streamOffsetRef.current - 10); },
      onSeekForward: () => { const video = videoRef.current; if (video) seekTo(video.currentTime + streamOffsetRef.current + 10); },
      onPrevious: () => {
        if (previousQueueItem) goToQueueItem(previousQueueItem);
        else { const video = videoRef.current; if (video) seekTo(streamOffsetRef.current); }
      },
      onNext: () => { if (nextQueueItem) goToQueueItem(nextQueueItem); },
      onSeekTo: (seconds) => seekTo(seconds),
      onFavorite: () => { void toggleFavorite(); },
    }, {
      title: details.name,
      subtitle: details.folder,
      album: details.queueLabel,
      duration,
      position: (backgroundAudioRef.current ?? videoRef.current)?.currentTime !== undefined ? (backgroundAudioRef.current ?? videoRef.current)!.currentTime + streamOffsetRef.current : displayedTime,
      playing,
      favorite,
      hasPrevious: true,
      hasNext: true,
      playbackRate,
    });
  });

  useEffect(() => {
    syncNativeSession();
  }, [details?.src, details?.kind, details?.name, details?.folder, details?.queueLabel, duration, playing, favorite, previousQueueItem?.src, nextQueueItem?.src, playbackRate, mediaSessionSyncId, foregroundMedia]);

  useEffect(() => () => {
    // Closing the mini player unmounts Watch without a page navigation.
    hlsRef.current?.destroy();
    hlsRef.current = null;
    ++backgroundAudioGenerationRef.current;
    const audio = backgroundAudioRef.current;
    backgroundAudioRef.current = null;
    backgroundAudioHlsRef.current?.destroy();
    backgroundAudioHlsRef.current = null;
    if (audio) {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      releaseMediaVolume(audio);
      audio.remove();
    }
    if (!companionRef.current || !foregroundRef.current) void clearNativeMediaSession();
  }, []);

  const qualityTriggerLabel = qualityBusy ? "Loading…" : quality === "auto" ? `Auto${resolvedQuality ? ` · ${resolvedQuality}p` : ""}` : quality === "original-aac" ? `Original · ${resolvedQuality || sourceHeight}p` : quality === "original" && !sourceHeight ? "Original" : `${resolvedQuality || sourceHeight}p`;
  const qualityCompactLabel = qualityBusy ? "…" : quality === "auto" ? (resolvedQuality ? `${resolvedQuality}p` : "Auto") : quality === "original-aac" ? `${resolvedQuality || sourceHeight}p` : quality === "original" && !sourceHeight ? "Original" : `${resolvedQuality || sourceHeight}p`;
  const renderCaptionTrack = (track: SubtitleTrack, index: number, closeMenu: () => void) => {
    const active = caption === String(index);
    return <button key={track.url} className={active ? `active ${captionStatus.state}` : ""} role="menuitemradio" aria-checked={active} onClick={() => { const sourceLabel = subtitleSource(track); const source = captionSource(track); const video = videoRef.current; const resumeAt = currentTime; const shouldContinue = video ? !video.paused : playing; const nextBurnedStream = track.mode === "burn_in" ? track.stream_index ?? null : null; setBurnedSubtitleStream(nextBurnedStream); setCaption(String(index)); saveCaptionsEnabled(true); saveCaptionSelection({ source, track_label: track.label }); setCues([]); setCaptionStatus(nextBurnedStream === null ? { state: "loading", label: `Loading ${sourceLabel.toLowerCase()} captions…` } : { state: "ready", label: "Local PGS" }); closeMenu(); if (nextBurnedStream !== null || burnedSubtitleStream !== null) void changeQuality(quality, resumeAt, true, shouldContinue, undefined, undefined, nextBurnedStream); }}><span>{track.label}</span><em>{active && captionStatus.state === "loading" ? "Loading…" : track.mode === "burn_in" ? "Local PGS" : subtitleSource(track)}</em></button>;
  };
  function handleVideoMetadata(video: HTMLVideoElement) {
    if (!details) return;
    applyMediaVolume(video, volume);
    video.muted = muted;
    video.playbackRate = playbackRate;
    if (video.videoWidth && video.videoHeight) setRatio(video.videoWidth / video.videoHeight);
    // The video element is retained while episodes swap. Ignore a late
    // metadata event from the outgoing direct source.
    // currentSrc is absolute in browsers while details.src is an
    // application-relative URL, so compare the authored attribute.
    if (quality === "original" && video.getAttribute("src") === details.src) {
      if (video.videoHeight) {
        sourceHeightRef.current = video.videoHeight;
        setSourceHeight(video.videoHeight);
        setResolvedQuality(video.videoHeight);
        setQualityLevels([1080, 720, 480, 360].filter((height) => height < video.videoHeight));
      }
      sourceDurationRef.current = video.duration;
      setDuration(video.duration);
      setMetadataLoaded(true);
      if (pendingInitialTranscodeRef.current) {
        pendingInitialTranscodeRef.current = false;
        void changeQuality("original", initialResumeRef.current, true, shouldPlayRef.current);
      }
    }
  }

  const renderCaptionOptions = (closeMenu: () => void) => <>
    <button className={caption === "off" ? "active" : ""} role="menuitemradio" aria-checked={caption === "off"} onClick={() => { const video = videoRef.current; const resumeAt = currentTime; const shouldContinue = video ? !video.paused : playing; const wasBurnedIn = burnedSubtitleStream !== null; setBurnedSubtitleStream(null); setCaption("off"); saveCaptionsEnabled(false); saveCaptionSelection({ source: "off" }); setCues([]); setCaptionStatus({ state: "idle", label: "Off" }); closeMenu(); if (wasBurnedIn) void changeQuality(quality, resumeAt, true, shouldContinue, undefined, undefined, null); }}><span>Off</span></button>
    {tracks.map((track, index) => subtitleSource(track) !== "Remote" && renderCaptionTrack(track, index, closeMenu))}
    {tracks.map((track, index) => subtitleSource(track) === "Remote" && renderCaptionTrack(track, index, closeMenu))}
  </>;
  const renderCaptionSettings = () => <div className="watch-caption-settings" role="group" aria-label="Caption appearance and position settings">
    <label>Size <output>{captionPreferences.font_size}%</output><input aria-label="Caption size" type="range" min="50" max="200" step="5" value={captionPreferences.font_size} onChange={(event) => updateCaptionPreferences({ font_size: Number(event.target.value) })} /></label>
    <label>Text color <input aria-label="Caption text color" type="color" value={captionPreferences.text_color} onChange={(event) => updateCaptionPreferences({ text_color: event.target.value })} /></label>
    <label>Background <input aria-label="Caption background color" type="color" value={captionPreferences.background_color} onChange={(event) => updateCaptionPreferences({ background_color: event.target.value })} /></label>
    <label>Background opacity <output>{Math.round(captionPreferences.background_opacity * 100)}%</output><input aria-label="Caption background opacity" type="range" min="0" max="1" step="0.05" value={captionPreferences.background_opacity} onChange={(event) => updateCaptionPreferences({ background_opacity: Number(event.target.value) })} /></label>
    <label>Font <select aria-label="Caption font" value={captionPreferences.font_family} onChange={(event) => updateCaptionPreferences({ font_family: event.target.value as CaptionPreferences["font_family"] })}><option value="system">System</option><option value="serif">Serif</option><option value="monospace">Monospace</option></select></label>
    <label>Text edge <select aria-label="Caption text edge" value={captionPreferences.text_edge} onChange={(event) => updateCaptionPreferences({ text_edge: event.target.value as CaptionPreferences["text_edge"] })}><option value="outline">Outline</option><option value="shadow">Shadow</option><option value="none">None</option></select></label>
    <label>Horizontal position <output>{Math.round(captionPreferences.position_x)}%</output><input aria-label="Caption horizontal position" type="range" min="5" max="95" step="1" value={captionPreferences.position_x} onChange={(event) => updateCaptionPreferences({ position_x: Number(event.target.value) })} /></label>
    <label>Vertical position <output>{Math.round(captionPreferences.position_y)}%</output><input aria-label="Caption vertical position" type="range" min="5" max="95" step="1" value={captionPreferences.position_y} onChange={(event) => updateCaptionPreferences({ position_y: Number(event.target.value) })} /></label>
    <p>Use the position sliders, or drag a visible caption anywhere in the player.</p>
    <button type="button" className="watch-caption-reset" onClick={resetCaptionPreferences}>Reset captions</button>
  </div>;

  const nativePip = pip && nativePipAvailable();
  // Android PiP shows the whole WebView, so the player fills it even while
  // the in-app mini player is active.
  const miniPlayer = watchMode === "mini" && !nativePip;
  const closeMiniPlayer = () => {
    pausePlayback();
    // Closing ends playback, like the audio mini player's close button.
    const shared = restorePlaybackSession(getSessionUser()?.id);
    if (shared && details && shared.item.path === detailsMediaPath(details)) setPlaybackSession(null);
    closeWatch();
  };
  const miniDrag = useMiniPlayerDrag(mainRef, miniPlayer, expandWatch, closeMiniPlayer);
  // Menus and panels belong to full Watch. Close them as it shrinks; the
  // queue menu is portaled to the page and would otherwise float over it.
  const [renderedWatchMode, setRenderedWatchMode] = useState(watchMode);
  if (renderedWatchMode !== watchMode) {
    setRenderedWatchMode(watchMode);
    if (watchMode === "mini") {
      closePopups();
      setSkipEvidenceOpen(false);
      setOrganizeOpen(false);
    }
  }
  useEffect(() => {
    document.title = watchMode === "full" ? watchTitleRef.current || TAB_TITLE_SUFFIX : TAB_TITLE_SUFFIX;
    if (watchMode === "mini" && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  }, [watchMode]);

  const isBuffering = loadingTarget !== null || bufferingWithoutPosition;
  const isTranscodingBusy = qualityBusy || (details?.kind === "video" && !audioCompatibilityChecked);
  const isInitialPlaybackLoad = details?.kind !== "image" && shouldPlayRef.current && !playing && (currentTime === 0 || !metadataLoaded || qualityBusy || !audioCompatibilityChecked);
  const showLoadingOverlay = !details || isBuffering || isTranscodingBusy || isInitialPlaybackLoad;

  const loadingText = !details
    ? (catalogResolveError || "Loading video…")
    : isBuffering
      ? loadingTarget === null ? "Buffering…" : `Buffering ${clock(loadingTarget)}…`
      : isTranscodingBusy
        ? "Preparing stream…"
        : "Loading playback…";
  const stallCandidate = showLoadingOverlay && Boolean(details) && details?.kind !== "image";
  useEffect(() => {
    if (!stallCandidate) { setLoadStalled(false); setVideoLoadError(false); return; }
    const timer = window.setTimeout(() => setLoadStalled(true), 20000);
    return () => window.clearTimeout(timer);
  }, [stallCandidate, details?.src]);
  useEffect(() => {
    const session = playbackQualityRef.current;
    if (!loadStalled || !session.src || session.started || session.failed) return;
    session.failed = true;
    reportClientPerformance("video_start", performance.now() - session.openedAt, {
      outcome: "error",
      reason: videoLoadError ? "error" : "timeout",
      intent: session.intent,
      mode: hlsRef.current ? "hls" : "direct",
      quality,
    });
  }, [loadStalled, videoLoadError, quality]);
  const retryPlayback = () => {
    setLoadStalled(false);
    setVideoLoadError(false);
    const video = videoRef.current;
    if (!video) return;
    const resumeAt = video.currentTime;
    video.load();
    if (resumeAt > 0) video.currentTime = resumeAt;
    void video.play().catch(() => undefined);
  };

  return <main ref={mainRef} className={`watch-page${details?.kind === "video" ? " watch-page--video" : ""}${companionInstance ? " watch-page--companion" : ""}${controlsVisible ? " controls-visible" : ""}${nativePip ? " native-pip" : ""}${miniPlayer ? " watch-page--mini" : ""}${watchMode === "mini" && nativePip ? " watch-page--overlay" : ""}${showLoadingOverlay && details?.kind !== "image" ? " watch-page--loading" : ""}`} style={miniPlayer ? miniDrag.style : undefined} {...(miniPlayer ? miniDrag.handlers : {})} aria-label={miniPlayer ? companionInstance ? "Companion mini player" : "Mini player" : undefined}>
    <header className="watch-bar">
      <button className="watch-back" onClick={leaveToLibrary} aria-label="Back to library">←</button>
      <div><h1>{details ? heading?.title || details.name.replace(/\.(mkv|mp4|m4v|avi|mov|webm|wmv|ts)$/i, "") : (catalogResolveError ? "Could not open video" : "Loading video…")}</h1><p>{details ? (heading ? heading.subtitle : pathLeaf(details.folder)) : (catalogResolveError || "Reading media")}</p></div>
      {details?.queueSource && queueLoadStatus !== "idle" && <p role="status">
        {queueLoadStatus === "loading" ? "Loading queue..." : <>Could not load queue. <button type="button" onClick={() => setQueueRetry((value) => value + 1)}>Retry queue</button></>}
      </p>}
    </header>
    <section className="watch-stage" aria-label={details ? `Playing ${details.name}` : "Loading video"}>
      <div ref={playerRef} className={`watch-player${controlsVisible ? " controls-visible" : ""}`} style={{ "--watch-ratio": ratio } as CSSProperties} onPointerMove={handlePlayerPointer} onPointerDown={handlePlayerPointer} onPointerLeave={() => { if (!isPhoneLayout() && !qualityMenuOpen && !queueMenuOpen && !captionMenuOpen && !settingsMenuOpen && !volumeMenuOpen) setControlsVisible(false); }}>
        <div className="watch-video-area" onClick={() => { if (popupsOpen) closePopups(); else if (isPhoneLayout()) toggleControlsVisibility(); }}>
          <div className="watch-video-shell" style={{ aspectRatio: ratio }}>
            <div className="watch-video-frame">
              {hydrated && details ? details.kind === "image" ? <img key={details.src} src={details.src} alt={details.name} className="watch-image" onLoad={(event) => { const img = event.currentTarget; if (img.naturalWidth && img.naturalHeight) setRatio(img.naturalWidth / img.naturalHeight); }} style={{ width: "100%", height: "100%", objectFit: "contain" }} onClick={(event) => { handlePlaybackSurfaceClick(); if (isPhoneLayout()) event.stopPropagation(); }} /> : <div
                className="watch-video-surface"
                onClick={(event) => { handlePlaybackSurfaceClick(); if (isPhoneLayout()) event.stopPropagation(); }}
                onDoubleClick={toggleFullscreen}
              >
                <canvas ref={canvasRef} className="watch-video-canvas" style={{ opacity: pip && !nativePip ? 0 : 1 }} />
                {pip && !nativePip && <div className="watch-pip-overlay">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" ry="2" /><rect x="12" y="11" width="7" height="5" rx="1" ry="1" /></svg>
                </div>}
              </div> : null}
            </div>
            {details?.kind !== "image" && <div className="watch-speed-control" role="group" aria-label="Playback speed" onClick={(event) => { event.stopPropagation(); showControls(); }} onPointerDown={(event) => { event.stopPropagation(); showControls(); }}>
              <button type="button" className="watch-speed-step" aria-label="Decrease playback speed" disabled={playbackRate <= PLAYBACK_SPEED_MIN} onClick={() => adjustPlaybackRate(-PLAYBACK_SPEED_STEP)}>
                <svg viewBox="0 0 20 14" aria-hidden="true"><path d="M8 1 2 7l6 6V1zm6 0-6 6 6 6V1z" /></svg>
              </button>
              <button type="button" className="watch-speed-display" aria-label={`Playback speed ${playbackRate.toFixed(2)}. Tap to reset to 1.`} onClick={resetPlaybackRate}>{playbackRate.toFixed(2)}</button>
              <button type="button" className="watch-speed-step" aria-label="Increase playback speed" disabled={playbackRate >= PLAYBACK_SPEED_MAX} onClick={() => adjustPlaybackRate(PLAYBACK_SPEED_STEP)}>
                <svg viewBox="0 0 20 14" aria-hidden="true"><path d="M12 1v12l6-6-6-6zM6 1v12l6-6-6-6z" /></svg>
              </button>
            </div>}
            {canPip && details?.kind !== "image" && <button type="button" className={`watch-pip-control ${pip ? "active" : ""}`} onClick={(event) => { event.stopPropagation(); togglePip(); }} onPointerDown={(event) => { event.stopPropagation(); showControls(); }} aria-label={pip ? "Exit picture-in-picture" : "Picture-in-picture"} title={pip ? "Exit picture-in-picture" : "Picture-in-picture"}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="4" width="18" height="16" rx="2" ry="2" /><rect x="12" y="11" width="7" height="5" rx="1" ry="1" /></svg>
            </button>}
            {showLoadingOverlay && details?.kind !== "image" && (loadStalled
              ? <div className="watch-buffering-overlay watch-load-stalled" role="alert">
                  <span>{videoLoadError ? "The video could not be loaded or decoded. Check the server connection and media format." : "The server has not sent a playable frame yet."}</span>
                  <button type="button" onClick={(event) => { event.stopPropagation(); retryPlayback(); }}>Retry</button>
                  <button type="button" onClick={(event) => { event.stopPropagation(); window.history.back(); }}>Back to library</button>
                </div>
              : <div className="watch-buffering-overlay" role="status" aria-live="polite">
                  <i aria-hidden="true" />
                  <span>{loadingText}</span>
                </div>)}
            {details?.moviesTv && activeSkipSegment && (controlsVisible || initialSkipPromptKey === activeSkipPromptKey) && <button className={`watch-segment-skip ${activeSkipSegment.auto_skip_safe ? "confirmed" : "single-source"}`} onClick={(event) => { event.stopPropagation(); skipSegment(activeSkipSegment); }}>
              Skip {skipKindLabel(activeSkipSegment.kind)}
              <small>{activeSkipSegment.agreement >= 2 ? `${activeSkipSegment.agreement} sources agree` : `${Math.round(activeSkipSegment.confidence * 100)}% confidence`}</small>
            </button>}
            {details?.moviesTv && skipEvidenceOpen && <aside className="watch-skip-evidence" aria-label="Skip timestamp evidence">
              <header>
                <div><strong>Skip decisions</strong><small>{skipData ? `${skipData.cache_status} · ${skipData.providers.length} providers checked` : skipDataLoading ? "Checking providers…" : "No evidence loaded"}</small></div>
                <button onClick={() => setSkipEvidenceOpen(false)} aria-label="Close skip evidence">×</button>
              </header>
              <label className="watch-auto-skip-toggle">
                <input type="checkbox" checked={autoSkipEnabled} onChange={(event) => updateAutoSkip(event.currentTarget.checked)} />
                <span><strong>Automatically skip detected segments for this show</strong><small>Saved separately for your account and this show.</small></span>
              </label>
              {!details?.imdbId && <p className="watch-skip-notice">This file does not have a matched IMDb title yet, so only local chapter and fingerprint detection can run.</p>}
              {skipDataError && <p className="watch-skip-notice error">{skipDataError}</p>}
              {skipData?.segments.length === 0 && <p className="watch-skip-notice">Providers were checked but none returned a valid segment for this release.</p>}
              {skipData?.segments.map((segment) => <section className="watch-skip-decision" key={`${segment.kind}:${segment.start}:${segment.end}`}>
                <div><strong>{skipKindLabel(segment.kind)}</strong><em className={segment.auto_skip_safe ? "confirmed" : ""}>{segment.auto_skip_safe ? "CONFIRMED" : "SINGLE SOURCE"}</em></div>
                <p>{clock(segment.start)} → {clock(segment.end)} · {Math.round(segment.confidence * 100)}%</p>
                <small>{segment.reason} · {segment.providers.join(", ")}</small>
              </section>)}
              <div className="watch-provider-list">
                {skipData?.providers.map((provider) => <details key={provider.provider}>
                  <summary><strong>{provider.provider}</strong><span className={provider.status}>{provider.status} · {provider.latency_ms} ms · {provider.segments.length} result{provider.segments.length === 1 ? "" : "s"}</span></summary>
                  {provider.error && <p>{provider.error}</p>}
                  {provider.segments.map((segment, index) => <p key={`${segment.kind}:${index}`}>{skipKindLabel(segment.kind)} {clock(segment.start)}–{clock(segment.end)}{segment.submission_count ? ` · ${segment.submission_count} submissions` : ""}{segment.label ? ` · “${segment.label}”` : ""}</p>)}
                  {provider.raw !== undefined && <details className="watch-raw-evidence"><summary>Raw provider response</summary><pre>{JSON.stringify(provider.raw, null, 2)}</pre></details>}
                </details>)}
              </div>
              <button className="watch-refresh-skip" disabled={skipDataLoading} onClick={() => setSkipRefresh((value) => value + 1)}>{skipDataLoading ? "Refreshing…" : "Refresh all evidence"}</button>
            </aside>}
          </div>
        </div>
        {activeCue && <div className={`watch-caption edge-${captionPreferences.text_edge}`} onPointerDown={dragCaption} title="Drag to move captions" style={{
          left: `${captionPreferences.position_x}%`, top: `calc(${captionPreferences.position_y}% + ${captionControlsOffset}px)`,
          color: captionPreferences.text_color,
          backgroundColor: `${captionPreferences.background_color}${Math.round(captionPreferences.background_opacity * 255).toString(16).padStart(2, "0")}`,
          fontSize: `clamp(${captionPreferences.font_size * 0.18}px, ${captionPreferences.font_size * 0.022}vw, ${captionPreferences.font_size * 0.38}px)`,
          fontFamily: captionPreferences.font_family === "serif" ? "Georgia, serif" : captionPreferences.font_family === "monospace" ? "ui-monospace, monospace" : "inherit",
        }}>{activeCue.text}</div>}
        <WatchPlayerControls
          playbackRate={playbackRate}
          onSetPlaybackRate={(rate) => setPlaybackRate(clampPlaybackRate(rate))}
          details={details}
          duration={duration}
          displayedTime={displayedTime}
          playing={playing}
          playbackError={showLoadingOverlay && loadStalled ? "Couldn’t load this video" : playbackError}
          timelineSections={timelineSections}
          bufferedRanges={bufferedRanges}
          loadingTarget={loadingTarget}
          seekHover={seekHover}
          seekPreviewUrl={seekPreviewUrl}
          onSeekHover={(event) => {
            if (duration <= 0) return;
            const track = event.currentTarget.querySelector<HTMLElement>(".watch-seek-visual");
            if (!track) return;
            const bounds = track.getBoundingClientRect();
            const progress = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
            const time = progress * duration;
            const frameTime = Math.max(0, Math.min(duration, Math.round(time / 10) * 10));
            const wrapBounds = event.currentTarget.getBoundingClientRect();
            const left = Math.max(80, Math.min(wrapBounds.width - 80, bounds.left - wrapBounds.left + progress * bounds.width));
            setSeekHover({ time, left, frameTime });
          }}
          onSeekHoverClear={() => setSeekHover(null)}
          onSeek={(value) => { if (details?.kind === "image") { setCurrentTime(value); return; } seekTo(value); }}
          onSeekBy={seekBy}
          onTogglePlayback={togglePlayback}
          previousQueueItem={previousQueueItem}
          nextQueueItem={nextQueueItem}
          onGoToQueueItem={(item) => { if (item) goToQueueItem(item); }}
          queue={queue}
          queueLoading={queueLoadStatus === "loading"}
          currentQueueIndex={currentQueueIndex}
          queueTriggerRef={queueTriggerRef}
          controlsRef={controlsRef}
          queueMenuOpen={queueMenuOpen}
          onToggleQueueMenu={() => { setQueueMenuOpen((open) => !open); setVolumeMenuOpen(false); setSettingsMenuOpen(false); setQualityMenuOpen(false); setCaptionMenuOpen(false); setControlsVisible(true); }}
          playbackPreferences={playbackPreferences}
          autoSkipEnabled={autoSkipEnabled}
          onUpdateAutoSkip={updateAutoSkip}
          onUpdateAutoNext={updateAutoNext}
          onUpdateImageSeconds={updateImageSeconds}
          onUpdateBufferSize={updateBufferSize}
          loopEnabled={loopEnabled}
          onToggleLoop={() => setLoopEnabled((value) => !value)}
          favorite={favorite}
          onToggleFavorite={toggleFavorite}
          organizeActive={organizeActive}
          onOpenOrganize={details ? openOrganize : undefined}
          volume={volume}
          muted={muted}
          volumeMenuOpen={volumeMenuOpen}
          onVolumeEnter={openVolumeMenu}
          onVolumeLeave={scheduleVolumeMenuClose}
          onVolumeTriggerClick={handleVolumeTriggerClick}
          onSetVolumeLevel={setVolumeLevel}
          settingsMenuOpen={settingsMenuOpen}
          onToggleSettingsMenu={() => { setSettingsMenuOpen((open) => !open); setVolumeMenuOpen(false); setQualityMenuOpen(false); setCaptionMenuOpen(false); setQueueMenuOpen(false); setControlsVisible(true); }}
          captionMenuOpen={captionMenuOpen}
          onToggleCaptionMenu={() => { setCaptionMenuOpen((open) => !open); setCaptionSettingsOpen(false); setVolumeMenuOpen(false); setSettingsMenuOpen(false); setControlsVisible(true); }}
          audioMenuOpen={audioMenuOpen}
          onToggleAudioMenu={() => { setAudioMenuOpen((open) => !open); setVolumeMenuOpen(false); setSettingsMenuOpen(false); setCaptionMenuOpen(false); setControlsVisible(true); }}
          captionStatus={captionStatus}
          renderCaptionOptions={renderCaptionOptions}
          captionSettingsOpen={captionSettingsOpen}
          onToggleCaptionSettings={() => setCaptionSettingsOpen((open) => !open)}
          onOpenCaptionSettings={() => { setCaptionMenuOpen(true); setCaptionSettingsOpen(true); setVolumeMenuOpen(false); setSettingsMenuOpen(false); setControlsVisible(true); }}
          renderCaptionSettings={renderCaptionSettings}
          audioTracks={audioTracks}
          selectedAudioStream={selectedAudioStream}
          onChangeAudioTrack={changeAudioTrack}
          qualityMenuOpen={qualityMenuOpen}
          onToggleQualityMenu={() => { setQualityMenuOpen((open) => !open); setVolumeMenuOpen(false); setSettingsMenuOpen(false); setQueueMenuOpen(false); setCaptionMenuOpen(false); setControlsVisible(true); }}
          quality={quality}
          qualityBusy={qualityBusy}
          qualityTriggerLabel={qualityTriggerLabel}
          qualityCompactLabel={qualityCompactLabel}
          sourceHeight={sourceHeight}
          resolvedQuality={resolvedQuality}
          qualityLevels={qualityLevels}
          onChangeQuality={changeQuality}
          skipData={skipData}
          skipDataLoading={skipDataLoading}
          skipEvidenceOpen={skipEvidenceOpen}
          onToggleSkipEvidence={() => { setSkipEvidenceOpen((open) => !open); setControlsVisible(true); }}
          canPip={canPip}
          pip={pip}
          onTogglePip={togglePip}
          onToggleFullscreen={toggleFullscreen}
          onMiniplayer={openMiniplayer}
        />
      </div>
    </section>
    {!miniPlayer && details?.kind === "video" && <section className="watch-portrait-info" aria-label="Now playing">
      <h2>{heading?.title || details.name.replace(/\.(mkv|mp4|m4v|avi|mov|webm|wmv|ts)$/i, "")}</h2>
      <p>{heading ? heading.subtitle : pathLeaf(details.folder)}</p>
      {queue.length > 1 && <>
        <h3>{/^S\d/.test(heading?.subtitle ?? "") ? "Episodes" : "Up next"} <span>{currentQueueIndex + 1} of {queue.length}</span></h3>
        <ol>
          {queue.map((item, index) => {
            const active = index === currentQueueIndex;
            const seconds = item.duration ?? (active && duration > 0 ? duration : undefined);
            return <li key={item.path ?? item.src ?? index}><button type="button" aria-current={active ? "true" : undefined} onClick={() => { if (!active) goToQueueItem(item); }}>
              <span className="watch-portrait-thumb">{queueItemThumb(item) ? <img src={queueItemThumb(item)} alt="" loading="lazy" /> : null}{active && <i>{playing ? "Playing" : "Paused"}</i>}</span>
              <span className="watch-portrait-text"><b>{queueItemLabel(item)}</b>{seconds && seconds > 0 ? <small>{clock(seconds)}</small> : null}</span>
            </button></li>;
          })}
        </ol>
      </>}
    </section>}
    {miniPlayer ? <WatchMiniControls
      title={details ? heading ? [heading.title, heading.subtitle].filter(Boolean).join(" · ") : details.name : (catalogResolveError ? "Could not open video" : "Loading video…")}
      subtitle={details?.folder ?? ""}
      playing={playing}
      loading={showLoadingOverlay && !loadStalled}
      failed={showLoadingOverlay && loadStalled}
      currentTime={displayedTime}
      duration={duration}
      hasPrevious={Boolean(previousQueueItem)}
      hasNext={Boolean(nextQueueItem)}
      canPip={canPip && details?.kind !== "image"}
      onTogglePlayback={showLoadingOverlay && loadStalled ? retryPlayback : togglePlayback}
      onPrevious={() => { if (previousQueueItem) goToQueueItem(previousQueueItem); }}
      onNext={() => { if (nextQueueItem) goToQueueItem(nextQueueItem); }}
      onExpand={expandWatch}
      onClose={closeMiniPlayer}
      onPip={togglePip}
    /> : null}
    {hydrated && details && details.kind !== "image" && <div className="watch-video-engine" aria-hidden="true">
      <div ref={videoHostRef} />
      {videoShadow && createPortal([0, 1].map((slot) => <QueueVideoSlot
        key={slot}
        active={slot === activeVideoSlot}
        mediaRef={(video) => { videoSlotsRef.current[slot] = video; if (video && slot === activeVideoSlot) videoRef.current = video; }}
        src={slot === activeVideoSlot ? (quality === "original" ? details.src : undefined) : preparedVideo?.slot === slot ? preparedVideo.src : undefined}
        playsInline
        preload={audioCompatibilityChecked && audioTracks.length <= 1 ? "auto" : "metadata"}
        loop={loopEnabled}
        muted={muted}
        onLoadedMetadata={(event) => { setVideoLoadError(false); handleVideoMetadata(event.currentTarget); }}
        onError={() => { setVideoLoadError(true); setLoadStalled(true); }}
        onPlay={(event) => {
          resumeMediaVolume(event.currentTarget);
          shouldPlayRef.current = true;
          setPlaying(true);
          if (nativeBackgroundRef.current) void startBackgroundAudioLatest(true).catch(console.error);
          // Autoplay and stream restarts must not reveal a hidden overlay.
          // Queue preservation lasts until the user explicitly shows controls.
          if (!preserveHiddenControlsRef.current && controlsVisibleRef.current) showControls();
          reportPlayback(event.currentTarget.currentTime + streamOffsetRef.current > 2 ? "resumed" : "started", event.currentTarget);
        }}
        onPlaying={(event) => {
          finishLoadingTarget(event.currentTarget);
          const playbackSession = playbackQualityRef.current;
          if (!playbackSession.started && playbackSession.src) {
            playbackSession.started = true;
            playbackSession.mode = hlsRef.current ? "hls" : "direct";
            playbackSession.quality = quality;
            if (!playbackSession.failed) {
              reportClientPerformance("video_start", performance.now() - playbackSession.openedAt, {
                outcome: "success",
                intent: playbackSession.intent,
                mode: playbackSession.mode,
                quality,
              });
            }
          }
          tickPlaybackQuality(event.currentTarget);
          if (details?.playAttemptId && details?.playAttemptStartedAt && reportedPlaybackAttemptRef.current !== details.playAttemptId) {
            reportedPlaybackAttemptRef.current = details.playAttemptId;
            reportClientPerformance("playback_started", Date.now() - details.playAttemptStartedAt, {
              attempt_id: details.playAttemptId,
              media_path: detailsMediaPath(details),
              media_name: details.name,
              mode: hlsRef.current ? "hls" : "direct",
              quality,
            });
          }
        }}
        onPause={(event) => {
          if (audioOnlyRef.current) return;
          // Android can suspend the video before onStop starts its audio
          // handoff. This is not a user pause; keep the media session alive.
          if (nativePipAvailable() && shouldPlayRef.current && (nativeBackgroundRef.current || document.visibilityState === "hidden")) return;
          // Loading a source and swapping streams can emit pause without any
          // user action. Playback intent is changed by the controls themselves,
          // so an incidental media event must not cancel autoplay/startup.
          if (!qualityBusyRef.current && !playbackStartupPending()) reportPlayback("paused", event.currentTarget);
          setPlaying(false);
          // The browser emits pause before ended, and source swaps also pause.
          // Only a deliberate pause may reveal controls, never an auto-next handoff.
          if (!preserveHiddenControlsRef.current && !event.currentTarget.ended && !shouldPlayRef.current && !qualityBusyRef.current && !playbackStartupPending()) showControls();
          saveProgress(event.currentTarget);
        }}
        onCanPlay={(event) => {
          finishLoadingTarget(event.currentTarget);
          // A play request can be aborted by the source swap. Retry only after
          // startup has applied the resume position and the final stream is ready.
          if (shouldPlayRef.current && !qualityBusyRef.current && !playbackStartupPending() && event.currentTarget.paused) playSafely(event.currentTarget);
          if (videoLoadStartedRef.current !== null && details?.src) {
            reportClientPerformance("video_load", performance.now() - videoLoadStartedRef.current, {
              video_load_ms: Math.round(performance.now() - videoLoadStartedRef.current),
              attempt_id: details?.playAttemptId,
            });
            videoLoadStartedRef.current = null;
          }
        }}
        onSeeked={(event) => { const video = event.currentTarget; finishLoadingTarget(video); saveProgress(video); reportPlayback(video.paused ? "paused" : "resumed", video); }}
        onWaiting={(event) => { markBuffering(event.currentTarget); notePlaybackStall(event.currentTarget); }}
        onStalled={(event) => markBuffering(event.currentTarget)}
        onVolumeChange={(event) => { setVolume(readMediaVolumePosition(event.currentTarget)); setMuted(event.currentTarget.muted); }}
        onProgress={(event) => updateBufferedRanges(event.currentTarget)}
        onTimeUpdate={(event) => { const video = event.currentTarget; tickPlaybackQuality(video); updateBufferedRanges(video); const absoluteTime = video.currentTime + streamOffsetRef.current; if (loadingTargetRef.current === null || Math.abs(absoluteTime - loadingTargetRef.current) <= 2) { finishLoadingTarget(video); setCurrentTime(absoluteTime); } if (Date.now() - lastSavedAt.current > 3000) { lastSavedAt.current = Date.now(); saveProgress(video); } if (Date.now() - lastRemoteSaveAt.current > 5000 && !video.paused && !video.seeking) { lastRemoteSaveAt.current = Date.now(); reportPlayback("resumed", video); } }}
        onEnded={(event) => handlePlaybackEnded(event.currentTarget)}
      />), videoShadow)}
    </div>}
    <div className="watch-duration-probes" aria-hidden="true">
      {nearbyItems.map((item) => <QueueDurationProbe key={item.path ?? item.src ?? item.id} item={item} skip={item.kind === "video"} onDuration={rememberQueueDuration} />)}
    </div>
    {queueMenuOpen && typeof document !== "undefined" ? createPortal(<div ref={queueMenuRef} className="watch-queue-menu watch-queue-menu-fixed" role="menu" aria-label="Playback queue" style={{ position: "fixed", left: queueMenuPosition?.left ?? -9999, top: queueMenuPosition?.top ?? 0, visibility: queueMenuPosition ? "visible" : "hidden", bottom: "auto", right: "auto" }} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <div className="watch-queue-menu-title">{details?.queueLabel ?? "Queue"}</div>
      {queue.map((item, index) => {
        const active = index === currentQueueIndex;
        const lengthSeconds = item.duration ?? (active && duration > 0 ? duration : item.kind === "image" ? imageSeconds : undefined);
        const lengthLabel = lengthSeconds && lengthSeconds > 0 ? clock(lengthSeconds) : "…";
        return <div key={item.path ?? item.src ?? index} className={`watch-queue-item${active ? " active" : ""}${queueDropIndex === index ? " queue-drop-target" : ""}`} role="presentation" onDragOver={(event) => { if (draggedQueueIndexRef.current === null) return; event.preventDefault(); event.dataTransfer.dropEffect = "move"; setQueueDropIndex(index); }} onDrop={(event) => { event.preventDefault(); const fromIndex = draggedQueueIndexRef.current; draggedQueueIndexRef.current = null; setQueueDropIndex(null); if (fromIndex !== null) reorderQueue(fromIndex, index); }}>
          <QueueItemMain name={item.name} active={active} lengthLabel={lengthLabel} onSelect={() => { if (!active) { setQueueMenuOpen(false); goToQueueItem(item); } }} />
          <button type="button" className={`watch-queue-item-fav${item.favorite ? " active" : ""}`} aria-label={item.favorite ? `Remove ${item.name} from favorites` : `Add ${item.name} to favorites`} aria-pressed={Boolean(item.favorite)} onClick={(event) => { event.stopPropagation(); void toggleQueueItemFavorite(item, index); }}>{item.favorite ? "★" : "☆"}</button>
          <button type="button" className="watch-queue-item-drag" draggable aria-label={`Drag to reorder ${item.name}`} title="Drag to reorder" onClick={(event) => event.preventDefault()} onDragStart={(event) => { draggedQueueIndexRef.current = index; event.dataTransfer.effectAllowed = "move"; event.dataTransfer.setData("text/plain", String(index)); }} onDragEnd={() => { draggedQueueIndexRef.current = null; setQueueDropIndex(null); }}><span aria-hidden="true">☰</span></button>
        </div>;
      })}
    </div>, (typeof document !== "undefined" && (document.fullscreenElement as HTMLElement)) || document.body) : null}
    {details && <OrganizeMediaModal
      open={organizeOpen}
      path={detailsMediaPath(details)}
      name={details.name}
      onClose={() => setOrganizeOpen(false)}
      onSaved={handleOrganizeSaved}
    />}
  </main>;
}
