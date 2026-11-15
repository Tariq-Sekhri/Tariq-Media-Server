"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { authFetch, getDeviceIdentity, getSessionToken, getSessionUser } from "./auth";
import { API_BASE } from "./media";
import { playbackPreferencesFromState, type PlaybackPreferences } from "./playback";

// Watch Together client. One room at a time per app instance; the server is
// the authority for ordering, this module keeps a projected copy of the room,
// an estimate of the server clock, and a diagnostic trail for debugging.

export type WatchRoomSettings = { auto_skip: boolean; auto_next: boolean; image_seconds: number; loop_enabled: boolean };
export type WatchRoomMedia = { path: string; name: string; kind: string; url: string };
export type WatchRoomPlayback = { playing: boolean; position: number; rate: number; at: number };
export type WatchRoomMember = { connection: number; user_id: number; name: string; device: string; joined_at: number; position: number | null; buffering: boolean; media_path: string | null; reported_at: number };
export type WatchRoomAction = { seq: number; action: string; by: string; by_connection: number; at: number };
export type WatchRoom = {
  id: string;
  name: string;
  created_by: string;
  created_at: number;
  media: WatchRoomMedia | null;
  /** The room plays something this account cannot open; nothing else about it is sent. */
  media_hidden?: boolean;
  media_seq: number;
  playback: WatchRoomPlayback;
  settings: WatchRoomSettings;
  seq: number;
  last_action: WatchRoomAction | null;
  members: WatchRoomMember[];
};
export type WatchRoomStatus = "idle" | "connecting" | "connected" | "reconnecting";
export type WatchRoomSnapshot = {
  roomId: string | null;
  room: WatchRoom | null;
  status: WatchRoomStatus;
  connection: number | null;
  error: string;
  rtt: number | null;
};
export type WatchRoomCommand = "play" | "pause" | "seek" | "rate" | "sync" | "media" | "clear_media" | "settings";
type CommandFields = {
  playing?: boolean;
  position?: number;
  rate?: number;
  media?: WatchRoomMedia;
  settings?: Partial<WatchRoomSettings>;
  reason?: string;
};

const ROOM_KEY = "tms:watch-room";
const DEBUG_KEY = "tms:watch-room-debug";
const PING_INTERVAL_MS = 4_000;
const RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 4_000, 8_000];
/** A local command stays authoritative locally until the server echoes it. */
const PENDING_COMMAND_TTL_MS = 3_000;

let snapshot: WatchRoomSnapshot = { roomId: null, room: null, status: "idle", connection: null, error: "", rtt: null };
const listeners = new Set<() => void>();
let socket: WebSocket | null = null;
let socketGeneration = 0;
let reconnectAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let pingTimer: ReturnType<typeof setInterval> | undefined;
let pingId = 0;
const pendingPings = new Map<number, number>();
const clockSamples: Array<{ rtt: number; offset: number }> = [];
let clockOffset = 0;
let started = false;
let pendingCommands: Array<{ sentAt: number }> = [];
/** Set after an explicit Join: the room's media wins over whatever is open. */
let adoptRoomMedia = false;
/** Media the room asked this player to open; its arrival is not a local pick. */
let expectedNavigation: { path: string; at: number } | null = null;
/** Media this player picked for the room; it shares its start once loaded. */
let localStartPath: string | null = null;

// ---------------------------------------------------------------- diagnostics

type DiagnosticEntry = { at: string; event: string; detail?: unknown };
const diagnostics: DiagnosticEntry[] = [];
const lastSent = new Map<string, number>();
const debugEnabled = () => {
  try { return typeof window !== "undefined" && window.localStorage.getItem(DEBUG_KEY) === "1"; } catch { return false; }
};

/**
 * Records a sync event locally (inspect with `window.__tmsWatchRoom.log()`),
 * and, at most once a second per event type, forwards it to the server log.
 */
export function watchRoomDiag(event: string, detail?: Record<string, unknown>, options: { send?: boolean } = {}) {
  const entry = { at: new Date().toISOString(), event, detail };
  diagnostics.push(entry);
  if (diagnostics.length > 300) diagnostics.splice(0, diagnostics.length - 300);
  if (debugEnabled()) console.info("[watch-room]", event, detail ?? "");
  if (options.send === false) return;
  const now = Date.now();
  if ((lastSent.get(event) ?? 0) > now - 1_000) return;
  lastSent.set(event, now);
  send({ type: "diag", event, detail: detail ?? {} });
}

if (typeof window !== "undefined") {
  (window as unknown as { __tmsWatchRoom?: unknown }).__tmsWatchRoom = {
    log: () => diagnostics.slice(),
    snapshot: () => snapshot,
    serverNow: () => serverNow(),
    clockOffset: () => clockOffset,
    debug: (enabled = true) => { try { window.localStorage.setItem(DEBUG_KEY, enabled ? "1" : "0"); } catch { /* storage unavailable */ } },
  };
}

// ---------------------------------------------------------------- store

const emit = () => { for (const listener of listeners) listener(); };
const update = (changes: Partial<WatchRoomSnapshot>) => {
  snapshot = { ...snapshot, ...changes };
  emit();
};

export const subscribeWatchRoom = (listener: () => void) => {
  ensureStarted();
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export const watchRoomSnapshot = () => snapshot;
const serverSnapshot = (): WatchRoomSnapshot => ({ roomId: null, room: null, status: "idle", connection: null, error: "", rtt: null });
export const useWatchRoom = () => useSyncExternalStore(subscribeWatchRoom, watchRoomSnapshot, serverSnapshot);

/** Current time on the server's clock, in Unix milliseconds. */
export const serverNow = () => Date.now() + clockOffset;

export const roomPositionAt = (playback: WatchRoomPlayback, at = serverNow()) => playback.playing
  ? playback.position + (Math.max(0, at - playback.at) / 1000) * playback.rate
  : playback.position;

function ensureStarted() {
  if (started || typeof window === "undefined") return;
  started = true;
  let stored = "";
  try { stored = window.localStorage.getItem(ROOM_KEY) ?? ""; } catch { /* storage unavailable */ }
  if (stored && getSessionToken()) {
    watchRoomDiag("restore_room", { room: stored }, { send: false });
    snapshot = { ...snapshot, roomId: stored, status: "connecting" };
    // Rejoining after a refresh follows the room, like an explicit join.
    adoptRoomMedia = true;
    connect();
  }
  window.addEventListener("online", () => { if (snapshot.roomId && !socket) connect(); });
  document.addEventListener("visibilitychange", () => {
    // Mobile browsers suspend sockets in the background; reconnect promptly.
    if (document.visibilityState === "visible" && snapshot.roomId && (!socket || socket.readyState > WebSocket.OPEN)) {
      watchRoomDiag("visible_reconnect", { state: socket?.readyState ?? null }, { send: false });
      reconnectAttempt = 0;
      connect();
    }
  });
}

// ---------------------------------------------------------------- connection

const socketUrl = (roomId: string) => {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({ room: roomId, token: getSessionToken(), device: getDeviceIdentity().device_name });
  return `${protocol}//${window.location.host}${API_BASE}/api/watch-rooms/socket?${params}`;
};

function connect() {
  const roomId = snapshot.roomId;
  if (!roomId) return;
  clearTimeout(reconnectTimer);
  closeSocket();
  const generation = ++socketGeneration;
  const opened = performance.now();
  update({ status: reconnectAttempt > 0 ? "reconnecting" : "connecting" });
  let ws: WebSocket;
  try {
    ws = new WebSocket(socketUrl(roomId));
  } catch (error) {
    watchRoomDiag("socket_create_failed", { message: error instanceof Error ? error.message : String(error) }, { send: false });
    scheduleReconnect();
    return;
  }
  socket = ws;
  ws.onopen = () => {
    if (generation !== socketGeneration) return;
    watchRoomDiag("socket_open", { ms: Math.round(performance.now() - opened), attempt: reconnectAttempt }, { send: false });
    reconnectAttempt = 0;
    clockSamples.length = 0;
    sendPing();
    clearInterval(pingTimer);
    pingTimer = setInterval(sendPing, PING_INTERVAL_MS);
    // A few quick pings give a usable clock estimate within the first second.
    setTimeout(sendPing, 150);
    setTimeout(sendPing, 400);
  };
  ws.onmessage = (event) => {
    if (generation !== socketGeneration || typeof event.data !== "string") return;
    let message: Record<string, unknown>;
    try { message = JSON.parse(event.data) as Record<string, unknown>; } catch { return; }
    handleMessage(message);
  };
  ws.onclose = (event) => {
    if (generation !== socketGeneration) return;
    socket = null;
    clearInterval(pingTimer);
    watchRoomDiag("socket_closed", { code: event.code, reason: event.reason, wasClean: event.wasClean }, { send: false });
    if (snapshot.roomId) scheduleReconnect();
  };
  ws.onerror = () => {
    if (generation !== socketGeneration) return;
    watchRoomDiag("socket_error", { readyState: ws.readyState }, { send: false });
  };
}

function closeSocket() {
  clearInterval(pingTimer);
  const current = socket;
  socket = null;
  socketGeneration++;
  if (current && current.readyState <= WebSocket.OPEN) {
    try { current.close(1000, "closing"); } catch { /* already closed */ }
  }
}

function scheduleReconnect() {
  const roomId = snapshot.roomId;
  if (!roomId) return;
  const delay = RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
  reconnectAttempt++;
  update({ status: "reconnecting", connection: null });
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(() => {
    // A closed room refuses the socket before upgrade, which the browser
    // reports only as a generic close. Check the list to tell the difference.
    void fetchWatchRooms().then((rooms) => {
      if (snapshot.roomId !== roomId) return;
      if (rooms && !rooms.some((room) => room.id === roomId)) {
        watchRoomDiag("room_gone", { room: roomId }, { send: false });
        forgetRoom("This room has closed.");
        return;
      }
      connect();
    });
  }, delay);
}

function send(message: Record<string, unknown>) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function sendPing() {
  const id = ++pingId;
  const t = Date.now();
  pendingPings.set(id, t);
  if (pendingPings.size > 20) pendingPings.delete(pendingPings.keys().next().value!);
  send({ type: "ping", id, t });
}

function handleMessage(message: Record<string, unknown>) {
  const type = message.type;
  if (type === "pong") {
    const id = Number(message.id);
    const sentAt = pendingPings.get(id);
    pendingPings.delete(id);
    if (sentAt === undefined) return;
    const receivedAt = Date.now();
    const rtt = receivedAt - sentAt;
    const offset = Number(message.server_time) - (sentAt + rtt / 2);
    clockSamples.push({ rtt, offset });
    if (clockSamples.length > 10) clockSamples.shift();
    // The fastest round trip has the least asymmetric delay.
    const best = clockSamples.reduce((winner, sample) => sample.rtt < winner.rtt ? sample : winner);
    const previous = clockOffset;
    clockOffset = best.offset;
    if (Math.abs(previous - clockOffset) > 250 && clockSamples.length > 3) {
      watchRoomDiag("clock_jump", { previous: Math.round(previous), offset: Math.round(clockOffset), rtt });
    }
    if (snapshot.rtt === null || Math.abs((snapshot.rtt ?? 0) - rtt) > 15) update({ rtt });
    return;
  }
  if (type === "welcome") {
    const room = message.room as WatchRoom;
    pendingCommands = [];
    watchRoomDiag("joined", { room: room.id, connection: message.connection, media: room.media?.path ?? null, seq: room.seq }, { send: false });
    update({ room, status: "connected", connection: Number(message.connection), error: "" });
    return;
  }
  if (type === "state") {
    applyServerRoom(message.room as WatchRoom);
    return;
  }
  if (type === "members") {
    if (!snapshot.room) return;
    update({ room: { ...snapshot.room, members: message.members as WatchRoomMember[] } });
    return;
  }
  if (type === "error") {
    watchRoomDiag("server_error", { message: message.message }, { send: false });
    update({ error: String(message.message ?? "Watch Together error") });
    return;
  }
  if (type === "closed") {
    watchRoomDiag("server_closed", { reason: message.reason }, { send: false });
    forgetRoom(String(message.reason ?? "This room has closed."));
  }
}

function applyServerRoom(room: WatchRoom) {
  const now = Date.now();
  if (room.last_action?.by_connection === snapshot.connection && pendingCommands.length) pendingCommands.shift();
  if (room.last_action?.action === "media_duplicate" && room.last_action.by_connection === snapshot.connection) {
    // Someone else announced the same media first; follow their start.
    watchRoomDiag("media_duplicate", { path: room.media?.path ?? null }, { send: false });
    localStartPath = null;
  }
  pendingCommands = pendingCommands.filter((command) => now - command.sentAt < PENDING_COMMAND_TTL_MS);
  const local = snapshot.room;
  if (pendingCommands.length && local) {
    // Someone else's update (or a join) arrived before our own command was
    // echoed. Keep our optimistic playback so the player does not bounce.
    update({ room: { ...room, playback: local.playback, media: local.media, media_seq: local.media_seq, settings: local.settings } });
    return;
  }
  update({ room });
}

function forgetRoom(error = "") {
  clearTimeout(reconnectTimer);
  closeSocket();
  try { window.localStorage.removeItem(ROOM_KEY); } catch { /* storage unavailable */ }
  pendingCommands = [];
  adoptRoomMedia = false;
  expectedNavigation = null;
  localStartPath = null;
  update({ roomId: null, room: null, status: "idle", connection: null, error, rtt: null });
}

// ---------------------------------------------------------------- actions

export async function fetchWatchRooms(): Promise<WatchRoom[] | null> {
  try {
    const response = await authFetch(`${API_BASE}/api/watch-rooms`, { cache: "no-store" });
    if (!response.ok) return null;
    const body = await response.json() as { rooms: WatchRoom[] };
    return body.rooms;
  } catch {
    return null;
  }
}

const defaultSettingsFromPreferences = (preferences: PlaybackPreferences): WatchRoomSettings => ({
  auto_skip: preferences.auto_skip_enabled,
  auto_next: preferences.auto_next_enabled,
  image_seconds: preferences.image_seconds,
  loop_enabled: false,
});

async function currentPreferences(): Promise<PlaybackPreferences> {
  try {
    const response = await authFetch(`${API_BASE}/api/user-state?view=playback`);
    const state = response.ok ? await response.json() as { playback_preferences?: Partial<PlaybackPreferences> } : {};
    return playbackPreferencesFromState(state.playback_preferences);
  } catch {
    return playbackPreferencesFromState(undefined);
  }
}

export async function createWatchRoom(options: {
  name?: string;
  settings?: WatchRoomSettings;
  media?: WatchRoomMedia | null;
  position?: number;
  playing?: boolean;
  rate?: number;
} = {}) {
  const settings = options.settings ?? defaultSettingsFromPreferences(await currentPreferences());
  const response = await authFetch(`${API_BASE}/api/watch-rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: options.name, settings, media: options.media ?? undefined, position: options.position, playing: options.playing, rate: options.rate }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { message?: string };
    throw new Error(body.message || `Could not create a room (${response.status}).`);
  }
  const { room } = await response.json() as { room: WatchRoom };
  watchRoomDiag("created", { room: room.id, media: room.media?.path ?? null }, { send: false });
  // The creator's own player already shows the media; nothing to adopt.
  joinWatchRoom(room.id, { adopt: false, room });
  return room;
}

export function joinWatchRoom(roomId: string, options: { adopt?: boolean; room?: WatchRoom } = {}) {
  ensureStarted();
  if (snapshot.roomId === roomId && socket) return;
  try { window.localStorage.setItem(ROOM_KEY, roomId); } catch { /* storage unavailable */ }
  adoptRoomMedia = options.adopt ?? true;
  expectedNavigation = null;
  pendingCommands = [];
  reconnectAttempt = 0;
  watchRoomDiag("join_requested", { room: roomId, adopt: adoptRoomMedia }, { send: false });
  update({ roomId, room: options.room ?? null, status: "connecting", connection: null, error: "" });
  connect();
}

export function leaveWatchRoom() {
  if (!snapshot.roomId) return;
  watchRoomDiag("leave", { room: snapshot.roomId });
  send({ type: "leave" });
  forgetRoom();
}

/**
 * Sends a playback command and applies it to the local copy right away so
 * this device reacts without waiting for the round trip.
 */
export function sendWatchRoomCommand(action: WatchRoomCommand, fields: CommandFields = {}) {
  const room = snapshot.room;
  if (!room) return false;
  const at = serverNow();
  const current = roomPositionAt(room.playback, at);
  let next: WatchRoom = room;
  if (action === "media" && fields.media) {
    next = { ...room, media: fields.media, media_hidden: false, media_seq: room.media_seq + 1, playback: { playing: fields.playing ?? true, position: fields.position ?? 0, rate: fields.rate ?? room.playback.rate, at } };
  } else if (action === "clear_media") {
    next = { ...room, media: null, media_seq: room.media_seq + 1, playback: { ...room.playback, playing: false, position: 0, at } };
  } else if (action === "settings" && fields.settings) {
    next = { ...room, settings: { ...room.settings, ...fields.settings } };
  } else {
    next = { ...room, playback: {
      playing: fields.playing ?? (action === "play" ? true : action === "pause" ? false : room.playback.playing),
      position: fields.position ?? current,
      rate: fields.rate ?? room.playback.rate,
      at,
    } };
  }
  const sent = send({ type: "command", action, at, ...fields });
  watchRoomDiag(`command_${action}`, {
    sent,
    position: fields.position === undefined ? undefined : Math.round(fields.position * 1000) / 1000,
    playing: next.playback.playing,
    rate: next.playback.rate,
    media: fields.media?.path,
    settings: fields.settings,
    reason: fields.reason,
  }, { send: false });
  if (sent) pendingCommands.push({ sentAt: Date.now() });
  update({ room: next });
  return sent;
}

export function reportWatchRoomMember(report: { position: number | null; buffering: boolean; playing: boolean; mediaPath: string | null }) {
  send({ type: "report", position: report.position ?? undefined, buffering: report.buffering, playing: report.playing, media_path: report.mediaPath ?? undefined, at: serverNow() });
}

export const takeAdoptRoomMedia = () => {
  const value = adoptRoomMedia;
  adoptRoomMedia = false;
  return value;
};
export const peekAdoptRoomMedia = () => adoptRoomMedia;
export const setLocalStartPath = (path: string | null) => { localStartPath = path; };
export const getLocalStartPath = () => localStartPath;
export const expectRoomNavigation = (path: string) => { expectedNavigation = { path, at: Date.now() }; };
/** True once when `path` was opened because the room asked for it. */
export const consumeExpectedNavigation = (path: string) => {
  if (!expectedNavigation || expectedNavigation.path !== path || Date.now() - expectedNavigation.at > 60_000) return false;
  expectedNavigation = null;
  return true;
};

/** The room's position and play state to start `path` from, when joining it. */
export function watchRoomStartFor(path: string) {
  const room = snapshot.room;
  if (!room?.media || room.media.path !== path || localStartPath === path) return null;
  return { position: roomPositionAt(room.playback), playing: room.playback.playing };
}

/** Polls the public room list while `enabled`. */
export function useWatchRoomList(enabled: boolean, intervalMs = 5_000) {
  const [rooms, setRooms] = useState<WatchRoom[]>([]);
  useEffect(() => {
    if (!enabled || typeof window === "undefined" || !getSessionUser()) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = async () => {
      if (document.visibilityState === "visible") {
        const next = await fetchWatchRooms();
        if (!cancelled && next) setRooms(next);
      }
      if (!cancelled) timer = setTimeout(load, intervalMs);
    };
    void load();
    const refreshNow = () => { clearTimeout(timer); void load(); };
    window.addEventListener(WATCH_ROOMS_CHANGED_EVENT, refreshNow);
    return () => { cancelled = true; clearTimeout(timer); window.removeEventListener(WATCH_ROOMS_CHANGED_EVENT, refreshNow); };
  }, [enabled, intervalMs]);
  return rooms;
}

export const WATCH_ROOMS_CHANGED_EVENT = "tms:watch-rooms-changed";

/** Builds the shareable `/watch?...` URL for the room, leaving out per-viewer fields. */
export function roomWatchUrl(search: string) {
  const params = new URLSearchParams(search);
  for (const key of ["start", "play", "playAttempt", "playStartedAt", "playbackSession", "return", "room", "queue"]) params.delete(key);
  return `/watch?${params}`;
}

/** The URL a member opens to follow the room into its media. */
export function followRoomUrl(media: WatchRoomMedia, position: number, playing: boolean) {
  const url = new URL(media.url, "http://tms.local");
  url.searchParams.set("start", position.toFixed(2));
  if (playing) url.searchParams.set("play", "1");
  url.searchParams.set("room", "1");
  return `${url.pathname}${url.search}`;
}

export const HIDDEN_ROOM_MEDIA_MESSAGE = "The room is playing something you don't have access to.";

export const formatRoomTime = (seconds: number) => {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}` : `${minutes}:${String(secs).padStart(2, "0")}`;
};
