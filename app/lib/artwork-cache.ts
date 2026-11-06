// Store image bytes, not remote URLs or temporary object URLs. IndexedDB also
// works in the native WebView and on HTTP LAN origins without a service worker.
const DB_NAME = "tms-artwork-cache";
const STORE = "images";
let database: Promise<IDBDatabase> | undefined;
const pending = new Map<string, Promise<Blob>>();

function openDatabase(): Promise<IDBDatabase> {
  if (!database) {
    database = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => request.result.createObjectStore(STORE);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    }).catch(error => { database = undefined; throw error; });
  }
  return database;
}

async function readImage(key: string): Promise<Blob | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE).objectStore(STORE).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function saveImage(key: string, image: Blob): Promise<void> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, "readwrite");
    transaction.objectStore(STORE).put(image, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

// The complete URL includes artwork revisions/query parameters. A changed URL
// gets a new image; unchanged artwork has no expiry or background re-download.
export function loadArtwork(src: string, scope: string): Promise<Blob> {
  const url = new URL(src, window.location.href).href;
  const key = JSON.stringify([scope, url]);
  const existing = pending.get(key);
  if (existing) return existing;
  const task = (async () => {
    const cached = await readImage(key).catch(() => undefined);
    if (cached) return cached;
    const host = new URL(url).hostname;
    const requestUrl = host === "images.metahub.space" || host === "image.tmdb.org"
      ? `/artwork-image?${new URLSearchParams({ url })}` : url;
    const response = await fetch(requestUrl, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error(`Artwork request failed: ${response.status}`);
    const image = await response.blob();
    if (!image.size || !image.type.startsWith("image/")) throw new Error("Invalid artwork response");
    // Storage failure must not prevent online display. A later visit can retry.
    await saveImage(key, image).catch(() => undefined);
    return image;
  })();
  pending.set(key, task);
  void task.finally(() => pending.delete(key)).catch(() => undefined);
  return task;
}
