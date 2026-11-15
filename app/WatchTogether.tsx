"use client";

import { useEffect, useRef, useState } from "react";
import { appShellSnapshot, navigateApp } from "./lib/app-shell";
import {
  createWatchRoom,
  expectRoomNavigation,
  followRoomUrl,
  formatRoomTime,
  joinWatchRoom,
  leaveWatchRoom,
  roomPositionAt,
  useWatchRoom,
  useWatchRoomList,
  WATCH_ROOMS_CHANGED_EVENT,
  HIDDEN_ROOM_MEDIA_MESSAGE,
  type WatchRoom,
  type WatchRoomMember,
  type WatchRoomSnapshot,
} from "./lib/watch-room";

const DISMISSED_KEY = "tms:watch-rooms-dismissed";

const mediaLabel = (room: WatchRoom) => room.media_hidden ? "Something you don't have access to" : room.media ? room.media.name.replace(/\.[a-z0-9]{2,4}$/i, "") : "Nothing playing yet";
const memberNames = (members: WatchRoomMember[]) => {
  const names = [...new Set(members.map((member) => member.name))];
  return names.length ? names.join(", ") : "Nobody here yet";
};
const playbackLine = (room: WatchRoom) => {
  if (room.media_hidden) return "Not available to you";
  if (!room.media) return "Pick something to watch";
  const state = room.playback.playing ? "Playing" : "Paused";
  const speed = Math.abs(room.playback.rate - 1) > 0.001 ? ` · ${room.playback.rate.toFixed(2)}×` : "";
  return room.media.kind === "image" ? `${state}${speed}` : `${state} · ${formatRoomTime(roomPositionAt(room.playback))}${speed}`;
};
const statusLabel = (snapshot: WatchRoomSnapshot) => snapshot.status === "connected"
  ? snapshot.rtt !== null ? `Connected · ${snapshot.rtt} ms` : "Connected"
  : snapshot.status === "reconnecting" ? "Reconnecting…" : "Connecting…";

/** Opens the room's media in the player, starting where the room is now. */
export function openRoomMedia(room: WatchRoom) {
  if (!room.media) return;
  expectRoomNavigation(room.media.path);
  navigateApp(followRoomUrl(room.media, roomPositionAt(room.playback), room.playback.playing));
}

/** Joins a room and, when no player is open, opens what it is watching. */
export function joinRoomAndWatch(room: WatchRoom) {
  joinWatchRoom(room.id, { adopt: true, room });
  if (room.media && !appShellSnapshot().watch) openRoomMedia(room);
}

export async function startEmptyWatchRoom() {
  const room = await createWatchRoom();
  window.dispatchEvent(new Event(WATCH_ROOMS_CHANGED_EVENT));
  return room;
}

// Rerender every second so the shown room position keeps moving.
function useTicker(active: boolean) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => clearInterval(timer);
  }, [active]);
}

function readDismissed(): string[] {
  try { return JSON.parse(window.sessionStorage.getItem(DISMISSED_KEY) ?? "[]") as string[]; } catch { return []; }
}

/**
 * Cards for the floating corner stack beside downloads: your room while you
 * are in one, otherwise the public rooms people are watching in.
 */
export function WatchTogetherCards() {
  const snapshot = useWatchRoom();
  const rooms = useWatchRoomList(!snapshot.roomId);
  const [dismissed, setDismissed] = useState<string[]>(() => typeof window === "undefined" ? [] : readDismissed());
  const [busy, setBusy] = useState(false);
  const room = snapshot.room;
  useTicker(Boolean(room?.media?.kind !== "image" && room?.playback.playing));

  if (snapshot.roomId) {
    const playerOpen = Boolean(appShellSnapshot().watch);
    return <article className="watch-together-card active">
      <div>
        <span>Watch together · {statusLabel(snapshot)}</span>
        <b>{room?.name ?? "Joining room…"}</b>
        {room && <small>{mediaLabel(room)} · {playbackLine(room)}</small>}
        {room && <small>{room.members.length} watching: {memberNames(room.members)}</small>}
        {room?.media_hidden && <small className="watch-together-error" role="status">{HIDDEN_ROOM_MEDIA_MESSAGE}</small>}
        {snapshot.error && <small className="watch-together-error" role="status">{snapshot.error}</small>}
      </div>
      <div className="magnet-background-actions">
        {room?.media && !playerOpen && <button type="button" onClick={() => openRoomMedia(room)}>Open player</button>}
        <button type="button" className="danger" onClick={leaveWatchRoom}>Leave</button>
      </div>
    </article>;
  }

  const visible = rooms.filter((entry) => entry.members.length > 0 && !dismissed.includes(entry.id));
  const lastError = snapshot.error;
  return <>
    {lastError && <article className="watch-together-card">
      <div><span>Watch together</span><b>{lastError}</b></div>
    </article>}
    {visible.map((entry) => <article key={entry.id} className="watch-together-card">
      <div>
        <span>Watch together · {entry.members.length} watching</span>
        <b>{entry.name}</b>
        <small>{mediaLabel(entry)} · {playbackLine(entry)}</small>
        <small>{memberNames(entry.members)}</small>
      </div>
      <div className="magnet-background-actions">
        <button type="button" disabled={busy} onClick={() => { setBusy(true); joinRoomAndWatch(entry); setBusy(false); }}>Join</button>
        <button type="button" onClick={() => {
          const next = [...dismissed, entry.id];
          setDismissed(next);
          try { window.sessionStorage.setItem(DISMISSED_KEY, JSON.stringify(next)); } catch { /* storage unavailable */ }
        }}>Hide</button>
      </div>
    </article>)}
  </>;
}

type PlayerButtonProps = {
  /** Starts a room with what this player is showing. */
  onStartRoom: () => Promise<void>;
  disabled?: boolean;
};

/** The player's Watch Together control: room status, members and joining. */
export function WatchTogetherPlayerButton({ onStartRoom, disabled = false }: PlayerButtonProps) {
  const snapshot = useWatchRoom();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const rooms = useWatchRoomList(open && !snapshot.roomId, 3_000);
  const wrapper = useRef<HTMLDivElement>(null);
  const room = snapshot.room;
  useTicker(open);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (wrapper.current && event.target instanceof Node && !wrapper.current.contains(event.target)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [open]);

  const start = async () => {
    setBusy(true);
    setError("");
    try {
      await onStartRoom();
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : "Could not start a room.");
    } finally {
      setBusy(false);
    }
  };
  const inRoom = Boolean(snapshot.roomId);
  const others = room ? room.members.filter((member) => member.connection !== snapshot.connection) : [];
  const roomPosition = room ? roomPositionAt(room.playback) : 0;

  return <div ref={wrapper} className="watch-together-control" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    {open && <div className="watch-together-menu" role="dialog" aria-label="Watch together">
      {inRoom ? <>
        <div className="watch-together-menu-head">
          <b>{room?.name ?? "Joining room…"}</b>
          <small className={snapshot.status === "connected" ? "ok" : "warn"}>{statusLabel(snapshot)}</small>
        </div>
        {room && <ul className="watch-together-members" aria-label="People in this room">
          {room.members.map((member) => {
            const self = member.connection === snapshot.connection;
            const sameMedia = !room.media || member.media_path === room.media.path;
            const offset = member.position !== null && sameMedia && room.media?.kind !== "image" ? member.position - roomPositionAt(room.playback, member.reported_at) : null;
            const state = !sameMedia ? "Opening…" : member.buffering ? "Loading" : offset !== null && Math.abs(offset) > 2 ? `${offset > 0 ? "+" : ""}${offset.toFixed(1)} s` : "In sync";
            return <li key={member.connection}><span>{member.name}{self ? " (you)" : ""}</span><small>{member.device}</small><em className={state === "In sync" ? "ok" : "warn"}>{state}</em></li>;
          })}
        </ul>}
        {room?.media_hidden && <p className="watch-together-error" role="status">{HIDDEN_ROOM_MEDIA_MESSAGE}</p>}
        {room && !others.length && <p className="watch-together-note">Nobody else is here yet. Friends can join from the corner of their library.</p>}
        <p className="watch-together-note">Play, pause, seeking, speed, Auto Skip, Auto Next, Loop and image timing are shared. Quality, captions, audio and volume stay yours.</p>
        {snapshot.error && <p className="watch-together-error" role="status">{snapshot.error}</p>}
        <div className="watch-together-actions">
          <button type="button" className="danger" onClick={() => { leaveWatchRoom(); setOpen(false); }}>Leave room</button>
        </div>
      </> : <>
        <div className="watch-together-menu-head"><b>Watch together</b></div>
        {rooms.filter((entry) => entry.members.length > 0).map((entry) => <div className="watch-together-room" key={entry.id}>
          <div><b>{entry.name}</b><small>{mediaLabel(entry)} · {playbackLine(entry)}</small><small>{memberNames(entry.members)}</small></div>
          <button type="button" onClick={() => { joinWatchRoom(entry.id, { adopt: true, room: entry }); }}>Join</button>
        </div>)}
        {!rooms.some((entry) => entry.members.length > 0) && <p className="watch-together-note">No open rooms.</p>}
        {(error || snapshot.error) && <p className="watch-together-error" role="status">{error || snapshot.error}</p>}
        <div className="watch-together-actions">
          <button type="button" className="primary" disabled={busy || disabled} onClick={() => void start()}>{busy ? "Starting…" : "Start a room with this"}</button>
        </div>
      </>}
    </div>}
    <button
      type="button"
      className={`watch-together-trigger${inRoom ? " active" : ""}${inRoom && snapshot.status !== "connected" ? " warn" : ""}`}
      aria-label={inRoom ? `Watch together: ${room?.name ?? "room"}, ${room?.members.length ?? 0} watching` : "Watch together"}
      aria-haspopup="dialog"
      aria-expanded={open}
      title={inRoom && room ? `${room.name} · ${formatRoomTime(roomPosition)}` : "Watch together"}
      onClick={() => setOpen((value) => !value)}
    >
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.3c2.2.7 3.5 2.8 3.5 5.7" /></svg>
      {inRoom && room ? <em>{room.members.length}</em> : null}
    </button>
  </div>;
}
