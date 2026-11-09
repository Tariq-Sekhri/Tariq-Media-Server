export const isActiveWork = (status: string) => ["running", "downloading", "scanning library"].includes(status);
export const workProgress = (status: string, progress: number | null) => status === "scanning library" ? null : progress;
export const isFinishedWork = (status: string) => ["complete", "completed", "finished with errors"].includes(status);
export const needsWorkAttention = (status: string) => ["failed", "interrupted", "finished with errors", "status unavailable"].includes(status);

export function workTitle(title: string, kind: string, destinationPath?: string | null): string {
  if (kind === "magnet download" && /^Magnet [a-f0-9]+$/i.test(title) && destinationPath) {
    const folders = destinationPath.split(/[\\/]/).filter(Boolean);
    const name = (/^season\s*\d+/i.test(folders.at(-1) || "") ? folders.slice(-2) : folders.slice(-1))
      .map((folder) => folder.replace(/^(?:\[[^\]]+\]\s*)+/, "").trim() || folder)
      .join(" / ");
    if (name) return name;
  }
  return /transcode|playback|remux|thumbnail|preview/i.test(kind) ? title.split(/[\\/]/).pop() || title : title;
}
