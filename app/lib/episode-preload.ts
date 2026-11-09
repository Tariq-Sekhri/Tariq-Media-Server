import type { FragmentLoaderContext, HlsConfig, Loader, LoaderCallbacks, LoaderConfiguration, LoaderContext } from "hls.js";

export type AudioTrack = { stream_index: number; label: string; language: string; is_default: boolean };
export type VideoInfo = { source_height: number; video_codec?: string | null; video_profile?: string | null; levels: number[]; audio_compatible: boolean; audio_codec: string | null; duration?: number; audio_tracks: AudioTrack[] };

// Audio support alone does not imply that the browser can decode the video.
export const canDirectPlayVideo = (info: VideoInfo, video: Pick<HTMLMediaElement, "canPlayType"> | null) => {
  if (!info.video_codec || !video) return true;
  const codec = info.video_codec.toLowerCase();
  if (codec === "hevc" || codec === "h265") {
    const profile = info.video_profile?.toLowerCase().includes("10") ? "2.4" : "1.6";
    return !!video.canPlayType(`video/mp4; codecs="hvc1.${profile}.L153.B0"`);
  }
  const mime = ({ h264: 'video/mp4; codecs="avc1.640028"', vp8: 'video/webm; codecs="vp8"', vp9: 'video/webm; codecs="vp9"', av1: 'video/mp4; codecs="av01.0.08M.08"' } as Record<string, string>)[codec];
  return mime ? !!video.canPlayType(mime) : false;
};

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
