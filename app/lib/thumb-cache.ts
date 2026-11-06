type ThumbCacheEntry = {
  frameSrc?: string;
  aspectRatio?: number;
};

const MAX_ENTRIES = 200;
const cache = new Map<string, ThumbCacheEntry>();

const touchEntry = (path: string): ThumbCacheEntry => {
  const existing = cache.get(path);
  if (existing) {
    cache.delete(path);
    cache.set(path, existing);
    return existing;
  }
  const entry: ThumbCacheEntry = {};
  cache.set(path, entry);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    cache.delete(oldest);
  }
  return entry;
};

export const readCachedThumbFrame = (path: string): string | null => {
  const value = cache.get(path)?.frameSrc;
  if (!value) return null;
  touchEntry(path);
  return value;
};

export const writeCachedThumbFrame = (path: string, frameSrc: string) => {
  touchEntry(path).frameSrc = frameSrc;
};

export const readCachedAspectRatio = (path: string): number | null => {
  const value = cache.get(path)?.aspectRatio;
  if (value === undefined) return null;
  touchEntry(path);
  return value;
};

export const writeCachedAspectRatio = (path: string, aspectRatio: number) => {
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) return;
  touchEntry(path).aspectRatio = aspectRatio;
};

export const clearCachedThumbFrame = (path: string) => {
  cache.delete(path);
};
