import { watchPlaysAlongside } from "./library-playback";
import { useSyncExternalStore } from "react";

// Library and Watch share one document so playback continues while the user
// browses. Leaving Watch keeps the same player mounted as a floating mini
// player; expanding it returns to the same instance without reloading media.
export type WatchMode = "full" | "mini";
export type WatchInstance = { id: string; url: string; mode: WatchMode };
export type AppShellState = { path: string; watch: WatchInstance | null; companion?: WatchInstance | null };
type WatchEntryState = { tmsWatchId?: string; tmsWatchFromShell?: boolean; tmsDocument?: string };

const SHELL_PATHS = new Set(["/", "/search", "/watch"]);
const SERVER_STATE: AppShellState = { path: "", watch: null };
let state: AppShellState = SERVER_STATE;
let enabled = false;
let watchBackHandler: (() => void) | null = null;
let miniplayerRequested = false;
const listeners = new Set<() => void>();

export const isShellPath = (pathname: string) => SHELL_PATHS.has(pathname);
// YouTube's split: on phones and tablets leaving Watch shrinks the video into
// the mini player; with a mouse, leaving stops it unless the user asked for
// the mini player (the button or the "i" key).
export const leavingWatchKeepsPlaying = () => typeof window !== "undefined"
  && !window.matchMedia?.("(hover: hover) and (pointer: fine)").matches;
const emit = () => listeners.forEach((listener) => listener());
const currentPath = () => `${window.location.pathname}${window.location.search}`;
const entryState = () => (window.history.state ?? {}) as WatchEntryState;
const newWatchId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
// History state survives a reload, but the entries before a reloaded page
// belong to the old document. Going back to those would reload the library.
const DOCUMENT_ID = newWatchId();

// Two Watch URLs describe the same playback when they open the same media.
// Other parameters (start position, play intent) only matter to a new player.
export const watchMediaKey = (url: string) => {
  const params = new URL(url, "http://tms.local").searchParams;
  const catalog = params.get("catalogPath");
  return params.get("offlineFile") ?? params.get("src") ?? (catalog ? `catalog:${catalog}` : params.get("path") ?? "");
};

const sameWatchMedia = (left: string, right: string) => {
  const key = watchMediaKey(left);
  return Boolean(key) && key === watchMediaKey(right);
};

export function syncAppShell() {
  if (typeof window === "undefined") return;
  const path = currentPath();
  let watch = state.watch;
  if (window.location.pathname === "/watch" && watchPlaysAlongside(path)) {
    const companion = state.companion ?? { id: entryState().tmsWatchId ?? newWatchId(), url: path, mode: "full" as const };
    state = { ...state, path, companion: { ...companion, mode: "full" }, watch: watch ? { ...watch, mode: "mini" } : null };
    emit();
    return;
  }
  if (window.location.pathname === "/watch") {
    const entry = entryState();
    if (watch && (entry.tmsWatchId === watch.id || sameWatchMedia(path, watch.url))) {
      // A forward history entry can be older than the queue item now playing.
      // The live player owns its URL, so the address bar follows it.
      if (path !== watch.url || entry.tmsWatchId !== watch.id) window.history.replaceState({ ...entry, tmsWatchId: watch.id }, "", watch.url);
      watch = watch.mode === "full" ? watch : { ...watch, mode: "full" };
    } else {
      watch = { id: entry.tmsWatchId ?? newWatchId(), url: path, mode: "full" };
      if (entry.tmsWatchId !== watch.id) window.history.replaceState({ ...entry, tmsWatchId: watch.id }, "", path);
    }
  } else if (watch && watch.mode !== "mini") {
    watch = miniplayerRequested || leavingWatchKeepsPlaying() ? { ...watch, mode: "mini" } : null;
  }
  if (window.location.pathname !== "/watch") miniplayerRequested = false;
  const next = { ...state, path: currentPath(), watch, companion: state.companion ? { ...state.companion, mode: "mini" as const } : null };
  if (next.path === state.path && next.watch === state.watch) return;
  state = next;
  emit();
}

export function startAppShell() {
  enabled = true;
  syncAppShell();
  window.addEventListener("popstate", syncAppShell);
  return () => {
    window.removeEventListener("popstate", syncAppShell);
    enabled = false;
    state = SERVER_STATE;
    emit();
  };
}

export const subscribeAppShell = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
export const appShellSnapshot = () => state;
export const appShellEnabled = () => enabled;
export const useAppShell = () => useSyncExternalStore(subscribeAppShell, appShellSnapshot, () => SERVER_STATE);
export const useWatchMode = (): WatchMode => useAppShell().watch?.mode ?? "full";

// Navigate between Library and Watch without a document load when the shell
// is running. Other destinations, and any shell route while nothing is
// playing, keep the browser's ordinary navigation.
export function navigateApp(url: string, options: { replace?: boolean } = {}) {
  const target = new URL(url, window.location.href);
  const inPlace = enabled && target.origin === window.location.origin && isShellPath(target.pathname)
    && (target.pathname === "/watch" || Boolean(state.watch || state.companion));
  if (!inPlace) {
    if (options.replace) window.location.replace(target.href);
    else window.location.assign(target.href);
    return;
  }
  const href = `${target.pathname}${target.search}`;
  if (target.pathname === "/watch" && watchPlaysAlongside(url)) {
    state = { ...state, companion: { id: newWatchId(), url, mode: "full" }, watch: state.watch ? { ...state.watch, mode: "mini" } : null };
    window.history.pushState({ tmsWatchId: state.companion!.id, tmsWatchFromShell: true, tmsDocument: DOCUMENT_ID }, "", url);
    syncAppShell();
    return;
  }
  if (target.pathname !== "/watch") {
    showLibrary(href, Boolean(options.replace));
    return;
  }
  const onWatch = window.location.pathname === "/watch";
  const reuse = state.watch && sameWatchMedia(href, state.watch.url) ? state.watch : null;
  const watch = reuse ?? { id: newWatchId(), url: href, mode: "full" as const };
  // Remember whether Back can simply return to the page that opened Watch.
  const fromShell = options.replace ? onWatch && openedFromLibrary() : !onWatch;
  const entry: WatchEntryState = { tmsWatchId: watch.id, tmsWatchFromShell: fromShell, tmsDocument: DOCUMENT_ID };
  if (!reuse) state = { ...state, watch };
  if (options.replace) window.history.replaceState(entry, "", reuse ? reuse.url : href);
  else window.history.pushState(entry, "", reuse ? reuse.url : href);
  syncAppShell();
}

function showLibrary(href: string, replace: boolean) {
  if (replace) window.history.replaceState(null, "", href);
  else window.history.pushState(null, "", href);
  // The library restores its view from the URL on popstate.
  window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
}

const openedFromLibrary = () => {
  const entry = entryState();
  return Boolean(entry.tmsWatchFromShell) && entry.tmsDocument === DOCUMENT_ID;
};

// Back returns to the library page that opened Watch. A Watch page opened
// directly is replaced by its return URL, as the separate route used to do.
function leaveWatchEntry(returnUrl: string) {
  if (openedFromLibrary()) {
    window.history.back();
    return;
  }
  const target = new URL(returnUrl, window.location.href);
  if (enabled && target.origin === window.location.origin && isShellPath(target.pathname) && target.pathname !== "/watch") {
    showLibrary(`${target.pathname}${target.search}`, true);
  } else window.location.replace(target.href);
}

// Leave the full player and keep playback running in the mini player.
export function minimizeWatch(returnUrl: string) {
  if (!enabled || window.location.pathname !== "/watch" || !state.watch) {
    navigateApp(returnUrl, { replace: true });
    return;
  }
  miniplayerRequested = true;
  leaveWatchEntry(returnUrl);
}

// The player's Back button: the mini player on touch screens, stop on desktop.
export function leaveWatch(returnUrl: string) {
  if (leavingWatchKeepsPlaying()) minimizeWatch(returnUrl);
  else closeWatch(returnUrl);
}

export function expandWatch() {
  if (state.watch) navigateApp(state.watch.url);
}

// End the video player. When Watch is visible, also return to the library.
export function closeWatch(returnUrl = "/") {
  if (state.watch) {
    state = { ...state, watch: null };
    emit();
  }
  if (typeof window !== "undefined" && window.location.pathname === "/watch") leaveWatchEntry(returnUrl);
}

// Watch may keep updating its URL (queue changes, resolved titles) while it is
// minimized. Those updates belong to its own entry, not the library's.
export function watchLocationSearch() {
  if (typeof window === "undefined") return "";
  if (window.location.pathname === "/watch" || !state.watch) return window.location.search;
  return new URL(state.watch.url, "http://tms.local").search;
}

export function replaceWatchLocation(url: string) {
  if (state.watch) state.watch.url = url;
  if (window.location.pathname === "/watch") window.history.replaceState({ ...entryState(), tmsWatchId: state.watch?.id }, "", url);
}

// The Android back button leaves full-screen Watch the same way the on-screen
// Back button does, even when Watch was the first page opened.
export function setWatchBackHandler(handler: (() => void) | null) {
  watchBackHandler = handler;
}

export function handleWatchBack() {
  if (!watchBackHandler || state.watch?.mode !== "full" && state.companion?.mode !== "full") return false;
  watchBackHandler();
  return true;
}

export function updateCompanionWatch(url: string) {
  if (!state.companion) return;
  state = { ...state, companion: { ...state.companion, url } };
  emit();
}
export function closeCompanionWatch() {
  const full = state.companion?.mode === "full";
  state = { ...state, companion: null };
  emit();
  if (full) navigateApp("/", { replace: true });
}
export function minimizeCompanionWatch() { navigateApp("/", { replace: true }); }
export function expandCompanionWatch() {
  if (!state.companion) return;
  window.history.pushState({ tmsWatchId: state.companion.id }, "", state.companion.url);
  syncAppShell();
}

// A library's "play alongside" toggle changed: move playback between players.
export function reconcileCompanionWatch() {
  if (state.companion && !watchPlaysAlongside(state.companion.url)) { closeCompanionWatch(); return; }
  if (state.watch && watchPlaysAlongside(state.watch.url)) {
    state = { ...state, companion: state.watch, watch: null };
    emit();
  }
}
