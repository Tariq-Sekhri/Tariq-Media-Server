const normalize = (name: string) => name.toLowerCase().replace(/&/g, " and ").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
const releaseNote = /^(?:(?:19|20)\d{2}|(?:bd|blu[- ]?ray|bdrip|web[- .]?dl|webrip|dvdrip|hdtv|hevc|avc|x26[45]|h\.?26[45]|\d{3,4}p|\d+bit|dual[- ]audio|multi[- ]subs|extended(?: edition)?|director'?s cut|remaster(?:ed)?|dubbed|subbed|uncut|unrated)(?:\b.*)?)$/i;

export function catalogTitleQueries(raw: string): string[] {
  let title = raw.replace(/\.(?:mkv|mp4|avi|webm|m4v|mov|ts)$/i, "")
    .replace(/^(?:\s*\[[^\]]+\]\s*)+/, "")
    .replace(/^\s*www\.[\w-]+(?:\.[\w-]+)+\s*[-–—|]+\s*/i, "")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/[._]+/g, " ");
  // A parenthesized release year and everything after it are release details.
  // A leading title such as "1917" must remain a title.
  title = title.replace(/\s+\((?:19|20)\d{2}\).*$/, "")
    .replace(/\(([^()]*)\)/g, (group, inner: string) => releaseNote.test(inner.trim()) ? " " : group)
    .replace(/\s+\b(?:\d{3,4}p|blu[- ]?ray|bdrip|web[- ]?dl|webrip|hevc|x26[45])\b.*$/i, "")
    .replace(/\s+/g, " ").trim();
  const aliases = [...title.matchAll(/\(([^()]+)\)/g)].map((match) => match[1].trim())
    .filter((value) => /\p{L}/u.test(value) && !releaseNote.test(value) && !/^or\b/i.test(value));
  const primary = title.replace(/\([^()]*\)/g, " ").replace(/\s+/g, " ").trim();
  const seen = new Set<string>();
  // Keep numbered titles intact first (for example "Blade Runner 2049").
  // A bare trailing release year is only a lower-priority search fallback.
  const withoutYear = primary.replace(/\s+(?:19|20)\d{2}$/, "");
  return [title, primary, ...aliases, withoutYear].filter((value) => {
    const key = normalize(value);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 4);
}

export function catalogTitleMatches(queries: string[], name: string) {
  const candidate = normalize(name);
  return Boolean(candidate && queries.some((query) => {
    const requested = normalize(query);
    return requested && (requested === candidate || requested.startsWith(`${candidate} `) || candidate.startsWith(`${requested} `));
  }));
}

export async function resolveCatalogTitle<T extends { name: string }>(
  queries: string[], kind: "movie" | "series",
  load: (title: string, kind: "movie" | "series") => Promise<{ status: number; metadata?: T }>,
  allowSeriesFallback = false,
): Promise<T> {
  const kinds: ("movie" | "series")[] = kind === "movie" && allowSeriesFallback ? ["movie", "series"] : [kind];
  for (const type of kinds) {
    for (const title of queries) {
      const result = await load(title, type);
      if (result.status !== 200 && result.status !== 404) throw new Error(`Catalog lookup failed (${result.status})`);
      if (result.metadata && catalogTitleMatches(queries, result.metadata.name)) return result.metadata;
    }
  }
  throw new Error("No matching catalog title");
}
