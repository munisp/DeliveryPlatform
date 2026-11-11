# PowerSync mobile client (SwitchOS Native / Expo RN)

Offline **data** sync for the native app: Postgres replicas stream to
on-device SQLite through the PowerSync service, and whitelisted client writes
flow back through the upload queue. This document is the mobile counterpart
of the backend pieces on main (`server/_core/powersyncToken.ts`,
`server/_core/powersyncUpload.ts`, `deploy/powersync/sync-rules.yaml`,
`drizzle/0103_powersync_sync_support.sql`).

## Boundary: action outbox vs data sync

| Layer | File | Owns |
| --- | --- | --- |
| Operator ACTION outbox | `lib/mobile/offline-sync-sqlite.ts` | User-initiated operator actions that need guaranteed execution; priority/retry/conflict UX on the Queue tab. **Untouched by this integration.** |
| PowerSync DATA sync | `lib/powersync/*` | Server→client replicated read data (orders, tracking, loyalty, notifications, support tickets, courier scorecards, reference catalogs) + client writes via the SDK's FIFO CRUD queue. |

Both may coexist: the outbox keeps executing operator workflows; PowerSync
keeps read models fresh and uploads whitelisted writes.

## What syncs (v1)

Mirrors the deployed sync rules and the 19-table `powersync` publication:

- `user_own` (every signed-in user): orders, order_tracking_events,
  notifications, support_tickets, loyalty_points, loyalty_transactions,
  loyalty_redemptions, consumer_memberships, consumer_reviews
- `courier_assignments` (courier tokens): drivers, driver_reviews,
  driver_performance_scores, delivery_tracking_events (plus own orders)
- `global_reference` (every client): service_verticals,
  vertical_service_templates, membership_plans, loyalty_rewards
- `merchant_store` tables (service_providers, provider_catalog_items) are
  declared in the client schema for stability; the merchant role uses the PWA.

## Upload whitelist (IMPORTANT)

`POST /api/powersync/upload` is a strict whitelist. **v1 accepts ONLY
`support_tickets` PUT** (idempotent via `powersync-upload-<entry.id>`).
Every other (table, op) pair answers 400, and the SDK retries forever —
so **do not write to synced tables directly**. The only sanctioned local
write path is `queueSupportCaseDraft()` in
`mobile/switchos-native/lib/powersync/localWrites.ts`, which validates the
draft against the server schema and queues a placeholder row
(`pslocal-<uuid>` id, `pending_upload` status). The placeholder is replaced
by the authoritative replicated row after upload + write checkpoint.

## Setup

Requires a **dev build** (`npx expo prebuild` / EAS Build) — op-sqlite is a
native module and **does not work in Expo Go**. Neither package ships an
Expo config plugin (checked `@op-engineering/op-sqlite@19.0.5` and
`@powersync/op-sqlite@0.9.17` tarballs — no `app.plugin.js`); autolinking
registers the module, so no `app.config.ts` change is needed.

Dependencies (added in `mobile/switchos-native/package.json`):

- `@powersync/react-native@^1.35.11` (SDK; pins `@powersync/common@1.58.0`)
- `@powersync/common@^1.58.0` (schema column/Table/Schema imports)
- `@powersync/op-sqlite@^0.9.17` (`OPSqliteOpenFactory` adapter)
- `@op-engineering/op-sqlite@^15.0.0` (native SQLite; adapter peer range is
  `^13 || ^14 || ^15` — do not jump to v19 without bumping the adapter)
- `@powersync/adapter-sql-js@0.0.18` (Expo-Go fallback; last version
  compatible with `@powersync/common@1.x` — 0.0.19+ requires common 2.x)

Regenerate `pnpm-lock.yaml` with `pnpm install` after pulling this change —
the lockfile is intentionally not edited by hand.

Wiring (already on main): `PowerSyncProvider` wraps the tree in
`app/_layout.tsx` inside `MobileAppProvider`; it connects when a session
exists and disconnects on logout (`disconnectPowerSync`). The Queue tab shows
live status via `usePowerSyncStatus()`.

Server-side env (already handled by the backend): `POWERSYNC_SERVICE_URL`,
`POWERSYNC_JWT_PRIVATE_KEY` (RS256 prod) or `POWERSYNC_JWT_SECRET` (HS256 dev
only). No new mobile env vars — the client discovers the service URL from the
token response `endpoint` field.

## Auth mechanism

The token call uses the app's existing session mechanism: **bearer token from
expo-secure-store** (`lib/_core/auth.getSessionToken()`), sent as
`Authorization: Bearer <token>` — the same way `lib/trpc.ts` authenticates
`/api/trpc` calls. `credentials: "include"` is also set so the web build
would fall back to the session cookie (the web sync path itself belongs to
the PWA and is parked here).

## Failure model (never crash)

- Unsupported platform / Expo Go without fallback / init failure → warn once,
  online-only mode.
- 401/403 from the token endpoint → park (signed out); SDK retries after
  re-login.
- Token response with `endpoint: null` (service not deployed) → park with one
  `console.warn`, re-check on the next connect.
- Upload non-2xx → throw → SDK retries with backoff; `complete()` only after
  2xx (at-least-once delivery; the backend is idempotent).

## Troubleshooting

- **Nothing syncs, "parked" warning**: `POWERSYNC_SERVICE_URL` unset
  server-side, or the service is down. The app is intentionally in
  online-only mode.
- **`powersync_upload_failed:400` looping**: some code wrote to a synced
  table outside `queueSupportCaseDraft` (non-whitelisted table/op). Find and
  remove the write; then clear the stuck op by reinstalling or wiping local
  state (`disconnectAndClear` during development).
- **Duplicate support case after upload**: the `pslocal-` placeholder lingers
  until the write checkpoint arrives. It converges automatically; if it does
  not, the write-checkpoint plumbing is the server-side follow-up.
- **Expo Go**: expect the sql-js fallback (in-memory; data resets on reload).
  Build a dev client for durable offline data.

## Tests

`mobile/switchos-native/tests/powersync.test.ts` — run with
`pnpm test` (vitest, node env; no native modules needed). Covers URL/header
construction, 30s prefetch TTL math, 401/403 park, null-endpoint park,
missing-token throw, `entries`-envelope FIFO serialization, retry-on-throw,
complete-only-on-2xx, whitelist validation, backend selection, and static
schema-vs-publication coverage.
