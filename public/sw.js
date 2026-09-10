const BUILD_VERSION = "__SW_BUILD_VERSION__";
const CACHE_PREFIX = "switchos-shell-";
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_VERSION}`;
const PRECACHE_ASSETS = [
  "/manifest.webmanifest",
  "/offline.html",
  "/icons/switchos-icon.svg",
  "/icons/switchos-maskable.svg",
];

if (!/^[a-zA-Z0-9._-]{7,128}$/.test(BUILD_VERSION)) {
  throw new Error("service_worker_build_version_missing");
}

function isApiOrSensitivePath(pathname) {
  return (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/auth/") ||
    pathname.includes("/signed-") ||
    pathname.includes("/presigned-")
  );
}

function isCacheableStaticAsset(pathname) {
  return (
    /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.(?:css|js|mjs|woff2?|svg|png|webp)$/.test(
      pathname,
    ) ||
    pathname.startsWith("/icons/") ||
    pathname === "/manifest.webmanifest" ||
    pathname === "/offline.html"
  );
}

async function clearStaleShellCaches() {
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
      .map((key) => caches.delete(key)),
  );
}

async function cacheFirstStaticAsset(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  const response = await fetch(request, { cache: "no-store" });
  if (response.ok && response.type === "basic") {
    const cache = await caches.open(CACHE_NAME);
    await cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(PRECACHE_ASSETS)),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      await clearStaleShellCaches();
      await self.clients.claim();
      const clients = await self.clients.matchAll({ type: "window" });
      await Promise.all(
        clients.map((client) =>
          client.postMessage({
            type: "SW_VERSION_ACTIVATED",
            version: BUILD_VERSION,
          }),
        ),
      );
    })(),
  );
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request, { cache: "no-store" }).catch(() =>
        caches.match("/offline.html"),
      ),
    );
    return;
  }

  if (isApiOrSensitivePath(url.pathname)) {
    event.respondWith(fetch(request, { cache: "no-store" }));
    return;
  }

  if (isCacheableStaticAsset(url.pathname)) {
    event.respondWith(cacheFirstStaticAsset(request));
  }
});
