"use client";

import { useMemo, useState, type FormEvent } from "react";
import MagnetDownloader from "./MagnetDownloader";
import TagInput from "./TagInput";
import { authFetch } from "./lib/auth";
import { API_BASE } from "./lib/media";

export type YtDlpJob = {
  id: string;
  title: string;
  extractor: string;
  mode: "video" | "audio";
  destination_path: string;
  item_count: number | null;
  estimated_bytes: number | null;
  reserved_bytes: number;
  downloaded_bytes: number;
  progress: number;
  speed: string | null;
  eta: string | null;
  current_item: string | null;
  status: string;
  error: string | null;
  user_name?: string;
  process_pid?: number | null;
  created_at?: number;
  updated_at?: number;
};

type Quota = {
  storage_quota_bytes: number | null;
  used_bytes: number;
  reserved_bytes: number;
  available_bytes: number | null;
  unlimited: boolean;
};

type PreviewItem = {
  title: string;
  duration_seconds: number | null;
};

type Inspection = {
  title: string;
  extractor: string;
  item_count: number | null;
  estimated_bytes: number | null;
  estimated_bytes_is_approx: boolean;
  preview_items: PreviewItem[];
  mode: "video" | "audio";
  destination_path: string;
  quota: Quota;
};

type Destination = { path: string; contentType: "mixed" | "movies_tv" | "music" | "files" };

type Playlist = {
  id: string;
  name: string;
  paths: string[];
};

const formatBytes = (bytes: number | null, approx = false) => {
  if (bytes === null) return "Unknown";
  if (bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = `${(bytes / 1024 ** unit).toFixed(unit >= 3 ? 1 : 0)} ${units[unit]}`;
  return approx ? `~${value}` : value;
};

const formatDuration = (seconds: number | null) => {
  if (seconds === null || seconds <= 0) return "Unknown length";
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
};

export default function ServerDownloadDialog({
  destination,
  destinations,
  playlists,
  allTags,
  onClose,
  onQueued,
}: {
  destination: string;
  destinations: Destination[];
  playlists: Record<string, Playlist>;
  allTags: string[];
  onClose: () => void;
  onQueued: (job: YtDlpJob) => void;
}) {
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<"video" | "audio">("video");
  const [selectedDestination, setSelectedDestination] = useState(destination);
  const [inspection, setInspection] = useState<Inspection | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshingCookies, setRefreshingCookies] = useState(false);
  const [error, setError] = useState("");
  const [downloadTags, setDownloadTags] = useState<string[]>([]);
  const [putInFolder, setPutInFolder] = useState(false);
  const [folderMode, setFolderMode] = useState<"new" | "existing">("new");
  const [newFolderName, setNewFolderName] = useState("");
  const [preferredFolderPath, setSelectedFolderPath] = useState("");
  const [saveAsPlaylist, setSaveAsPlaylist] = useState(false);
  const [playlistMode, setPlaylistMode] = useState<"new" | "existing">("new");
  const [newPlaylistName, setNewPlaylistName] = useState("");
  const [preferredPlaylistId, setSelectedPlaylistId] = useState("");
  const [showAllPreviewItems, setShowAllPreviewItems] = useState(false);
  const normalizedDestinations = useMemo(() => {
    const libraryPath = destination.split("/")[0];
    const fallbackType = destinations.find((item) => item.path === libraryPath)?.contentType ?? "mixed";
    const current = destinations.find((item) => item.path === destination)
      ?? { path: destination, contentType: fallbackType };
    return [current, ...destinations].filter(
      (item, index, all) => item.path && all.findIndex((candidate) => candidate.path === item.path) === index,
    );
  }, [destination, destinations]);
  const destinationType = useMemo(
    () => normalizedDestinations.find((item) => item.path === selectedDestination)?.contentType ?? "mixed",
    [normalizedDestinations, selectedDestination],
  );
  const playlistOptions = useMemo(
    () => Object.values(playlists).sort((left, right) => left.name.localeCompare(right.name)),
    [playlists],
  );
  const folderOptions = useMemo(
    () => normalizedDestinations
      .map((item) => item.path)
      .filter((path) => path === selectedDestination || path.startsWith(`${selectedDestination}/`))
      .sort((left, right) => left.split("/").length - right.split("/").length || left.localeCompare(right)),
    [normalizedDestinations, selectedDestination],
  );
  const isMultiItem = (inspection?.item_count ?? 0) > 1;
  const showQuotaDetails = inspection ? !inspection.quota.unlimited : false;
  const previewItems = useMemo(() => {
    if (!inspection) return [];
    const raw = inspection.preview_items
      ?? (inspection as Inspection & { previewItems?: PreviewItem[] }).previewItems;
    return Array.isArray(raw) ? raw : [];
  }, [inspection]);
  const visiblePreviewItems = showAllPreviewItems ? previewItems : previewItems.slice(0, 5);
  const trimmedUrl = url.trim();
  const isMagnetLink = trimmedUrl.toLowerCase().startsWith("magnet:?");

  const selectedFolderPath = folderOptions.includes(preferredFolderPath)
    ? preferredFolderPath : folderOptions[0] ?? selectedDestination;
  const selectedPlaylistId = playlistOptions.some((playlist) => playlist.id === preferredPlaylistId)
    ? preferredPlaylistId : playlistOptions[0]?.id ?? "";

  const acceptInspection = (result: Inspection) => {
    setInspection(result);
    setNewFolderName((current) => current || result.title);
    setNewPlaylistName((current) => current || result.title);
  };

  if (destinationType === "movies_tv") {
    return (
      <MagnetDownloader
        destination={selectedDestination}
        destinations={normalizedDestinations.map((item) => item.path)}
        onClose={onClose}
      />
    );
  }

  if (isMagnetLink) {
    return (
      <MagnetDownloader
        destination={selectedDestination}
        destinations={normalizedDestinations.map((item) => item.path)}
        initialMagnetLink={trimmedUrl}
        onClose={onClose}
      />
    );
  }

  const resetInspection = () => {
    setInspection(null);
    setShowAllPreviewItems(false);
  };

  const isCookieOrAuthError = (msg: string) => {
    const lower = msg.toLowerCase();
    return (
      lower.includes("cookie") ||
      lower.includes("private video") ||
      lower.includes("sign in") ||
      lower.includes("bot verification") ||
      lower.includes("members-only") ||
      lower.includes("403")
    );
  };

  const refreshCookiesAndRetry = async () => {
    setRefreshingCookies(true);
    setError("");
    try {
      const response = await authFetch(`${API_BASE}/api/downloads/yt-dlp/cookies/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ browser: "auto" }),
      });
      const result = (await response.json()) as { success: boolean; message: string };
      if (!result.success) {
        throw new Error(result.message || "Failed to refresh cookies from browser.");
      }
      setBusy(true);
      resetInspection();
      const inspectRes = await authFetch(`${API_BASE}/api/downloads/yt-dlp/inspect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, destination_path: selectedDestination, mode }),
      });
      const inspectResult = (await inspectRes.json()) as Inspection & { message?: string };
      if (!inspectRes.ok) throw new Error(inspectResult.message || "Could not inspect this URL.");
      acceptInspection(inspectResult);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not refresh cookies.");
    } finally {
      setRefreshingCookies(false);
      setBusy(false);
    }
  };

  const inspect = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError("");
    resetInspection();
    try {
      const response = await authFetch(`${API_BASE}/api/downloads/yt-dlp/inspect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, destination_path: selectedDestination, mode }),
      });
      const result = await response.json() as Inspection & { message?: string };
      if (!response.ok) throw new Error(result.message || "Could not inspect this URL.");
      acceptInspection(result);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not inspect this URL.");
    } finally {
      setBusy(false);
    }
  };

  const queue = async () => {
    if (!inspection) return;
    if (putInFolder) {
      if (folderMode === "new" && !newFolderName.trim()) {
        setError("Enter a folder name.");
        return;
      }
      if (folderMode === "existing" && !selectedFolderPath) {
        setError("Choose a folder.");
        return;
      }
    }
    if (saveAsPlaylist) {
      if (playlistMode === "new" && !newPlaylistName.trim()) {
        setError("Enter a playlist name.");
        return;
      }
      if (playlistMode === "existing" && !selectedPlaylistId) {
        setError("Choose a playlist.");
        return;
      }
    }
    setBusy(true);
    setError("");
    try {
      const body: Record<string, unknown> = {
        url,
        destination_path: selectedDestination,
        mode,
        tags: downloadTags,
      };
      if (putInFolder) {
        if (folderMode === "new") {
          body.new_folder_name = newFolderName.trim();
        } else {
          body.folder_path = selectedFolderPath;
        }
      }
      if (saveAsPlaylist) {
        if (playlistMode === "new") {
          body.new_playlist_name = newPlaylistName.trim();
        } else {
          body.playlist_id = selectedPlaylistId;
        }
      }
      const response = await authFetch(`${API_BASE}/api/downloads/yt-dlp`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = await response.json() as YtDlpJob & { message?: string };
      if (!response.ok) throw new Error(result.message || "Could not queue this download.");
      onQueued(result);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not queue this download.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop modal-backdrop-scroll" onMouseDown={onClose}>
      <section className="modal server-download-modal" role="dialog" aria-modal="true" aria-labelledby="server-download-title" onMouseDown={(event) => event.stopPropagation()}>
        <button className="modal-close" type="button" onClick={onClose} aria-label="Close">×</button>
        <div className="modal-icon">↓</div>
        <h2 id="server-download-title">Server download</h2>
        <form onSubmit={inspect}>
            <p>Paste a magnet link or any public URL supported by yt-dlp.</p>
            <label className="field">
              <span>Download link</span>
              <input value={url} onChange={(event) => { setUrl(event.target.value); resetInspection(); }} placeholder="magnet:?… or https://…" autoFocus required />
              <small>Magnet links switch to the secure qBittorrent flow automatically. Other links are inspected with yt-dlp.</small>
            </label>
            <label className="field">
              <span>Current location</span>
              <select value={selectedDestination} onChange={(event) => {
                const nextDestination = event.target.value;
                setSelectedDestination(nextDestination);
                resetInspection();
              }}>
                {normalizedDestinations.filter((item) => item.contentType !== "movies_tv").map((item) => <option key={item.path} value={item.path}>{item.path}</option>)}
              </select>
            </label>
            <label className="field">
              <span>Mode</span>
              <select value={mode} onChange={(event) => { setMode(event.target.value as "video" | "audio"); resetInspection(); }}>
                <option value="video">Best video + audio</option>
                <option value="audio">Audio only</option>
              </select>
            </label>
            {error && (
              <div className="server-download-error-box">
                <p className="form-error">{error}</p>
                {isCookieOrAuthError(error) && (
                  <div style={{ display: "flex", gap: "0.5rem", marginTop: "0.5rem", flexWrap: "wrap", alignItems: "center" }}>
                    <button
                      type="button"
                      disabled={busy || refreshingCookies}
                      onClick={() => void refreshCookiesAndRetry()}
                      style={{ padding: "0.3rem 0.65rem", fontSize: "0.85rem", cursor: "pointer" }}
                    >
                      {refreshingCookies ? "Refreshing cookies…" : "🔄 Refresh Cookies & Retry"}
                    </button>
                    <a href="/admin?section=downloads" className="server-download-cookie-link" target="_blank" rel="noopener noreferrer">
                      🔑 Manage Cookies in Admin →
                    </a>
                  </div>
                )}
              </div>
            )}
            {inspection && (
              <>
                <div className="server-download-inspection">
                  <b>{inspection.title}</b>
                  <span>{inspection.extractor} · {inspection.item_count ?? "Unknown"} item{inspection.item_count === 1 ? "" : "s"}</span>
                  {showQuotaDetails && (
                    <>
                      <span>Estimated size: {formatBytes(inspection.estimated_bytes, inspection.estimated_bytes_is_approx)}</span>
                      <span>Remaining quota: {formatBytes(inspection.quota.available_bytes)}</span>
                    </>
                  )}
                </div>
                {isMultiItem && (
                  <div className="server-download-preview">
                    <span className="server-download-preview-label">Items</span>
                    {previewItems.length > 0 ? (
                      <>
                        <ol className="server-download-preview-list">
                          {visiblePreviewItems.map((item, index) => (
                            <li key={`${item.title}-${index}`}>
                              <b>{item.title}</b>
                              <small>{formatDuration(item.duration_seconds)}</small>
                            </li>
                          ))}
                        </ol>
                        {previewItems.length > 5 && (
                          <button type="button" className="server-download-preview-toggle" onClick={() => setShowAllPreviewItems((current) => !current)}>
                            {showAllPreviewItems ? "Show less" : `Show all ${previewItems.length} items`}
                          </button>
                        )}
                      </>
                    ) : (
                      <p className="server-download-preview-empty">Item details are not available yet. Restart the server if this persists.</p>
                    )}
                  </div>
                )}
              </>
            )}
            <div className="server-download-organize">
              <div className="field">
                <span>Tags when complete</span>
                <TagInput value={downloadTags} onChange={setDownloadTags} allTags={allTags} />
                <small>These tags will be applied to every downloaded file.</small>
              </div>
              <label className="field server-download-checkbox">
                <input
                  type="checkbox"
                  checked={putInFolder}
                  onChange={(event) => setPutInFolder(event.target.checked)}
                />
                <span>Put in folder</span>
              </label>
              {putInFolder && (
                <fieldset className="server-download-playlist-options">
                  <legend>Folder</legend>
                  <label className="server-download-radio">
                    <input
                      type="radio"
                      name="download-folder-mode"
                      checked={folderMode === "new"}
                      onChange={() => setFolderMode("new")}
                    />
                    <span>Create new folder</span>
                  </label>
                  {folderMode === "new" && (
                    <label className="field">
                      <span>Name</span>
                      <input
                        value={newFolderName}
                        onChange={(event) => setNewFolderName(event.target.value)}
                        placeholder="Folder name"
                        maxLength={80}
                      />
                    </label>
                  )}
                  <label className="server-download-radio">
                    <input
                      type="radio"
                      name="download-folder-mode"
                      checked={folderMode === "existing"}
                      onChange={() => setFolderMode("existing")}
                    />
                    <span>Use existing folder</span>
                  </label>
                  {folderMode === "existing" && (
                    <label className="field">
                      <span>Folder</span>
                      <select
                        value={selectedFolderPath}
                        onChange={(event) => setSelectedFolderPath(event.target.value)}
                      >
                        {folderOptions.map((path) => (
                          <option key={path} value={path}>{path}</option>
                        ))}
                      </select>
                    </label>
                  )}
                </fieldset>
              )}
              <label className="field server-download-checkbox">
                <input
                  type="checkbox"
                  checked={saveAsPlaylist}
                  onChange={(event) => setSaveAsPlaylist(event.target.checked)}
                />
                <span>Add to playlist</span>
              </label>
              {saveAsPlaylist && (
                <fieldset className="server-download-playlist-options">
                  <legend>Playlist</legend>
                  <label className="server-download-radio">
                    <input
                      type="radio"
                      name="download-playlist-mode"
                      checked={playlistMode === "new"}
                      onChange={() => setPlaylistMode("new")}
                    />
                    <span>Create new playlist</span>
                  </label>
                  {playlistMode === "new" && (
                    <label className="field">
                      <span>Name</span>
                      <input
                        value={newPlaylistName}
                        onChange={(event) => setNewPlaylistName(event.target.value)}
                        placeholder="Playlist name"
                        maxLength={80}
                      />
                    </label>
                  )}
                  <label className="server-download-radio">
                    <input
                      type="radio"
                      name="download-playlist-mode"
                      checked={playlistMode === "existing"}
                      onChange={() => setPlaylistMode("existing")}
                    />
                    <span>Add to existing playlist</span>
                  </label>
                  {playlistMode === "existing" && (
                    <label className="field">
                      <span>Playlist</span>
                      <select
                        value={selectedPlaylistId}
                        onChange={(event) => setSelectedPlaylistId(event.target.value)}
                        disabled={!playlistOptions.length}
                      >
                        {!playlistOptions.length ? (
                          <option value="">No playlists yet</option>
                        ) : (
                          playlistOptions.map((playlist) => (
                            <option key={playlist.id} value={playlist.id}>{playlist.name}</option>
                          ))
                        )}
                      </select>
                    </label>
                  )}
                </fieldset>
              )}
            </div>
            <div className="modal-actions">
              <button type="button" onClick={onClose}>Cancel</button>
              {!inspection
                ? <button className="primary" type="submit" disabled={busy || !url.trim()}>{busy ? "Inspecting…" : "Analyze link"}</button>
                : <button className="primary" type="button" disabled={busy} onClick={queue}>{busy ? "Queueing…" : "Confirm download"}</button>}
            </div>
        </form>
      </section>
    </div>
  );
}
