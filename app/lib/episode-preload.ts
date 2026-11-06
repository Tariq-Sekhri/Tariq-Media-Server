import type { FragmentLoaderContext, HlsConfig, Loader, LoaderCallbacks, LoaderConfiguration, LoaderContext } from "hls.js";

export type AudioTrack = { stream_index: number; label: string; language: string; is_default: boolean };
export type VideoInfo = { source_height: number; levels: number[]; audio_compatible: boolean; audio_codec: string | null; duration?: number; audio_tracks: AudioTrack[] };

export const preferredAudioTrack = (tracks: AudioTrack[], language = "en") => {
  const normalize = (value: string) => ({ eng: "en", english: "en", jpn: "ja", japanese: "ja" }[value.trim().toLowerCase()] ?? value.trim().toLowerCase().split(/[-_]/)[0]);
  return tracks.find((track) => normalize(track.language) === normalize(language))
    ?? tracks.find((track) => normalize(track.language) === "en")
    ?? tracks.find((track) => track.is_default) ?? tracks[0];
};

// Only one upcoming episode's first ten seconds are retained in memory.
export const preloadSegments = (playlist: string, playlistUrl: string, seconds = 10) => {
  let duration = 0;
  let total = 0;
  const urls: string[] = [];
  for (const line of playlist.split(/\r?\n/)) {
    if (line.startsWith("#EXTINF:")) duration = Number.parseFloat(line.slice(8));
    else if (line && !line.startsWith("#") && Number.isFinite(duration) && duration > 0) {
      urls.push(new URL(line, playlistUrl).href);
      total += duration;
      duration = 0;
      if (total >= seconds) break;
    }
  }
  return urls;
};

export const cachedFragmentLoader = (
  BaseLoader: new (config: HlsConfig) => Loader<LoaderContext>,
  fragments: Map<string, ArrayBuffer>,
) => class extends BaseLoader {
  declare context: FragmentLoaderContext | null;
  load(context: FragmentLoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<FragmentLoaderContext>) {
    const data = fragments.get(context.url);
    if (!data || context.rangeStart !== undefined || context.rangeEnd !== undefined) {
      super.load(context, config, callbacks as unknown as LoaderCallbacks<LoaderContext>);
      return;
    }
    this.context = context;
    const now = performance.now();
    Object.assign(this.stats, { loaded: data.byteLength, total: data.byteLength, chunkCount: 1 });
    Object.assign(this.stats.loading, { start: now, first: now, end: now });
    // hls.js may transfer the buffer to its worker. Keep our cached copy intact.
    callbacks.onSuccess({ url: context.url, data: data.slice(0) }, this.stats, context, null);
  }
};
