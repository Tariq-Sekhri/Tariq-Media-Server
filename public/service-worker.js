const APP_CACHE = "tms-react-shell-v2";
self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const response = await fetch("/app-shell-manifest.json", { cache: "no-store" });
    if (!response.ok) throw new Error("React app manifest unavailable");
    const assets = await response.json();
    const cache = await caches.open(APP_CACHE);
    await cache.addAll(assets);
    await self.skipWaiting();
  })());
});
self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith("tms-offline-shell-")) await caches.delete(name);
    }
    await self.clients.claim();
  })());
});
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || event.request.method !== "GET") return;
  if (url.pathname.startsWith("/app-shell-assets/")) {
    event.respondWith(caches.match(event.request).then(cached => cached || fetch(event.request)));
  } else if (event.request.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const response = await fetch(event.request, { signal: AbortSignal.timeout(4000) });
        if (response.status < 500) return response;
      } catch { /* Preserve the React app during network loss. */ }
      return (await caches.match("/index.html")) || Response.error();
    })());
  }
});
