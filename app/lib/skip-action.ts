// Hunter x Hunter's ending is followed by a next-episode preview. A deliberate
// ending skip should finish this episode and start the next one instead.
export const endingSkipAdvancesEpisode = (
  show: { imdbId?: string; series?: string; folder: string },
  kind: string,
) => {
  if (kind !== "credits" && kind !== "preview") return false;
  if (show.imdbId?.toLowerCase() === "tt2098220") return true;
  // Release folders can carry tags and episode ranges, and catalog metadata
  // can temporarily identify the movie bundled alongside the series.
  return (show.series || show.folder).replace(/\\/g, "/").split("/").some((part) => {
    const title = part.replace(/\[[^\]]*\]/g, "").trim();
    return /^hunter\s*[x×]\s*hunter\s*\(2011\)(?:\s*\(complete series\s*\+\s*movies\)|\s*-\s*episodes\s+\d+-\d+)?$/i.test(title)
      || (!show.imdbId && /^hunter\s*[x×]\s*hunter$/i.test(title));
  });
};
