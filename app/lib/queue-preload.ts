import type { MediaItem } from "./media";

// Cap speculative direct media by file size; never download the whole queue.
export const QUEUE_PRELOAD_BYTES = 32 * 1024 * 1024;

// A rolling window stays small even when the queue contains thousands of files.
export function nearbyQueueItems(queue: MediaItem[], index: number) {
  return index < 0 ? [] : queue.slice(index + 1, index + 4);
}

export function canBufferQueueVideo(item: MediaItem) {
  // Small clips can be retained in full. Large files keep the existing HLS
  // prefix preparation rather than starting an unbounded direct download.
  return item.kind === "video" && !item.offline && Boolean(item.src)
    && Boolean(item.sizeBytes && item.sizeBytes > 0 && item.sizeBytes <= QUEUE_PRELOAD_BYTES);
}
