"use client";

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ComponentProps, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { playsAlongside } from "./lib/library-playback";
import MiniAudioPlayer from "./MiniAudioPlayer";
import { authFetch, getSessionUser } from "./lib/auth";
import { loadPlaybackQueue } from "./lib/playback-queue";
import { playbackSessionSnapshot, serverPlaybackSessionSnapshot, subscribePlaybackSession, restorePlaybackSession, setPlaybackSession, selectPlaybackItem, playbackWatchUrl, samePlaybackItem, checkpointPlaybackSession } from "./lib/playback-session";
import { resolveOfflineFileUrl } from "./lib/offline";
import { navigateApp, useAppShell } from "./lib/app-shell";
import { readLocalWatchProgress } from "./lib/watch-progress";
import type { MediaItem } from "./lib/media";

export const usePlaybackSession = () => useSyncExternalStore(subscribePlaybackSession, playbackSessionSnapshot, serverPlaybackSessionSnapshot);

function SessionAudioPlayer(props: ComponentProps<typeof MiniAudioPlayer>) {
  const itemKey = props.item.path ?? props.item.src;
  const [resume, setResume] = useState(() => ({ itemKey, time: props.initialTime, playing: props.initialPlaying }));
  if (resume.itemKey !== itemKey) setResume({ itemKey, time: props.initialTime, playing: props.initialPlaying });
  return <MiniAudioPlayer {...props} initialTime={resume.time} initialPlaying={resume.playing} />;
}

export default function PlaybackProvider({ children }: { children: ReactNode }) {
  const session = usePlaybackSession();
  const routePathname = usePathname();
  const shell = useAppShell();
  // The shell moves between Library and Watch without a route change.
  const pathname = shell.path ? new URL(shell.path, "http://tms.local").pathname : routePathname;
  const selection = useRef(0);
  const [queueFailure, setQueueFailure] = useState<{ id: string; message: string } | null>(null);
  const [queueRetry, setQueueRetry] = useState(0);
  const queueError = queueFailure?.id === session?.id ? queueFailure?.message : undefined;
  const updateQueue = useCallback((update: MediaItem[] | ((current: MediaItem[]) => MediaItem[])) => {
    const latest = playbackSessionSnapshot();
    if (latest) setPlaybackSession({ ...latest, queue: typeof update === "function" ? update(latest.queue) : update });
  }, []);
  const updatePlaying = useCallback((playing: boolean) => window.dispatchEvent(new CustomEvent("tms:playback-playing", { detail: playing })), []);

  useEffect(() => {
    const restored = restorePlaybackSession(getSessionUser()?.id);
    if (restored) setPlaybackSession(restored);
  }, []);

  // Queue hydration never blocks the first audio request. A new session aborts
  // the old request, and the identity check rejects late responses after close.
  useEffect(() => {
    const session = playbackSessionSnapshot();
    if (!session?.source || session.complete || pathname?.startsWith("/watch")) return;
    const id = session.id;
    const controller = new AbortController();
    void loadPlaybackQueue(session.source, authFetch, controller.signal, getSessionUser()).then(({ queue }) => {
      const latest = playbackSessionSnapshot();
      if (controller.signal.aborted || latest?.id !== id) return;
      setPlaybackSession({ ...latest, queue: queue.some((entry) => samePlaybackItem(entry, latest.item)) ? queue : [latest.item, ...queue], complete: true });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && playbackSessionSnapshot()?.id === id) setQueueFailure({ id, message: error instanceof Error ? error.message : "Could not load queue" });
    });
    return () => { controller.abort(); };
  }, [session?.id, session?.complete, pathname, queueRetry]); // The source is fixed for this session.

  const select = async (item: MediaItem, playing = true) => {
    const latest = playbackSessionSnapshot();
    if (!latest) return;
    const request = ++selection.current;
    try {
      let nextItem = item;
      if (item.offline?.fileId) {
        const resolved = await resolveOfflineFileUrl(item.offline.bundleId, item.offline.fileId);
        if (selection.current !== request || playbackSessionSnapshot()?.id !== latest.id) return;
        nextItem = { ...item, src: resolved.url };
      }
      const active = playbackSessionSnapshot();
      if (!active || active.id !== latest.id) return;
      const progress = readLocalWatchProgress(active.userId)[nextItem.path ?? ""];
      const next = { ...selectPlaybackItem(active, nextItem, playing), time: progress && !progress.completed ? progress.position : 0 };
      setPlaybackSession(next);
      if (nextItem.kind !== "audio" || playsAlongside(nextItem.path)) {
        window.dispatchEvent(new Event("tms:before-watch"));
        // Watch restores this same session from its URL.
        const target = { ...(playbackSessionSnapshot() ?? next), watchEntry: true };
        setPlaybackSession(target);
        navigateApp(playbackWatchUrl(target));
      }
    } catch (error) { setQueueFailure({ id: latest.id, message: error instanceof Error ? error.message : "Could not open media" }); }
  };

  const active = !playsAlongside(session?.item.path) && session?.item.kind === "audio" && !pathname?.startsWith("/watch") && session.userId === getSessionUser()?.id;
  return <>{children}{active && session ? <>
    {queueError ? <div className="playback-queue-status" role="status">{queueError} {session.source && !session.complete
      ? <button type="button" onClick={() => { setQueueFailure(null); setQueueRetry((value) => value + 1); }}>Retry queue</button>
      : <button type="button" onClick={() => setQueueFailure(null)}>Dismiss</button>}</div> : null}
    <SessionAudioPlayer
      key={session.id}
      item={session.item}
      queue={session.queue}
      pathLabel={session.item.path ?? session.item.name}
      moviesTv={false}
      queueLabel={session.label}
      queueLoading={!session.complete && !queueError}
      initialTime={session.time}
      initialPlaying={session.playing}
      onItemChange={(item, playing) => { void select(item, playing); }}
      onQueueChange={updateQueue}
      onFavoriteChange={(path, favorite, locallyQueued) => {
        const latest = playbackSessionSnapshot();
        if (latest) setPlaybackSession({ ...latest, item: latest.item.path === path ? { ...latest.item, favorite } : latest.item, queue: latest.queue.map((item) => item.path === path ? { ...item, favorite } : item) });
        window.dispatchEvent(new CustomEvent("tms:playback-favorite", { detail: { path, favorite, locallyQueued } }));
      }}
      onOrganizeSaved={(state) => window.dispatchEvent(new CustomEvent("tms:playback-organize", { detail: state }))}
      onPlayingChange={updatePlaying}
      onCheckpoint={(time, playing) => {
        checkpointPlaybackSession(session.item, time, playing);
      }}
      onClose={() => { ++selection.current; setPlaybackSession(null); }}
    />
  </> : null}</>;
}

