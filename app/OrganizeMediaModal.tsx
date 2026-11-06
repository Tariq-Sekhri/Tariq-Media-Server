"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { createPortal } from "react-dom";
import { authFetch } from "./lib/auth";
import { API_BASE, ancestorTags } from "./lib/media";
import { hydratePendingOfflineChanges, queueOfflineOrganization, queueOfflinePlaylistCreate, readOfflineUserState, readPendingOfflineChanges } from "./lib/offline";
import { applyPendingOrganization, emptyPendingChanges } from "./lib/offline-organization";
import TagInput from "./TagInput";

export type OrganizePlaylist = {
  id: string;
  name: string;
  paths: string[];
  created_at: number;
  updated_at?: number;
};

export type OrganizeTagDefinition = {
  name: string;
  created_at: number;
  updated_at?: number;
};

export type OrganizeUserState = {
  tags?: Record<string, string[]>;
  tag_catalog?: Record<string, OrganizeTagDefinition>;
  playlists?: Record<string, OrganizePlaylist>;
};

export type OrganizeSavedState = {
  tags: Record<string, string[]>;
  tag_catalog: Record<string, OrganizeTagDefinition>;
  playlists: Record<string, OrganizePlaylist>;
};

// Null when the server cannot be reached: the change is saved on this device
// and syncs when the server reconnects, the same as in the library.
const reachServer = async (path: string, init?: RequestInit) => {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return null;
  try {
    return await authFetch(`${API_BASE}${path}`, { ...init, signal: AbortSignal.timeout(8_000) });
  } catch {
    return null;
  }
};

// The last organization state this device saw, with its queued changes.
const readSavedOrganization = async () => {
  const pending = await hydratePendingOfflineChanges().catch(() => readPendingOfflineChanges());
  const saved = await readOfflineUserState<OrganizeUserState>().catch(() => undefined);
  return applyPendingOrganization(saved ?? {}, pending);
};

type OrganizeMediaModalProps = {
  open: boolean;
  path: string;
  name: string;
  onClose: () => void;
  onSaved?: (state: OrganizeSavedState) => void;
};

export default function OrganizeMediaModal({
  open,
  path,
  name,
  onClose,
  onSaved,
}: OrganizeMediaModalProps) {
  const [tags, setTags] = useState<string[]>([]);
  const [playlistIds, setPlaylistIds] = useState<string[]>([]);
  const [playlists, setPlaylists] = useState<Record<string, OrganizePlaylist>>({});
  const [tagCatalog, setTagCatalog] = useState<Record<string, OrganizeTagDefinition>>({});
  const [pathTags, setPathTags] = useState<Record<string, string[]>>({});
  const [inlinePlaylistName, setInlinePlaylistName] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savingPlaylist, setSavingPlaylist] = useState(false);

  useEffect(() => {
    if (!open || !path) return;
    let cancelled = false;
    setLoading(true);
    setError("");
    setInlinePlaylistName("");
    void reachServer("/api/user-state")
      .then(async (response) => {
        if (!response) return readSavedOrganization();
        if (!response.ok) throw new Error(`Server returned ${response.status}`);
        return applyPendingOrganization(await response.json() as OrganizeUserState, readPendingOfflineChanges());
      })
      .then((state) => {
        if (cancelled) return;
        const nextTags = state.tags;
        const nextCatalog = state.tag_catalog;
        const nextPlaylists = state.playlists;
        setPathTags(nextTags);
        setTagCatalog(nextCatalog);
        setPlaylists(nextPlaylists);
        setTags(nextTags[path] ?? []);
        setPlaylistIds(
          Object.values(nextPlaylists)
            .filter((playlist) => playlist.paths.includes(path))
            .map((playlist) => playlist.id),
        );
      })
      .catch((loadError) => {
        if (cancelled) return;
        setError(loadError instanceof Error ? loadError.message : "Could not load tags and playlists");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, path]);

  const allTags = useMemo(
    () => [...new Set([...Object.keys(tagCatalog), ...Object.values(pathTags).flat()])],
    [pathTags, tagCatalog],
  );

  const inherited = useMemo(() => ancestorTags(path, pathTags), [path, pathTags]);

  const sortedPlaylists = useMemo(
    () => Object.values(playlists).sort((left, right) => left.name.localeCompare(right.name)),
    [playlists],
  );

  const createPlaylistInline = async () => {
    const trimmed = inlinePlaylistName.trim();
    if (!trimmed || savingPlaylist) return;
    setSavingPlaylist(true);
    setError("");
    try {
      const response = await reachServer("/api/playlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (response && !response.ok) {
        throw new Error(response.status === 409 ? "A playlist with that name already exists" : `Server returned ${response.status}`);
      }
      const playlist = response
        ? await response.json() as OrganizePlaylist
        : queueOfflinePlaylistCreate(trimmed, Object.values(playlists).map((existing) => existing.name));
      setPlaylists((current) => ({ ...current, [playlist.id]: playlist }));
      setPlaylistIds((current) => [...current, playlist.id]);
      setInlinePlaylistName("");
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : "Could not create playlist");
    } finally {
      setSavingPlaylist(false);
    }
  };

  const saveOrganization = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!path || saving || loading) return;
    const nextTags = tags.map((value) => value.trim()).filter(Boolean);
    setSaving(true);
    setError("");
    try {
      const response = await reachServer("/api/organize", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path, tags: nextTags, playlist_ids: playlistIds }),
      });
      if (response && !response.ok) {
        throw new Error(response.status === 400 ? "Use no more than 20 tags, with 32 characters per tag" : `Server returned ${response.status}`);
      }
      const update = { path, tags: nextTags, playlist_ids: playlistIds, updatedAt: Date.now() };
      const local = applyPendingOrganization({ tags: pathTags, tag_catalog: tagCatalog, playlists }, { ...emptyPendingChanges(), organization: [update] });
      if (!response) queueOfflineOrganization(path, nextTags, playlistIds);
      const stateResponse = response ? await reachServer("/api/user-state") : null;
      const saved: OrganizeSavedState = stateResponse?.ok
        ? applyPendingOrganization(await stateResponse.json() as OrganizeUserState, readPendingOfflineChanges())
        : local;
      onSaved?.(saved);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not organize this item");
    } finally {
      setSaving(false);
    }
  };

  if (!open || typeof document === "undefined") return null;

  return createPortal(
    <div
      className="organize-media-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !saving) onClose();
      }}
    >
      <form className="organize-media-modal" onSubmit={saveOrganization}>
        <div>
          <p>ORGANIZE MEDIA</p>
          <h2>{name}</h2>
          <small>Add searchable tags and choose the playlists that include this item.</small>
        </div>
        {loading ? (
          <p className="organize-media-status">Loading tags and playlists…</p>
        ) : (
          <>
            <div className="organize-field">
              Tags
              <TagInput
                value={tags}
                onChange={(value) => {
                  setTags(value);
                  setError("");
                }}
                allTags={allTags}
                autoFocus
              />
              <small>Start typing to search existing tags, or press Enter to add a new one.</small>
              {inherited.length > 0 && <small>Inherited from parent folders: {inherited.join(", ")}</small>}
            </div>
            <fieldset className="playlist-checklist">
              <legend>Playlists</legend>
              {sortedPlaylists.length ? (
                sortedPlaylists.map((playlist) => (
                  <label key={playlist.id}>
                    <input
                      type="checkbox"
                      checked={playlistIds.includes(playlist.id)}
                      onChange={(event) =>
                        setPlaylistIds((current) =>
                          event.target.checked
                            ? [...current, playlist.id]
                            : current.filter((id) => id !== playlist.id),
                        )
                      }
                    />
                    <span>{playlist.name}</span>
                    <small>
                      {playlist.paths.length} item{playlist.paths.length === 1 ? "" : "s"}
                    </small>
                  </label>
                ))
              ) : (
                <small>No playlists yet. Create one below, then save.</small>
              )}
              <div className="inline-playlist-create">
                <input
                  type="text"
                  value={inlinePlaylistName}
                  onChange={(event) => {
                    setInlinePlaylistName(event.target.value);
                    setError("");
                  }}
                  placeholder="Create a new playlist…"
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      void createPlaylistInline();
                    }
                  }}
                />
                <button
                  type="button"
                  disabled={!inlinePlaylistName.trim() || savingPlaylist}
                  onClick={() => void createPlaylistInline()}
                >
                  ＋
                </button>
              </div>
            </fieldset>
          </>
        )}
        {error && (
          <p className="organize-media-error" role="alert">
            {error}
          </p>
        )}
        <div className="organize-media-actions">
          <button type="button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" disabled={saving || loading}>
            {saving ? "Saving…" : "Save changes"}
          </button>
        </div>
      </form>
    </div>,
    document.body,
  );
}
