"use client";

import { useState } from "react";

// Playback, library, server, request, download and error metrics. Client
// events come from /api/client-performance; server events are logged by the
// backend under tms_server::server_metrics; errors are client error reports.

type Props = { lines: string[]; serverLines: string[]; errorLines: string[]; device: string };
type Details = Record<string, unknown>;

const DAY_MS = 86_400_000;
const LATENCY_LIMITS_MS = [50, 100, 250, 500, 1_000, 2_500, 5_000, 10_000];
const STAGE_LABELS: Record<string, string> = {
  pending: "Waiting for approval",
  queued: "Queued",
  searching: "Searching",
  pick: "Waiting for a release pick",
  submitting: "Submitting",
  downloading: "Downloading",
  importing: "Importing",
  partial: "Partly imported",
  failed: "Failed",
};

// String literals are logged quoted (event="x"); other values are bare.
const field = (line: string, key: string) => line.match(new RegExp(`(?:^|\\s)${key}=([^\\s]+)`))?.[1]?.replace(/^"(.*)"$/, "$1");
const parseDetails = (line: string): unknown => {
  const raw = line.match(/\sdetails=(.+)$/)?.[1];
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
};
const lineTime = (line: string) => {
  const match = line.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})?)/);
  return match ? new Date(match[1]).getTime() : 0;
};
const average = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
const percentile = (values: number[], fraction: number) => {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
};
const formatMs = (ms: number) => {
  if (ms < 1_000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1_000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
};
const formatDuration = (seconds: number) => formatMs(seconds * 1_000);
const formatSpeed = (bytesPerSecond: number) => {
  if (!Number.isFinite(bytesPerSecond) || bytesPerSecond <= 0) return "—";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  const unit = Math.min(Math.floor(Math.log(bytesPerSecond) / Math.log(1024)), units.length - 1);
  return `${(bytesPerSecond / 1024 ** unit).toFixed(unit >= 2 ? 1 : 0)} ${units[unit]}`;
};
const percent = (part: number, whole: number) => whole ? `${((part / whole) * 100).toFixed(1)}%` : "—";

function Stat({ label, value, detail, warn }: { label: string; value: string; detail: string; warn?: boolean }) {
  return <div className="admin-metric-card admin-insight-stat">
    <span>{label}</span>
    <strong className={warn ? "warn" : undefined}>{value}</strong>
    <small>{detail}</small>
  </div>;
}

export default function MetricsInsights({ lines, serverLines, errorLines, device }: Props) {
  const [now] = useState(() => Date.now());
  const matchesDevice = (details: Details) => device === "all" || details.device_class === device;

  // Client events.
  const starts: { ok: boolean; reason: string; mode: string; ms: number; intent: boolean }[] = [];
  const sessions: { watchedMs: number; stalls: number; stallMs: number; mode: string }[] = [];
  const firstContent: number[] = [];
  const fullLoads: number[] = [];
  for (const line of lines) {
    const phase = field(line, "phase");
    if (phase !== "video_start" && phase !== "playback_session" && phase !== "library_first_content" && phase !== "library_load_complete") continue;
    const details = parseDetails(line) as Details | null;
    if (!details || !matchesDevice(details)) continue;
    const duration = Number(field(line, "duration_ms"));
    if (phase === "video_start") {
      starts.push({ ok: details.outcome === "success", reason: String(details.reason ?? ""), mode: String(details.mode ?? "direct"), ms: duration, intent: details.intent !== false });
    } else if (phase === "playback_session") {
      sessions.push({ watchedMs: Number(details.watched_ms) || 0, stalls: Number(details.stall_count) || 0, stallMs: Number(details.stall_ms) || 0, mode: String(details.mode ?? "direct") });
    } else if (phase === "library_first_content") {
      if (Number.isFinite(duration)) firstContent.push(duration);
    } else if (typeof details.total_wait_ms === "number") {
      fullLoads.push(details.total_wait_ms);
    }
  }
  const failedStarts = starts.filter((start) => !start.ok);
  const watchedMs = sessions.reduce((sum, session) => sum + session.watchedMs, 0);
  const stallCount = sessions.reduce((sum, session) => sum + session.stalls, 0);
  const stallMs = sessions.reduce((sum, session) => sum + session.stallMs, 0);
  const watchedHours = watchedMs / 3_600_000;
  const modes = ["direct", "hls"].map((mode) => {
    const modeStarts = starts.filter((start) => start.mode === mode);
    const timed = modeStarts.filter((start) => start.ok && start.intent).map((start) => start.ms);
    const modeSessions = sessions.filter((session) => session.mode === mode);
    const modeWatched = modeSessions.reduce((sum, session) => sum + session.watchedMs, 0);
    return {
      mode,
      label: mode === "hls" ? "Transcoded" : "Direct play",
      count: modeStarts.length,
      failed: modeStarts.filter((start) => !start.ok).length,
      average: average(timed),
      p95: percentile(timed, 0.95),
      stallsPerHour: modeWatched ? modeSessions.reduce((sum, session) => sum + session.stalls, 0) / (modeWatched / 3_600_000) : 0,
    };
  }).filter((row) => row.count > 0);

  // Client errors, last 7 days.
  const errors = errorLines
    .map((line) => ({ time: lineTime(line), kind: field(line, "kind") ?? "client-error", screen: (field(line, "route") ?? "/").split(/[?#]/)[0] || "/", message: line.match(/Client error: (.*?) user=/)?.[1] ?? "Unknown error" }))
    .filter((error) => error.time > now - 7 * DAY_MS);
  const countBy = <T,>(items: T[], key: (item: T) => string) => {
    const counts = new Map<string, number>();
    for (const item of items) counts.set(key(item), (counts.get(key(item)) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  };
  const errorsByScreen = countBy(errors, (error) => error.screen).slice(0, 8);
  const topErrors = countBy(errors, (error) => `${error.kind}: ${error.message}`).slice(0, 6);
  const errorsLastDay = errors.filter((error) => error.time > now - DAY_MS).length;

  // Server endpoint timings, merged across logged windows.
  type Endpoint = { route: string; count: number; errors: number; total_ms: number; max_ms: number; buckets: number[] };
  const endpoints = new Map<string, Endpoint>();
  const stageEvents: { id: string; from: string; to: string; at: number; created: number; hash: string }[] = [];
  const downloads: { source: string; id: string; outcome: string; at: number; seconds: number; bytes: number }[] = [];
  for (const line of serverLines) {
    const event = field(line, "event");
    if (event === "endpoint_stats") {
      const windows = parseDetails(line);
      if (!Array.isArray(windows)) continue;
      for (const window of windows as Endpoint[]) {
        const merged = endpoints.get(window.route) ?? { route: window.route, count: 0, errors: 0, total_ms: 0, max_ms: 0, buckets: Array(9).fill(0) };
        merged.count += window.count;
        merged.errors += window.errors;
        merged.total_ms += window.total_ms;
        merged.max_ms = Math.max(merged.max_ms, window.max_ms);
        window.buckets.forEach((count, index) => { merged.buckets[index] += count; });
        endpoints.set(window.route, merged);
      }
    } else if (event === "request_stage") {
      stageEvents.push({ id: field(line, "request_id") ?? "", from: field(line, "from") ?? "", to: field(line, "to") ?? "", at: Number(field(line, "at")) || 0, created: Number(field(line, "created_at")) || 0, hash: field(line, "hash") ?? "-" });
    } else if (event === "download_finished") {
      downloads.push({ source: field(line, "source") ?? "", id: field(line, "id") ?? "", outcome: field(line, "outcome") ?? "", at: Number(field(line, "at")) || 0, seconds: Number(field(line, "duration_s")) || 0, bytes: Number(field(line, "bytes")) || 0 });
    }
  }
  const endpointP95 = (endpoint: Endpoint) => {
    let seen = 0;
    for (let index = 0; index < endpoint.buckets.length; index += 1) {
      seen += endpoint.buckets[index];
      if (seen >= endpoint.count * 0.95) return index;
    }
    return endpoint.buckets.length - 1;
  };
  const endpointRows = [...endpoints.values()]
    .filter((endpoint) => endpoint.count >= 3)
    .sort((a, b) => endpointP95(b) - endpointP95(a) || b.total_ms / b.count - a.total_ms / a.count)
    .slice(0, 12);
  const p95Label = (index: number) => index < LATENCY_LIMITS_MS.length ? `≤ ${formatMs(LATENCY_LIMITS_MS[index])}` : `> ${formatMs(LATENCY_LIMITS_MS[LATENCY_LIMITS_MS.length - 1])}`;

  // Request pipeline: time in each stage, and where requests fail.
  const stages = new Map<string, { durations: number[]; failures: number }>();
  const stage = (name: string) => {
    const entry = stages.get(name) ?? { durations: [], failures: 0 };
    stages.set(name, entry);
    return entry;
  };
  const byRequest = new Map<string, typeof stageEvents>();
  for (const event of stageEvents) byRequest.set(event.id, [...(byRequest.get(event.id) ?? []), event]);
  const downloadByHash = new Map(downloads.filter((download) => download.source === "torrent").map((download) => [download.id, download]));
  const endToEnd: number[] = [];
  let downloadFailures = 0;
  for (const events of byRequest.values()) {
    events.sort((a, b) => a.at - b.at);
    let enteredAt = events[0].from === "new" ? events[0].created || events[0].at : 0;
    for (const event of events) {
      if (event.from !== "new" && enteredAt) stage(event.from).durations.push(event.at - enteredAt);
      if (event.to === "failed" && event.from !== "new") stage(event.from).failures += 1;
      enteredAt = event.at;
      if (event.to === "handed_off" && event.hash !== "-") {
        const download = downloadByHash.get(event.hash);
        if (download?.outcome === "completed" && event.created) endToEnd.push(download.at - event.created);
        else if (download) downloadFailures += 1;
      }
    }
  }
  const stageRows = Object.keys(STAGE_LABELS)
    .filter((name) => name !== "failed" && stages.has(name))
    .map((name) => ({ name, ...stages.get(name)! }));

  // Downloads per day and source, last 14 days.
  const dayKey = (seconds: number) => new Date(seconds * 1_000).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const recentDownloads = downloads.filter((download) => download.at * 1_000 > now - 14 * DAY_MS).sort((a, b) => b.at - a.at);
  const downloadRows: { day: string; source: string; done: number; failed: number; seconds: number[]; speeds: number[] }[] = [];
  for (const download of recentDownloads) {
    const day = dayKey(download.at);
    let row = downloadRows.find((candidate) => candidate.day === day && candidate.source === download.source);
    if (!row) downloadRows.push(row = { day, source: download.source, done: 0, failed: 0, seconds: [], speeds: [] });
    if (download.outcome === "completed") {
      row.done += 1;
      row.seconds.push(download.seconds);
      if (download.seconds > 0 && download.bytes > 0) row.speeds.push(download.bytes / download.seconds);
    } else if (download.outcome !== "cancelled") {
      row.failed += 1;
    }
  }

  return <div className="admin-insights">
    <div className="admin-insight-stats">
      <Stat label="Video start failures" value={percent(failedStarts.length, starts.length)} warn={failedStarts.length > 0}
        detail={starts.length ? `${failedStarts.length} of ${starts.length} · ${failedStarts.filter((start) => start.reason === "timeout").length} timed out` : "No video starts yet"} />
      <Stat label="Buffering" value={watchedHours ? `${(stallCount / watchedHours).toFixed(1)}/h` : "—"} warn={stallCount > 0}
        detail={watchedMs ? `${percent(stallMs, watchedMs + stallMs)} of watch time · ${formatMs(watchedMs)} watched` : "No playback yet"} />
      <Stat label="First content" value={firstContent.length ? formatMs(average(firstContent)) : "—"}
        detail={firstContent.length ? `p95 ${formatMs(percentile(firstContent, 0.95))} · full load ${fullLoads.length ? formatMs(average(fullLoads)) : "—"}` : "No library loads yet"} />
      <Stat label="App errors (7 days)" value={String(errors.length)} warn={errorsLastDay > 0}
        detail={`${errorsLastDay} in the last 24 hours`} />
    </div>

    {modes.length > 0 && <section>
      <h3>Direct play vs transcoded</h3>
      <table className="admin-insight-table">
        <thead><tr><th>Mode</th><th>Starts</th><th>Share</th><th>Failed</th><th>Avg start</th><th>p95 start</th><th>Stalls/h</th></tr></thead>
        <tbody>{modes.map((row) => <tr key={row.mode}>
          <td>{row.label}</td><td>{row.count}</td><td>{percent(row.count, starts.length)}</td><td>{row.failed}</td>
          <td>{row.average ? formatMs(row.average) : "—"}</td><td>{row.p95 ? formatMs(row.p95) : "—"}</td><td>{row.stallsPerHour.toFixed(1)}</td>
        </tr>)}</tbody>
      </table>
    </section>}

    {endpointRows.length > 0 && <section>
      <h3>Server response times</h3>
      <table className="admin-insight-table">
        <thead><tr><th>Endpoint</th><th>Requests</th><th>Errors</th><th>Avg</th><th>p95</th><th>Max</th></tr></thead>
        <tbody>{endpointRows.map((row) => <tr key={row.route}>
          <td className="admin-insight-route">{row.route}</td><td>{row.count.toLocaleString()}</td><td className={row.errors ? "warn" : undefined}>{row.errors}</td>
          <td>{formatMs(row.total_ms / row.count)}</td><td>{p95Label(endpointP95(row))}</td><td>{formatMs(row.max_ms)}</td>
        </tr>)}</tbody>
      </table>
    </section>}

    {(stageRows.length > 0 || endToEnd.length > 0) && <section>
      <h3>Requests</h3>
      {endToEnd.length > 0 && <p className="admin-insight-note">Request to ready: avg {formatDuration(average(endToEnd))} · p95 {formatDuration(percentile(endToEnd, 0.95))} · {endToEnd.length} finished{downloadFailures ? ` · ${downloadFailures} download${downloadFailures === 1 ? "" : "s"} failed` : ""}</p>}
      {stageRows.length > 0 && <table className="admin-insight-table">
        <thead><tr><th>Stage</th><th>Requests</th><th>Avg time</th><th>p95 time</th><th>Failed here</th></tr></thead>
        <tbody>{stageRows.map((row) => <tr key={row.name}>
          <td>{STAGE_LABELS[row.name]}</td><td>{row.durations.length}</td>
          <td>{row.durations.length ? formatDuration(average(row.durations)) : "—"}</td><td>{row.durations.length ? formatDuration(percentile(row.durations, 0.95)) : "—"}</td>
          <td className={row.failures ? "warn" : undefined}>{row.failures}</td>
        </tr>)}</tbody>
      </table>}
    </section>}

    {downloadRows.length > 0 && <section>
      <h3>Downloads</h3>
      <table className="admin-insight-table">
        <thead><tr><th>Day</th><th>Source</th><th>Finished</th><th>Failed</th><th>Avg time</th><th>Avg speed</th></tr></thead>
        <tbody>{downloadRows.map((row) => <tr key={`${row.day}-${row.source}`}>
          <td>{row.day}</td><td>{row.source === "ytdlp" ? "yt-dlp" : "Torrent"}</td><td>{row.done}</td><td className={row.failed ? "warn" : undefined}>{row.failed}</td>
          <td>{row.seconds.length ? formatDuration(average(row.seconds)) : "—"}</td><td>{row.speeds.length ? formatSpeed(average(row.speeds)) : "—"}</td>
        </tr>)}</tbody>
      </table>
    </section>}

    {errors.length > 0 && <section className="admin-insight-split">
      <div>
        <h3>Errors by screen</h3>
        <table className="admin-insight-table">
          <thead><tr><th>Screen</th><th>Errors</th></tr></thead>
          <tbody>{errorsByScreen.map(([screen, count]) => <tr key={screen}><td className="admin-insight-route">{screen}</td><td>{count}</td></tr>)}</tbody>
        </table>
      </div>
      <div>
        <h3>Most frequent errors</h3>
        <table className="admin-insight-table">
          <thead><tr><th>Error</th><th>Count</th></tr></thead>
          <tbody>{topErrors.map(([message, count]) => <tr key={message}><td className="admin-insight-route">{message}</td><td>{count}</td></tr>)}</tbody>
        </table>
      </div>
    </section>}
  </div>;
}
