"use client";

import { useCallback, useEffect, useEffectEvent, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type TouchEvent as ReactTouchEvent } from "react";
import { createPortal } from "react-dom";
import QueueReadout from "./QueueReadout";
import { authFetch, getSessionUser } from "./lib/auth";
import { savesWatchProgress, writeLocalWatchProgress } from "./lib/watch-progress";
import { updateSnapshotPlayback } from "./lib/browse-cache";
import { clearPlaybackHandoff } from "./lib/playback-handoff";
import { DEFAULT_PLAYBACK_PREFERENCES, playbackPreferencesFromState, type PlaybackPreferences } from "./lib/playback";
import { API_BASE, VOLUME_SLIDER_MAX, applyMediaVolume, readMediaVolumePosition, resumeMediaVolume, releaseMediaVolume, readStoredVolumePosition, volumeLabelFromSlider, type MediaItem } from "./lib/media";
import { QueueIcon, SkipIcon, VolumeIcon, playbackClock, volumeSliderStyle } from "./lib/player-ui";
import { clearNativeMediaSession, nativeMediaSessionAvailable, syncNativeMediaSession } from "./lib/native-media-session";
import { queueOfflineFavorite } from "./lib/offline";
import OrganizeMediaModal, { type OrganizeSavedState } from "./OrganizeMediaModal";
import { updateSnapshotOrganization } from "./lib/browse-cache";
import { useBackLayer } from "./lib/back-layers";

function QueueDurationProbe({ item, onDuration }: { item: MediaItem; onDuration: (path: string, duration: number) => void }) {
  if (!item.src || !item.path || item.duration || item.kind === "image") return null;
  const handleLoadedMetadata = (mediaDuration: number) => {
    if (Number.isFinite(mediaDuration) && mediaDuration > 0) onDuration(item.path!, mediaDuration);
  };
  return <audio src={item.src} preload="metadata" onLoadedMetadata={(event) => handleLoadedMetadata(event.currentTarget.duration)} />;
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

type MiniAudioPlayerProps = {
  item: MediaItem;
  queue: MediaItem[];
  pathLabel: string;
  moviesTv: boolean;
  queueLabel?: string;
  queueLoading?: boolean;
  initialTime?: number;
  initialPlaying?: boolean;
  onItemChange: (item: MediaItem, playing?: boolean) => void;
  onCheckpoint?: (time: number, playing: boolean) => void;
  onQueueChange?: (queue: MediaItem[] | ((current: MediaItem[]) => MediaItem[])) => void;
  onFavoriteChange?: (path: string, favorite: boolean, locallyQueued?: boolean) => void;
  onOrganizeSaved?: (state: OrganizeSavedState) => void;
  onPlayingChange?: (playing: boolean) => void;
  onClose: () => void;
};

export default function MiniAudioPlayer({
  item,
  queue,
  pathLabel,
  queueLabel,
  queueLoading = false,
  initialTime = 0,
  initialPlaying = true,
  onItemChange,
  onCheckpoint,
  onQueueChange,
  onFavoriteChange,
  onOrganizeSaved,
  onPlayingChange,
  onClose,
}: MiniAudioPlayerProps) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const progressSentRef = useRef(0);
  const progressCheckpointRef = useRef(0);
  const endedWaitingRef = useRef(false);
  const queueTriggerRef = useRef<HTMLDivElement>(null);
  const queueMenuRef = useRef<HTMLDivElement>(null);
  const volumeHoverRef = useRef(false);
  const volumeHoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resumeAppliedRef = useRef("");
  const playAfterLoadRef = useRef<boolean | null>(null);
  const pendingSeekRef = useRef<number | null>(null);
  const seekTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrubbingRef = useRef(false);
  const scrubTargetRef = useRef<number | null>(null);
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const [playing, setPlaying] = useState(initialPlaying);
  const [currentTime, setCurrentTime] = useState(initialTime);
  const [duration, setDuration] = useState(item.duration ?? 0);
  const [volume, setVolume] = useState(readStoredVolumePosition);
  const [muted, setMuted] = useState(() => typeof window !== "undefined" ? window.localStorage.getItem("tms_muted") === "true" : false);

  const checkpoint = (audio: HTMLAudioElement, event: "started" | "resumed" | "paused" | "stopped" | "completed" = "resumed", force = false) => {
    if (resumeAppliedRef.current !== item.src || !Number.isFinite(audio.duration) || audio.duration <= 0) return;
    if (!force && event === "resumed" && Date.now() - progressCheckpointRef.current < 1000) return;
    progressCheckpointRef.current = Date.now();
    const position = Math.max(0, audio.currentTime);
    const completed = event === "completed" || audio.ended;
    const state = { position, duration: audio.duration, updated: Math.floor(Date.now() / 1000), completed };
    if (item.path && savesWatchProgress(item.path)) {
      writeLocalWatchProgress(getSessionUser()?.id, item.path, state);
      updateSnapshotPlayback(item.path, state);
    }
    onCheckpoint?.(position, !audio.paused && !completed);
    if (!item.offline && item.path && (event !== "resumed" || Date.now() - progressSentRef.current > 15_000)) {
      progressSentRef.current = Date.now();
      void authFetch(`${API_BASE}/api/activity`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ save_progress: savesWatchProgress(item.path), event: completed ? "completed" : event, media_name: item.name, path: item.path, position, duration: audio.duration }), keepalive: true }).catch(() => undefined);
    }
  };
  const checkpointLatest = useEffectEvent(checkpoint);
  const changeItem = (next: MediaItem, playing = true) => {
    if (audioRef.current) checkpoint(audioRef.current, "stopped");
    playAfterLoadRef.current = playing;
    onItemChange(next, playing);
  };

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;
    // Capture the outgoing item before React swaps the source or unmounts us.
    const save = () => checkpointLatest(audio, "stopped");
    window.addEventListener("pagehide", save);
    return () => { window.removeEventListener("pagehide", save); save(); };
  }, []);
  const activeAudio = () => audioRef.current;

  useEffect(() => {
    const audio = audioRef.current;
    return () => { if (audio) releaseMediaVolume(audio); };
  }, []);
  const [volumeMenuOpen, setVolumeMenuOpen] = useState(false);
  const [volumeAdjusting, setVolumeAdjusting] = useState(false);
  const volumeSliderInteraction = {
    onFocus: () => setVolumeAdjusting(true),
    onBlur: () => setVolumeAdjusting(false),
    onPointerDown: (event: React.PointerEvent<HTMLInputElement>) => {
      event.currentTarget.setPointerCapture(event.pointerId);
      setVolumeAdjusting(true);
    },
    onPointerUp: () => setVolumeAdjusting(false),
    onPointerCancel: () => setVolumeAdjusting(false),
    onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => { if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)) setVolumeAdjusting(true); },
    onKeyUp: (event: React.KeyboardEvent<HTMLInputElement>) => { if (["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)) setVolumeAdjusting(false); },
  };
  const [queueMenuOpen, setQueueMenuOpen] = useState(false);
  const [queueMenuPosition, setQueueMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const [settingsMenuOpen, setSettingsMenuOpen] = useState(false);
  const [loopEnabled, setLoopEnabled] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [playbackPreferences, setPlaybackPreferences] = useState<PlaybackPreferences>(DEFAULT_PLAYBACK_PREFERENCES);
  const [organizeOpen, setOrganizeOpen] = useState(false);
  const [organizeActive, setOrganizeActive] = useState(false);
  const [playbackError, setPlaybackError] = useState("");
  useBackLayer(expanded, () => setExpanded(false));
  useBackLayer(queueMenuOpen, () => setQueueMenuOpen(false));
  useBackLayer(settingsMenuOpen, () => setSettingsMenuOpen(false));

  const queueIndex = queue.findIndex((entry) =>
    entry.id === item.id
    || (item.path && entry.path === item.path)
    || (item.src && entry.src === item.src)
  );
  const previousItem = queueIndex > 0 ? queue[queueIndex - 1] : null;
  const nextItem = queueIndex >= 0 && queueIndex < queue.length - 1 ? queue[queueIndex + 1] : null;
  const trackSwipeStart = useRef<{ x: number; y: number; itemId: MediaItem["id"] } | null>(null);
  const startTrackSwipe = (event: ReactTouchEvent<HTMLDivElement>) => {
    const touch = event.touches[0];
    trackSwipeStart.current = !expanded && event.touches.length === 1 && touch
      ? { x: touch.clientX, y: touch.clientY, itemId: item.id }
      : null;
  };
  const finishTrackSwipe = (event: ReactTouchEvent<HTMLDivElement>) => {
    const start = trackSwipeStart.current;
    trackSwipeStart.current = null;
    const touch = event.changedTouches[0];
    if (expanded || !start || !touch || event.touches.length > 0 || start.itemId !== item.id) return;
    const dx = touch.clientX - start.x;
    const dy = touch.clientY - start.y;
    if (Math.abs(dx) < 48 || Math.abs(dx) <= Math.abs(dy) * 1.5) return;
    const target = dx < 0 ? nextItem : previousItem;
    if (target) changeItem(target, playing);
  };

  useEffect(() => {
    void authFetch(`${API_BASE}/api/user-state`).then(async (response) => {
      if (!response.ok) return;
      const state = await response.json() as {
        playback_preferences?: Partial<PlaybackPreferences>;
        tags?: Record<string, string[]>;
        playlists?: Record<string, { paths: string[] }>;
      };
      setPlaybackPreferences(playbackPreferencesFromState(state.playback_preferences));
      if (item.path) {
        const itemTags = state.tags?.[item.path] ?? [];
        const inPlaylists = Object.values(state.playlists ?? {}).some((playlist) => playlist.paths.includes(item.path!));
        setOrganizeActive(itemTags.length > 0 || inPlaylists);
      }
    }).catch(() => undefined);
  }, [item.path]);

  useEffect(() => {
    onPlayingChange?.(playing);
    return () => onPlayingChange?.(false);
  }, [onPlayingChange, playing]);

  useEffect(() => {
    window.localStorage.setItem("tms_volume", String(volume));
  }, [volume]);

  useEffect(() => {
    window.localStorage.setItem("tms_muted", String(muted));
    if (activeAudio()) activeAudio()!.muted = muted;
  }, [muted]);

  useEffect(() => {
    resumeAppliedRef.current = "";
    pendingSeekRef.current = null;
    scrubbingRef.current = false;
    scrubTargetRef.current = null;
    queueMicrotask(() => setScrubTime(null));
    if (seekTimeoutRef.current) clearTimeout(seekTimeoutRef.current);
    setCurrentTime(initialTime);
    const audio = activeAudio();
    setDuration(audio && Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : item.duration ?? 0);
    setPlaying(initialPlaying);
    endedWaitingRef.current = false;
    setVolumeMenuOpen(false);
    setQueueMenuOpen(false);
    setSettingsMenuOpen(false);
  }, [item.id, item.src, initialTime, initialPlaying]);

  useEffect(() => {
    if (!queueMenuOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || (!target.closest(".watch-queue-trigger") && !target.closest(".watch-queue-menu"))) {
        setQueueMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [queueMenuOpen]);

  useEffect(() => {
    if (!settingsMenuOpen) return;
    const close = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element) || (!target.closest(".watch-settings-trigger") && !target.closest(".watch-settings-menu"))) {
        setSettingsMenuOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, [settingsMenuOpen]);

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
  }, [queueMenuOpen, queue.length, updateQueueMenuPosition]);

  useEffect(() => {
    if (!queueMenuOpen || !queueMenuPosition) return;
    scrollQueueMenuToActive();
  }, [queueMenuOpen, queueMenuPosition, queueIndex, scrollQueueMenuToActive]);

  const rememberQueueDuration = useCallback((path: string, nextDuration: number) => {
    if (!Number.isFinite(nextDuration) || nextDuration <= 0 || !onQueueChange) return;
    onQueueChange((current) => current.map((entry) => entry.path === path && (!entry.duration || entry.duration <= 0) ? { ...entry, duration: nextDuration } : entry));
  }, [onQueueChange]);

  useEffect(() => {
    if (queueIndex < 0 || duration <= 0 || !onQueueChange) return;
    onQueueChange((current) => current.map((entry, index) => index === queueIndex && (!entry.duration || entry.duration <= 0) ? { ...entry, duration } : entry));
  }, [duration, onQueueChange, queueIndex]);

  const applyResume = (audio: HTMLAudioElement) => {
    if (resumeAppliedRef.current === item.src) return;
    resumeAppliedRef.current = item.src ?? String(item.id);
    applyMediaVolume(audio, volume);
    audio.muted = muted;
    audio.loop = loopEnabled;
    const resumeAt = initialTime > 0 ? initialTime : 0;
    const startPlayback = () => {
      setCurrentTime(audio.currentTime);
      const shouldPlay = playAfterLoadRef.current ?? initialPlaying;
      playAfterLoadRef.current = null;
      if (shouldPlay) void audio.play().catch(() => { setPlaying(false); setPlaybackError("Playback could not start. Press Play to try again."); });
      else audio.pause();
    };
    if (resumeAt > 0 && Number.isFinite(audio.duration) && resumeAt < audio.duration - 0.25) {
      audio.addEventListener("seeked", startPlayback, { once: true });
      audio.currentTime = resumeAt;
      return;
    }
    startPlayback();
  };

  const seekTo = (time: number) => {
    const audio = activeAudio();
    if (!audio) return;
    const nextTime = Math.max(0, Math.min(duration || audio.duration || 0, time));
    pendingSeekRef.current = nextTime;
    if (seekTimeoutRef.current) clearTimeout(seekTimeoutRef.current);
    seekTimeoutRef.current = setTimeout(() => {
      pendingSeekRef.current = null;
      setCurrentTime(audio.currentTime);
    }, 5000);
    audio.currentTime = nextTime;
    setCurrentTime(nextTime);
    setMediaSessionSyncId((id) => id + 1);
  };

  const updatePlaybackTime = (audio: HTMLAudioElement) => {
    if (scrubbingRef.current) return;
    const pending = pendingSeekRef.current;
    if (pending !== null) {
      // WebView can report the old position while a file seek is pending.
      if (Math.abs(audio.currentTime - pending) > 1.5) return;
      pendingSeekRef.current = null;
      if (seekTimeoutRef.current) clearTimeout(seekTimeoutRef.current);
    }
    setCurrentTime(audio.currentTime);
  };

  const commitScrub = () => {
    if (!scrubbingRef.current) return;
    scrubbingRef.current = false;
    const target = scrubTargetRef.current;
    scrubTargetRef.current = null;
    setScrubTime(null);
    if (target !== null) seekTo(target);
  };

  useEffect(() => () => {
    if (seekTimeoutRef.current) clearTimeout(seekTimeoutRef.current);
  }, []);

  const seekBy = (delta: number) => seekTo(currentTime + delta);

  const togglePlayback = () => {
    const audio = activeAudio();
    if (!audio) return;
    if (audio.paused) {
      setPlaying(true);
      void audio.play().catch(() => { setPlaying(false); setPlaybackError("Playback could not start. Press Play to try again."); });
    } else {
      audio.pause();
      setPlaying(false);
    }
  };

  const setVolumeLevel = (value: number) => {
    setVolume(value);
    setMuted(false);
    const audio = activeAudio();
    if (audio) {
      setVolume(applyMediaVolume(audio, value));
      audio.muted = false;
    }
  };

  const supportsVolumeHover = () => typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches;

  const openVolumeMenu = () => {
    if (volumeHoverTimerRef.current) clearTimeout(volumeHoverTimerRef.current);
    volumeHoverRef.current = true;
    setVolumeMenuOpen(true);
    setQueueMenuOpen(false);
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
    if (!supportsVolumeHover()) {
      setQueueMenuOpen(false);
      setVolumeMenuOpen((open) => !open);
      return;
    }
    setMuted((value) => !value);
  };

  const goPrevious = () => {
    if (previousItem && currentTime < 3) {
      playAfterLoadRef.current = playing;
      changeItem(previousItem);
    }
    else seekTo(0);
  };

  const goToQueueItem = (target: MediaItem) => {
    if (target.id === item.id) return;
    setQueueMenuOpen(false);
    playAfterLoadRef.current = playing;
    changeItem(target);
  };

  const handlePlaybackEnded = () => {
    if (activeAudio()) checkpoint(activeAudio()!, "completed");
    if (loopEnabled) {
      seekTo(0);
      void activeAudio()?.play();
      return;
    }
    if (playbackPreferences.auto_next_enabled && nextItem) {
      playAfterLoadRef.current = true;
      changeItem(nextItem);
      return;
    }
    endedWaitingRef.current = queueLoading && playbackPreferences.auto_next_enabled;
    setPlaying(false);
  };

  const advanceLoadedQueue = useEffectEvent(() => changeItem(nextItem!, true));
  useEffect(() => {
    if (!endedWaitingRef.current || queueLoading || !nextItem || !playbackPreferences.auto_next_enabled) return;
    endedWaitingRef.current = false;
    playAfterLoadRef.current = true;
    advanceLoadedQueue();
  }, [queueLoading, nextItem, playbackPreferences.auto_next_enabled]);

  const updateAutoNext = (enabled: boolean) => {
    const next = { ...playbackPreferences, auto_next_enabled: enabled };
    const previous = playbackPreferences;
    setPlaybackPreferences(next);
    void authFetch(`${API_BASE}/api/playback-preferences`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
    }).catch(() => {
      setPlaybackPreferences(previous);
    });
  };

  const toggleQueueItemFavorite = async (target: MediaItem, index: number) => {
    if (!target.path || !onQueueChange) return;
    const nextFavorite = !target.favorite;
    onQueueChange((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, favorite: nextFavorite } : entry));
    // Downloaded media must remain usable without a server connection. Queue
    // its favorite mutation locally instead of optimistically calling an API
    // that is intentionally unavailable in Offline mode.
    if (target.offline) {
      queueOfflineFavorite(target.path, nextFavorite);
      onFavoriteChange?.(target.path, nextFavorite, true);
      return;
    }
    try {
      const response = await authFetch(`${API_BASE}/api/favorites`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: target.path, favorite: nextFavorite }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      onFavoriteChange?.(target.path, nextFavorite);
    } catch {
      onQueueChange((current) => current.map((entry, entryIndex) => entryIndex === index ? { ...entry, favorite: !nextFavorite } : entry));
      onFavoriteChange?.(target.path, !nextFavorite);
    }
  };

  const openOrganize = () => {
    if (!item.path) return;
    setOrganizeOpen(true);
    setVolumeMenuOpen(false);
    setSettingsMenuOpen(false);
    setQueueMenuOpen(false);
  };

  const handleOrganizeSaved = (state: OrganizeSavedState) => {
    if (!item.path) return;
    const itemTags = state.tags[item.path] ?? [];
    const inPlaylists = Object.values(state.playlists).some((playlist) => playlist.paths.includes(item.path!));
    setOrganizeActive(itemTags.length > 0 || inPlaylists);
    updateSnapshotOrganization(item.path, {
      tags: state.tags,
      tagCatalog: state.tag_catalog,
      playlists: state.playlists,
    });
    onOrganizeSaved?.(state);
  };

  const toggleQueueMenu = (event: ReactMouseEvent) => {
    event.stopPropagation();
    setVolumeMenuOpen(false);
    setSettingsMenuOpen(false);
    setQueueMenuOpen((open) => !open);
  };

  const onToggleSettingsMenu = (event: ReactMouseEvent) => {
    event.stopPropagation();
    setQueueMenuOpen(false);
    setVolumeMenuOpen(false);
    setSettingsMenuOpen((open) => !open);
  };

  useEffect(() => {
    const audio = activeAudio();
    if (audio) audio.loop = loopEnabled;
  }, [loopEnabled, item.src]);

  const displayedTime = scrubTime ?? currentTime;
  const completedPercent = duration > 0 ? Math.max(0, Math.min(100, displayedTime / duration * 100)) : 0;
  const [mediaSessionSyncId, setMediaSessionSyncId] = useState(0);

  const syncNativeSession = useEffectEvent(() => {
    if (!nativeMediaSessionAvailable()) return;
    void syncNativeMediaSession({
      // Android notification actions are commands, not toggles. Keep the
      // rendered element as the sole playback owner so an audio-focus pause
      // from another app updates both the player and notification.
      onPlay: () => { setPlaying(true); void activeAudio()?.play().catch(() => setPlaying(false)); },
      onPause: () => {
        activeAudio()?.pause();
        setPlaying(false);
      },
      onSeekBackward: () => {
        const audio = activeAudio();
        if (audio) seekTo(audio.currentTime - 10);
      },
      onSeekForward: () => {
        const audio = activeAudio();
        if (audio) seekTo(audio.currentTime + 10);
      },
      onPrevious: () => {
        if (previousItem) goPrevious();
        else {
          const audio = activeAudio();
          if (audio) seekTo(0);
        }
      },
      onNext: () => { if (nextItem) { playAfterLoadRef.current = playing; changeItem(nextItem); } },
      onSeekTo: (seconds) => seekTo(seconds),
      onFavorite: () => { if (item.path && queueIndex >= 0) void toggleQueueItemFavorite(item, queueIndex); },
    }, {
      title: item.name,
      subtitle: pathLabel,
      album: queueLabel,
      duration,
      position: pendingSeekRef.current ?? activeAudio()?.currentTime ?? currentTime,
      playing,
      favorite: Boolean(item.favorite),
      // Keep Back visible even at the beginning of a queue. The handler
      // restarts the current track from 0 there, and moves to the prior item
      // everywhere else.
      hasPrevious: true,
      hasNext: Boolean(nextItem),
    });
  });

  useEffect(() => {
    syncNativeSession();
  }, [item.id, item.name, item.favorite, item.path, pathLabel, queueLabel, duration, playing, previousItem?.id, nextItem?.id, queueIndex, mediaSessionSyncId]);

  useEffect(() => () => {
    void clearNativeMediaSession();
  }, []);

  return <>
    <div className={`miniplayer${expanded ? " expanded" : ""}`}>
      <audio
        ref={audioRef}
        className="miniplayer-source"
        src={item.src}
        autoPlay={initialPlaying}
        loop={loopEnabled}
        onPlay={(event) => { resumeMediaVolume(event.currentTarget); setPlaying(true); setPlaybackError(""); checkpoint(event.currentTarget, "started"); }}
        onPause={(event) => { setPlaying(false); checkpoint(event.currentTarget, "paused"); }}
        onTimeUpdate={(event) => { updatePlaybackTime(event.currentTarget); checkpoint(event.currentTarget); }}
        onSeeked={(event) => { updatePlaybackTime(event.currentTarget); checkpoint(event.currentTarget, "resumed", true); }}
        onLoadedMetadata={(event) => {
          setDuration(event.currentTarget.duration);
          applyResume(event.currentTarget);
        }}
        onDurationChange={(event) => setDuration(event.currentTarget.duration)}
        onVolumeChange={(event) => {
          setVolume(readMediaVolumePosition(event.currentTarget));
          setMuted(event.currentTarget.muted);
        }}
        onEnded={handlePlaybackEnded}
        onError={() => { setPlaying(false); setPlaybackError("This audio could not be loaded. Try another item in the queue."); }}
      />
      <div className="miniplayer-header">
        <div
          onTouchStart={startTrackSwipe}
          onTouchMove={(event) => { if (event.touches.length !== 1) trackSwipeStart.current = null; }}
          onTouchEnd={finishTrackSwipe}
          onTouchCancel={() => { trackSwipeStart.current = null; }}
        >
          <b>{item.name}</b>
          <small>{pathLabel}</small>
          {queueLoading ? <small role="status">Loading queue…</small> : null}
          {playbackError ? <small role="status">{playbackError}</small> : null}
        </div>
        <button type="button" className="miniplayer-expand" onClick={() => { setQueueMenuOpen(false); setSettingsMenuOpen(false); setExpanded((value) => !value); }} aria-label={expanded ? "Collapse now playing" : "Expand now playing"} aria-pressed={expanded} title={expanded ? "Collapse now playing" : "Expand now playing"}>
          {expanded ? "⌄" : "⌃"}
        </button>
      </div>
      <div className="miniplayer-content">
      <div className="miniplayer-shell watch-controls">
        <div className="watch-seek-wrap">
          <div className="watch-seek-visual" aria-hidden="true">
            <i className="watch-seek-section" style={{ flexGrow: 1 }}>
              {completedPercent > 0 ? <b className="completed" style={{ width: `${completedPercent}%` }} /> : null}
            </i>
          </div>
          <input
            className="watch-seek"
            aria-label="Playback position"
            type="range"
            min="0"
            max={duration || 0}
            step="0.1"
            value={displayedTime}
            onPointerDown={() => { scrubbingRef.current = true; scrubTargetRef.current = null; }}
            onPointerUp={commitScrub}
            onPointerCancel={() => { scrubbingRef.current = false; scrubTargetRef.current = null; setScrubTime(null); }}
            onChange={(event) => {
              const target = Number(event.target.value);
              if (scrubbingRef.current) { scrubTargetRef.current = target; setScrubTime(target); }
              else seekTo(target);
            }}
          />
        </div>
        <div className="watch-control-row">
          <div className="watch-controls-left">
            <div className="watch-episode-nav" aria-label="Queue navigation">
              <button type="button" className="wctl-bar-t0" disabled={!previousItem} onClick={goPrevious} aria-label={previousItem ? `Previous: ${previousItem.name}` : "No previous media"} title={previousItem ? `Previous: ${previousItem.name}` : "No previous media"}>
                <QueueIcon direction="previous" />
              </button>
            </div>
            <button type="button" className="wctl-bar-t0" onClick={togglePlayback} aria-label={playing ? "Pause" : "Play"}>
              {playing ? "❚❚" : "▶"}
            </button>
            <div className="watch-episode-nav" aria-label="Queue navigation">
              <button type="button" className="wctl-bar-t0" disabled={!nextItem} onClick={() => { if (nextItem) { playAfterLoadRef.current = playing; changeItem(nextItem); } }} aria-label={nextItem ? `Next: ${nextItem.name}` : "No next media"} title={nextItem ? `Next: ${nextItem.name}` : "No next media"}>
                <QueueIcon direction="next" />
              </button>
            </div>
            <span className="watch-readout">
              <span className="watch-readout-time">{playbackClock(displayedTime)} / {playbackClock(duration)}</span>
              {queue.length > 0 ? <>
                <span className="watch-readout-divider" aria-hidden="true" />
                <div ref={queueTriggerRef} className={`watch-queue-trigger${queueMenuOpen ? " open" : ""}`} role="button" tabIndex={0} aria-expanded={queueMenuOpen} aria-haspopup="menu" aria-label={queueLoading ? "Loading queue. View queue." : `Queue: ${Math.max(queueIndex, 0) + 1} of ${queue.length}. View queue.`} onClick={toggleQueueMenu} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); toggleQueueMenu(event as unknown as ReactMouseEvent); } }}>
                  <QueueReadout loading={queueLoading} index={queueIndex} total={queue.length} />
                </div>
              </> : null}
            </span>
          </div>
          <div className="watch-controls-right">
            <button type="button" className={`watch-toggle-button miniplayer-playback-toggle wctl-bar-t2 ${playbackPreferences.auto_next_enabled ? "active" : ""}`} onClick={() => updateAutoNext(!playbackPreferences.auto_next_enabled)} aria-label={playbackPreferences.auto_next_enabled ? "Disable auto next" : "Enable auto next"} aria-pressed={playbackPreferences.auto_next_enabled} title="Play the next item in the queue when this one ends">Auto Next</button>
            <button type="button" className={`watch-loop-button miniplayer-playback-toggle wctl-bar-t2 ${loopEnabled ? "active" : ""}`} onClick={() => setLoopEnabled((value) => !value)} aria-label={loopEnabled ? "Disable repeat" : "Enable repeat"} aria-pressed={loopEnabled} title={loopEnabled ? "Repeat enabled" : "Repeat disabled"}>↻</button>
            <button type="button" className={`watch-favorite-button wctl-bar-t1 ${item?.favorite ? "active" : ""}`} onClick={() => { if (item) void toggleQueueItemFavorite(item, queueIndex); }} aria-label={item?.favorite ? "Remove from favorites" : "Add to favorites"} aria-pressed={Boolean(item?.favorite)} title={item?.favorite ? "Remove from favorites" : "Add to favorites"}><span aria-hidden="true">{item?.favorite ? "★" : "☆"}</span></button>
            {item?.path ? <button type="button" className={`watch-organize-button wctl-bar-t1 ${organizeActive ? "active" : ""}`} onClick={openOrganize} aria-label="Tags and playlists" aria-pressed={organizeActive} title="Tags and playlists"><span aria-hidden="true">#</span></button> : null}
            <div className="watch-volume-control wctl-bar-t1" onMouseEnter={openVolumeMenu} onMouseLeave={scheduleVolumeMenuClose}>
              <div className="watch-volume-compact" onMouseEnter={openVolumeMenu} onMouseLeave={scheduleVolumeMenuClose}>
                {volumeMenuOpen ? <div className="watch-volume-popup" onMouseEnter={openVolumeMenu} onMouseLeave={scheduleVolumeMenuClose} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                  <div className="watch-volume-vertical-wrap">
                    <input {...volumeSliderInteraction} className="watch-volume watch-volume-vertical" style={volumeSliderStyle(muted ? 0 : volume)} aria-label="Volume" aria-valuetext={volumeLabelFromSlider(muted ? 0 : volume)} type="range" min="0" max={VOLUME_SLIDER_MAX} step="0.01" value={muted ? 0 : volume} onChange={(event) => setVolumeLevel(Number(event.target.value))} />
                  </div>
                </div> : null}
                <button type="button" className={`watch-volume-trigger${volumeMenuOpen ? " open" : ""}`} aria-label={muted ? "Unmute" : "Mute"} aria-haspopup="true" aria-expanded={volumeMenuOpen} onClick={handleVolumeTriggerClick} title={muted ? "Unmute" : "Mute"}>
                  <span className="watch-volume-readout" hidden={!volumeAdjusting} aria-hidden="true">{volumeLabelFromSlider(muted ? 0 : volume)}</span><span hidden={volumeAdjusting}><VolumeIcon muted={muted || volume === 0} /></span>
                </button>
              </div>
              <input {...volumeSliderInteraction} className="watch-volume watch-volume-inline wctl-bar-t6" style={volumeSliderStyle(muted ? 0 : volume)} aria-label="Volume" aria-valuetext={volumeLabelFromSlider(muted ? 0 : volume)} type="range" min="0" max={VOLUME_SLIDER_MAX} step="0.01" value={muted ? 0 : volume} onChange={(event) => setVolumeLevel(Number(event.target.value))} />

            </div>
            <button type="button" className="miniplayer-close wctl-bar-t1" onClick={() => { clearPlaybackHandoff(); onClose(); }} aria-label="Close miniplayer" title="Close miniplayer">×</button>
            <div className="watch-settings hide-when-empty wctl-bar-t0">
              {settingsMenuOpen && <div className="watch-settings-menu" role="menu" aria-label="Playback settings" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
                <div className="watch-settings-title">Settings</div>
                <button type="button" className={`watch-settings-toggle wctl-set-item wctl-set-t1 ${item?.favorite ? "active" : ""}`} role="menuitemcheckbox" aria-checked={Boolean(item?.favorite)} onClick={() => { if (item) void toggleQueueItemFavorite(item, queueIndex); }}><span>Favorite</span><em>{item?.favorite ? "Saved" : "Off"}</em></button>
                {item?.path ? <button type="button" className={`watch-settings-toggle wctl-set-item wctl-set-t1 ${organizeActive ? "active" : ""}`} role="menuitem" onClick={() => { setSettingsMenuOpen(false); openOrganize(); }}><span>Tags & playlists</span><em>{organizeActive ? "Set" : "Edit"}</em></button> : null}
                <label className="watch-settings-volume wctl-set-item wctl-set-t1"><span>Volume</span><input {...volumeSliderInteraction} aria-label="Volume" aria-valuetext={volumeLabelFromSlider(muted ? 0 : volume)} type="range" min="0" max={VOLUME_SLIDER_MAX} step="0.01" value={muted ? 0 : volume} onChange={(event) => setVolumeLevel(Number(event.target.value))} /></label>
                <button type="button" className={`watch-settings-toggle wctl-set-item wctl-set-t2 watch-auto-next ${playbackPreferences.auto_next_enabled ? "active" : ""}`} role="menuitemcheckbox" aria-checked={playbackPreferences.auto_next_enabled} onClick={() => updateAutoNext(!playbackPreferences.auto_next_enabled)}><i aria-hidden="true">↪</i><span>Auto Next</span><em>{playbackPreferences.auto_next_enabled ? "On" : "Off"}</em></button>
                <button type="button" className={`watch-settings-toggle wctl-set-item wctl-set-t2 ${loopEnabled ? "active" : ""}`} role="menuitemcheckbox" aria-checked={loopEnabled} onClick={() => setLoopEnabled((value) => !value)}><span>Loop</span><em>{loopEnabled ? "On" : "Off"}</em></button>
                <button type="button" className="watch-settings-toggle wctl-set-item wctl-set-t1" role="menuitem" onClick={() => { clearPlaybackHandoff(); onClose(); }}><span>Close</span><em>×</em></button>
              </div>}
              <button type="button" className={`watch-settings-trigger${settingsMenuOpen ? " open" : ""}`} aria-label="Playback settings" aria-haspopup="menu" aria-expanded={settingsMenuOpen} onClick={onToggleSettingsMenu}>⚙</button>
            </div>
          </div>
        </div>
      </div>
      <aside className="miniplayer-expanded-queue" aria-label="Playback queue">
        <div className="miniplayer-expanded-queue-title">
          <span>{queueLabel ?? "Queue"}</span>
          <small><QueueReadout loading={queueLoading} index={queueIndex} total={queue.length} /></small>
        </div>
        <div className="miniplayer-expanded-queue-list" role="list">
          {queue.map((entry, index) => {
            const active = index === queueIndex;
            const lengthSeconds = entry.duration ?? (active && duration > 0 ? duration : undefined);
            return <button key={entry.path ?? entry.src ?? index} type="button" className={`miniplayer-expanded-queue-item${active ? " active" : ""}`} role="listitem" aria-current={active ? "true" : undefined} onClick={() => goToQueueItem(entry)}>
              <span>{entry.name}</span>
              <small>{lengthSeconds && lengthSeconds > 0 ? playbackClock(lengthSeconds) : "…"}</small>
            </button>;
          })}
        </div>
      </aside>
      </div>
    </div>
    <div className="watch-duration-probes" aria-hidden="true">
      {queue.slice(Math.max(0, queueIndex - 2), Math.max(0, queueIndex) + 8).map((entry) => <QueueDurationProbe key={entry.path ?? entry.src ?? entry.id} item={entry} onDuration={rememberQueueDuration} />)}
    </div>
    {queueMenuOpen && typeof document !== "undefined" ? createPortal(<div ref={queueMenuRef} className="watch-queue-menu watch-queue-menu-fixed" role="menu" aria-label="Playback queue" style={{ position: "fixed", left: queueMenuPosition?.left ?? -9999, top: queueMenuPosition?.top ?? 0, visibility: queueMenuPosition ? "visible" : "hidden", bottom: "auto", right: "auto" }} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
      <div className="watch-queue-menu-title">{queueLabel ?? "Queue"}</div>
      {queue.map((entry, index) => {
        const active = index === queueIndex;
        const lengthSeconds = entry.duration ?? (active && duration > 0 ? duration : undefined);
        const lengthLabel = lengthSeconds && lengthSeconds > 0 ? playbackClock(lengthSeconds) : "…";
        return <div key={entry.path ?? entry.src ?? index} className={`watch-queue-item${active ? " active" : ""}`} role="presentation">
          <QueueItemMain name={entry.name} active={active} lengthLabel={lengthLabel} onSelect={() => goToQueueItem(entry)} />
          {onQueueChange ? <button type="button" className={`watch-queue-item-fav${entry.favorite ? " active" : ""}`} aria-label={entry.favorite ? `Remove ${entry.name} from favorites` : `Add ${entry.name} to favorites`} aria-pressed={Boolean(entry.favorite)} onClick={(event) => { event.stopPropagation(); void toggleQueueItemFavorite(entry, index); }}>{entry.favorite ? "★" : "☆"}</button> : null}
        </div>;
      })}
    </div>, document.body) : null}
    {item.path ? <OrganizeMediaModal
      open={organizeOpen}
      path={item.path}
      name={item.name}
      onClose={() => setOrganizeOpen(false)}
      onSaved={handleOrganizeSaved}
    /> : null}
  </>;
}
