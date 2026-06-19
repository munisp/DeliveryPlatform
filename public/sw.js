const BUILD_VERSION = self.__SW_BUILD_VERSION__ || "dev";
const CACHE_NAME = `switchos-shell-${BUILD_VERSION}`;
const ASSETS = ["/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)));
    const clients = await self.clients.matchAll({ type: "window" });
    await Promise.all(clients.map((client) => client.postMessage({ type: "SW_VERSION_ACTIVATED", version: BUILD_VERSION })));
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") {
    return;
  }

  const url = new URL(event.request.url);
  const isSameOrigin = url.origin === self.location.origin;
  const isNavigation = event.request.mode === "navigate";

  if (isNavigation) {
    event.respondWith(fetch(event.request, { cache: "no-store" }).catch(() => caches.match("/offline.html")));
    return;
  }

  if (!isSameOrigin) {
    return;
  }

  if (url.pathname === "/" || url.pathname.endsWith("index.html")) {
    event.respondWith(fetch(event.request, { cache: "no-store" }));
    return;
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          if (!response || response.status !== 200 || response.type !== "basic") {
            return response;
          }
          const cloned = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, cloned));
          return response;
        });
    }),
  );
});
