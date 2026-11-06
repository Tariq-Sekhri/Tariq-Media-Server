import { authFetch, getSessionToken } from "./auth";
import { API_BASE } from "./media";

// Resumable uploads: the server keeps each file's partial data on disk, so a
// dropped connection, a page reload, or a server restart only costs the chunk
// that was in flight. Re-adding the same file reconnects to its session.

export type UploadSession = {
  id: string;
  parent_path: string;
  relative_path: string;
  file_name: string;
  size: number;
  last_modified: number | null;
  received_bytes: number;
  chunk_size: number;
  complete: boolean;
  path: string | null;
  updated_at: number;
};

export class UploadError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean, readonly receivedBytes?: number) {
    super(message);
    this.name = "UploadError";
  }
}

const MIN_CHUNK_BYTES = 1024 * 1024;
const MAX_CHUNK_BYTES = 32 * 1024 * 1024;
// Consecutive failures tolerated before a file is handed back to the user
// with a Retry button. Any successful chunk resets the count.
const RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 30_000, 30_000];

// Page-level reloads (such as a new frontend release) must wait while files
// are uploading; reloading the document aborts every request in flight.
let uploadsActive = false;
export const setUploadsActive = (active: boolean) => { uploadsActive = active; };
export const uploadsAreActive = () => uploadsActive;

// Operating-system clutter that folder selections and drops pick up.
const IGNORED_UPLOAD_NAMES = new Set(["desktop.ini", "thumbs.db", ".ds_store"]);
export const isIgnoredUploadFile = (name: string) => IGNORED_UPLOAD_NAMES.has(name.toLowerCase()) || name.startsWith("._");

const abortError = () => new DOMException("Upload stopped", "AbortError");
export const isUploadAbort = (error: unknown) => error instanceof DOMException && error.name === "AbortError";

const retryableStatus = (status: number) => status === 0 || status === 408 || status === 429 || status >= 500 && status !== 507;

const errorMessage = (status: number, serverMessage?: string) => serverMessage
  || (status === 401 ? "Your session expired. Sign in again."
    : status === 403 ? "You do not have permission to upload here."
      : status === 409 ? "A file with that name already exists."
        : status === 415 ? "This library does not accept that file type."
          : status === 507 ? "This upload would exceed your server storage quota."
            : status === 0 ? "The connection to the server was lost."
              : `Server returned ${status}.`);

const errorFromResponse = async (response: Response) => {
  const body = await response.json().catch(() => null) as { message?: string; received_bytes?: number } | null;
  return new UploadError(errorMessage(response.status, body?.message), response.status, retryableStatus(response.status), body?.received_bytes);
};

const wait = (milliseconds: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(abortError());
  const timer = window.setTimeout(done, milliseconds);
  function done() {
    signal.removeEventListener("abort", stop);
    resolve();
  }
  function stop() {
    window.clearTimeout(timer);
    reject(abortError());
  }
  signal.addEventListener("abort", stop, { once: true });
});

// While the device itself reports no network, waiting is not a failure.
const waitForNetwork = (signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal.aborted) return reject(abortError());
  if (navigator.onLine !== false) return resolve();
  const online = () => {
    signal.removeEventListener("abort", stop);
    resolve();
  };
  const stop = () => {
    window.removeEventListener("online", online);
    reject(abortError());
  };
  window.addEventListener("online", online, { once: true });
  signal.addEventListener("abort", stop, { once: true });
});

export const listUploadSessions = async (): Promise<UploadSession[]> => {
  const response = await authFetch(`${API_BASE}/api/uploads/sessions`, { cache: "no-store" });
  if (!response.ok) throw await errorFromResponse(response);
  return response.json();
};

/** Best effort: frees the partial data and storage reservation on the server. */
export const cancelUploadSession = (id: string) => authFetch(`${API_BASE}/api/uploads/sessions/${encodeURIComponent(id)}`, { method: "DELETE" })
  .then(() => undefined, () => undefined);

const createUploadSession = async (file: File, parentPath: string, relativePath: string, signal: AbortSignal): Promise<UploadSession> => {
  const response = await authFetch(`${API_BASE}/api/uploads/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      parent_path: parentPath,
      relative_path: relativePath,
      file_name: file.name,
      file_size: file.size,
      last_modified: file.lastModified || null,
    }),
    signal,
  });
  if (!response.ok) throw await errorFromResponse(response);
  return response.json();
};

const completeUploadSession = async (id: string, signal: AbortSignal): Promise<UploadSession> => {
  const response = await authFetch(`${API_BASE}/api/uploads/sessions/${encodeURIComponent(id)}/complete`, { method: "POST", signal });
  if (!response.ok) throw await errorFromResponse(response);
  return response.json();
};

const sendChunk = (id: string, offset: number, chunk: Blob, signal: AbortSignal, onProgress: (loaded: number) => void) => new Promise<UploadSession>((resolve, reject) => {
  if (signal.aborted) return reject(abortError());
  const request = new XMLHttpRequest();
  const stop = () => request.abort();
  signal.addEventListener("abort", stop, { once: true });
  const settle = () => signal.removeEventListener("abort", stop);
  request.open("PUT", `${API_BASE}/api/uploads/sessions/${encodeURIComponent(id)}?offset=${offset}`);
  const token = getSessionToken();
  if (token) request.setRequestHeader("Authorization", `Bearer ${token}`);
  request.setRequestHeader("Content-Type", "application/octet-stream");
  request.upload.onprogress = (event) => onProgress(event.loaded);
  request.onload = () => {
    settle();
    let body: (UploadSession & { message?: string }) | null = null;
    try { body = JSON.parse(request.responseText); } catch { body = null; }
    if (request.status >= 200 && request.status < 300 && body) return resolve(body);
    reject(new UploadError(errorMessage(request.status, body?.message), request.status, retryableStatus(request.status), body?.received_bytes));
  };
  request.onerror = () => {
    settle();
    reject(new UploadError(errorMessage(0), 0, true));
  };
  request.onabort = () => {
    settle();
    reject(abortError());
  };
  request.send(chunk);
});

export type ResumableUploadOptions = {
  file: File;
  parentPath: string;
  relativePath: string;
  signal: AbortSignal;
  onSession?: (session: UploadSession) => void;
  onProgress?: (uploadedBytes: number, bytesPerSecond: number) => void;
};

/**
 * Uploads one file in sequential chunks, retrying transient failures with
 * backoff and resuming from the server's offset. Rejects with an AbortError
 * when `signal` aborts, or an UploadError the user must act on.
 */
export const uploadFileResumably = async ({ file, parentPath, relativePath, signal, onSession, onProgress }: ResumableUploadOptions): Promise<UploadSession> => {
  let failures = 0;
  let session: UploadSession | null = null;
  let offset = 0;
  let chunkSize = 0;
  let speed = 0;
  let lastSample = { time: performance.now(), bytes: 0 };
  const report = (uploaded: number) => {
    const now = performance.now();
    const elapsed = (now - lastSample.time) / 1000;
    if (elapsed >= 0.5) {
      const instant = Math.max(0, (uploaded - lastSample.bytes) / elapsed);
      speed = speed ? speed * 0.7 + instant * 0.3 : instant;
      lastSample = { time: now, bytes: uploaded };
    }
    onProgress?.(uploaded, speed);
  };

  while (true) {
    try {
      await waitForNetwork(signal);
      if (!session) {
        session = await createUploadSession(file, parentPath, relativePath, signal);
        offset = session.received_bytes;
        chunkSize ||= session.chunk_size;
        lastSample = { time: performance.now(), bytes: offset };
        onSession?.(session);
        report(offset);
        if (session.complete) return session;
      }
      while (offset < file.size) {
        const started = performance.now();
        const end = Math.min(file.size, offset + chunkSize);
        const result = await sendChunk(session.id, offset, file.slice(offset, end), signal, (loaded) => report(offset + loaded));
        offset = result.received_bytes;
        failures = 0;
        report(offset);
        // Keep each request comfortably short on slow links and cheap on fast ones.
        const seconds = (performance.now() - started) / 1000;
        if (seconds > 20) chunkSize = Math.max(MIN_CHUNK_BYTES, Math.floor(chunkSize / 2));
        else if (seconds < 4) chunkSize = Math.min(MAX_CHUNK_BYTES, chunkSize * 2);
      }
      return await completeUploadSession(session.id, signal);
    } catch (error) {
      if (isUploadAbort(error) || signal.aborted) throw abortError();
      if (!(error instanceof UploadError)) {
        // fetch() rejects with a TypeError when the connection drops.
        if (!(error instanceof TypeError)) throw error;
        error = new UploadError(errorMessage(0), 0, true);
      }
      const uploadError = error as UploadError;
      // The server holds a different amount than we assumed (a retried chunk
      // that had in fact landed, or a completion that came too early).
      if (uploadError.status === 409 && session && typeof uploadError.receivedBytes === "number") {
        offset = uploadError.receivedBytes;
        report(offset);
        continue;
      }
      // An expired or cleared session is simply recreated.
      const sessionLost = uploadError.status === 404 && session !== null;
      if (sessionLost) session = null;
      if ((!uploadError.retryable && !sessionLost) || failures >= RETRY_DELAYS_MS.length) throw uploadError;
      await wait(RETRY_DELAYS_MS[failures], signal);
      failures += 1;
    }
  }
};
