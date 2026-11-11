# PowerSync offline-sync integration — validation & readiness (2026-11-12)

Scope: evaluate powersync-ja for DeliveryPlatform and, if valuable, integrate
across backend + PWA + native mobile. Verdict: strong fit as the offline-first
DATA sync layer (Postgres ↔ on-device SQLite). It is NOT a transaction engine —
TigerBeetle remains the money-movement TPS engine; PowerSync moves data
replicas, not ledger entries.

## What shipped (all on main, every file blob-SHA verified post-push)

### Backend + infra (earlier commits this wave)
- `server/_core/powersyncToken.ts` (`0ff46df9`) — GET/POST `/api/powersync/token`,
  session-auth, rate-limited (60/min). RS256 + JWKS (`/api/powersync/jwks.json`)
  in production; HS256 refused outside dev. Role-aware identity resolution
  (operator / courier / merchant / consumer), TTL clamp 60..3600s.
  Returns `endpoint: null` when `POWERSYNC_SERVICE_URL` is unset (park signal).
- `server/_core/powersyncUpload.ts` (`b1e04b9a`) — POST `/api/powersync/upload`,
  zod envelope EXACTLY `{ entries: [{ id, op: PUT|PATCH|DELETE, table, data? }] }`
  (1..100). FIFO, first failure stops the batch (SDK redelivers from failed
  entry). v1 whitelist: `support_tickets` PUT only, idempotent via
  `powersync-upload-<entry.id>`.
- `drizzle/0103_powersync_sync_support.sql` (`e974f0dc`) — idempotent DO-block
  `CREATE PUBLICATION powersync FOR TABLE` over 19 tables (orders, tracking,
  notifications, support, loyalty ×4, memberships, reviews ×2, drivers,
  driver_performance_scores, service_providers, catalog, verticals, templates,
  membership_plans).
- `deploy/powersync/` — `service.yaml` (`0f2eee81`, Postgres bucket storage),
  `sync-rules.yaml` (`ce9da1fb`, 4 role groups), `README.md`, `k8s/powersync.yaml`
  (replication singleton + warm standby), `deploy/platform/docker-compose.powersync.yml`.

### PWA (client/src)
- `lib/powersync.ts` (`6e9e2cc5`) — lazy singleton wa-sqlite/OPFSCoopSyncVFS DB,
  REST connector (cookie auth, 30s prefetch, 401/403 park, null-endpoint park,
  FIFO upload, complete-only-on-2xx). Envelope fixed to `{ entries: [...] }`
  this wave (was `{ operations: [...] }` — would have 400'd every offline write).
- `lib/powersyncSchema.ts`, `lib/usePowerSync.ts`, `components/PowerSyncStatus.tsx`
  (pill in ConsumerLayout), provider wired in `main.tsx`, vite COOP/COEP notes.
- `tests/powersync-client.test.ts` (`69bec031`) — 17 tests incl. null-endpoint
  park + missing-token throw added this wave.
- `docs/powersync/CLIENT_WEB.md` (`cbfb8664`) — contract corrected to `entries`.

### Native mobile (mobile/switchos-native) — commits 93f3a885..8cfc5790
- `lib/powersync/schema.ts` (`439c2714`) — 19-table client schema mirroring the
  deployed sync-rules buckets; bigint money as TEXT, ids as TEXT (id::text).
- `lib/powersync/connector.ts` (`dedf1e2f`) — bearer-auth (expo-secure-store,
  same token the tRPC client uses) REST connector; verified byte-content on
  main: correct `entries` envelope, null-endpoint single-warn park, 401/403
  park, throw-on-non-2xx, complete-only-on-2xx.
- `lib/powersync/localWrites.ts` (`fd39036a`) — only sanctioned local-write
  path (support_tickets PUT whitelist, `pslocal-` placeholder ids).
- `lib/powersync/backend.ts` (`fe2d9583`) — op-sqlite default / sql-js Expo-Go
  fallback / web parked.
- `lib/powersync/PowerSyncProvider.tsx` (`67a14b73`) — lazy singleton,
  connect-on-session, `usePowerSyncStatus` (upload queue stats), never-crash.
- `app/_layout.tsx` (`29e1b579`) provider wrap; `app/(tabs)/queue.tsx`
  (`958647e4`) sync-status SectionCard; operator action outbox untouched.
- `package.json` (`cea00556`) — @powersync/react-native ^1.35.11, common
  ^1.58.0, op-sqlite adapter ^0.9.17 + @op-engineering/op-sqlite ^15.0.0,
  adapter-sql-js 0.0.18. `pnpm-lock.yaml` NOT regenerated (needs one
  `pnpm install` — documented).
- `tests/powersync.test.ts` (`57b2d238`) — 41/41 Node-level tests.
- `docs/powersync/CLIENT_MOBILE.md` (`043cc357`) — setup (dev build, not Expo
  Go), outbox-vs-sync boundary, whitelist caveat, failure model.

## Test evidence
- Backend: 16/16 vitest (token issuance, JWKS, upload whitelist, idempotency).
- PWA: 17/17 vitest (connector contract, TTL math, park behavior, FIFO upload).
- Mobile: 41/41 vitest (same contract surface + whitelist + backend selection);
  `tsc --strict` clean against REAL @powersync/common@1.58.0 /
  react-native@1.35.11 / op-sqlite types.
- Cross-layer contract: PWA + mobile connectors assert the identical
  `{ entries: [...] }` envelope against the backend zod schema.

## Honest scale framing
- PowerSync replication service: ~2–4k ops/s per replication singleton
  (+ warm standby); ~100 concurrent client connections per API pod — scale API
  pods horizontally. No published multi-client benchmarks; load-test before
  committing to SLAs.
- Service limits: 1000 buckets/connection (PSYNC_S2305), 1000 param-query
  rows, 15MB max row size.
- "Millions of transactions per second" applies to the TigerBeetle ledger
  path, not to sync. Sync throughput needs per-user data change rates, which
  are orders of magnitude lower than payment TPS.

## Deploy checklist (ops)
1. Apply migration `0103` (creates the `powersync` publication).
2. Create the `powersync_replication` role per `deploy/powersync/README.md`;
   ensure `wal_level=logical` (PG >= 11).
3. Deploy `journeyapps/powersync-service:v1.28.2` (k8s manifest or compose
   file provided) with `deploy/powersync/service.yaml` + `sync-rules.yaml`.
4. Set server env: `POWERSYNC_SERVICE_URL`, `POWERSYNC_JWT_PRIVATE_KEY`
   (RS256; kid derived server-side), optional `POWERSYNC_JWT_ISSUER/AUDIENCE`.
5. Serve the PWA shell with COOP `same-origin` + COEP `require-corp`
   (Safari OPFS hard requirement; audit third-party embeds first).
6. Mobile: `pnpm install` (regenerates lockfile), build a dev client
   (NOT Expo Go) for op-sqlite.
7. Smoke: sign in → status pill/SectionCard shows connected → offline →
   read `/account` data → online → uploads drain.

## Known caveats
- No on-device RN build executed in-sandbox (provider/SDK wiring is
  type-verified against real package types, not device-run).
- No live PowerSync service end-to-end test in-sandbox (service image not
  run here); contracts are pinned by 74 tests across the three surfaces.
- Upload whitelist v1 is support_tickets-only by design; widen per-vertical
  as the consumer-parity program lands new write paths.
- Write-checkpoint plumbing for custom backends is a server-side follow-up
  (documented in CLIENT_MOBILE.md).
- Earlier rental-scoped mobile prototype retained locally at
  /mnt/agents/output/1a1cb627-4902-8899-8000-0f99d42b8f4d/ for a future
  rental-sync wave (rental tables are not in the v1 publication).

## Readiness score: 8/10 (integration-complete, pre-live-service)
Schema/publication 9, auth (RS256+JWKS) 9, upload path 8 (v1 whitelist is
narrow by design), client coverage 8 (PWA + mobile, type-verified),
operability 7 (k8s/compose shipped, lockfile regen + live smoke pending),
evidence 7 (74 automated tests, no live-service run yet). Path to 9+:
deploy the service, run the smoke sequence above, load-test replication.
