# Audit Remediation Evidence — 2026-09-13

Evidence for the extensive-audit remediation round (PRs #15, #16, #17, #18, #19), main @ `99993a0`.

## Live PostGIS migration rehearsal (fresh database)
- Environment: root-free conda-forge PostgreSQL 16 + PostGIS 3.5, fresh `switchos_rehearsal` DB, `CREATE EXTENSION postgis`.
- Result: **77/77 migrations PASS** (0000–0077), 0 failures.
- Caught-and-fixed during rehearsal: `0077_settlement_payout_uniqueness.sql` initially failed on fresh DB (`public.payout_settlements` had no in-repo DDL). Fixed to `CREATE TABLE IF NOT EXISTS` (columns mirror `drizzle/schema.ts`) before dedupe + unique index (PR #19).
- Post-rehearsal check: `payout_settlements_driver_period_unique` index present (count = 1).

## Mojaloop funds suite — live DB (TEST_DATABASE_URL set)
- `go test -count=1 -timeout 300s ./...` in `services/go/mojaloop`: **ok mojaloop 24.114s** — DB-backed outbox atomicity/recovery, fencing, and idempotency tests ran against the live PostGIS rehearsal database (no skips for DB-gated tests).
- New FIX-INFRA boot-validation tests all PASS:
  - `TestValidateFundsOutboxConfigurationNamesEveryMissingVariable`
  - `TestValidateFundsOutboxConfigurationRequiresDestinationList`
  - `TestValidateFundsOutboxConfigurationAcceptsCompleteConfiguration`
  - `TestRequiredFundsOutboxDestinationsRejectIncompleteDestinationConfiguration/{Dapr,Kafka,Fluvio,Temporal}`
  - `TestRequiredFundsOutboxDestinationsAcceptCompleteDestinationConfiguration`

## TypeScript / frontend gates on final merged main
- `./node_modules/.bin/tsc --noEmit`: PASS
- `vitest run`: **81 files, 368 passed / 38 skipped / 0 failed**
- `pnpm build`: PASS — emits both `dist/index.js` (801,536 B) and `dist/vehicleTrackerIngestWorker.js` (63,158 B), closing the 16-replica tracker-ingest never-built-binary finding.

## Remediation PR map
| PR | Stream | Merge commit | Highlights |
|---|---|---|---|
| #15 | settlement | 8364705 | payout UNIQUE + advisory lock + ON CONFLICT idempotency, UTC half-open windows, refund idempotency + outbox notification, honest aggregate errors |
| #17 | security | 0c6eff9 | resolvePublicUser (C-1 IDOR), per-credential openId (C-2), integrationStatus authenticated + stripped (H-1), SSRF guard (H-2), TLS verify restored (H-3), timingSafeEqual (M-1) |
| #16 | ui/ux | 5dc7a39 | 13 orphaned routes wired into nav, MerchantCommercePortal routed, global+section error boundaries, QueryErrorState/EmptyState across consoles |
| #18 | infra | afa5f2e | dynamic CI deployment counts, 2 missing CI gate scripts recreated, tracker-ingest worker build, MEDUSA/outbox boot validation, compliance-review+medusa publish parity |
| #19 | migrations | 99993a0 | 0077 fresh-deploy fix found by this rehearsal |
