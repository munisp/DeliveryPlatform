# Validation — Rental Condition & Insurance Wave (2026-11-10)

Scope: `drizzle/0096_rental_condition_insurance.sql` against the frozen interfaces in
`CONTRACT.md`. Everything below follows the 0050/0058 vehicle-access patterns exactly:
SECURITY DEFINER functions with `SET search_path = pg_catalog, vehicle_access`, operator
gate via `vehicle_access.is_operator(int)`, idempotency keys matching
`^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`, append-only triggers via
`vehicle_access.prevent_rental_operations_mutation()`, events via
`vehicle_access.append_rental_operations_event(...)`, GRANT EXECUTE to role
`vehicle_access_service` guarded by `IF EXISTS(SELECT 1 FROM pg_roles ...)`.

## Spec summary

Three enums (`condition_phase`, `condition_grade`, `photo_zone`), five tables
(`insurance_tier` config; `contract_insurance_selection`, `condition_report`,
`condition_photo`, `return_settlement` append-only), seven SQL functions, and a
`CREATE OR REPLACE` of `vehicle_access.transition_contract` that is byte-identical to
the 0058 version except three added prerequisite gates (check-out report before
handover; check-in report and return settlement before close). The
`rental_operations_event.aggregate_type` CHECK is dropped and re-added with the extended
list adding `insurance_tier`, `condition_report`, `settlement`.

## Gap → feature mapping

| Identified gap | Closed by |
|---|---|
| Single-photo inspection (one object per handover/return, no zones, no per-zone damage flags) | `vehicle_access.condition_report` + `vehicle_access.condition_photo` (1–24 zone photos per phase, 10-zone enum, per-photo `damage_flag`, sha256 integrity, `UNIQUE(report_id, zone, sha256_hex)`), written atomically by `vehicle_access.record_condition_report`; `dashboard_odometer` zone photo is mandatory |
| No odometer monotonicity (check-in odometer could regress below check-out) | `vehicle_access.record_condition_report` rejects `p_odometer < check_out.odometer_km` with `23514 'odometer regression'`; `vehicle_access.compute_return_settlement` re-verifies and `return_settlement` enforces `CHECK (distance_km = odometer_in_km - odometer_out_km AND distance_km >= 0)` |
| No excess-km settlement (included km and per-km price captured at booking but never charged) | `vehicle_access.compute_return_settlement`: `billed_weeks = GREATEST(1, CEIL(epoch/604800))`, `included_km = included_km_per_week * billed_weeks` from the contract `price_snapshot`, `excess_km = GREATEST(0, distance - included_km)`, charge = `excess_km * excess_km_price_minor` with 0058-style bigint division-guard (`22003`) |
| Asset odometer never advances (`vehicle_asset.odometer_km` frozen at registration) | `vehicle_access.compute_return_settlement` updates `vehicle_asset.odometer_km` to the check-in reading inside the same transaction as the settlement insert, with the asset row locked `FOR UPDATE` |
| No insurance tiers (no coverage products, no deposit scaling, no damage-cap split) | `vehicle_access.insurance_tier` + `vehicle_access.create_insurance_tier` / `retire_insurance_tier` / `list_insurance_tiers_for_offer`; `vehicle_access.select_contract_insurance` snapshots the tier onto the contract and recomputes `deposit_minor = round(base_deposit * deposit_multiplier_bp / 10000)` (overflow-guarded), merging it into `access_contract.price_snapshot->'insurance'` |
| No damage delta (no way to attribute new damage to the rental) | `compute_return_settlement` computes `new_damage_zones` = damage-flagged zones at check-in EXCEPT damage-flagged zones at check-out; `vehicle_access.condition_delta_report` exposes the same delta plus odometer/fuel deltas and the settlement to the operator or the contract worker |

Lifecycle enforcement added on top: `transition_contract` now refuses `handover` without
a check-out condition report and refuses `close` without a check-in condition report and
a computed return settlement — so the evidence chain cannot be skipped.

## Function inventory

1. `create_insurance_tier(integer,uuid,text,text,char(3),bigint,bigint,bigint,bigint,boolean,integer,text,timestamptz) → uuid` — operator-only; provider must be `active`; idempotent replay via `rental_operations_event` (aggregate `insurance_tier`, actor + key lookup, mirrors `create_provider_location`).
2. `retire_insurance_tier(integer,uuid,text,timestamptz) → boolean` — operator-only; sets `active=false`; same-key replay returns true; already-retired with a new key raises `23505` (mirrors `cancel_availability_block`).
3. `select_contract_insurance(integer,uuid,uuid,text,timestamptz) → uuid` — contract worker only; state `requested|approved`; tier must be active and match contract provider and `price_snapshot->>'currency'`; deposit recomputed into the snapshot; same key + same tier replays to the existing selection id, same key + different tier raises `23505`, any second selection raises `23505`.
4. `list_insurance_tiers_for_offer(uuid,integer) → TABLE(...)` — STABLE sql; offer → provider active tiers, currency-matched, limit clamped to 1..24 (mirrors `list_rental_add_ons_for_offer`).
5. `record_condition_report(integer,uuid,condition_phase,integer,smallint,condition_grade,text,jsonb,text,timestamptz) → uuid` — contract worker OR operator; state gates per phase; photo payload validated element-wise (zone, object_key, content_type, sha256, boolean damage_flag, optional 3..500 note), duplicates rejected, `dashboard_odometer` required; odometer monotonicity for check-in; same-key replay returns existing id, different key for the same (contract, phase) raises `23505`.
6. `compute_return_settlement(integer,uuid,bigint,bigint,text,timestamptz) → uuid` — operator-only; requires `return_pending` and both condition reports; CEIL-week billing, included/excess km, damage split (`LEAST(damage, excess)` renter liability, `LEAST(GREATEST(damage - excess, 0), damage_cap)` insurance credit when a selection exists, else full renter liability and zero credit); bigint overflow guards in 0058 style; inserts `return_settlement`; advances `vehicle_asset.odometer_km`; emits both a `settlement` aggregate event and a contract `append_event`/`enqueue_event` pair; idempotent by contract + key.
7. `condition_delta_report(integer,uuid) → jsonb` — STABLE; operator or contract worker only (`42501` otherwise); returns `{contract_id, check_out, check_in, deltas, settlement}` with photos nested.
8. `transition_contract` — CREATE OR REPLACE, byte-identical to 0058 except the three gates described above (verified by diff against `drizzle/0058_gig_vehicle_rental_operations.sql`).

## Operator runbook

### Apply order

1. Confirm 0050 and 0058 are applied (`vehicle_access.rental_operations_event`,
   `prevent_rental_operations_mutation`, `append_rental_operations_event`,
   `is_operator`, `contract_agreement_acceptance` must exist). Migrations 0059–0095
   apply independently; nothing in 0096 depends on or conflicts with them.
2. Apply `drizzle/0096_rental_condition_insurance.sql` in a single transaction
   (`psql -1` / drizzle migrator). The migration is DDL + CREATE OR REPLACE only; no
   data backfill is required.
3. Post-check: `\d vehicle_access.return_settlement` shows both CHECK constraints;
   `pg_trigger` lists the four new `*_append_only` triggers; the
   `rental_operations_event_aggregate_type_check` constraint lists nine values.

### Rollback note

Rollback is destructive because the new tables hold evidence: `DROP TABLE
vehicle_access.condition_photo, vehicle_access.condition_report,
vehicle_access.contract_insurance_selection, vehicle_access.return_settlement,
vehicle_access.insurance_tier; DROP TYPE vehicle_access.condition_phase,
vehicle_access.condition_grade, vehicle_access.photo_zone;` then re-apply the 0058
`transition_contract` body (remove the three added gate lines) and restore the six-value
`aggregate_type` CHECK. Because `transition_contract` is replaced in place, applying
0058's function body again fully restores pre-0096 transition behavior. Do NOT roll back
once contracts have condition reports or settlements — the append-only evidence would
be lost.

### GRANT note

The closing `DO` block grants EXECUTE on the seven new functions and the replaced
`transition_contract` to `vehicle_access_service`, guarded by
`IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='vehicle_access_service')`. Unlike 0058,
0096 deliberately does **not** re-run blanket `REVOKE ALL ON ALL TABLES/FUNCTIONS IN
SCHEMA vehicle_access` statements: migrations 0059–0095 granted additional functions to
the service role, and a blanket revoke in 0096 would silently strip those grants. Table
access remains function-mediated only (no table GRANTs are added), matching the 0058
security posture.

## Verification performed

- Parsed with pglast/libpg_query (real PostgreSQL 17 grammar): 31 top-level statements,
  all valid (3 enum DO-blocks, 2 ALTER TABLE, 5 CREATE TABLE, 4 indexes, 4 DROP TRIGGER,
  4 CREATE TRIGGER, 8 CREATE OR REPLACE FUNCTION, 1 GRANT DO-block).
- `transition_contract` diffed against 0058: only the three contract-specified gate
  lines differ.
- `parse_plpgsql` body validation is unavailable in the packaged pglast build (fails on
  trivial valid bodies — tool defect, not a SQL defect); function bodies were
  hand-reviewed for BEGIN/END, paren, and dollar-quote balance instead.

## Photo upload endpoint (/api/rental-condition/photo)

Server endpoint consumed by the Expo app to upload check-out / check-in
condition evidence photos, implemented in `server/rental/conditionPhotoUpload.ts`
and mounted in `server/_core/index.ts` (after the global `express.json` parser
and the session middleware):

```ts
app.post("/api/rental-condition/photo", rateLimit(30), handleRentalConditionPhotoUpload);
```

### Contract

Request: `POST /api/rental-condition/photo`,
`content-type: application/json`, `authorization: Bearer <session token>`

```json
{ "objectKey": "rental-condition/<contract-uuid>/<check_out|check_in>/<view>-<16 hex>.<jpg|jpeg|png|webp>",
  "contentType": "image/jpeg | image/png | image/webp",
  "contentBase64": "<strict base64, no whitespace>" }
```

Responses:

| Status | Body | Meaning |
|---|---|---|
| 201 | `{objectKey, sha256Hex, sizeBytes}` | stored (atomic temp-write + rename) |
| 200 | `{objectKey, sha256Hex, sizeBytes, reused: true}` | idempotent retry, identical bytes already stored |
| 400 | `{error:"invalid_object_key"}` | key fails the strict shape / traversal guard |
| 400 | `{error:"invalid_content_type"}` | contentType not allowlisted or disagrees with the key extension |
| 400 | `{error:"invalid_content_base64"}` | base64 not strict / decodes to zero bytes |
| 401 | `{error:"unauthorized"}` | no authenticated session |
| 409 | `{error:"object_key_conflict"}` | key already exists with different bytes |
| 413 | `{error:"photo_too_large"}` | decoded payload over 6,000,000 bytes |
| 503 | `{error:"photo_storage_not_configured"}` | `RENTAL_CONDITION_UPLOAD_DIR` unset |
| 500 | `{error:"photo_upload_failed"}` | internal failure (logged with `[SwitchOS]` prefix) |

### Auth

Any authenticated session user may upload (drivers and renters, not just
operators). The session middleware resolves `req.user` from
`Authorization: Bearer` (external JWT, then local session JWT) or the session
cookie, rejects revoked sessions, and unifies the identity onto `public.users`.
Authorization on the evidence itself happens later inside
`vehicle_access.record_condition_report`, which checks contract participation.

### Size cap

Decoded payload cap is **6,000,000 bytes**. The global JSON body limit is
`ENV.apiBodyLimit` (default `"10mb"`); base64 inflates bytes by ~4/3, so 6MB
decoded ≈ 8MB base64, which fits safely under the 10mb envelope together with
the JSON framing.

### Idempotency and conflicts

Uploads are keyed by `objectKey` (the mobile client embeds a 16-hex random
digest per capture). A retry with identical bytes returns 200 `reused:true`
(verified via sha256 of the stored file); the same key with different bytes is
rejected with 409 `object_key_conflict` and the existing file is never
overwritten. New files are written to `<file>.tmp-<pid>-<rand>` and renamed
into place so readers never observe partial content.

### Deploy checklist addition

- [ ] Set `RENTAL_CONDITION_UPLOAD_DIR` to the durable evidence volume
      (absolute path; created recursively on demand). If unset/empty the
      endpoint fails closed with 503 — there is no implicit default directory.
- Ensure the volume is included in backup/retention policy for condition
      evidence, since `record_condition_report` references these object keys.

### Verification performed

- `tests/rental-condition-photo-upload.test.ts` (vitest, 16 tests): key-shape
  accept/reject matrix (traversal, absolute paths, wrong phase, missing digest
  suffix, bad extension), content-type/extension agreement, strict base64
  rejection (whitespace/bad chars/empty), 6,000,000-byte cap boundary
  (at-cap accepted, +1 byte → 413), store idempotency (201 → 200 reused →
  409 conflict), fail-closed 503 with unset root, and handler-level 401/503.
- `npx tsc --noEmit --strict` clean over the new module, tests, and the
  patched `env.ts` (sandbox stubs for `operationalEvents`/`trpc` only).
