"use client";

import type { MouseEvent as ReactMouseEvent, ReactNode, RefObject } from "react";
import { useState } from "react";
import ImageDurationControl from "./ImageDurationControl";
import QueueReadout from "./QueueReadout";
import { GearIcon, PlayPauseIcon, QueueIcon, SkipIcon, VolumeIcon, playbackClock as clock, volumeSliderStyle } from "./lib/player-ui";
import { VOLUME_SLIDER_MAX, volumeLabelFromSlider } from "./lib/media";
import type { MediaItem } from "./lib/media";
import type { PlaybackPreferences } from "./lib/playback";

type CaptionStatus = { state: "idle" | "loading" | "ready" | "error"; label: string };
type AudioTrack = { stream_index: number; label: string; language: string; is_default: boolean };
type TimelineSection = { start: number; end: number };
type SeekHover = { time: number; left: number; frameTime: number } | null;

type WatchDetailsSlice = {
  kind: string;
  moviesTv: boolean;
};

export type WatchPlayerControlsProps = {
  details: WatchDetailsSlice | null;
  duration: number;
  displayedTime: number;
  playing: boolean;
  playbackError: string;
  timelineSections: TimelineSection[];
  bufferedRanges: Array<{ start: number; end: number }>;
  loadingTarget: number | null;
  seekHover: SeekHover;
  seekPreviewUrl: string;
  onSeekHover: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onSeekHoverClear: () => void;
  onSeek: (value: number) => void;
  onSeekBy: (delta: number) => void;
  onTogglePlayback: () => void;
  previousQueueItem: MediaItem | null | undefined;
  nextQueueItem: MediaItem | null | undefined;
  onGoToQueueItem: (item: MediaItem | null | undefined) => void;
  queue: MediaItem[];
  queueLoading: boolean;
  currentQueueIndex: number;
  queueTriggerRef: RefObject<HTMLDivElement | null>;
  controlsRef: RefObject<HTMLDivElement | null>;
  queueMenuOpen: boolean;
  onToggleQueueMenu: () => void;
  playbackPreferences: PlaybackPreferences;
  autoSkipEnabled: boolean;
  onUpdateAutoSkip: (enabled: boolean) => void;
  onUpdateAutoNext: (enabled: boolean) => void;
  onUpdateImageSeconds: (seconds: number) => void;
  onUpdateBufferSize: (size: PlaybackPreferences["buffer_size_mb"]) => void;
  loopEnabled: boolean;
  onToggleLoop: () => void;
  favorite: boolean;
  onToggleFavorite: () => void | Promise<void>;
  organizeActive?: boolean;
  onOpenOrganize?: () => void;
  volume: number;
  muted: boolean;
  volumeMenuOpen: boolean;
  onVolumeEnter: () => void;
  onVolumeLeave: () => void;
  onVolumeTriggerClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  onSetVolumeLevel: (value: number) => void;
  settingsMenuOpen: boolean;
  onToggleSettingsMenu: () => void;
  captionMenuOpen: boolean;
  onToggleCaptionMenu: () => void;
  audioMenuOpen: boolean;
  onToggleAudioMenu: () => void;
  captionStatus: CaptionStatus;
  renderCaptionOptions: (closeMenu: () => void) => ReactNode;
  captionSettingsOpen: boolean;
  onToggleCaptionSettings: () => void;
  onOpenCaptionSettings: () => void;
  renderCaptionSettings: () => ReactNode;
  audioTracks: AudioTrack[];
  selectedAudioStream: number | null;
  onChangeAudioTrack: (streamIndex: number) => void;
  qualityMenuOpen: boolean;
  onToggleQualityMenu: () => void;
  quality: string;
  qualityBusy: boolean;
  qualityTriggerLabel: string;
  qualityCompactLabel: string;
  sourceHeight: number;
  resolvedQuality: number;
  qualityLevels: number[];
  onChangeQuality: (quality: string) => void | Promise<void>;
  skipData: { segments: Array<{ auto_skip_safe: boolean }> } | null;
  skipDataLoading: boolean;
  skipEvidenceOpen: boolean;
  onToggleSkipEvidence: () => void;
  canPip: boolean;
  pip: boolean;
  onTogglePip: () => void;
  onToggleFullscreen: () => void;
  onMiniplayer?: () => void;
  playbackRate?: number;
  onSetPlaybackRate?: (rate: number) => void;
};

export default function WatchPlayerControls({
  details,
  duration,
  displayedTime,
  playing,
  playbackError,
  timelineSections,
  bufferedRanges,
  loadingTarget,
  seekHover,
  seekPreviewUrl,
  onSeekHover,
  onSeekHoverClear,
  onSeek,
  onSeekBy,
  onTogglePlayback,
  previousQueueItem,
  nextQueueItem,
  onGoToQueueItem,
  queue,
  queueLoading,
  currentQueueIndex,
  queueTriggerRef,
  controlsRef,
  queueMenuOpen,
  onToggleQueueMenu,
  playbackPreferences,
  autoSkipEnabled,
  onUpdateAutoSkip,
  onUpdateAutoNext,
  onUpdateImageSeconds,
  onUpdateBufferSize,
  loopEnabled,
  onToggleLoop,
  favorite,
  onToggleFavorite,
  organizeActive = false,
  onOpenOrganize,
  volume,
  muted,
  volumeMenuOpen,
  onVolumeEnter,
  onVolumeLeave,
  onVolumeTriggerClick,
  onSetVolumeLevel,
  settingsMenuOpen,
  onToggleSettingsMenu,
  captionMenuOpen,
  onToggleCaptionMenu,
  audioMenuOpen,
  onToggleAudioMenu,
  captionStatus,
  renderCaptionOptions,
  captionSettingsOpen,
  onToggleCaptionSettings,
  onOpenCaptionSettings,
  renderCaptionSettings,
  audioTracks,
  selectedAudioStream,
  onChangeAudioTrack,
  qualityMenuOpen,
  onToggleQualityMenu,
  quality,
  qualityBusy,
  qualityTriggerLabel,
  qualityCompactLabel,
  sourceHeight,
  resolvedQuality,
  qualityLevels,
  onChangeQuality,
  skipData,
  skipDataLoading,
  skipEvidenceOpen,
  onToggleSkipEvidence,
  canPip,
  pip,
  onTogglePip,
  onToggleFullscreen,
  onMiniplayer,
  playbackRate = 1,
  onSetPlaybackRate,
}: WatchPlayerControlsProps) {
  const volumeLabel = volumeLabelFromSlider(muted ? 0 : volume);
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
  const closeSettings = () => { if (settingsMenuOpen) onToggleSettingsMenu(); };
  const showQueue = queue.length > 1;
  const stopControlClick = (event: ReactMouseEvent) => event.stopPropagation();

  return <>
    <div className="watch-center-controls" aria-label="Playback controls" onClick={stopControlClick} onPointerDown={stopControlClick}>
      {showQueue && <button type="button" className="watch-center-queue" disabled={!previousQueueItem} onClick={() => onGoToQueueItem(previousQueueItem)} aria-label={previousQueueItem ? `Previous: ${previousQueueItem.name}` : "No previous media"}><QueueIcon direction="previous" /></button>}
      <button type="button" className="watch-center-skip" disabled={Boolean(playbackError)} onClick={() => onSeekBy(-10)} aria-label="Skip back 10 seconds"><SkipIcon direction="back" /></button>
      <button type="button" className="watch-center-play" disabled={Boolean(playbackError)} onClick={onTogglePlayback} aria-label={playing ? "Pause" : "Play"}><PlayPauseIcon playing={playing} /></button>
      <button type="button" className="watch-center-skip" disabled={Boolean(playbackError)} onClick={() => onSeekBy(10)} aria-label="Skip forward 10 seconds"><SkipIcon direction="forward" /></button>
      {showQueue && <button type="button" className="watch-center-queue" disabled={!nextQueueItem} onClick={() => onGoToQueueItem(nextQueueItem)} aria-label={nextQueueItem ? `Next: ${nextQueueItem.name.replace(/\.[a-z0-9]+$/i, "")}` : "No next media"}><QueueIcon direction="next" /></button>}
    </div>
    <div ref={controlsRef} className="watch-controls">
    <div className="watch-seek-wrap" onPointerMove={onSeekHover} onPointerLeave={onSeekHoverClear}>
      {seekHover && <span className="watch-seek-tooltip" style={{ left: seekHover.left }}>
        {seekPreviewUrl ? <img src={seekPreviewUrl} alt="" onError={(event) => { event.currentTarget.style.display = "none"; }} /> : <i aria-hidden="true" />}
        <small>{clock(seekHover.time)}</small>
      </span>}
      <div className="watch-seek-visual" aria-hidden="true">
        {timelineSections.map((section) => {
          const length = section.end - section.start;
          const completed = Math.max(0, Math.min(section.end, displayedTime) - section.start) / length * 100;
          return <i className="watch-seek-section" key={`${section.start}:${section.end}`} style={{ flexGrow: length }}>
            {bufferedRanges.map((range, index) => {
              const start = Math.max(section.start, range.start);
              const end = Math.min(section.end, range.end);
              return end > start ? <b className="buffered" key={`${index}:${start}`} style={{ left: `${(start - section.start) / length * 100}%`, width: `${(end - start) / length * 100}%` }} /> : null;
            })}
            {loadingTarget !== null && loadingTarget >= section.start && loadingTarget <= section.end && <b className="loading" style={{ left: `${(loadingTarget - section.start) / length * 100}%` }} />}
            {completed > 0 && <b className="completed" style={{ width: `${completed}%` }} />}
          </i>;
        })}
        {duration > 0 && <b className="watch-seek-thumb" style={{ left: `${Math.max(0, Math.min(100, displayedTime / duration * 100))}%` }} />}
      </div>
      <input className="watch-seek" disabled={Boolean(playbackError) || !duration} aria-label="Playback position" type="range" min="0" max={duration || 0} step="0.1" value={displayedTime} onChange={(event) => onSeek(Number(event.target.value))} />
    </div>
    <div className="watch-control-row">
      <div className="watch-controls-left">
        <div className="watch-bar-transport">
        {showQueue && <div className="watch-episode-nav wctl-bar-t4" aria-label="Queue navigation"><button type="button" className="wctl-bar-t4" disabled={!previousQueueItem} onClick={() => onGoToQueueItem(previousQueueItem)} aria-label={previousQueueItem ? `Previous: ${previousQueueItem.name}` : "No previous media"} title={previousQueueItem ? `Previous: ${previousQueueItem.name}` : "No previous media"}><QueueIcon direction="previous" /></button></div>}
        <button type="button" className="watch-skip wctl-bar-t0" disabled={Boolean(playbackError)} onClick={() => onSeekBy(-10)} aria-label="Skip back 10 seconds"><SkipIcon direction="back" /></button>
        <button type="button" className="wctl-bar-t0" disabled={Boolean(playbackError)} onClick={onTogglePlayback} aria-label={playing ? "Pause" : "Play"}><PlayPauseIcon playing={playing} /></button>
        <button type="button" className="watch-skip wctl-bar-t0" disabled={Boolean(playbackError)} onClick={() => onSeekBy(10)} aria-label="Skip forward 10 seconds"><SkipIcon direction="forward" /></button>
        {showQueue && <div className="watch-episode-nav wctl-bar-t4" aria-label="Queue navigation"><button type="button" className="wctl-bar-t4" disabled={!nextQueueItem} onClick={() => onGoToQueueItem(nextQueueItem)} aria-label={nextQueueItem ? `Next: ${nextQueueItem.name.replace(/\.[a-z0-9]+$/i, "")}` : "No next media"} title={nextQueueItem ? `Next: ${nextQueueItem.name.replace(/\.[a-z0-9]+$/i, "")}` : "No next media"}><QueueIcon direction="next" /></button></div>}
        </div>
        <span className="watch-readout">
          <span className="watch-readout-time">{clock(displayedTime)} / {clock(Math.round(duration))}</span>
          {(queueLoading || (showQueue && currentQueueIndex >= 0)) && <>
            <span className="watch-readout-divider wctl-bar-t0" aria-hidden="true" />
            <div ref={queueTriggerRef} className={`watch-queue-trigger wctl-bar-t0${queueMenuOpen ? " open" : ""}`} role="button" tabIndex={0} aria-expanded={queueMenuOpen} aria-haspopup="menu" aria-label={queueLoading ? "Loading queue. View queue." : `Queue: ${currentQueueIndex + 1} of ${queue.length}. View queue.`} onClick={onToggleQueueMenu} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onToggleQueueMenu(); } }}>
              <QueueReadout loading={queueLoading} index={currentQueueIndex} total={queue.length} />
            </div>
          </>}
        </span>
        {playbackError && <span className="watch-playback-error" role="status">{playbackError}</span>}
      </div>
      <div className="watch-controls-right">
        {details?.kind === "image" && <label className="watch-image-duration-inline wctl-bar-t8">
          <span>Time per image</span>
          <ImageDurationControl idPrefix="watch-image-seconds-inline" value={playbackPreferences.image_seconds} onChange={onUpdateImageSeconds} onClick={(event) => event.stopPropagation()} />
        </label>}
        {details?.moviesTv && <button type="button" className={`watch-skip-data-button wctl-bar-t7 ${skipData?.segments.some((segment) => segment.auto_skip_safe) ? "confirmed" : ""}`} onClick={onToggleSkipEvidence} aria-expanded={skipEvidenceOpen} title="View timestamp providers and consensus"><span>SKIP</span><small>{skipDataLoading ? "…" : skipData?.segments.length ?? 0}</small></button>}
        {details?.moviesTv && <button type="button" className={`watch-toggle-button wctl-bar-t2 ${autoSkipEnabled ? "active" : ""}`} onClick={() => onUpdateAutoSkip(!autoSkipEnabled)} aria-label={autoSkipEnabled ? "Disable auto skip for this show" : "Enable auto skip for this show"} aria-pressed={autoSkipEnabled} title="Skips detected segments for this show only">Auto Skip</button>}
        {showQueue && <button type="button" className={`watch-toggle-button wctl-bar-t4 ${playbackPreferences.auto_next_enabled ? "active" : ""}`} onClick={() => onUpdateAutoNext(!playbackPreferences.auto_next_enabled)} aria-label={playbackPreferences.auto_next_enabled ? "Disable auto next" : "Enable auto next"} aria-pressed={playbackPreferences.auto_next_enabled} title="Play the next item in the queue when this one ends">Auto Next</button>}
        <button type="button" className={`watch-loop-button wctl-bar-t5 ${loopEnabled ? "active" : ""}`} onClick={onToggleLoop} aria-label={loopEnabled ? "Disable loop" : "Enable loop"} aria-pressed={loopEnabled} title={loopEnabled ? "Loop enabled" : "Loop disabled"}>↻</button>
        <button type="button" className={`watch-favorite-button wctl-bar-t3 ${favorite ? "active" : ""}`} onClick={() => void onToggleFavorite()} aria-label={favorite ? "Remove from favorites" : "Add to favorites"} aria-pressed={favorite} title={favorite ? "Remove from favorites" : "Add to favorites"}><span aria-hidden="true">{favorite ? "★" : "☆"}</span></button>
        {onOpenOrganize && <button type="button" className={`watch-organize-button wctl-bar-t3 ${organizeActive ? "active" : ""}`} onClick={onOpenOrganize} aria-label="Tags and playlists" aria-pressed={organizeActive} title="Tags and playlists"><span aria-hidden="true">#</span></button>}
        {details?.kind !== "image" && <div className="watch-volume-control wctl-bar-t1" onMouseEnter={onVolumeEnter} onMouseMove={onVolumeEnter} onMouseLeave={onVolumeLeave}>
          <div className="watch-volume-compact" onMouseEnter={onVolumeEnter} onMouseLeave={onVolumeLeave}>
            {volumeMenuOpen && <div className="watch-volume-popup" onMouseEnter={onVolumeEnter} onMouseLeave={onVolumeLeave} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
              <div className="watch-volume-vertical-wrap">
                <input {...volumeSliderInteraction} className="watch-volume watch-volume-vertical" style={volumeSliderStyle(muted ? 0 : volume)} aria-label="Volume" aria-valuetext={volumeLabel} type="range" min="0" max={VOLUME_SLIDER_MAX} step="0.01" value={muted ? 0 : volume} onChange={(event) => onSetVolumeLevel(Number(event.target.value))} />
              </div>
            </div>}
            <button type="button" className={`watch-volume-trigger${volumeMenuOpen ? " open" : ""}`} aria-label={muted ? "Unmute" : "Mute"} aria-haspopup="true" aria-expanded={volumeMenuOpen} onClick={onVolumeTriggerClick} title={muted ? "Unmute" : "Mute"}><span className="watch-volume-readout" hidden={!volumeAdjusting} aria-hidden="true">{volumeLabel}</span><span hidden={volumeAdjusting}><VolumeIcon muted={muted || volume === 0} /></span></button>
          </div>
          <input {...volumeSliderInteraction} className="watch-volume watch-volume-inline wctl-bar-t6" style={volumeSliderStyle(muted ? 0 : volume)} aria-label="Volume" aria-valuetext={volumeLabel} type="range" min="0" max={VOLUME_SLIDER_MAX} step="0.01" value={muted ? 0 : volume} onChange={(event) => onSetVolumeLevel(Number(event.target.value))} />

        </div>}
        <div className="watch-settings wctl-bar-t0">
          {settingsMenuOpen && <div className="watch-settings-menu" role="menu" aria-label="Playback settings" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
            <div className="watch-settings-title">Settings</div>
            <button type="button" className={`watch-settings-toggle wctl-set-item wctl-set-t3 ${favorite ? "active" : ""}`} role="menuitemcheckbox" aria-checked={favorite} onClick={() => void onToggleFavorite()}><span>Favorite</span><em>{favorite ? "Saved" : "Off"}</em></button>
            {onOpenOrganize && <button type="button" className={`watch-settings-toggle wctl-set-item wctl-set-t3 ${organizeActive ? "active" : ""}`} role="menuitem" onClick={() => { closeSettings(); onOpenOrganize(); }}><span>Tags & playlists</span><em>{organizeActive ? "Set" : "Edit"}</em></button>}
            {details?.moviesTv && <button type="button" className={`watch-settings-toggle wctl-set-item wctl-set-t2 watch-auto-skip ${autoSkipEnabled ? "active" : ""}`} role="menuitemcheckbox" aria-checked={autoSkipEnabled} onClick={() => onUpdateAutoSkip(!autoSkipEnabled)}><i aria-hidden="true">⏭</i><span>Auto Skip</span><em>{autoSkipEnabled ? "On" : "Off"}</em></button>}
            {details?.kind !== "image" && <label className="watch-settings-volume wctl-set-item wctl-set-t1"><span>Volume</span><input {...volumeSliderInteraction} aria-label="Volume" aria-valuetext={volumeLabel} type="range" min="0" max={VOLUME_SLIDER_MAX} step="0.01" value={muted ? 0 : volume} onChange={(event) => onSetVolumeLevel(Number(event.target.value))} /></label>}
            {details?.kind !== "image" && <button type="button" className="watch-settings-toggle wctl-set-item wctl-set-t5 watch-settings-quality-toggle" role="menuitem" onClick={() => { closeSettings(); onToggleQualityMenu(); }}><span>Quality</span><em>{qualityCompactLabel}</em></button>}
            {details?.kind === "image" && <div className="watch-image-duration-setting wctl-set-item wctl-set-t8">
              <label htmlFor="watch-image-seconds-compact-preset">Time per image</label>
              <ImageDurationControl idPrefix="watch-image-seconds-compact" value={playbackPreferences.image_seconds} onChange={onUpdateImageSeconds} onClick={(event) => event.stopPropagation()} />
              <small>How long each image stays on screen.</small>
            </div>}
            {showQueue && <button type="button" className={`watch-settings-toggle wctl-set-item wctl-set-t4 watch-auto-next ${playbackPreferences.auto_next_enabled ? "active" : ""}`} role="menuitemcheckbox" aria-checked={playbackPreferences.auto_next_enabled} onClick={() => onUpdateAutoNext(!playbackPreferences.auto_next_enabled)}><i aria-hidden="true">↪</i><span>Auto Next</span><em>{playbackPreferences.auto_next_enabled ? "On" : "Off"}</em></button>}
            <button type="button" className={`watch-settings-toggle wctl-set-item wctl-set-t5 ${loopEnabled ? "active" : ""}`} role="menuitemcheckbox" aria-checked={loopEnabled} onClick={onToggleLoop}><span>Loop</span><em>{loopEnabled ? "On" : "Off"}</em></button>
            {details?.moviesTv && <button type="button" className={`watch-settings-toggle wctl-set-item wctl-set-t7 ${skipEvidenceOpen ? "active" : ""}`} role="menuitem" onClick={onToggleSkipEvidence}><span>Skip info</span><em>{skipDataLoading ? "…" : skipData?.segments.length ?? 0}</em></button>}
            {details?.moviesTv && details?.kind !== "image" && <>
              <div className="watch-settings-subtitle wctl-set-section wctl-set-t7">Captions</div>
              <button type="button" className="watch-settings-toggle wctl-set-item wctl-set-t7" role="menuitem" onClick={() => { closeSettings(); onOpenCaptionSettings(); }}><span>Caption settings</span><em>›</em></button>
              <div className="wctl-set-section wctl-set-t7">{renderCaptionOptions(closeSettings)}</div>
            </>}
          </div>}
          <button type="button" className={`watch-settings-trigger${settingsMenuOpen ? " open" : ""}`} aria-label="Playback settings" aria-haspopup="menu" aria-expanded={settingsMenuOpen} onClick={onToggleSettingsMenu}><GearIcon /></button>
        </div>
        {details?.moviesTv && details?.kind !== "image" && <div className="watch-caption-selector wctl-bar-t7">
          {captionMenuOpen && <div className="watch-caption-menu" role="menu" aria-label="Closed captions">
            <div className="watch-caption-menu-header"><div className="watch-caption-title">Closed captions</div><button type="button" className={`watch-caption-settings-trigger${captionSettingsOpen ? " active" : ""}`} onClick={onToggleCaptionSettings} aria-label="Caption settings" aria-expanded={captionSettingsOpen}><GearIcon /></button></div>
            {captionSettingsOpen ? renderCaptionSettings() : renderCaptionOptions(() => { if (captionMenuOpen) onToggleCaptionMenu(); })}
          </div>}
          <button type="button" className={`watch-caption-trigger ${captionStatus.state}`} aria-label="Closed captions" aria-haspopup="menu" aria-expanded={captionMenuOpen} onClick={onToggleCaptionMenu}><strong>CC</strong><small>{captionStatus.label}</small><i aria-hidden="true">⌄</i></button>
        </div>}
        {details?.kind !== "image" && audioTracks.length > 1 && <div className="watch-audio-selector wctl-bar-t7">
          {audioMenuOpen && <div className="watch-audio-menu" role="menu" aria-label="Audio tracks">
            <div className="watch-caption-title">Audio</div>
            {audioTracks.map((track) => <button type="button" key={track.stream_index} className={selectedAudioStream === track.stream_index ? "active" : ""} role="menuitemradio" aria-checked={selectedAudioStream === track.stream_index} onClick={() => { onChangeAudioTrack(track.stream_index); onToggleAudioMenu(); }}><span>{track.label}</span><em>{selectedAudioStream === track.stream_index ? "Playing" : ""}</em></button>)}
          </div>}
          <button type="button" className="watch-audio-trigger" aria-label="Audio tracks" aria-haspopup="menu" aria-expanded={audioMenuOpen} onClick={onToggleAudioMenu}><strong>Audio</strong><i aria-hidden="true">⌄</i></button>
        </div>}
        {details?.kind !== "image" && <div className="watch-quality wctl-bar-t5">
          {qualityMenuOpen && <div className="watch-quality-menu" role="menu" aria-label="Video quality options">
            <div className="watch-quality-title">Quality</div>
            <button type="button" className={quality === "auto" ? "active" : ""} role="menuitemradio" aria-checked={quality === "auto"} onClick={() => void onChangeQuality("auto")}><span>Auto <small>(recommended)</small></span><em>{quality === "auto" && resolvedQuality ? `${resolvedQuality}p` : ""}</em></button>
            {sourceHeight > 0 && <button type="button" className={quality === "original" || quality === "original-aac" ? "active" : ""} role="menuitemradio" aria-checked={quality === "original" || quality === "original-aac"} onClick={() => void onChangeQuality("original")}><span>{sourceHeight}p</span><em>Original</em></button>}
            {qualityLevels.map((height) => <button type="button" key={height} className={quality === String(height) ? "active" : ""} role="menuitemradio" aria-checked={quality === String(height)} onClick={() => void onChangeQuality(String(height))}><span>{height}p</span></button>)}
            {onSetPlaybackRate ? <div className="watch-speed-setting" role="group" aria-label="Playback speed"><div className="watch-quality-title">Speed</div><div className="watch-speed-options">{[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => <button type="button" key={rate} className={Math.abs(playbackRate - rate) < 0.001 ? "active" : ""} role="menuitemradio" aria-checked={Math.abs(playbackRate - rate) < 0.001} onClick={() => onSetPlaybackRate(rate)}>{rate === 1 ? "Normal" : `${rate}×`}</button>)}</div></div> : null}
            <div className="watch-buffer-setting">
              <label htmlFor="watch-buffer-size">Buffer memory</label>
              <select id="watch-buffer-size" value={playbackPreferences.buffer_size_mb} onChange={(event) => onUpdateBufferSize(Number(event.target.value) as PlaybackPreferences["buffer_size_mb"])}>
                <option value="100">100 MB</option>
                <option value="250">250 MB</option>
                <option value="500">500 MB</option>
              </select>
              <small>Maximum used for transcoded playback.</small>
            </div>
          </div>}
          <button type="button" className="watch-quality-trigger" aria-label={`Video quality: ${qualityCompactLabel}`} aria-haspopup="menu" aria-expanded={qualityMenuOpen} onClick={onToggleQualityMenu} disabled={qualityBusy}><span className="watch-quality-label">{qualityTriggerLabel}</span><span className="watch-quality-compact-label">{qualityCompactLabel}</span></button>
        </div>}
        {onMiniplayer ? <button type="button" className="watch-miniplayer-button wctl-bar-t0" onClick={onMiniplayer} aria-label="Miniplayer" title="Miniplayer (i)">
          <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M8 10v5h5" /><path d="M8 15l7-7" /></svg>
        </button> : null}
        <button type="button" className="wctl-bar-t0" onClick={onToggleFullscreen} aria-label="Fullscreen">⛶</button>
      </div>
    </div>
    </div>
  </>;
}
