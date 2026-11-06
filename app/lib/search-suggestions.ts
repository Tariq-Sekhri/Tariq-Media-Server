import { supportedFormats, type MediaItem } from "./media";
import { fuzzyMatches, matchesSearchQuery, parseSearchQuery, searchCompletionContext, searchFields, type SearchField } from "./search";

export type SuggestionKind = "search" | "filter" | "tag" | "folder" | "media";
export type SearchSuggestion = { id: string; label: string; detail: string; kind: SuggestionKind; item?: MediaItem; path?: string; value?: string; field?: SearchField };
type SuggestionUser = { name: string; is_admin: boolean };
type SuggestionLibraries = Record<string, { members: { name: string; can_view: boolean }[] }>;
// Match the server's eq_ignore_ascii_case membership comparison.
const memberNameKey = (name: string) => name.replace(/[A-Z]/g, (letter) => letter.toLowerCase());

export function canSuggestLibraryPath(path: string | undefined, libraries: SuggestionLibraries, user: SuggestionUser | null): boolean {
  if (!user || !path) return false;
  const parts = path.replace(/\\/g, "/").split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return false;
  const root = parts[0];
  if (!Object.hasOwn(libraries, root)) return false;
  return user.is_admin || libraries[root].members.some((member) => member.can_view && memberNameKey(member.name) === memberNameKey(user.name));
}

export function searchSuggestionItemPath(item: MediaItem): string | undefined {
  // Offline browse metadata can be recovered by basename across libraries.
  // It is not an authorization identity for shared search suggestions.
  if (item.offline) return undefined;
  const path = (item.path || (item.parent ? `${item.parent}/${item.name}` : item.kind === "folder" ? item.name : undefined))?.replace(/\\/g, "/");
  // An inconsistent cached parent must not publish a different library's name.
  if (item.path && item.parent && item.parent.replace(/\\/g, "/") !== path?.split("/").slice(0, -1).join("/")) return undefined;
  return path;
}

function canSuggestSearchHistory(query: string, items: MediaItem[], libraries: SuggestionLibraries, user: SuggestionUser | null): boolean {
  if (!user) return false;
  const atoms = parseSearchQuery(query).groups.flat();
  const types = ["video", "movie", "clip", "picture", "pic", "image", "photo", "photograph", "audio", "music", "sound", "song", "folder", "directory", "file", "document"];
  const formats: string[] = [...supportedFormats.video, ...supportedFormats.audio, ...supportedFormats.image];
  const statuses = ["favorite", "recent", "played", "trashed", "deleted"];
  // Check each positive value separately: OR and negation must not hide a
  // revoked location or title inside an otherwise matching saved query.
  return atoms.length > 0 && atoms.every((atom) => {
    const value = atom.value.toLowerCase();
    if (atom.field === "type") return types.includes(value) || formats.includes(value.replace(/^\./, ""));
    if (atom.field === "format") return formats.includes(value.replace(/^\./, ""));
    if (atom.field === "is") return statuses.includes(value);
    if (atom.field === "in") {
      return Object.keys(libraries).some((path) => canSuggestLibraryPath(path, libraries, user) && path.toLowerCase() === value)
        || items.some((item) => {
          const path = searchSuggestionItemPath(item);
          return (item.kind === "folder" ? path : path?.split("/").slice(0, -1).join("/"))?.toLowerCase().includes(value);
        });
    }
    if (atom.field === "tag" || value.startsWith("#")) return items.some((item) => !item.trashed && item.tags.some((tag) => tag.toLowerCase().includes(value.replace(/^#/, ""))));
    return items.some((item) => !item.trashed && item.name.toLowerCase().includes(value));
  });
}

export function buildSearchSuggestions({ query, caret = query.length, items, libraries, user, previousSearches = [], recentFolders = [] }: {
  query: string; caret?: number; items: MediaItem[]; libraries: SuggestionLibraries; user: SuggestionUser | null; previousSearches?: string[]; recentFolders?: string[];
}): SearchSuggestion[] {
  const context = searchCompletionContext(query, caret);
  const sources = items.filter((item) => canSuggestLibraryPath(searchSuggestionItemPath(item), libraries, user));
  const counts = new Map<string, number>();
  const seenPaths = new Set<string>();
  for (const item of sources) {
    if (item.trashed || seenPaths.has(searchSuggestionItemPath(item)!)) continue;
    seenPaths.add(searchSuggestionItemPath(item)!);
    for (const tag of new Set(item.tags)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  const tagStats = [...counts].map(([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  if (context.field) {
    const field = context.field;
    let values: string[] = [];
    if (field === "in") {
      const locations = new Set(Object.keys(libraries).filter((path) => canSuggestLibraryPath(path, libraries, user)));
      for (const item of sources.filter((item) => !item.trashed)) {
        const sourcePath = searchSuggestionItemPath(item);
        const path = item.kind === "folder" ? sourcePath : sourcePath?.split("/").slice(0, -1).join("/");
        path?.split("/").forEach((_, index, parts) => locations.add(parts.slice(0, index + 1).join("/")));
      }
      values = [...locations].sort((a, b) => a.localeCompare(b));
    } else if (field === "tag") values = tagStats.map((tag) => tag.name);
    else if (field === "type") values = ["video", "image", "audio", "folder", "file"];
    else if (field === "format") values = [...supportedFormats.video, ...supportedFormats.audio, ...supportedFormats.image];
    else if (field === "is") values = ["favorite", "recent", "trashed"];
    else values = [...new Set(sources.filter((item) => !item.trashed).map((item) => item.name))];
    return values.filter((value) => !context.value || value.toLowerCase().includes(context.value.toLowerCase()))
      .slice(0, 22).map((value) => ({ id: `filter-${field}-${value}`, label: field === "in" ? value.split("/").at(-1) ?? value : value,
        detail: field === "in" ? value : `${field}: ${value}`, kind: "filter", value, field }));
  }
  const suggestions: SearchSuggestion[] = [];
  const seen = new Set<string>();
  const add = (suggestion: SearchSuggestion) => {
    const key = `${suggestion.kind}:${suggestion.value ?? suggestion.label}`.toLowerCase();
    if (!seen.has(key)) { seen.add(key); suggestions.push(suggestion); }
  };
  const isTagSearch = /^#[^\s&/]*$/.test(query.trim());
  if (isTagSearch) {
    const term = query.trim().slice(1);
    tagStats.filter((tag) => !term || fuzzyMatches(term, tag.name)).forEach((tag) => add({ id: `tag-${tag.name}`, label: tag.name, detail: `Tag - ${tag.count} items`, kind: "tag" }));
  } else {
    searchFields.filter((filter) => !context.value || filter.field.startsWith(context.value.toLowerCase()))
      .forEach((filter) => add({ id: `field-${filter.field}`, label: filter.label, detail: filter.detail, kind: "filter", value: `${filter.field}:` }));
    previousSearches.filter((search) => canSuggestSearchHistory(search, sources, libraries, user) && (!query.trim() || fuzzyMatches(query, search))).slice(0, 3)
      .forEach((search) => add({ id: `search-${search}`, label: search, detail: "Recent search", kind: "search" }));
    if (!query.trim()) {
      tagStats.slice(0, 5).forEach((tag) => add({ id: `tag-${tag.name}`, label: tag.name, detail: `Popular tag - ${tag.count} items`, kind: "tag" }));
      recentFolders.filter((path) => canSuggestLibraryPath(path, libraries, user)).slice(0, 4).forEach((path) => add({ id: `folder-${path}`, label: path.split("/").at(-1) ?? path, detail: path, kind: "folder", path }));
    }
    if (query.trim()) {
      const searchesTrash = parseSearchQuery(query).filters.is.some((value) => fuzzyMatches(value, "trashed") || fuzzyMatches(value, "deleted"));
      sources.filter((item) => (!item.trashed || searchesTrash) && matchesSearchQuery(item, query)).forEach((item) => {
        const path = item.kind === "folder" ? searchSuggestionItemPath(item) : undefined;
        const parent = searchSuggestionItemPath(item)?.split("/").slice(0, -1).join("/");
        add({ id: `item-${item.id}`, label: item.name, detail: `${item.kind.toUpperCase()} - ${parent || "My library"}`, kind: item.kind === "folder" ? "folder" : "media", item, path });
      });
    }
  }
  const order: SuggestionKind[] = ["filter", "search", "tag", "folder", "media"];
  return suggestions.slice(0, 22).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}
