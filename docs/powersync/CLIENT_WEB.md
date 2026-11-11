# Offline data sync (PowerSync) — web client (PWA)

The web client syncs the consumer/operator data subset (orders + tracking,
loyalty, verticals/catalog reference data) into a local SQLite database so
the `/account` surface keeps working offline and reads feel instant.

## Pieces

- `client/src/lib/powersync.ts` — lazy singleton database, OPFS feature
  detection with degrade-to-online-only, and the backend connector
  (`GET /api/powersync/token`, `POST /api/powersync/upload`).
- `client/src/lib/powersyncSchema.ts` — client schema; mirrors the
  sync-rules role groups (`consumer_data` per-user bucket, `global_reference`
  bucket). Comment in that file is the authoritative mapping.
- `client/src/lib/usePowerSync.ts` — `PowerSyncProvider` (wired in
  `client/src/main.tsx` inside `QueryClientProvider`). Connects when a
  session exists, disconnects on logout, exposes `usePowerSyncStatus()`.
- `client/src/components/PowerSyncStatus.tsx` — status pill mounted in the
  `ConsumerLayout` header.
- `tests/powersync-client.test.ts` — connector URL/header contract, token
  prefetch TTL math, OPFS feature-detection degradation, upload
  retry-on-throw.

## How it works

- Storage: wa-sqlite (WASM SQLite) in a web worker with the
  `OPFSCoopSyncVFS` (Origin Private File System) VFS — the only PowerSync web
  VFS with reliable multi-tab support, including Safari/iOS. Multi-tab sync
  coordination uses a SharedWorker on desktop Chrome/Firefox; Safari/mobile
  fall back to BroadcastChannel coordination inside the SDK.
- Auth: session cookie → our token endpoint returns a short-lived PowerSync
  JWT. The connector caches it and prefetches a fresh one once the remaining
  TTL is ≤ 30 s (mirroring the SDK's own keepalive).
- Writes: local SQLite writes are queued FIFO by the SDK and uploaded as
  `{ operations: [{ op, table, id, data }] }` batches. Any non-2xx response
  throws, so the SDK retries with backoff — the backend must be idempotent
  and apply batches synchronously.

## COOP/COEP requirement (deployment blocker for Safari)

OPFS on Safari requires cross-origin isolation. The HTML shell and static
assets must be served with:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

The server-side header middleware is delivered separately. Until it lands,
`detectPowerSyncSupport` reports unsupported, logs a clear warning, and the
app runs online-only — no crash. Note COEP `require-corp` can break
third-party embeds/CDN assets that don't send CORP/CORS headers; audit
before enabling in production.

## Safari / browser caveats

- Safari private/incognito windows have **no OPFS** — offline sync disables
  itself (logged warning) and the app runs online-only.
- OPFS is evictable browser storage (Safari ITP pressure, quota eviction).
  Always treat the local DB as a rebuildable cache; the server remains the
  source of truth.
- SharedWorkers are unavailable on Android Chrome, iOS, and Safari; expect
  one syncing tab there (SDK BroadcastChannel fallback).

## Dev vs prod

- `vite.config.ts` excludes `@journeyapps/wa-sqlite` and `@powersync/web`
  from dev pre-bundling (their worker/WASM URLs resolve relative to the
  package) and sets `worker.format: "es"` so production worker bundles keep
  ESM code-splitting. `pnpm dev` needs no extra steps after `pnpm install`.
- Dev server proxies `/api` to the backend (`vite.config.ts`); the
  COOP/COEP headers must also be sent by the dev/proxy layer for OPFS to
  work locally — with the header middleware enabled this is automatic.
- The SDK and its WASM assets are loaded lazily via dynamic import, so
  unsupported browsers never download them.
