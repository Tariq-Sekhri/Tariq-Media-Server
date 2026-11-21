import type { MediaItem } from "./media";

const startupSeconds = 1;
const maxLoading = 2;
type Candidate = { src: string; owner: number; resumeAt: number };
type Preload = Candidate & {
  audio: HTMLAudioElement;
  host: HTMLSpanElement;
  ready: boolean;
  stopWatching: () => void;
};

const wanted = new Map<string, Candidate>();
const preloads = new Map<string, Preload>();
const attempted = new Set<string>();
let resumeQueue: number | undefined;
let viewportOwner: number | undefined;

function removePreload(entry: Preload, keepAudio = false) {
  preloads.delete(entry.src);
  entry.stopWatching();
  if (!keepAudio) {
    entry.audio.removeAttribute("src");
    entry.audio.load();
  }
  entry.host.remove();
}

export function discardPreparedAudio() {
  wanted.clear();
  attempted.clear();
  viewportOwner = undefined;
  if (resumeQueue !== undefined) window.clearTimeout(resumeQueue);
  resumeQueue = undefined;
  for (const entry of preloads.values()) removePreload(entry);
}

function pump() {
  if (resumeQueue !== undefined || document.hidden) return;
  let active = [...preloads.values()].filter((entry) => !entry.ready).length;
  for (const candidate of wanted.values()) {
    if (active >= maxLoading) return;
    if (attempted.has(candidate.src)) continue;
    attempted.add(candidate.src);
    active++;
    start(candidate);
  }
}

function start(candidate: Candidate) {
  const host = document.createElement("span");
  host.hidden = true;
  host.dataset.audioPreload = "loading";
  const audio = document.createElement("audio");
  audio.preload = "metadata";
  host.append(audio);
  document.body.append(host);

  function checkBuffer() {
    if (audio.readyState < 1 || audio.seeking) return;
    const position = candidate.resumeAt > 0 && candidate.resumeAt < audio.duration - 0.25 ? candidate.resumeAt : 0;
    if (Math.abs(audio.currentTime - position) > 0.005) {
      audio.currentTime = position;
      return;
    }
    const end = Number.isFinite(audio.duration) ? Math.min(position + startupSeconds, audio.duration) : position + startupSeconds;
    const enough = Array.from({ length: audio.buffered.length }, (_, i) => i)
      .some((i) => audio.buffered.start(i) <= position + 0.05 && audio.buffered.end(i) >= end - 0.05);
    if (!enough || audio.readyState < 2) return;
    entry.ready = true;
    host.dataset.audioPreload = "ready";
    // A preload level is a browser hint. The browser may already have
    // fetched ahead of this window and decides when to suspend transport.
    audio.preload = "metadata";
    entry.stopWatching();
    pump();
  }

  function fail() {
    removePreload(entry);
    pump();
  }

  function onSuspend() {
    checkBuffer();
    // A metadata request often supplies enough playable media already.
    // Request further buffering only if that request stopped short.
    if (!entry.ready) audio.preload = "auto";
  }

  const events = ["loadedmetadata", "loadeddata", "progress", "seeked", "canplaythrough"];
  const timer = window.setTimeout(fail, 8000);
  const entry: Preload = {
    ...candidate, audio, host, ready: false,
    stopWatching() {
      window.clearTimeout(timer);
      for (const event of events) audio.removeEventListener(event, checkBuffer);
      audio.removeEventListener("suspend", onSuspend);
      audio.removeEventListener("error", fail);
    },
  };
  preloads.set(candidate.src, entry);
  for (const event of events) audio.addEventListener(event, checkBuffer);
  audio.addEventListener("suspend", onSuspend);
  audio.addEventListener("error", fail);
  audio.src = candidate.src;
}

export function setViewportAudio(items: MediaItem[], owner: number, resumeTime: (item: MediaItem) => number) {
  if (viewportOwner !== owner) {
    discardPreparedAudio();
    viewportOwner = owner;
  }
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  const eligible = document.hidden || connection?.saveData ? [] : items;
  const next = new Map<string, Candidate>();
  for (const item of eligible) {
    if (item.kind !== "audio" || item.offline || !item.src) continue;
    const url = new URL(item.src, window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/media/")) continue;
    next.set(url.href, wanted.get(url.href) ?? { src: url.href, owner, resumeAt: resumeTime(item) });
  }

  for (const src of wanted.keys()) {
    if (next.has(src)) continue;
    attempted.delete(src);
    const entry = preloads.get(src);
    if (entry) removePreload(entry);
  }
  wanted.clear();
  for (const [src, candidate] of next) wanted.set(src, candidate);
  pump();
}

export function takePreparedAudio(src: string, owner: number | undefined) {
  const url = new URL(src, window.location.href).href;
  const entry = preloads.get(url);
  if (wanted.has(url)) attempted.add(url);
  const match = entry?.owner === owner && !entry?.audio.error ? entry : undefined;
  if (match) removePreload(match, true);
  // Give the selected audio the connection slots used by speculative loads.
  for (const pending of preloads.values()) {
    if (pending.ready) continue;
    attempted.delete(pending.src);
    removePreload(pending);
  }
  if (resumeQueue !== undefined) window.clearTimeout(resumeQueue);
  resumeQueue = undefined;
  if (wanted.size) resumeQueue = window.setTimeout(() => {
    resumeQueue = undefined;
    pump();
  }, 750);
  return match?.audio;
}
