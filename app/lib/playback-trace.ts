export type PlaybackTrace = { id: string; startedAt: number };
type Reporter = (event: string, durationMs: number, details: Record<string, unknown>) => void;
let reporter: Reporter = () => {};
let active: PlaybackTrace | undefined;
let requestSequence = 0;
let resourceObserver: PerformanceObserver | undefined;
let observerTimeout: ReturnType<typeof setTimeout> | undefined;
const TRACE_WINDOW_MS = 120_000;

export function configurePlaybackTraceReporter(next: Reporter) { reporter = next; }

export function playbackTracePhase(event: string, details: Record<string, unknown> = {}, trace = currentPlaybackTrace()) {
  if (!trace) return;
  // Do not let diagnostics change playback, even if a browser API is unavailable.
  try {
    const now = Date.now();
    reporter(event, Math.max(0, now - trace.startedAt), {
      ...details, attempt_id: trace.id, click_started_at_ms: trace.startedAt,
      client_timestamp_ms: now, elapsed_ms: Math.max(0, now - trace.startedAt),
    });
  } catch {}
}

export function currentPlaybackTrace() {
  return active && Date.now() - active.startedAt < TRACE_WINDOW_MS ? active : undefined;
}

function endpoint(input: string | URL) {
  try {
    // Queries may contain credentials. Log the endpoint only, including for HLS.
    return new URL(String(input), window.location.href).pathname;
  } catch { return String(input).split(/[?#]/)[0]; }
}

function observeResources(trace: PlaybackTrace) {
  resourceObserver?.disconnect();
  if (observerTimeout) clearTimeout(observerTimeout);
  if (typeof PerformanceObserver === "undefined") return;
  try {
    resourceObserver = new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as PerformanceResourceTiming[]) {
        const path = endpoint(entry.name);
        const sentAt = performance.timeOrigin + entry.startTime;
        if (sentAt < trace.startedAt || sentAt > trace.startedAt + TRACE_WINDOW_MS
          || !/^\/(?:api|media|transcode)(?:\/|$)/.test(path)
          || /\/api\/(?:client-|auth\/activity|activity)/.test(path)) continue;
        playbackTracePhase("play_request_resource", {
          endpoint: path, initiator: entry.initiatorType,
          request_started_at_ms: Math.round(sentAt),
          request_start_elapsed_ms: Math.round(sentAt - trace.startedAt),
          request_end_elapsed_ms: Math.round(sentAt + entry.duration - trace.startedAt),
          request_duration_ms: Math.round(entry.duration),
          headers_wait_ms: entry.responseStart > 0 ? Math.round(Math.max(0, entry.responseStart - entry.startTime)) : null,
          download_ms: entry.responseStart > 0 ? Math.round(Math.max(0, entry.responseEnd - entry.responseStart)) : null,
          transfer_bytes: entry.transferSize, decoded_bytes: entry.decodedBodySize,
        }, trace);
      }
    });
    resourceObserver.observe({ type: "resource", buffered: true });
    observerTimeout = setTimeout(() => resourceObserver?.disconnect(), TRACE_WINDOW_MS);
  } catch { resourceObserver?.disconnect(); }
}

export function resumePlaybackTrace(trace: PlaybackTrace) {
  if (!trace.id || !Number.isFinite(trace.startedAt) || trace.startedAt <= 0
    || trace.startedAt > Date.now() || Date.now() - trace.startedAt >= TRACE_WINDOW_MS) return;
  if (active?.id === trace.id && active.startedAt === trace.startedAt) return active;
  active = trace;
  observeResources(trace);
  return trace;
}

export function beginPlaybackTrace(details: Record<string, unknown> = {}) {
  const trace = {
    id: typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
    startedAt: Date.now(),
  };
  resumePlaybackTrace(trace);
  playbackTracePhase("play_click", details, trace);
  return trace;
}

export function writePlaybackTrace(params: URLSearchParams, trace: PlaybackTrace) {
  params.set("playAttempt", trace.id);
  params.set("playStartedAt", String(trace.startedAt));
}

export function traceFromParams(params: URLSearchParams) {
  const id = params.get("playAttempt");
  const startedAt = Number(params.get("playStartedAt"));
  return id && startedAt > 0 ? resumePlaybackTrace({ id, startedAt }) : undefined;
}

export function startPlaybackRequest(input: string | URL, init: RequestInit) {
  const trace = currentPlaybackTrace();
  const path = endpoint(input);
  if (!trace || /\/api\/(?:client-|auth\/activity)/.test(path)) return;
  const startedAt = Date.now();
  const requestId = `${trace.id}:${++requestSequence}`;
  const details = { request_id: requestId, endpoint: path, method: init.method ?? "GET", request_started_at_ms: startedAt };
  const mark = (event: string, extra: Record<string, unknown> = {}) => playbackTracePhase(event, {
    ...details, request_duration_ms: Math.max(0, Date.now() - startedAt), ...extra,
  }, trace);
  mark("play_request_started");
  return {
    response(response: Response) {
      mark("play_request_headers", { status: response.status, ok: response.ok });
      // Measure body transfer and parsing only when the caller consumes it.
      // Never clone or read a response just for logging.
      for (const method of ["json", "text", "blob", "arrayBuffer", "formData"] as const) {
        const read = response[method].bind(response);
        Object.defineProperty(response, method, { configurable: true, value: async () => {
          const bodyStartedAt = Date.now();
          try {
            const result = await read();
            mark("play_request_resolved", { status: response.status, body_method: method,
              body_read_parse_ms: Date.now() - bodyStartedAt });
            return result;
          } catch (error) {
            mark("play_request_body_failed", { status: response.status, body_method: method,
              outcome: error instanceof Error ? error.name : "error" });
            throw error;
          }
        } });
      }
    },
    failed(error: unknown) {
      mark("play_request_failed", { outcome: error instanceof Error ? error.name : "error" });
    },
  };
}
