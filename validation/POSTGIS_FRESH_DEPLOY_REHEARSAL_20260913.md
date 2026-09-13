# PostGIS Fresh-Deploy Migration Rehearsal — 2026-09-13

## Environment
- PostgreSQL 16.10 (conda-forge, user-space install, no root)
- **PostGIS 3.5.0** (GEOS 3.13.0, PROJ 9.5.1) — `CREATE EXTENSION postgis` verified
- Database `switchos` created empty; full `drizzle/*.sql` chain applied in lexical order

## Result: 76/76 migrations apply cleanly (0 failures)

Previously, 27 migrations failed on PostGIS-less embedded PostgreSQL and 3 more
failed on idempotency defects. Both classes are now closed:

1. **PostGIS-dependent migrations (27)** — all apply against PostGIS 3.5
   (H3 spatial index, ride-hailing dispatch, telematics, geofence tables).
2. **Idempotency defects (3)** — fixed in this commit chain:
   - `0034_workflow_mapping_geofence.sql`: previously did a blind
     `CREATE TABLE operations.workflow_definition` that collided with the older
     shape created by `0028_logistics_operations.sql`. Because application code
     (`server/_core/logisticsOperationsStore.ts`) requires the 0034 columns
     (`workflow_code`, `state`, `work_state_transitions`, `policy_version`),
     **every fresh deployment since 0028 was silently running a broken
     workflow-publishing path**. 0034 now upgrades the 0028 shape in place
     (column renames + additive columns) or creates fresh, with guarded enum
     and index creation.
   - `0057` / `0062`: REVOKE/GRANT chains referenced service roles
     (`commerce_gateway_service`, `vehicle_access_service`) absent on fresh
     databases; both migrations now create NOLOGIN placeholder roles first.

## Post-rehearsal verification queries
- `platform_schema_contracts` at version 10 ✅
- `operations.workflow_definition` has 0034 shape (workflow_code, state,
  work_state_transitions) ✅ — the upgrade path executed against the 0028 table
- `vertical_compliance_packs` seeded: 4 packs (pharmacy, alcohol, healthcare,
  grocery) ✅

## Funds suite against the fully-migrated database
`go test -count=1 ./...` in `services/go/mojaloop` with
`TEST_DATABASE_URL=postgres://postgres@127.0.0.1:5432/switchos`:
**PASS, exit 0, 53.9s** — outbox claim/fence, refund finalization, concurrent
reservation serialization all green against the complete PostGIS schema.
