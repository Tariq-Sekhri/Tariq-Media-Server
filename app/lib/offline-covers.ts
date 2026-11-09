import { stableId } from "./media";
import type { OfflineFile } from "./offline";

// Save the artwork actually shown for each folder, separately from playable media.
export function offlineFolderCovers(path: string, files: OfflineFile[], source: (path: string) => string | undefined, serverOrigin: string): Record<string, OfflineFile> {
  const folders = new Set([path]);
  for (const file of files) {
    const parts = file.path.split("/");
    for (let index = 1; index < parts.length; index++) {
      const folder = parts.slice(0, index).join("/");
      if (folder === path || folder.startsWith(`${path}/`)) folders.add(folder);
    }
  }
  return Object.fromEntries([...folders].flatMap((folder) => {
    const src = source(folder);
    if (!src) return [];
    const url = new URL(src, serverOrigin);
    if (!['http:', 'https:'].includes(url.protocol)) return [];
    return [[folder, {
      id: `offline-cover-${stableId(folder)}`, path: folder, name: "folder-cover.jpg", kind: "image" as const,
      size: 0, url: url.href, public: url.origin !== new URL(serverOrigin).origin,
      relativePath: `.tms-folder-cover-${stableId(folder)}.jpg`,
    }]];
  }));
}
