"use client";

import { useEffect, useLayoutEffect, useRef } from "react";
import {
  consumeExpectedNavigation,
  expectRoomNavigation,
  getLocalStartPath,
  setLocalStartPath,
  peekAdoptRoomMedia,
  reportWatchRoomMember,
  roomPositionAt,
  sendWatchRoomCommand,
  serverNow,
  subscribeWatchRoom,
  takeAdoptRoomMedia,
  HIDDEN_ROOM_MEDIA_MESSAGE,
  watchRoomDiag,
  watchRoomSnapshot,
  type WatchRoomMedia,
} from "./watch-room";

/** What the Watch page exposes so the room can drive it. */
export type WatchRoomPlayer = {
  /** False for companion players, offline files and audio handoffs. */
  enabled: boolean;
  mediaPath: string | null;
  kind: string;
  /** Startup and stream changes finished; position and play state are real. */
  ready: () => boolean;
  /** Absolute media position, in seconds. */
  position: () => number | null;
  /** Whether this player is playing or has been asked to play. */
  playing: () => boolean;
  buffering: () => boolean;
  /** Media length in seconds, or 0 while unknown. */
  duration: () => number;
  rate: number;
  play: () => void;
  pause: () => void;
  seek: (seconds: number) => void;
  setRate: (rate: number) => void;
  /** Temporarily trims the element's speed to close a small gap; null restores it. */
  nudgeRate: (rate: number | null) => void;
  /** The room-shareable description of what is open now. */
  roomMedia: () => WatchRoomMedia | null;
  /** The room moved to media this account cannot open: stop and say so. */
  blocked: (message: string) => void;
  /** Opens other media for the room (in place when it is in the queue). */
  openMedia: (media: WatchRoomMedia, position: number, playing: boolean) => void;
};

const RECONCILE_INTERVAL_MS = 500;
const REPORT_INTERVAL_MS = 2_000;
/** Beyond this gap a member jumps; below it they speed up or slow down. */
const SEEK_DRIFT_PLAYING_S = 1.25;
const SEEK_DRIFT_PAUSED_S = 0.4;
const NUDGE_START_S = 0.15;
const NUDGE_STOP_S = 0.05;
const MAX_NUDGE = 0.08;
const SEEK_COOLDOWN_MS = 2_500;
const PLAY_RETRY_MS = 2_500;

/**
 * Keeps one player in step with its Watch Together room: follows media
 * changes, applies play/pause/speed, corrects drift, announces media the
 * user opens locally, and reports its position for the room's status list.
 */
export function useWatchRoomSync(player: WatchRoomPlayer) {
  const playerRef = useRef(player);
  // The timers below read the latest player callbacks, not the first render's.
  useLayoutEffect(() => { playerRef.current = player; });
  const state = useRef({
    lastSeekAt: 0,
    lastPlayAttemptAt: 0,
    lastPauseAttemptAt: 0,
    playAttempts: 0,
    nudging: false,
    followedMediaSeq: -1,
    hiddenMediaSeq: -1,
    lastReportAt: 0,
    lastRateApplied: 0,
  });

  // Media changes on this player: either the room asked for it, or the user
  // opened something and the room should follow.
  useEffect(() => {
    const current = playerRef.current;
    const path = current.mediaPath;
    const room = watchRoomSnapshot().room;
    if (!current.enabled || !path || !room) return;
    if (room.media?.path === path) {
      if (consumeExpectedNavigation(path)) watchRoomDiag("follow_arrived", { path });
      return;
    }
    if (consumeExpectedNavigation(path)) return;
    if (peekAdoptRoomMedia() && (room.media || room.media_hidden)) return; // reconcile follows the room
    takeAdoptRoomMedia();
    const media = current.roomMedia();
    if (!media) return;
    setLocalStartPath(path);
    watchRoomDiag("local_media_pick", { path, previous: room.media?.path ?? null });
    // Members load paused at the start until this player knows where it
    // resumes, then a sync command carries the real position.
    sendWatchRoomCommand("media", { media, position: 0, playing: false, reason: "opened locally" });
  }, [player.mediaPath, player.enabled]);

  useEffect(() => {
    if (!player.enabled) return;
    const reconcile = () => {
      const current = playerRef.current;
      const room = watchRoomSnapshot().room;
      const local = state.current;
      if (!room || !current.enabled) {
        if (local.nudging) { current.nudgeRate(null); local.nudging = false; }
        return;
      }
      const media = room.media;
      const now = Date.now();

      if (room.media_hidden) {
        // Never adopt, follow or announce anything here: this member only
        // learns that the room moved somewhere they cannot go.
        takeAdoptRoomMedia();
        if (local.nudging) { current.nudgeRate(null); local.nudging = false; }
        if (local.hiddenMediaSeq !== room.media_seq) {
          local.hiddenMediaSeq = room.media_seq;
          watchRoomDiag("media_hidden", { seq: room.media_seq });
          current.blocked(HIDDEN_ROOM_MEDIA_MESSAGE);
        }
        return;
      }

      if (!media) {
        if (current.mediaPath && takeAdoptRoomMedia()) {
          // Joined an empty room while watching: the room starts here.
          const roomMedia = current.roomMedia();
          if (roomMedia) {
            setLocalStartPath(current.mediaPath);
            sendWatchRoomCommand("media", { media: roomMedia, position: current.position() ?? 0, playing: current.playing(), reason: "joined empty room" });
          }
        }
        return;
      }

      if (media.path !== current.mediaPath) {
        if (getLocalStartPath() === current.mediaPath) return;
        if (local.followedMediaSeq === room.media_seq) return;
        local.followedMediaSeq = room.media_seq;
        takeAdoptRoomMedia();
        const position = roomPositionAt(room.playback);
        watchRoomDiag("follow_media", { path: media.path, from: current.mediaPath, position: Math.round(position * 10) / 10, playing: room.playback.playing, seq: room.media_seq });
        expectRoomNavigation(media.path);
        current.openMedia(media, position, room.playback.playing);
        return;
      }
      takeAdoptRoomMedia();

      if (!current.ready()) return;

      if (getLocalStartPath() === current.mediaPath) {
        // This player picked the media; now share where it really starts.
        setLocalStartPath(null);
        const position = current.position() ?? 0;
        watchRoomDiag("local_start_ready", { path: media.path, position: Math.round(position * 10) / 10, playing: current.playing() });
        sendWatchRoomCommand("sync", { position, playing: current.playing(), rate: current.rate, reason: "local start ready" });
        return;
      }

      const playback = room.playback;
      if (Math.abs(current.rate - playback.rate) > 0.001 && local.lastRateApplied !== playback.rate) {
        local.lastRateApplied = playback.rate;
        watchRoomDiag("apply_rate", { rate: playback.rate, from: current.rate }, { send: false });
        current.setRate(playback.rate);
      } else if (Math.abs(current.rate - playback.rate) <= 0.001) {
        local.lastRateApplied = playback.rate;
      }

      const isPlaying = current.playing();
      const mediaDuration = current.kind === "image" ? 0 : current.duration();
      const expectedNow = roomPositionAt(playback, serverNow());
      // When the room has run past the end, an ended player must not be
      // restarted from zero by a play request.
      const roomAtEnd = mediaDuration > 0 && expectedNow >= mediaDuration - 1;
      if (playback.playing && !isPlaying && roomAtEnd) {
        // Nothing to do: the room's auto-next (or loop) decides what is next.
      } else if (playback.playing && !isPlaying) {
        if (now - local.lastPlayAttemptAt > PLAY_RETRY_MS) {
          local.lastPlayAttemptAt = now;
          local.playAttempts++;
          watchRoomDiag("apply_play", { attempt: local.playAttempts, by: room.last_action?.by });
          current.play();
        }
      } else if (!playback.playing && isPlaying) {
        if (now - local.lastPauseAttemptAt > 700) {
          local.lastPauseAttemptAt = now;
          watchRoomDiag("apply_pause", { by: room.last_action?.by }, { send: false });
          current.pause();
        }
      } else {
        local.playAttempts = 0;
      }

      if (current.kind === "image") return;
      const position = current.position();
      if (position === null) return;
      if (roomAtEnd && position >= mediaDuration - 1.5) return;
      const expected = mediaDuration > 0 ? Math.min(expectedNow, mediaDuration - 0.25) : expectedNow;
      const drift = position - expected;
      const threshold = playback.playing ? SEEK_DRIFT_PLAYING_S : SEEK_DRIFT_PAUSED_S;
      if (Math.abs(drift) > threshold) {
        if (local.nudging) { current.nudgeRate(null); local.nudging = false; }
        if (now - local.lastSeekAt < SEEK_COOLDOWN_MS) return;
        if (current.buffering() && playback.playing && drift < 0 && now - local.lastSeekAt < SEEK_COOLDOWN_MS * 3) return;
        local.lastSeekAt = now;
        // Land slightly ahead while playing so the seek's own load time
        // does not leave this member behind again.
        const target = playback.playing ? expected + Math.min(0.4, 0.15 * playback.rate) : expected;
        watchRoomDiag("drift_seek", { drift: Math.round(drift * 100) / 100, target: Math.round(target * 100) / 100, playing: playback.playing, buffering: current.buffering(), last: room.last_action?.action });
        current.seek(target);
        return;
      }
      if (!playback.playing || current.buffering()) {
        if (local.nudging) { current.nudgeRate(null); local.nudging = false; }
        return;
      }
      if (Math.abs(drift) > NUDGE_START_S || (local.nudging && Math.abs(drift) > NUDGE_STOP_S)) {
        const correction = Math.max(-MAX_NUDGE, Math.min(MAX_NUDGE, drift / 2));
        current.nudgeRate(playback.rate * (1 - correction));
        if (!local.nudging) watchRoomDiag("drift_nudge", { drift: Math.round(drift * 100) / 100 }, { send: false });
        local.nudging = true;
      } else if (local.nudging) {
        current.nudgeRate(null);
        local.nudging = false;
      }
    };
    const report = () => {
      const current = playerRef.current;
      if (!current.enabled || !watchRoomSnapshot().room) return;
      reportWatchRoomMember({ position: current.position(), buffering: current.buffering() || !current.ready(), playing: current.playing(), mediaPath: current.mediaPath });
    };
    const tick = () => {
      reconcile();
      const now = Date.now();
      if (now - state.current.lastReportAt >= REPORT_INTERVAL_MS) {
        state.current.lastReportAt = now;
        report();
      }
    };
    const local = state.current;
    const interval = setInterval(tick, RECONCILE_INTERVAL_MS);
    // React to room changes immediately rather than on the next tick.
    let scheduled = false;
    const unsubscribe = subscribeWatchRoom(() => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(() => { scheduled = false; reconcile(); });
    });
    return () => {
      clearInterval(interval);
      unsubscribe();
      if (local.nudging) playerRef.current.nudgeRate(null);
      local.nudging = false;
    };
  }, [player.enabled]);
}
