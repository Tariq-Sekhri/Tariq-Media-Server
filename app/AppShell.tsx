"use client";

import { useEffect, useSyncExternalStore, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { LIBRARY_PLAYBACK_EVENT, playsAlongside } from "./lib/library-playback";
import Home from "./page";
import WatchPage from "./watch/page";
import AdminPage from "./admin/page";
import { closeWatch, reconcileCompanionWatch, isShellPath, navigateApp, startAppShell, useAppShell, appShellSnapshot } from "./lib/app-shell";
import { playbackSessionSnapshot, serverPlaybackSessionSnapshot, subscribePlaybackSession } from "./lib/playback-session";

// Library and Watch are rendered here rather than by their routes, so moving
// between them never unmounts the player. Admin shares the shell so moving
// to and from it does not reload the app. Other routes render normally.
export default function AppShell({ children }: { children: ReactNode }) {
  const shell = useAppShell();
  const session = useSyncExternalStore(subscribePlaybackSession, playbackSessionSnapshot, serverPlaybackSessionSnapshot);
  const inShell = isShellPath(usePathname() ?? "");

  useEffect(() => {
    if (!inShell) return;
    const stop = startAppShell();
    // Shell links remain ordinary anchors for open-in-new-tab. A plain click
    // updates the mounted app without reloading the library or player.
    const openInPlace = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
      if (!(anchor instanceof HTMLAnchorElement) || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href);
      if (url.origin !== window.location.origin || !isShellPath(url.pathname)) return;
      event.preventDefault();
      navigateApp(`${url.pathname}${url.search}`);
    };
    // Starting audio hands playback to the audio mini player.
    const stopVideoForAudio = () => {
      if (playbackSessionSnapshot()?.item.kind === "audio" && appShellSnapshot().watch?.mode === "mini") closeWatch();
    };
    const preferencesChanged = () => reconcileCompanionWatch();
    window.addEventListener(LIBRARY_PLAYBACK_EVENT, preferencesChanged);
    document.addEventListener("click", openInPlace);
    const unsubscribe = subscribePlaybackSession(stopVideoForAudio);
    return () => {
      window.removeEventListener(LIBRARY_PLAYBACK_EVENT, preferencesChanged);
      document.removeEventListener("click", openInPlace);
      unsubscribe();
      stop();
    };
  }, [inShell]);

  if (!inShell) return children;
  if (!shell.path) return null;
  const shellPathname = new URL(shell.path, "http://tms.local").pathname;
  const onWatch = shellPathname === "/watch";
  return <>
    {onWatch ? null : shellPathname === "/admin" ? <AdminPage /> : <Home />}
    {[shell.watch, shell.companion].filter((watch): watch is NonNullable<typeof watch> => Boolean(watch)).map(watch => <WatchPage key={watch.id} companionInstance={watch.id === shell.companion?.id ? watch : undefined} foregroundMedia={Boolean(shell.watch || (session?.item.kind === "audio" && !playsAlongside(session.item.path)))} />)}
  </>;
}
