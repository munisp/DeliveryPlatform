# PowerSync backend/infrastructure integration

Offline-first read sync for consumer/courier/merchant/operator clients, backed
by the self-hosted PowerSync service (`journeyapps/powersync-service:1.28.2`,
Apache 2.0 since 2026-11-03) replicating from the platform Postgres.

**PowerSync is the sync layer, not the money engine.** TigerBeetle remains the
authoritative ledger for all money movement; no ledger/wallet/transaction
table is replicated to clients (see the exclusion list in
`drizzle/0103_powersync_sync_support.sql`).

## Components

| File | Purpose |
|---|---|
| `drizzle/0103_powersync_sync_support.sql` | Creates the `powersync` publication (explicit v1 table list) + SELECT grants for the replication role. Idempotent, DO-block guarded. |
| `deploy/powersync/service.yaml` | Service config: Postgres source replication + Postgres bucket storage + JWKS client auth. Secrets via `!env PS_*` refs only. |
| `deploy/powersync/sync-rules.yaml` | Legacy `bucket_definitions` sync rules: `global_reference`, `user_own`, `courier_assignments`, `merchant_store`, `operator_admin`. |
| `deploy/powersync/k8s/powersync.yaml` | Replication Deployment (singleton) + API Deployment (2+ replicas) + Service + config/secret wiring. |
| `deploy/platform/docker-compose.powersync.yml` | Local/dev unified-mode service for platform compose parity. |
| `server/_core/powersyncToken.ts` | `GET/POST /api/powersync/token` (RS256 JWT mint, ≤3600s) + `GET /api/powersync/jwks.json` (public JWKS). Fail-closed 503 `powersync_not_configured`. |
| `server/_core/powersyncUpload.ts` | `POST /api/powersync/upload` — the client `uploadData()` bridge; strict table+op whitelist, idempotent handlers, zod-validated. |

## Apply order (strict)

1. **Migration first.** Apply `drizzle/0103_powersync_sync_support.sql` to the
   main database. It creates the `powersync` publication the service attaches
   to. Postgres must run with `wal_level=logical`,
   `max_replication_slots >= 10`, `max_wal_senders >= 10`.
2. **Roles and bucket database** (run as a superuser; passwords come from your
   secret pipeline — do not commit them):

   ```sql
   -- Least-privilege source role: read-only + replication.
   CREATE ROLE powersync_replication WITH LOGIN REPLICATION BYPASSRLS
     PASSWORD '...'; -- from secret pipeline
   GRANT SELECT ON ALL TABLES IN SCHEMA public TO powersync_replication;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public
     GRANT SELECT ON TABLES TO powersync_replication;

   -- Separate bucket-storage database + owner role (no access to app data).
   CREATE ROLE powersync_storage WITH LOGIN PASSWORD '...';
   CREATE DATABASE powersync_bucket OWNER powersync_storage;
   ```

   Re-applying migration 0103 after creating the role also grants SELECT on
   the v1 published tables explicitly (the grant block is role-guarded).
3. **Deploy the service** (`deploy/powersync/k8s/powersync.yaml`, or the
   compose snippet for dev). The service fails startup if the publication is
   missing — that is intentional.
4. **Backend endpoints**: set `POWERSYNC_JWT_PRIVATE_KEY` (RS256 PEM) and
   `POWERSYNC_SERVICE_URL` on the API; the token/JWKS endpoints self-activate.
   HS256 (`POWERSYNC_JWT_SECRET`) is dev-only and refused in production.

## Slot management

- The service creates one logical replication slot (e.g. `powersync_1_6489`)
  **per active sync-config deployment**. Every `sync-rules.yaml` deploy creates
  a **new slot** and reprocesses from scratch at replication rates; the old
  slot is retired after the new deployment catches up. Budget
  `max_replication_slots`/`max_wal_senders` for 2+ slots during deploys and
  schedule big sync-config changes off-peak.
- Set `max_slot_wal_keep_size` to cover the worst expected downtime — if
  retained WAL exceeds it, Postgres invalidates the slot (`PSYNC_S1146`) and
  the service does a full re-snapshot. Guidance: ≥ expected lag and ≤ ~50% of
  disk (25–50% of disk is the recon baseline). Alert on
  `pg_replication_slots` retained-WAL vs that ceiling; drop dead slots with
  `pg_drop_replication_slot` (inactive slots silently eat disk).

## Honest scale model (self-host, from the recon brief)

- **Replication (singleton):** ~2,000–4,000 ops/s small rows, ~5 MB/s large
  rows, ~60 small transactions/s source→service. This single pipeline is what
  breaks first — bulk updates/backfills/`COPY`/`TRUNCATE` cause sustained lag.
- **API layer:** ~100 concurrent sync connections per API pod (PowerSync
  guidance); scale API pods horizontally
  (`replicas = ceil(concurrent_connections / 100)`). Service→client sync is
  ~2,000–20,000 ops/s per client; up to ~1M rows/client is fine.
- **Bucket storage:** Postgres storage here; watch write amplification and run
  periodic compaction (the community Helm chart runs a daily compaction
  CronJob).
- **No published multi-thousand-client self-host benchmarks exist.** PowerSync
  Cloud advertises 50k+ connections per instance (plan-gated); self-host has
  no documented hard limit but at 100k concurrent clients you are in
  uncharted territory (~1,000 API pods at the 100/pod guideline). Load-test
  against the 2–4k ops/s replication ceiling before promising >10k concurrent
  clients.

## Token contract

`GET /api/powersync/token` (session-authed, rate-limited 60/min/IP) returns
`{ endpoint, token, expiresAt }` for the client SDK connector's
`fetchCredentials()`. JWT claims: `sub` = `public.users.id`, `aud` =
`POWERSYNC_JWT_AUDIENCE` (default `powersync`), `role` ∈
`consumer|courier|merchant|operator` (derived from `public.users.role` plus
driver/provider row resolution), `driver_id`/`provider_id` when applicable,
`exp - iat ≤ 3600s`. JWKS at `GET /api/powersync/jwks.json` (public).

## Upload bridge

`POST /api/powersync/upload` (session-authed, rate-limited 120/min/IP) is the
`uploadData()` target: a FIFO batch of `{op, table, id, data}` entries
dispatched through a strict whitelist. v1 ships one worked entry
(`support_tickets` PUT → `openConsumerSupportCase`, idempotent via the
client entry id) and documents the extension procedure in
`server/_core/powersyncUpload.ts`. Unknown table/op → 400; handler failure →
non-2xx so the SDK retries.
