import { supportedFormats, type Kind, type MediaItem } from "./media";

export type SearchField = "in" | "title" | "type" | "format" | "tag" | "is";
type SearchAtom = { field?: SearchField; value: string; negated: boolean };

const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let row = 1; row <= left.length; row += 1) {
    let diagonal = previous[0];
    previous[0] = row;
    for (let column = 1; column <= right.length; column += 1) {
      const above = previous[column];
      previous[column] = Math.min(
        above + 1,
        previous[column - 1] + 1,
        diagonal + (left[row - 1] === right[column - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

export function fuzzyMatches(query: string, candidate: string): boolean {
  const needle = normalize(query);
  const haystack = normalize(candidate);
  if (!needle || haystack.includes(needle)) return true;
  const tolerance = needle.length <= 4 ? 1 : needle.length <= 8 ? 2 : 3;
  return haystack.split(" ").some((word) =>
    editDistance(needle, word) <= tolerance
    || (word.length > needle.length && editDistance(needle, word.slice(0, needle.length)) <= tolerance));
}

const searchTokens = (query: string) => query.match(/!?(?:in|title|type|format|tag|is):!?(?:"(?:\\.|[^"\\])*"?|[^\s&/]*)|!?"(?:\\.|[^"\\])*"?|[&/]|[^\s&/]+/gi) ?? [];

export const searchFields: { field: SearchField; label: string; detail: string }[] = [
  { field: "in", label: "In a location", detail: "in: folder or library" },
  { field: "title", label: "With a title", detail: "title: words in the name" },
  { field: "type", label: "A specific media type", detail: "type: video, image, audio, folder or file" },
  { field: "format", label: "A specific file format", detail: "format: mp4, mp3, jpg and more" },
  { field: "tag", label: "With a tag", detail: "tag: a library tag" },
  { field: "is", label: "By status", detail: "is: favorite, recent or trashed" },
];

// Work on the token at the caret, preserving other filters and title words.
export function searchCompletionContext(query: string, caret = query.length) {
  const tokens = /!?(?:[a-z]+:)?!?(?:"(?:\\.|[^"\\])*"?|[^\s&/]+)/gi;
  for (const match of query.matchAll(tokens)) {
    const start = match.index;
    const end = start + match[0].length;
    if (caret < start || caret > end) continue;
    const prefix = query.slice(start, caret);
    const filter = prefix.match(/^(!?)(in|title|type|format|tag|is):(!?)(.*)$/i);
    return { start, end, field: filter?.[2].toLowerCase() as SearchField | undefined,
      value: (filter?.[4] ?? prefix).replace(/^"|"$/g, "").replace(/\\(["\\])/g, "$1"),
      negation: filter && filter[1] !== filter[3] ? "!" : "" };
  }
  return { start: caret, end: caret, field: undefined, value: "", negation: "" };
}

export function completeSearchToken(query: string, caret: number, value: string, field?: SearchField) {
  const context = searchCompletionContext(query, caret);
  const quoted = /[\s&/"\\]/.test(value) ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"` : value;
  const token = field ? `${context.negation}${field}:${quoted}` : value;
  const before = query.slice(0, context.start);
  const after = query.slice(context.end);
  const separator = before && !/[\s&/]$/.test(before) ? " " : "";
  const suffix = token.endsWith(":") ? "" : " ";
  return { query: `${before}${separator}${token}${suffix}${after.replace(/^\s+/, "")}`, caret: before.length + separator.length + token.length + suffix.length };
}

export function parseSearchQuery(query: string) {
  const filters: Record<SearchField, string[]> = { in: [], title: [], type: [], format: [], tag: [], is: [] };
  const groups: SearchAtom[][] = [[]];
  const text: string[] = [];
  let previousOperator: "and" | "or" = "and";
  let inheritedField: SearchAtom["field"];

  searchTokens(query).forEach((rawToken) => {
    const lowered = rawToken.toLowerCase();
    if (rawToken === "/" || lowered === "or") {
      previousOperator = "or";
      groups.push([]);
      return;
    }
    if (rawToken === "&" || lowered === "and") {
      previousOperator = "and";
      inheritedField = undefined;
      return;
    }

    let token = rawToken;
    let negated = token.startsWith("!");
    if (negated) token = token.slice(1);
    const filterMatch = token.match(/^(in|title|type|format|tag|is):(.*)$/i);
    let field = filterMatch?.[1].toLowerCase() as SearchAtom["field"];
    let value = filterMatch?.[2] ?? token;
    if (value.startsWith("!")) {
      negated = !negated;
      value = value.slice(1);
    }
    value = value.replace(/^"|"$/g, "").replace(/\\(["\\])/g, "$1").trim();
    if (!value) return;

    const inheritableValues = ["video", "movie", "clip", "picture", "pic", "image", "photo", "audio", "music", "sound", "folder", ...supportedFormats.video, ...supportedFormats.audio, ...supportedFormats.image];
    if (!field && previousOperator === "or" && inheritedField && inheritableValues.includes(value.toLowerCase())) field = inheritedField;
    inheritedField = field;

    const atom = { field, value, negated } satisfies SearchAtom;
    groups.at(-1)?.push(atom);
    if (field && !negated) filters[field].push(value);
    if (!field) text.push(value);
    previousOperator = "and";
  });

  return { filters, groups: groups.filter((group) => group.length > 0), text: text.join(" ") };
}

function matchesSearchAtom(item: MediaItem, atom: SearchAtom): boolean {
  const value = atom.value.toLowerCase().replace(/^\./, "");
  const extension = item.name.includes(".") ? item.name.split(".").at(-1)?.toLowerCase() ?? "" : "";
  let matches: boolean;
  if (atom.field === "in") {
    const location = (item.parent ?? item.path?.split("/").slice(0, -1).join("/") ?? "").toLowerCase();
    const requested = atom.value.toLowerCase().replace(/\\/g, "/").replace(/\/$/, "");
    matches = requested.includes("/") ? location === requested || location.startsWith(`${requested}/`)
      : location.split("/").some((part) => part.includes(requested));
  } else if (atom.field === "title") {
    matches = fuzzyMatches(atom.value, item.name);
  } else if (atom.field === "type") {
    const aliases: Record<Kind, string[]> = { video: ["video", "movie", "clip"], image: ["picture", "pic", "image", "photo", "photograph"], audio: ["audio", "music", "sound", "song"], folder: ["folder", "directory"], file: ["file", "document"] };
    matches = aliases[item.kind].some((alias) => fuzzyMatches(value, alias)) || extension === value || (value === "jpg" && extension === "jpeg");
  } else if (atom.field === "format") {
    matches = extension === value || (value === "jpg" && extension === "jpeg");
  } else if (atom.field === "tag") {
    matches = item.kind !== "folder" && item.tags.some((tag) => fuzzyMatches(value, tag));
  } else if (atom.field === "is") {
    matches = fuzzyMatches(value, "favorite") ? Boolean(item.favorite)
      : fuzzyMatches(value, "recent") || fuzzyMatches(value, "played") ? Boolean(item.lastOpenedAt ?? item.lastPlayed)
        : fuzzyMatches(value, "trashed") || fuzzyMatches(value, "deleted") ? Boolean(item.trashed) : false;
  } else if (atom.value.startsWith("#")) {
    matches = item.kind !== "folder" && item.tags.some((tag) => fuzzyMatches(atom.value.slice(1), tag));
  } else {
    matches = fuzzyMatches(atom.value, item.name);
  }
  return atom.negated ? !matches : matches;
}

export function matchesSearchQuery(item: MediaItem, query: string): boolean {
  if (!query.trim()) return true;
  if (/^#[^\s&/]+$/.test(query.trim())) {
    const tagQuery = query.trim().slice(1).trim();
    return item.kind !== "folder" && (!tagQuery || item.tags.some((tag) => fuzzyMatches(tagQuery, tag)));
  }
  const { groups } = parseSearchQuery(query);
  return groups.length === 0 || groups.some((group) => group.every((atom) => matchesSearchAtom(item, atom)));
}
