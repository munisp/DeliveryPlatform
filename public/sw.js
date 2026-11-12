const BUILD_VERSION = "__SW_BUILD_VERSION__";
const CACHE_PREFIX = "switchos-shell-";
const CACHE_NAME = `${CACHE_PREFIX}${BUILD_VERSION}`;
const PRECACHE_ASSETS = [
  "/manifest.webmanifest",
  "/offline.html",
  "/icons/switchos-icon.svg",
  "/icons/switchos-maskable.svg",
];

// P5-OFFLINE: consumer read-path cache + outbox background sync.
// Versioned with the shell so each deploy starts from a clean read cache.
const CONSUMER_READ_CACHE_PREFIX = "switchos-consumer-read-";
const CONSUMER_READ_CACHE_NAME = `${CONSUMER_READ_CACHE_PREFIX}${BUILD_VERSION}`;
const CONSUMER_READ_MAX_AGE_MS = 60_000;
const CONSUMER_OUTBOX_SYNC_TAG = "consumer-outbox";
const CONSUMER_OUTBOX_SYNC_MESSAGE = "CONSUMER_OUTBOX_SYNC";

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

/**
 * Consumer read procedures eligible for stale-while-revalidate caching:
 * every consumerCatalog.* procedure is a query (verified against
 * server/_core/consumerCatalog.ts — no mutations exist on that router), and
 * consumerRide.myRideTrips is the read-only trip list (backed by
 * listMyRideTrips). tRPC batches join procedure paths with commas, so every
 * segment must be whitelisted. Mutations travel as POST and never reach
 * this branch (see the GET-only guard in the fetch listener).
 */
function isConsumerReadTrpcPath(pathname) {
  if (!pathname.startsWith("/api/trpc/")) return false;
  const procedures = pathname.slice("/api/trpc/".length).split(",");
  return (
    procedures.length > 0 &&
    procedures.every(
      (procedure) =>
        procedure.startsWith("consumerCatalog.") ||
        procedure === "consumerRide.myRideTrips",
    )
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

async function clearStaleConsumerReadCaches() {
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter(
        (key) =>
          key.startsWith(CONSUMER_READ_CACHE_PREFIX) &&
          key !== CONSUMER_READ_CACHE_NAME,
      )
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

async function fetchAndCacheConsumerRead(cache, request) {
  const response = await fetch(request, { cache: "no-store" });
  if (response.ok && response.type === "basic") {
    const headers = new Headers(response.headers);
    headers.set("x-sw-cached-at", String(Date.now()));
    const body = await response.clone().blob();
    await cache.put(
      request,
      new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      }),
    );
  }
  return response;
}

/**
 * Stale-while-revalidate for whitelisted consumer read procedures with a
 * 60s max-age: a cached entry younger than 60s is served immediately while
 * the network revalidates in the background; anything older (or absent)
 * goes to the network and refreshes the cache.
 *
 * Requests carrying an Authorization header are NEVER cached: a bearer
 * token identifies a principal we cannot fold into the cache key without
 * persisting the credential, so URL-keyed caching could serve one caller's
 * response to another. Cookie-session requests from this browser profile
 * share the profile's principal, so URL-keyed caching with a 60s bound is
 * safe there (and the cache is versioned per deploy).
 */
function staleWhileRevalidateConsumerRead(event) {
  const request = event.request;
  if (request.headers.has("authorization")) {
    return fetch(request, { cache: "no-store" });
  }
  return (async () => {
    const cache = await caches.open(CONSUMER_READ_CACHE_NAME);
    const cached = await cache.match(request);
    if (cached) {
      const cachedAt = Number(cached.headers.get("x-sw-cached-at") ?? "0");
      if (
        Number.isFinite(cachedAt) &&
        cachedAt > 0 &&
        Date.now() - cachedAt < CONSUMER_READ_MAX_AGE_MS
      ) {
        event.waitUntil(
          fetchAndCacheConsumerRead(cache, request).catch(() => undefined),
        );
        return cached;
      }
    }
    return fetchAndCacheConsumerRead(cache, request);
  })();
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
      await clearStaleConsumerReadCaches();
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

// Background Sync: when the consumer outbox sync fires, fan a message out
// to every window client so the page can replay its queued offlineSync
// actions via tRPC mutations (see client/src/lib/consumerOfflineQueue.ts).
self.addEventListener("sync", (event) => {
  if (event.tag !== CONSUMER_OUTBOX_SYNC_TAG) return;
  event.waitUntil(
    self.clients
      .matchAll({ type: "window", includeUncontrolled: true })
      .then((clients) =>
        Promise.all(
          clients.map((client) =>
            client.postMessage({
              type: CONSUMER_OUTBOX_SYNC_MESSAGE,
              tag: event.tag,
            }),
          ),
        ),
      ),
  );
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

  if (isConsumerReadTrpcPath(url.pathname)) {
    event.respondWith(staleWhileRevalidateConsumerRead(event));
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
