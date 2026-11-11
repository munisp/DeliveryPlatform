# Vehicle-Rental Vertical ("vehicle_access" / rental) — Production-Readiness Scorecard

Repo: github.com/munisp/DeliveryPlatform, branch `main`, HEAD `358b813f64f64f5734537b2bbe34ba1ab53ee16c` (verified via `/commits/main`).
Method: byte-exact fetches of every file in scope; cross-checks of mounts/imports/callers; behavioral execution of the pure-JS SHA-256 and the billed-weeks formula under Node 20. No live database was available — see "Not verifiable" at the end.

## Dimension scores (0–10, equal weights)

| # | Dimension | Score | One-line justification |
|---|-----------|-------|------------------------|
| 1 | Schema integrity | **9** | CHECKs on every money/bounds column, append-only triggers on all four 0096 evidence tables, odometer monotonicity + `CHECK (distance_km = odometer_in_km − odometer_out_km AND >= 0)`, bigint overflow guards (`22003`), partial unique index for one-open-dispute, coherent status/decided CHECKs; minor: CHECK re-add without `NOT VALID`, mutable dispute table (documented design). |
| 2 | Authorization | **8** | SQL is the authority everywhere (`is_operator` = `public.users.role='admin'`, worker/renter equality checks inside every SECURITY DEFINER fn; tables REVOKED from PUBLIC, EXECUTE-only grants); deductions: REST photo download is any-authenticated-user (no party check), new routers use plain `protectedProcedure` (role∈{admin,operator,ops}) vs the base router's `operatorMutationProcedure("operate")` policy layer. |
| 3 | Idempotency | **8** | Unique idempotency keys + replay-return semantics in every mutating SQL fn, `ON CONFLICT DO NOTHING` in event/outbox/enqueue paths, upload 200-reused/409-conflict, `FOR UPDATE SKIP LOCKED` claim; deductions: `decide_settlement_dispute` replay ignores parameter mismatch (same key + different decision returns success), `open_settlement_dispute` key replay not bound to the supplied contract, PWA generates a fresh key per submit click (only react-query's internal retry shares it; mobile uses stable `useRef` keys). |
| 4 | Money correctness | **8** | Integer minor units (`bigint`) end-to-end, `total = excess_km + fuel + renter_liability` CHECK, damage split `LEAST/LEAST-GREATEST` mirrored exactly in `server/rental/settlementMath.ts` (executed: billed-weeks TS≡SQL over 100k random offsets; rounding half-up equivalence holds for non-negative values), adjustment ceiling overflow-proof via settlement CHECK; deductions: dispute reason enum includes `fuel_charge` but the adjustment ceiling (`renter_damage_liability + excess_km_charge`) excludes `fuel_charge_minor`, so a pure fuel dispute can never be adjusted; JS `Number()` coercion of bigint columns (bounded by `.safe()` inputs, but unenforced at DB read). |
| 5 | Evidence chain | **6** | Working chain capture→pure-JS SHA-256 (verified against 4 FIPS 180-4 vectors incl. 1 MB)→upload (atomic tmp+rename, server-side hash, 200-reused/409-conflict)→SQL append-only→operator delta view; deductions: three-way content-type mismatch (REST allows jpeg/png/webp; DB CHECK allows jpeg/png/heic; mobile produces jpeg/png/**heic** → iOS HEIC captures fail upload with 400, and webp uploads can never be referenced in a report), server never verifies the recorded sha256 against stored bytes (client-asserted binding), upload not bound to contract party, PWA has no upload UI — operators hand-type object key + hash. |
| 6 | Event/notification flow | **6** | Dual-channel events (`rental_operations_event` + `contract_event` + `outbox_event`) on every mutation, real consumer (`vehicleAccessOutboxSweepJob` → `claim_outbox_events` SKIP LOCKED, batched contacts, operator emails on open / renter email-SMS on decision); deductions: no in-repo scheduling (external cron required; documented), claim-then-send = at-most-once notification (crash/failed send after claim is lost forever), **all other event types (incl. `settlement_computed` and every contract lifecycle event) are claimed, marked `published_at`, and silently dropped — the "forward-compatible" comment is wrong**, notification renders adjustment with hardcoded `/100` currency exponent. |
| 7 | API surface | **8** | 3 tRPC routers mounted in `server/routers.ts` (verified), REST POST+GET `/api/rental-condition/photo` mounted after `express.json` + global session middleware with `rateLimit(30)`/`rateLimit(120)` (60 s window, Redis w/ local fallback, fail-closed 500), strict zod mirrors of SQL regexes/bounds, fail-closed 503 when `RENTAL_CONDITION_UPLOAD_DIR` unset; deductions: no rate limit on the tRPC rental mutations themselves, `rentalDispute.get` has no caller (redundant with `list`), `rentalInsurance.listForOffer` is `publicProcedure` (unguessable UUID offer ids; pricing exposure only). |
| 8 | Client coverage | **6** | PWA complete: 4 `Rental*` components mounted in `/vehicle-access` page (App.tsx route verified), every server procedure except `rentalDispute.get` has a PWA caller; mobile has full capture/settlement/dispute code but **no in-app navigation to `/rental-condition`, `/rental-settlement`, `/kyc-document-capture` (deep-link-only orphan screens) and `InsuranceTierPicker` + `useSelectContractInsurance` have no host screen — mobile workers cannot select insurance**; PWA tier manager shows "Lock onto contract" (worker-only per SQL) to operators, who will always get 42501. |
| 9 | Test coverage realism | **6** | 102 `it`s across 5 files: genuinely behavioral for `settlementMath` (boundaries, overflow), photo upload/download (traversal matrix, 6 MB boundary ±1 byte, idempotent re-store, tmpfs-backed), outbox sweep (mocked pool but behavioral JS), router zod/authz gates via `createCaller`; but migration tests are static string pins, and there are **zero live-DB integration tests** for the SQL authority functions (idempotency races, odometer monotonicity, append-only triggers, adjustment ceiling, SKIP LOCKED) even though a DB-backed harness (`scripts/run-db-backed-integration-tests.sh`) exists for other verticals; no test guards the heic/webp cross-layer mismatch. |
| 10 | Operability | **6.5** | Strong runbook in `validation/rental_condition_insurance_20261110.md` (apply order, post-checks, rollback procedure, GRANT rationale, deploy checklist, sweep scheduling note); deductions: no down-migrations for 0096–0099 (`drizzle/rollback/` stops at 0024), `RENTAL_CONDITION_UPLOAD_DIR` absent from `.env.example`, no in-repo cron for the sweep, `db:push` (`drizzle-kit migrate`) cannot apply these hand-authored files (no root `drizzle/meta/_journal.json` — CI shell scripts do), CHECK drop/re-add on `rental_operations_event` takes ACCESS EXCLUSIVE + full-table validation scan (no `NOT VALID`) — fine small, a lock hazard on a large live table. |

**Overall (equal weights): (9 + 8 + 8 + 8 + 6 + 6 + 8 + 6 + 6 + 6.5) / 10 = 7.15 / 10 (71.5 / 100).**

## Wiring-break results

Verified sound:
- HEAD = 358b813f ✓. All 6 migrations present ✓ (0096–0099 contiguous after 0095).
- `rentalInsurance`, `rentalCondition`, `rentalDispute` imported and mounted in `server/routers.ts`; `vehicleAccess` router present ✓.
- `handleRentalConditionPhotoUpload/Download` imported and mounted in `server/_core/index.ts` after `express.json` and global session middleware ✓.
- `vehicleAccessOutboxSweepJob` exported, registered in `jobs` map and in `server/db.ts` `jobMap` (`triggerJobManually`) ✓.
- `server/rental/disputes.ts` imports `../_core/vehicleDispute` — exists (not in the original scope list; no missing file) ✓.
- Every tRPC procedure has at least one caller except `rentalDispute.get`.
- Mobile SHA-256/base64 code executes correctly (FIPS vectors pass) ✓.

Breaks / orphans found:
1. **(P1) heic/webp three-way content-type mismatch** — `conditionPhotoUpload.ts` key regex `(jpg|jpeg|png|webp)` + content types `{jpeg,png,webp}`; DB `condition_photo.content_type` CHECK `(image/jpeg,image/png,image/heic)`; mobile `normalizeContentType` emits heic. iOS HEIC captures produce `.heic` keys → 400 `invalid_object_key`/`invalid_content_type` at upload; webp uploads succeed but `record_condition_report` rejects them (`22023`). Two dead ends.
2. **(P1) Mobile insurance selection unwired** — `InsuranceTierPicker.tsx` and `useSelectContractInsurance` have no host screen (search confirms zero importers); mobile workers cannot select insurance.
3. **(P1) Mobile rental screens are deep-link-only** — no `router.push`/`href` anywhere in `mobile/switchos-native` targets `/rental-condition`, `/rental-settlement`, or `/kyc-document-capture`.
4. **(P2) Outbox consumer drops non-dispute events** — sweep claims batches of `vehicle_access.outbox_event` and marks everything `published_at`; `settlement_computed`, `contract.approved/activated/...` are permanently consumed with no handler and no notification (renter is never notified their settlement exists).
5. **(P2) `rentalDispute.get`** — server procedure with zero callers (harmless; `list` returns full rows).
6. **(P2) PWA "Lock onto contract" for operators** — `selectTier` requires the contract worker in SQL (`42501`); the operator console renders the button unconditionally (fail-closed but dead affordance).
7. **(P3) `db:push` script** — `drizzle-kit migrate` requires `drizzle/meta/_journal.json`, which does not exist at repo root; hand-authored SQL is applied by CI shell scripts instead. Two divergent migration paths.

## Security findings

- **(P2) Photo download authorization**: `GET /api/rental-condition/photo/*` requires only *any* authenticated session — no contract-party or operator check. Keys carry ~64 bits of sha-derived entropy (unguessable), but any key leak (logs, screenshots, browser history) makes the evidence readable by any signed-in user. Same posture on upload (no contract-party binding; any authed user can write 6 MB objects under any contract's key namespace — storage pollution, 30/min/IP limited).
- **(P2) Hash binding is client-asserted**: `record_condition_report` accepts `sha256_hex` from the caller; the server never compares it to the hash it computed at upload. A party can bind a report row to an object key with a fabricated digest. EXIF is stripped at capture (`exif: false`), so no capture-time/location attestation exists at all.
- **(P3) App/SQL role mismatch (fail-closed)**: `protectedProcedure` admits roles `{admin, operator, ops}`; SQL `is_operator` requires `role='admin'`. `operator`/`ops` users pass the tRPC gate and always error at SQL. Not exploitable, but confusing; also the new rental routers bypass the `operatorMutationProcedure("operate")` policy layer the base `vehicleAccess` router uses.
- **(P2) Idempotency-mismatch blind spots**: `decide_settlement_dispute` same-key replay returns success without checking the decision parameters match; `open_settlement_dispute` same-key replay returns a dispute id without checking it belongs to the supplied contract (key values are exposed in list/get payloads to their owners and operators).
- **No injection / traversal found**: all queries parameterized, `SET search_path = pg_catalog, …` on every function, strict key regex + `..`/`\`/absolute rejects + `startsWith(resolvedRoot + sep)` containment on photo paths (traversal matrix unit-tested).
- **PII**: dispute detail/notes visible only to renter + operator (SQL-enforced); OCR audit events exclude field values; sweep operator fan-out capped at 10 emails. Photo evidence PII exposure limited by the download authz gap above.

## Residual gaps (severity)

- **P0**: none found.
- **P1**: (a) heic/webp content-type triangle (breaks iOS HEIC capture upload; webp upload dead-ends at record time); (b) mobile rental/KYC screens unreachable from in-app navigation; (c) mobile insurance selection orphaned (no host for `InsuranceTierPicker`/`useSelectContractInsurance`); (d) no live-DB integration tests for any SQL authority function despite an existing harness.
- **P2**: photo download lacks party-level authz; recorded sha256 never verified against stored bytes; outbox sweep drops all non-dispute events and is at-most-once; no in-repo cron for the sweep; fuel-charge disputes can never be adjusted (ceiling excludes `fuel_charge_minor`); idempotency replay blind spots in dispute open/decide; PWA per-click fresh idempotency keys; no tRPC rate limits; `RENTAL_CONDITION_UPLOAD_DIR` missing from `.env.example`; no down-migrations 0096–0099; drizzle journal absent vs `db:push` script; CHECK swap without `NOT VALID` on a live traffic table; notification currency exponent hardcoded `/100`.
- **P3**: app-level vs SQL-level operator role mismatch; `rentalDispute.get` unused; public `listForOffer`; PWA operator sees always-failing "Lock onto contract".

## Not verifiable without a live database

- Actual firing of CHECK constraints, append-only triggers, partial unique index, and `FOR UPDATE SKIP LOCKED` claim semantics (concurrent sweep safety).
- Race behavior of idempotency replay under concurrent requests (analysis says row locks make them safe; unproven).
- Whether the runtime DB role for the main/satellite pools actually is `vehicle_access_service` (grants are conditional `IF EXISTS pg_roles`; role mapping is deployment config).
- Real end-to-end behavior of `transition_contract` gates, `compute_return_settlement` arithmetic vs. its TS mirror, and migration apply time/lock impact of 0096–0098 on a populated `rental_operations_event` table.
- CI green status of the 5 test files (tests were read and their logic spot-executed, but the suite was not run against this checkout).

## Outbox claim filter (migration 0100)

Two verified findings fixed in this wave:

1. **(P2, fixed) Outbox sweep silently drops non-dispute events** — 0098's
   `vehicle_access.claim_outbox_events` claimed ALL unpublished
   `outbox_event` rows and marked them `published_at`, while the sweep only
   handles `vehicle_access.contract.settlement_dispute_opened` /
   `..._settlement_dispute_decided`; every other event (e.g.
   `settlement_computed`) was permanently consumed and dropped. New migration
   `drizzle/0100_outbox_claim_event_filter.sql` replaces the function
   (identical signature/return shape, same SECURITY DEFINER + search_path +
   guarded GRANT conventions; CREATE OR REPLACE preserves existing grants)
   and narrows the claim subquery with
   `AND p.event_type IN ('vehicle_access.contract.settlement_dispute_opened','vehicle_access.contract.settlement_dispute_decided')`.
   Unknown events intentionally remain unpublished for future consumers.
   pglast-validated (2 statements: CreateFunctionStmt, DoStmt). Static pin
   added to `tests/vehicle-access-outbox-sweep.test.ts`; the mocked sweep
   tests still verify claiming goes through `claim_outbox_events`.

2. **(P1, fixed) webp evidence never OCR-extracted** —
   `stakeholderVerification.recordEvidence` in `server/routers.ts` fired
   MiniCPM-OCR auto-extraction only for `image/jpeg` / `image/png`, although
   `server/_core/documentOcr.ts` also accepts `image/webp`, so webp evidence
   was silently never extracted. Added `image/webp` to the extraction-fire
   condition (minimal one-condition diff, roundtrip-verified against base
   blob 2411db81; new blob 21d7c877). Router pin in
   `tests/document-extraction.test.ts` updated to assert the webp condition.
   Note: this closes only the extraction half of the heic/webp content-type
   triangle; the upload-side content-type acceptance is unchanged.

Validation: vitest 66/66 across the four wave test files
(document-ocr, document-extraction, terrio-etl, vehicle-access-outbox-sweep);
`tsc --noEmit --strict` clean over the changed TS and its dependency graph.

## P2 closure (migration 0101 + evidence verification)

Two P2 security findings fixed in this wave:

1. **(P2, fixed) Photo sha256 was client-asserted, never server-verified** —
   `rentalCondition.recordReport` now verifies evidence before calling the
   data-access layer: for every photo whose objectKey matches the
   rental-condition upload namespace, the file must exist under
   `ENV.rentalConditionUploadDir` (resolved via the same traversal-defended
   `resolveConditionPhotoPath`) and the sha256 of the stored bytes must equal
   the claimed `sha256Hex` — mismatch → `BAD_REQUEST evidence_hash_mismatch`,
   missing object → `BAD_REQUEST evidence_not_uploaded`, per-photo checks
   batched with `Promise.all`. Fail-closed: when
   `ENV.rentalConditionUploadDir` is unset the submission fails with
   `PRECONDITION_FAILED photo_storage_not_configured` (photos cannot have
   been uploaded through our endpoint, so every namespaced claim is
   unverifiable). Photos with keys outside our namespace (external object
   stores) pass through unchanged — out of scope, we cannot re-hash what we
   do not host. The verifier (`verifyConditionPhotoEvidence`) is exported
   from `server/rental/conditionPhotoUpload.ts` next to the resolver it
   reuses.

2. **(P2, fixed) Photo download was any-authenticated-user** —
   `GET /api/rental-condition/photo/<key>` is now party-gated. After key
   validation the handler extracts the contract id from the key's second
   path segment and calls the new SECURITY DEFINER STABLE function
   `vehicle_access.can_view_contract_evidence(actor, contract)`
   (drizzle/0101; true iff operator via `is_operator` or actor =
   `access_contract.worker_user_id`) through a lazy satellite pool that
   mirrors `server/_core/vehicleCondition.ts` (application_name
   `vehicle-condition`, max 3 connections, 10 s statement timeout). Denied →
   `403 {error:"forbidden"}`; gate failure → `500` (fail closed, never
   serve). The gate is exported separately (`canViewConditionPhoto`) for
   mock-pool unit tests.

3. **(P2-adjacent, fixed) Dispute adjustment ceiling excluded the fuel
   charge** — drizzle/0101 CREATE OR REPLACEs
   `vehicle_access.decide_settlement_dispute` so an 'adjusted' decision may
   cover `renter_damage_liability_minor + excess_km_charge_minor +
   fuel_charge_minor` (= `total_charge_minor` by the 0096 settlement CHECK);
   `dispute_reason` already included `'fuel_charge'`, so a legitimate fuel
   overcharge could never be fully adjusted. Every other line of the
   function (validation, error codes, event payloads, idempotency) is
   byte-identical to 0097 — pinned by test. Grants for both functions are
   guarded behind the `pg_roles` existence check mirroring 0096/0098. pglast
   parses 0101 as 3 statements (CreateFunctionStmt, CreateFunctionStmt,
   DoStmt).

Ops gap closed alongside: `.env.example` now documents
`RENTAL_CONDITION_UPLOAD_DIR`, `TERRIO_BIN`, `TERRIO_TIMEOUT_MS`,
`MINICPM_OCR_OLLAMA_URL`, `MINICPM_OCR_MODEL`, `MINICPM_OCR_JEV_ENABLED`,
`MINICPM_OCR_JEV_MODEL`, `MINICPM_OCR_REVIEW_THRESHOLD` (one-line comments,
secrets-free, appended in their thematic sections).

Score impact estimate: **Authorization 8 → 9** (both deductions tied to the
photo endpoints are closed; the `protectedProcedure` vs
`operatorMutationProcedure` policy-layer gap remains). **Money correctness
8 → 8** (fuel-ceiling fix removes the under-adjustment gap but the remaining
deductions stand). **Idempotency 8 → 8** (unchanged; the same-key replay
blind spots are a separate open P2). The two closed P2 security findings
leave one open P2 (idempotency-mismatch blind spots) and one P3 (app/SQL
role mismatch, fail-closed).

Validation: vitest 182/182 (164 pre-existing wave tests incl. the 66
geo-ai-wave suite, + 18 new: evidence hash verification, download party
gate, 0101 static pins); `tsc --noEmit --strict` clean over the changed
files and their harness dependency graph.
