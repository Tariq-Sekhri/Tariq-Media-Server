// Tags, playlists and favorites edited without a server connection. Changes
// are queued here, replayed onto the last known organization state so the
// offline UI matches what the server will hold, and sent in a fixed order once
// the server is reachable: creations, item organization, deletions, favorites.
// Everything in this module is pure so the same rules run in tests.

export type PendingOrganization = { path: string; tags: string[]; playlist_ids: string[]; updatedAt: number };
export type PendingFavorite = { path: string; favorite: boolean; updatedAt: number };
export type PendingCatalogChange =
  | { type: "create_playlist"; id: string; name: string; updatedAt: number }
  | { type: "delete_playlist"; id: string; updatedAt: number }
  | { type: "create_tag"; name: string; updatedAt: number }
  | { type: "delete_tag"; name: string; updatedAt: number };
export type PendingOfflineChanges = {
  organization: PendingOrganization[];
  favorites: PendingFavorite[];
  catalog: PendingCatalogChange[];
};

export type OrganizationPlaylist = { id: string; name: string; paths: string[]; created_at: number; updated_at?: number };
export type OrganizationTag = { name: string; created_at: number; updated_at?: number };
export type OrganizationState = {
  tags: Record<string, string[]>;
  tag_catalog: Record<string, OrganizationTag>;
  playlists: Record<string, OrganizationPlaylist>;
};

// Playlists created offline use a local id until the server assigns one.
export const OFFLINE_PLAYLIST_PREFIX = "offline-playlist-";
export const isOfflinePlaylistId = (id: string) => id.startsWith(OFFLINE_PLAYLIST_PREFIX);

export const emptyPendingChanges = (): PendingOfflineChanges => ({ organization: [], favorites: [], catalog: [] });

const sameName = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const arrayOf = <T>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];

export const normalizePendingChanges = (value: Partial<Record<keyof PendingOfflineChanges, unknown>> | null | undefined): PendingOfflineChanges => ({
  organization: arrayOf<PendingOrganization>(value?.organization),
  favorites: arrayOf<PendingFavorite>(value?.favorites),
  catalog: arrayOf<PendingCatalogChange>(value?.catalog),
});

export const hasPendingChanges = (pending: PendingOfflineChanges) =>
  pending.organization.length > 0 || pending.favorites.length > 0 || pending.catalog.length > 0;

// The server's rules (normalize_tags and clean_playlist_name). Checking them
// offline keeps a queued change from being rejected after it was shown.
export const cleanTagName = (value: string) => {
  const tag = value.trim().replace(/^#+/, "").trim();
  if (!tag || [...tag].length > 32 || /\p{Cc}/u.test(tag)) return null;
  return tag;
};

export const cleanPlaylistName = (value: string) => {
  const name = value.trim();
  if (!name || [...name].length > 80 || /[/\\]/.test(name) || name === "." || name === ".." || /\p{Cc}/u.test(name)) return null;
  return name;
};

export const withOrganization = (pending: PendingOfflineChanges, update: PendingOrganization): PendingOfflineChanges => ({
  ...pending,
  organization: [...pending.organization.filter((entry) => entry.path !== update.path), update],
  // Using a tag again after deleting it offline restores it.
  catalog: pending.catalog.filter((change) => change.type !== "delete_tag" || !update.tags.some((tag) => sameName(tag, change.name))),
});

export const withoutOrganization = (pending: PendingOfflineChanges, path: string): PendingOfflineChanges => ({
  ...pending,
  organization: pending.organization.filter((entry) => entry.path !== path),
});

export const withFavorite = (pending: PendingOfflineChanges, update: PendingFavorite): PendingOfflineChanges => ({
  ...pending,
  favorites: [...pending.favorites.filter((entry) => entry.path !== update.path), update],
});

export const withoutFavorite = (pending: PendingOfflineChanges, path: string): PendingOfflineChanges => ({
  ...pending,
  favorites: pending.favorites.filter((entry) => entry.path !== path),
});

export const withPlaylistCreated = (pending: PendingOfflineChanges, id: string, name: string, now: number): PendingOfflineChanges => ({
  ...pending,
  catalog: [...pending.catalog, { type: "create_playlist", id, name, updatedAt: now }],
});

export const withPlaylistDeleted = (pending: PendingOfflineChanges, id: string, now: number): PendingOfflineChanges => {
  const createdOffline = pending.catalog.some((change) => change.type === "create_playlist" && change.id === id);
  return {
    ...pending,
    organization: pending.organization.map((entry) => entry.playlist_ids.includes(id)
      ? { ...entry, playlist_ids: entry.playlist_ids.filter((playlistId) => playlistId !== id) }
      : entry),
    // A playlist the server never saw only needs its creation withdrawn.
    catalog: createdOffline
      ? pending.catalog.filter((change) => !(change.type === "create_playlist" && change.id === id))
      : [...pending.catalog.filter((change) => !(change.type === "delete_playlist" && change.id === id)), { type: "delete_playlist", id, updatedAt: now }],
  };
};

export const withTagCreated = (pending: PendingOfflineChanges, name: string, now: number): PendingOfflineChanges => ({
  ...pending,
  catalog: [
    ...pending.catalog.filter((change) => !((change.type === "create_tag" || change.type === "delete_tag") && sameName(change.name, name))),
    { type: "create_tag", name, updatedAt: now },
  ],
});

export const withTagDeleted = (pending: PendingOfflineChanges, name: string, now: number): PendingOfflineChanges => ({
  ...pending,
  organization: pending.organization.map((entry) => entry.tags.some((tag) => sameName(tag, name))
    ? { ...entry, tags: entry.tags.filter((tag) => !sameName(tag, name)) }
    : entry),
  catalog: [
    ...pending.catalog.filter((change) => !((change.type === "create_tag" || change.type === "delete_tag") && sameName(change.name, name))),
    { type: "delete_tag", name, updatedAt: now },
  ],
});

// Show the server state as it will be once every queued change is saved.
// Applying the queue twice gives the same result, so it is safe to replay it
// over a state that already contains some of the changes.
export const applyPendingOrganization = (state: Partial<OrganizationState>, pending: PendingOfflineChanges, nowSeconds = Math.floor(Date.now() / 1000)): OrganizationState => {
  const tags = { ...(state.tags ?? {}) };
  const tagCatalog = { ...(state.tag_catalog ?? {}) };
  const playlists = Object.fromEntries(Object.entries(state.playlists ?? {})
    .map(([id, playlist]) => [id, { ...playlist, paths: [...playlist.paths] }])) as Record<string, OrganizationPlaylist>;
  for (const change of pending.catalog) {
    if (change.type === "create_playlist" && !playlists[change.id]) {
      const created = Math.floor(change.updatedAt / 1000);
      playlists[change.id] = { id: change.id, name: change.name, paths: [], created_at: created, updated_at: created };
    }
    if (change.type === "create_tag" && !Object.keys(tagCatalog).some((tag) => sameName(tag, change.name))) {
      const created = Math.floor(change.updatedAt / 1000);
      tagCatalog[change.name] = { name: change.name, created_at: created, updated_at: created };
    }
  }
  for (const update of pending.organization) {
    if (update.tags.length) tags[update.path] = update.tags;
    else delete tags[update.path];
    update.tags.forEach((tag) => {
      if (!Object.keys(tagCatalog).some((existing) => sameName(existing, tag))) tagCatalog[tag] = { name: tag, created_at: nowSeconds, updated_at: nowSeconds };
    });
    for (const playlist of Object.values(playlists)) {
      const include = update.playlist_ids.includes(playlist.id);
      if (include && !playlist.paths.includes(update.path)) playlist.paths = [...playlist.paths, update.path];
      if (!include) playlist.paths = playlist.paths.filter((path) => path !== update.path);
    }
  }
  for (const change of pending.catalog) {
    if (change.type === "delete_playlist") delete playlists[change.id];
    if (change.type === "delete_tag") {
      Object.keys(tagCatalog).filter((tag) => sameName(tag, change.name)).forEach((tag) => delete tagCatalog[tag]);
      for (const [path, assigned] of Object.entries(tags)) {
        const remaining = assigned.filter((tag) => !sameName(tag, change.name));
        if (remaining.length) tags[path] = remaining;
        else delete tags[path];
      }
    }
  }
  return { tags, tag_catalog: tagCatalog, playlists };
};

type SyncResponse = { ok: boolean; status: number; json(): Promise<unknown> };
export type SyncRequest = (path: string, init?: { method?: string; headers?: Record<string, string>; body?: string }) => Promise<SyncResponse>;

export type PendingSyncResult = {
  // Keys of queued entries that are finished: saved, or rejected for good.
  processed: string[];
  // Offline playlist ids that now have server ids; null means never created.
  playlistIds: Record<string, string | null>;
  organizationSynced: number;
  favoritesSynced: number;
  catalogSynced: number;
};

export const pendingOrganizationKey = (entry: PendingOrganization) => `organization:${entry.path}:${entry.updatedAt}`;
export const pendingFavoriteKey = (entry: PendingFavorite) => `favorite:${entry.path}:${entry.updatedAt}`;
export const pendingCatalogKey = (change: PendingCatalogChange) =>
  `${change.type}:${"id" in change ? change.id : change.name}:${change.updatedAt}`;

// A request the server can never accept is dropped instead of retried forever.
// Network failures, expired sessions and server errors are retried later.
const rejectedForGood = (status: number) => status === 400 || status === 403 || status === 404 || status === 409 || status === 422;

const json = (body: unknown) => ({ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

export const syncPendingChanges = async (pending: PendingOfflineChanges, request: SyncRequest): Promise<PendingSyncResult> => {
  const processed: string[] = [];
  const playlistIds: Record<string, string | null> = {};
  let organizationSynced = 0;
  let favoritesSynced = 0;
  let catalogSynced = 0;
  let serverPlaylists: Record<string, OrganizationPlaylist> | null = null;
  const loadServerPlaylists = async () => {
    if (serverPlaylists) return serverPlaylists;
    const response = await request("/api/user-state");
    if (!response.ok) throw new Error(`Server returned ${response.status}`);
    serverPlaylists = ((await response.json()) as Partial<OrganizationState>).playlists ?? {};
    return serverPlaylists;
  };
  const attempt = async (send: () => Promise<SyncResponse>) => {
    try {
      const response = await send();
      return response.ok ? "saved" : rejectedForGood(response.status) ? "rejected" : "retry";
    } catch {
      return "retry";
    }
  };

  for (const change of pending.catalog) {
    if (change.type === "create_playlist") {
      try {
        const response = await request("/api/playlists", { ...json({ name: change.name }), method: "POST" });
        if (response.ok) {
          playlistIds[change.id] = ((await response.json()) as OrganizationPlaylist).id;
          catalogSynced += 1;
          processed.push(pendingCatalogKey(change));
        } else if (response.status === 409) {
          // Another device already created a playlist with this name: use it.
          const existing = Object.values(await loadServerPlaylists()).find((playlist) => sameName(playlist.name, change.name));
          if (existing) {
            playlistIds[change.id] = existing.id;
            catalogSynced += 1;
            processed.push(pendingCatalogKey(change));
          }
        } else if (rejectedForGood(response.status)) {
          playlistIds[change.id] = null;
          processed.push(pendingCatalogKey(change));
        }
      } catch {
        // Retry with the next sync.
      }
    }
    if (change.type === "create_tag") {
      const result = await attempt(() => request("/api/tags", { ...json({ name: change.name }), method: "POST" }));
      if (result !== "retry") processed.push(pendingCatalogKey(change));
      if (result === "saved") catalogSynced += 1;
    }
  }

  // Playlists whose creation must be retried. Their items wait with them; an
  // offline id with no queued creation can never be saved and is dropped.
  const waiting = new Set(pending.catalog
    .filter((change) => change.type === "create_playlist" && !(change.id in playlistIds))
    .map((change) => "id" in change ? change.id : ""));
  const serverId = (id: string) => isOfflinePlaylistId(id) ? playlistIds[id] ?? null : id;

  for (const update of pending.organization) {
    if (update.playlist_ids.some((id) => waiting.has(id))) continue;
    let ids = update.playlist_ids.map(serverId).filter((id): id is string => Boolean(id));
    const send = () => request("/api/organize", json({ path: update.path, tags: update.tags, playlist_ids: ids }));
    let result = await attempt(send);
    if (result === "rejected" && ids.length) {
      // A playlist deleted on the server since makes the whole update fail.
      // Keep the tags and the playlists that still exist.
      try {
        const existing = await loadServerPlaylists();
        const known = ids.filter((id) => existing[id]);
        if (known.length !== ids.length) {
          ids = known;
          result = await attempt(send);
        }
      } catch {
        result = "retry";
      }
    }
    if (result !== "retry") processed.push(pendingOrganizationKey(update));
    if (result === "saved") organizationSynced += 1;
  }

  for (const change of pending.catalog) {
    if (change.type === "delete_playlist") {
      if (waiting.has(change.id)) continue;
      const id = serverId(change.id);
      // Already gone counts as deleted.
      const result = id === null ? "rejected" : await attempt(() => request(`/api/playlists/${encodeURIComponent(id)}`, { method: "DELETE" }));
      if (result !== "retry") processed.push(pendingCatalogKey(change));
      if (result === "saved") catalogSynced += 1;
    }
    if (change.type === "delete_tag") {
      const result = await attempt(() => request(`/api/tags/${encodeURIComponent(change.name)}`, { method: "DELETE" }));
      if (result !== "retry") processed.push(pendingCatalogKey(change));
      if (result === "saved") catalogSynced += 1;
    }
  }

  for (const update of pending.favorites) {
    const result = await attempt(() => request("/api/favorites", json({ path: update.path, favorite: update.favorite })));
    if (result !== "retry") processed.push(pendingFavoriteKey(update));
    if (result === "saved") favoritesSynced += 1;
  }

  return { processed, playlistIds, organizationSynced, favoritesSynced, catalogSynced };
};

// Remove what a sync finished from the queue as it is now. Changes queued
// while the sync ran stay, and refer to the server ids of new playlists.
export const finishPendingSync = (pending: PendingOfflineChanges, result: Pick<PendingSyncResult, "processed" | "playlistIds">): PendingOfflineChanges => {
  const done = new Set(result.processed);
  const mapId = (id: string) => isOfflinePlaylistId(id) && id in result.playlistIds ? result.playlistIds[id] : id;
  return {
    organization: pending.organization
      .filter((entry) => !done.has(pendingOrganizationKey(entry)))
      .map((entry) => ({ ...entry, playlist_ids: entry.playlist_ids.map(mapId).filter((id): id is string => Boolean(id)) })),
    favorites: pending.favorites.filter((entry) => !done.has(pendingFavoriteKey(entry))),
    catalog: pending.catalog
      .filter((change) => !done.has(pendingCatalogKey(change)))
      .flatMap((change): PendingCatalogChange[] => {
        if (change.type !== "delete_playlist") return [change];
        const id = mapId(change.id);
        return id ? [{ ...change, id }] : [];
      }),
  };
};
