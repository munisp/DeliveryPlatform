# World-Class Roadmap Evidence — 2026-09-14

Evidence for Wave 1 (P0 Trust) + Wave 2 (P1 Operability / P2 Stakeholders / P3 Health), final main @ `42f7580`.

## Live PostGIS rehearsal (fresh database, final merged tree)
- Root-free conda-forge PostgreSQL 16 + PostGIS 3.5, fresh `switchos_final` DB, `CREATE EXTENSION postgis`.
- **79/79 migrations PASS** (0000–0079), 0 failures.
- Spot checks: `session_revocations` table present (0078), `commerce.merchant_portal.onboarding_completed_at` present (0079), `payout_settlements_driver_period_unique` present (0077).

## Mojaloop funds suite — live DB (TEST_DATABASE_URL → switchos_final)
- `go test -count=1 -timeout 300s ./...`: **ok mojaloop 41.039s** — DB-gated outbox claim/fence, refund finalization, schema contract, and batch-outbox tests ran against the real PostGIS database on the final schema.

## Go modules on merged tree (post conflict-resolution)
- `go vet ./... && go test ./...` in all 9 Go modules: **PASS, FAIL=0** (inventory-control, local-commerce-gateway, mojaloop, notification-dispatcher, resilience alert-receiver, ride-matching-worker, verification-orchestrator, vertical-provisioning, voice-gateway).

## TypeScript / frontend gates on final merged main
- `./node_modules/.bin/tsc --noEmit`: PASS
- `vitest run`: **433 passed / 43 skipped / 0 failed**
- `pnpm build`: PASS

## Roadmap PR map
| PR | Stream | Merge | Highlights |
|---|---|---|---|
| #21 | P0-TLS | d76330d | zero insecure TLS sites; shared buildDatabaseSsl; timing-safe compares swept |
| #22 | P0-AUTHZ | d28599f | operatorMutationProcedure tier; 44 mutations elevated to policy+MFA |
| #23 | P0-IDENT | 7741cab | session subject = public.users.id; OIDC collision fix; session revocation (logout→401 proven) |
| #24 | P2-MERCHANT | a46f0d7 | onboarding checklist from real tables; 0079 onboarding_completed_at |
| #25 | P2-CONSUMER | 742d422 | /account orders+timeline, idempotent disputes, wallet/ledger view |
| #26 | P3-HEALTH | 29bffea | db.ts exports 162→68; 22 fabricated-zero catches removed; CI guard |
| #27 | P1-RESIL | b548c2b | circuit-breaker/retry standard (Go/Py/TS); /metrics on all 21 services |
| #28 | P1-CIGATE | 42f7580 | funds suite CI merge gate (PostGIS service container); boot validation 20 services; env contract check |
