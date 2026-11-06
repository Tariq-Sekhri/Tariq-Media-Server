"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type FormEvent,
} from "react";
import { authFetch } from "./lib/auth";
import { API_BASE } from "./lib/media";

const DOWNLOAD_POLL_INTERVAL_MS = 2_000;
const SAFETY_STATUS_TIMEOUT_MS = 10_000;
const SAFETY_PREPARE_TIMEOUT_MS = 28_000;

const withTimeout = async <T,>(operation: Promise<T>, timeoutMs: number, message: string): Promise<T> => {
  let timeout: number | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeout = window.setTimeout(() => reject(new Error(message)), timeoutMs);
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
  }
};

type MagnetSafetyCheck = {
  id: string;
  label: string;
  ready: boolean;
  detail: string;
};

type MagnetDownload = {
  hash: string;
  name: string;
  state: string;
  progress: number;
  download_speed: number;
  upload_speed: number;
  eta: number;
  completed: number;
  total: number;
  amount_left: number;
  added_on: number;
  complete: boolean;
  stopped: boolean;
};

type MagnetStatus = {
  configured: boolean;
  connected: boolean;
  vpn_connected: boolean;
  binding_verified: boolean;
  ready: boolean;
  required_interface: string | null;
  bound_interface: string | null;
  message: string;
  checks: MagnetSafetyCheck[];
  downloads: MagnetDownload[];
};

type MagnetDownloaderProps = {
  destination?: string;
  destinations?: string[];
  initialMagnetLink?: string;
  activeDownloadHash?: string;
  onClose: () => void;
};

const formatBytes = (bytes: number) => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** unit;
  return `${value.toFixed(value >= 100 || unit === 0 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
};

const formatRate = (bytesPerSecond: number) =>
  bytesPerSecond > 0 ? `${formatBytes(bytesPerSecond)}/s` : "Waiting";

const formatEta = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds >= 8_640_000) return "Calculating";
  const rounded = Math.ceil(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${remainder}s`;
  return `${remainder}s`;
};

const magnetInfoHash = (value: string) => {
  try {
    const exactTopic = new URL(value.trim()).searchParams.getAll("xt")
      .find((topic) => topic.toLowerCase().startsWith("urn:btih:"));
    const hash = exactTopic?.slice("urn:btih:".length) ?? "";
    return /^[a-f0-9]{40}$/i.test(hash) ? hash.toLowerCase() : null;
  } catch {
    return null;
  }
};

const torrentStateLabel = (download?: MagnetDownload) => {
  if (!download) return "Starting";
  if (download.complete && download.stopped) return "Complete · stopped";
  const state = download.state.toLowerCase();
  if (state.includes("meta")) return "Fetching metadata";
  if (state.includes("check")) return "Checking files";
  if (state.includes("stall")) return "Waiting for peers";
  if (state.includes("queue")) return "Queued";
  if (state.includes("error") || state.includes("missing")) return "Needs attention";
  if (state.includes("download") || state.includes("forceddl")) return "Downloading";
  if (state.includes("stopped") || state.includes("paused")) return "Stopped";
  return download.state || "Starting";
};

export default function MagnetDownloader({ destination, destinations = [], initialMagnetLink = "", activeDownloadHash, onClose }: MagnetDownloaderProps) {
  const destinationOptions = useMemo(() => {
    const paths = destination ? [destination, ...destinations] : destinations;
    return paths.filter((path, index) => path && paths.indexOf(path) === index);
  }, [destination, destinations]);
  const [selectedDestination, setSelectedDestination] = useState(() => destinationOptions[0] ?? "");
  const [magnetLink, setMagnetLink] = useState(() => initialMagnetLink);
  const [status, setStatus] = useState<MagnetStatus | null>(null);
  const [activeHash, setActiveHash] = useState<string | null>(activeDownloadHash ?? null);
  const [queued, setQueued] = useState(false);
  const [preparing, setPreparing] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [requestError, setRequestError] = useState("");
  const [statusError, setStatusError] = useState("");
  const requestedHash = useMemo(() => magnetInfoHash(magnetLink), [magnetLink]);
  const effectiveDestination = destinationOptions.includes(selectedDestination)
    ? selectedDestination
    : destinationOptions[0] ?? "";

  const loadStatus = useCallback(async (quiet = true) => {
    if (!quiet) setPreparing(true);
    try {
      const result = await withTimeout((async () => {
        const response = await authFetch(`${API_BASE}/api/downloads/magnet?check_route=true`);
        if (!response.ok) throw new Error(`Safety check returned ${response.status}`);
        return await response.json() as MagnetStatus;
      })(), SAFETY_STATUS_TIMEOUT_MS, "The safety status check timed out.");
      setStatus(result);
      setStatusError("");
    } catch (error) {
      // A background refresh timing out does not mean the previously verified
      // route became unsafe. Keep that snapshot until the server reports an
      // actual failed check; magnet submission performs its own route check.
      const message = error instanceof Error ? error.message : "Could not check the secure download route";
      setStatusError(message);
      if (!quiet) {
        setStatus((current) => current ? {
          ...current,
          ready: false,
          message: "The secure route could not be verified.",
        } : current);
      }
    } finally {
      if (!quiet) setPreparing(false);
    }
  }, []);

  const prepare = useCallback(async () => {
    setPreparing(true);
    setRequestError("");
    try {
      const result = await withTimeout((async () => {
        const response = await authFetch(`${API_BASE}/api/downloads/magnet/prepare`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ destination_path: effectiveDestination }),
        });
        const prepared = await response.json() as MagnetStatus & { message?: string };
        if (!response.ok) throw new Error(prepared.message || `Preparation returned ${response.status}`);
        return prepared;
      })(), SAFETY_PREPARE_TIMEOUT_MS, "The safety check timed out. Check qBittorrent, then retry.");
      setStatus(result);
      setStatusError("");
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "Could not prepare the secure download route");
      // Preparation can fail for reasons unrelated to the three safety checks
      // (for example, a stale destination). Fetch their actual state instead of
      // rendering every check as failed.
      await loadStatus(true);
    } finally {
      setPreparing(false);
    }
  }, [effectiveDestination, loadStatus]);

  useEffect(() => {
    const timeout = window.setTimeout(() => void prepare(), 0);
    return () => window.clearTimeout(timeout);
  }, [prepare]);

  useEffect(() => {
    if (preparing) return;
    let cancelled = false;
    let timeout: number | undefined;
    const poll = async () => {
      await loadStatus(true);
      if (!cancelled) timeout = window.setTimeout(() => void poll(), DOWNLOAD_POLL_INTERVAL_MS);
    };
    void poll();
    return () => { cancelled = true; if (timeout !== undefined) window.clearTimeout(timeout); };
  }, [loadStatus, preparing]);

  const activeDownload = useMemo(
    () => activeHash ? status?.downloads.find((download) => download.hash === activeHash) : undefined,
    [activeHash, status?.downloads],
  );
  useEffect(() => {
    if (!requestedHash) return;
    const matchingDownload = status?.downloads.find((download) => download.hash.toLowerCase() === requestedHash);
    if (!matchingDownload) return;
    setActiveHash(matchingDownload.hash);
    setQueued(true);
    setRequestError("");
  }, [requestedHash, status?.downloads]);
  useEffect(() => {
    if (activeDownload) setRequestError("");
  }, [activeDownload]);
  const progress = activeDownload?.complete ? 1 : Math.max(0, Math.min(1, activeDownload?.progress ?? 0));
  const percent = Math.round(progress * 100);
  const hasTorrentError = Boolean(activeDownload && /error|missing/i.test(activeDownload.state));
  const canSubmit = Boolean(effectiveDestination && status?.ready && !preparing && magnetLink.trim().toLowerCase().startsWith("magnet:?") && !submitting);
  const displayedChecks = status?.checks ?? [
    { id: "configuration", label: "Local credentials", ready: false, detail: "Waiting for TMS" },
    { id: "vpn", label: "Proton VPN", ready: false, detail: "Waiting for TMS" },
    { id: "qbittorrent", label: "qBittorrent", ready: false, detail: "Waiting for TMS" },
  ];
  const readinessState = status?.ready ? "ready" : status ? "failed" : "checking";
  const readinessTitle = preparing
    ? "Preparing your secure route"
    : status?.ready
      ? "Protected and ready"
      : status
        ? "Waiting for a safe connection"
        : statusError
          ? "TMS backend is unreachable"
          : "Checking the secure route";
  const readinessMessage = status?.message
    ?? statusError
    ?? "TMS is checking Proton VPN and qBittorrent before anything is sent.";

  const queueDownload = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setRequestError("");
    try {
      const response = await authFetch(`${API_BASE}/api/downloads/magnet`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ magnet: magnetLink.trim(), destination_path: effectiveDestination }),
      });
      const result = await response.json() as { queued: boolean; message: string; hash: string | null };
      if (!response.ok || !result.queued) throw new Error(result.message || `Download returned ${response.status}`);
      setActiveHash(result.hash);
      setQueued(true);
      await loadStatus(true);
    } catch (error) {
      setRequestError(error instanceof Error ? error.message : "Could not add this magnet link");
      await loadStatus(true);
    } finally {
      setSubmitting(false);
    }
  };

  const addAnotherMagnet = () => {
    setActiveHash(null);
    setQueued(false);
    setMagnetLink("");
    setRequestError("");
    void prepare();
  };

  return (
    <div className="folder-create-backdrop magnet-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="folder-create-modal magnet-download-modal" role="dialog" aria-modal="true" aria-labelledby="magnet-title">
        <header className="magnet-modal-header">
          <span className={`magnet-lock-mark ${status?.ready ? "ready" : ""}`} aria-hidden="true">⌁</span>
          <div>
            <p>MAGNET DOWNLOAD</p>
            <h2 id="magnet-title">{queued ? activeDownload?.name || "Starting download" : "Ready to download"}</h2>
            <small><span aria-hidden="true">⌂</span>Paste a magnet. TV episodes are sorted into show and season folders automatically.</small>
          </div>
          <button type="button" className="magnet-close" onClick={onClose} aria-label="Minimize magnet downloader">×</button>
        </header>

        <div className="magnet-stepper" aria-label="Download steps">
          <span className={status?.ready ? "done" : "active"}><i>{status?.ready ? "✓" : "1"}</i>Safety</span>
          <b />
          <span className={queued ? "done" : status?.ready ? "active" : ""}><i>{queued ? "✓" : "2"}</i>Magnet</span>
          <b />
          <span className={queued ? "active" : ""}><i>{activeDownload?.complete ? "✓" : "3"}</i>Download</span>
        </div>

        {!queued ? (
          <form onSubmit={queueDownload}>
            <section className={`magnet-readiness ${readinessState}`} aria-live="polite">
              <div className="magnet-readiness-heading">
                <span className={preparing ? "magnet-check-spinner" : ""}>{preparing ? "" : status?.ready ? "✓" : status ? "!" : "?"}</span>
                <div>
                  <b>{readinessTitle}</b>
                  <small>{readinessMessage}</small>
                </div>
                {!status?.ready && <button type="button" onClick={() => void prepare()} disabled={preparing}>{preparing ? "Starting…" : "Retry"}</button>}
              </div>
              <div className="magnet-check-grid">
                {displayedChecks.map((check) => (
                  <div key={check.id} className={status ? (check.ready ? "ready" : "failed") : "checking"}>
                    <i>{status ? (check.ready ? "✓" : "—") : "·"}</i>
                    <span><b>{check.label}</b><small>{check.detail}</small></span>
                  </div>
                ))}
              </div>
            </section>

            <label className="magnet-destination-field">
              <span>Save to</span>
              <select value={effectiveDestination} onChange={(event) => setSelectedDestination(event.target.value)} disabled={destinationOptions.length < 2}>
                {destinationOptions.map((path) => <option key={path} value={path}>{path}</option>)}
              </select>
              {destinationOptions.length < 2 && <small>No subfolders are available in this library yet.</small>}
            </label>

            <label className="magnet-link-field">
              <span>Magnet link</span>
              <input
                type="text"
                value={magnetLink}
                onChange={(event) => {
                  setMagnetLink(event.target.value);
                  setRequestError("");
                }}
                placeholder="magnet:?xt=urn:btih:…"
                spellCheck={false}
                autoFocus
              />
              <small>Sent to local qBittorrent only after these checks pass.</small>
            </label>

            {requestError && <p className="magnet-error" role="alert"><span>!</span>{requestError}</p>}

            <div className="magnet-privacy-note">
              <span aria-hidden="true">◈</span>
              <p><b>Leak-locked by design</b>qBittorrent must be bound to {status?.required_interface ?? "your Proton VPN interface"}. TMS blocks submission if the adapter disconnects or the binding changes.</p>
            </div>

            <div className="folder-create-actions magnet-actions">
              <button type="button" onClick={onClose} disabled={submitting}>Cancel</button>
              <button type="submit" disabled={!canSubmit}>{submitting ? "Sending securely…" : status?.ready ? "Start secure download" : "Waiting for protection"}</button>
            </div>
          </form>
        ) : (
          <div className={`magnet-progress-view ${activeDownload?.complete ? "complete" : ""} ${hasTorrentError ? "error" : ""}`} aria-live="polite">
            <div className="magnet-progress-hero">
              <div
                className="magnet-progress-ring"
                style={{ "--magnet-progress": `${progress * 360}deg` } as CSSProperties}
              >
                <span><strong>{percent}%</strong><small>{activeDownload?.complete ? "DONE" : "DOWNLOADED"}</small></span>
              </div>
              <div>
                <em>{torrentStateLabel(activeDownload)}</em>
                <h3>{activeDownload?.complete ? "Download complete" : activeDownload?.name || "Fetching torrent metadata…"}</h3>
                <p>{activeDownload?.complete
                  ? "TMS stops seeding and automatically sorts recognized TV episodes into their show and season folders."
                  : "The download is running in qBittorrent through Proton VPN. You can close this window safely."}</p>
              </div>
            </div>

            <div className="magnet-progress-track" aria-label={`${percent}% downloaded`}>
              <i style={{ width: `${percent}%` }} />
            </div>
            <div className="magnet-transfer-line">
              <span>{formatBytes(activeDownload?.completed ?? 0)} of {formatBytes(activeDownload?.total ?? 0)}</span>
              <span>{formatBytes(activeDownload?.amount_left ?? 0)} remaining</span>
            </div>

            <div className="magnet-stat-grid">
              <article><span>↓</span><div><small>DOWNLOAD SPEED</small><strong>{formatRate(activeDownload?.download_speed ?? 0)}</strong></div></article>
              <article><span>◷</span><div><small>TIME REMAINING</small><strong>{activeDownload?.complete ? "Finished" : formatEta(activeDownload?.eta ?? 0)}</strong></div></article>
              <article><span>↑</span><div><small>CURRENT UPLOAD</small><strong>{formatRate(activeDownload?.upload_speed ?? 0)}</strong></div></article>
            </div>

            {requestError && <p className="magnet-error" role="alert"><span>!</span>{requestError}</p>}
            {hasTorrentError && <p className="magnet-error" role="alert"><span>!</span>qBittorrent reported a file or transfer error. Open qBittorrent for details.</p>}

            <div className="magnet-progress-footer">
              <span><i className={status?.ready ? "ready" : ""} />{status?.ready ? `Protected by ${status.bound_interface}` : "Secure route interrupted — qBittorrent is leak-locked"}</span>
              <button type="button" onClick={addAnotherMagnet}>Add another magnet</button>
              <button type="button" onClick={() => {
                if (activeDownload?.complete) window.location.reload();
                else onClose();
              }}>{activeDownload?.complete ? "Return to library" : "Run in background"}</button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
