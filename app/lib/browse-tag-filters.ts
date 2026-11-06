import type { MediaItem } from "./media";

export function browseTagFilters(items: Pick<MediaItem, "tags">[], showFavorites: boolean) {
  const counts = new Map<string, number>();
  for (const item of items) {
    for (const tag of new Set(item.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const distinguishing = [...counts]
    .filter(([, count]) => count > 0 && count < items.length)
    .sort(([left, leftCount], [right, rightCount]) => rightCount - leftCount || left.localeCompare(right));
  const mediaTypes = ["Video", "Photos", "Audio", "File"].filter((tag) => distinguishing.some(([name]) => name === tag));
  const base = ["All", ...(showFavorites ? ["Favorites"] : []), ...mediaTypes];
  return {
    filters: [...base, ...distinguishing.filter(([tag]) => !base.includes(tag)).slice(0, 8).map(([tag]) => tag)],
    commonTags: new Set([...counts].filter(([, count]) => count === items.length).map(([tag]) => tag)),
  };
}
