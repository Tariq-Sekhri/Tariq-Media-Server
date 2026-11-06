import { Capacitor } from "@capacitor/core";
import { MediaSession, type MediaSessionAction } from "@capgo/capacitor-media-session";

type ExtendedMediaSession = typeof MediaSession & {
  setFavoriteState?: (options: { favorite: boolean }) => Promise<void>;
  removeActionHandler?: (options: { action: MediaSessionAction }) => Promise<void>;
};

export type NativeMediaSessionHandlers = {
  onPlay: () => void;
  onPause: () => void;
  onSeekBackward: () => void;
  onSeekForward: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSeekTo: (seconds: number) => void;
  onFavorite?: () => void;
};

export type NativeMediaSessionState = {
  title: string;
  subtitle?: string;
  album?: string;
  artworkUrl?: string;
  duration: number;
  position: number;
  playing: boolean;
  favorite?: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
  playbackRate?: number;
};

const mediaSession = MediaSession as ExtendedMediaSession;
const nativePlatform = Capacitor.isNativePlatform();

const updateFavoriteNative = async (favorite: boolean) => {
  if (!nativePlatform || !mediaSession.setFavoriteState) return;
  await mediaSession.setFavoriteState({ favorite });
};
const handlersRef: { current: NativeMediaSessionHandlers | null } = { current: null };
const registeredActions = new Set<string>();
let active = false;

const removeAction = (action: MediaSessionAction) => {
  if (mediaSession.removeActionHandler) return mediaSession.removeActionHandler({ action });
  return MediaSession.setActionHandler({ action }, null);
};

export const nativeMediaSessionAvailable = () => nativePlatform;

const bindAction = (action: MediaSessionAction, enabled: boolean, invoke: () => void) => {
  const key = action;
  if (!enabled) {
    if (registeredActions.has(key)) {
      registeredActions.delete(key);
      // Native action handlers are kept alive for their future callback, so
      // their registration promise does not settle until the user presses the
      // notification action. Never let unregistering delay media teardown.
      void removeAction(action).catch(() => undefined);
    }
    return;
  }
  if (registeredActions.has(key)) return;
  // Capacitor's native callback remains pending until Android invokes it.
  // Register it, but publish the playing state immediately so both ordinary
  // and downloaded audio receive the foreground media notification before
  // the WebView can be backgrounded.
  void MediaSession.setActionHandler({ action }, (details) => {
    // Capacitor removes the JavaScript callback after delivering a callback
    // result. Re-register after every native action so notification controls
    // remain responsive for the next press (for example Next then Previous).
    registeredActions.delete(key);
    if (action === "seekto") {
      const seekTime = details.seekTime;
      if (typeof seekTime === "number" && Number.isFinite(seekTime)) handlersRef.current?.onSeekTo(seekTime);
    } else {
      invoke();
    }
    window.setTimeout(() => {
      if (active && handlersRef.current && !registeredActions.has(key)) bindAction(action, true, invoke);
    }, 0);
  }).catch(() => registeredActions.delete(key));
  registeredActions.add(key);
};

const ensureHandlers = async (handlers: NativeMediaSessionHandlers, state: NativeMediaSessionState) => {
  handlersRef.current = handlers;
  await bindAction("play", true, () => handlersRef.current?.onPlay());
  await bindAction("pause", true, () => handlersRef.current?.onPause());
  await bindAction("seekbackward", true, () => handlersRef.current?.onSeekBackward());
  await bindAction("seekforward", true, () => handlersRef.current?.onSeekForward());
  await bindAction("seekto", state.duration > 0, () => undefined);
  await bindAction("previoustrack", state.hasPrevious, () => handlersRef.current?.onPrevious());
  await bindAction("nexttrack", state.hasNext, () => handlersRef.current?.onNext());
  if (handlers.onFavorite) {
    await bindAction("favorite", true, () => handlersRef.current?.onFavorite?.());
  } else if (registeredActions.has("favorite")) {
    await removeAction("favorite");
    registeredActions.delete("favorite");
  }
};

export const syncNativeMediaSession = async (handlers: NativeMediaSessionHandlers, state: NativeMediaSessionState) => {
  if (!nativePlatform) return;
  const hasMedia = state.duration > 0 || state.playing || state.position > 0;
  if (!hasMedia && !state.title) {
    await clearNativeMediaSession();
    return;
  }
  active = true;
  await ensureHandlers(handlers, state);
  await MediaSession.setMetadata({
    title: state.title,
    artist: state.subtitle ?? "TMS",
    album: state.album,
    artwork: state.artworkUrl ? [{ src: state.artworkUrl }] : undefined,
  });
  await MediaSession.setPlaybackState({
    playbackState: state.playing ? "playing" : state.duration > 0 || state.position > 0 ? "paused" : "none",
  });
  if (state.duration > 0) {
    await MediaSession.setPositionState({
      duration: state.duration,
      position: state.position,
      playbackRate: state.playbackRate ?? 1,
    });
  }
  await updateFavoriteNative(Boolean(state.favorite));
};

export const clearNativeMediaSession = async () => {
  if (!nativePlatform || !active) return;
  active = false;
  handlersRef.current = null;
  await MediaSession.setPlaybackState({ playbackState: "none" });
  await Promise.all([...registeredActions].map((action) => removeAction(action as MediaSessionAction)));
  registeredActions.clear();
};
