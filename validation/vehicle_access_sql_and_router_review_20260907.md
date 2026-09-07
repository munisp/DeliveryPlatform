# Vehicle-Access SQL and Router Review

**Source of truth:** `drizzle/0050_gig_worker_vehicle_access.sql` and `server/routers.ts` in the isolated commerce worktree, reviewed 2026-09-07.

## Exact asset activation code

```sql
CREATE OR REPLACE FUNCTION vehicle_access.activate_asset(p_actor integer,p_asset uuid,p_key text,p_now timestamptz DEFAULT clock_timestamp())
RETURNS vehicle_access.asset_state LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,vehicle_access AS $$
DECLARE v_state vehicle_access.asset_state;
BEGIN
  IF NOT vehicle_access.is_operator(p_actor) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE='42501'; END IF;
  SELECT state INTO v_state FROM vehicle_access.vehicle_asset WHERE id=p_asset FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'asset not found' USING ERRCODE='P0002'; END IF;
  IF v_state='available' THEN RETURN v_state; END IF;
  IF v_state<>'intake' OR EXISTS (SELECT 1 FROM unnest(ARRAY['registration','roadworthiness','commercial_cover','ownership_authority','inspection']) AS required(kind) WHERE NOT EXISTS (SELECT 1 FROM vehicle_access.asset_document_evidence e WHERE e.asset_id=p_asset AND e.kind=required.kind AND (e.expires_at IS NULL OR e.expires_at>p_now))) THEN RAISE EXCEPTION 'required valid asset evidence missing' USING ERRCODE='23514'; END IF;
  UPDATE vehicle_access.vehicle_asset SET state='available',compliance_verified_at=p_now,updated_at=p_now WHERE id=p_asset;
  RETURN 'available';
END; $$;
```

## Exact contract/asset transition code

```sql
IF p_action='cancel' AND p_actor=v_contract.worker_user_id AND v_contract.state IN ('requested','approved') THEN
  IF p_reason IS NULL OR length(p_reason) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'cancellation reason required' USING ERRCODE='22023'; END IF;
  v_next='cancelled'; v_event='vehicle_access.contract.cancelled';
  IF v_contract.state='approved' THEN UPDATE vehicle_access.vehicle_asset SET state='available',updated_at=p_now WHERE id=v_contract.asset_id; END IF;
ELSIF p_action='begin_return' AND p_actor=v_contract.worker_user_id AND v_contract.state='active' THEN
  v_next='return_pending'; v_event='vehicle_access.contract.return_pending'; UPDATE vehicle_access.vehicle_asset SET state='return_pending',updated_at=p_now WHERE id=v_contract.asset_id;
ELSIF NOT vehicle_access.is_operator(p_actor) THEN RAISE EXCEPTION 'operator role required' USING ERRCODE='42501';
ELSIF p_action='approve' AND v_contract.state='requested' THEN
  IF NOT EXISTS(SELECT 1 FROM vehicle_access.vehicle_asset WHERE id=v_contract.asset_id AND state='available') THEN RAISE EXCEPTION 'asset unavailable' USING ERRCODE='23514'; END IF;
  v_next='approved'; v_event='vehicle_access.contract.approved'; UPDATE vehicle_access.vehicle_asset SET state='reserved',updated_at=p_now WHERE id=v_contract.asset_id;
ELSIF p_action='handover' AND v_contract.state='approved' THEN
  IF NOT EXISTS(SELECT 1 FROM vehicle_access.inspection_evidence WHERE contract_id=p_contract AND kind='handover') THEN RAISE EXCEPTION 'handover inspection required' USING ERRCODE='23514'; END IF;
  v_next='active'; v_event='vehicle_access.contract.activated'; UPDATE vehicle_access.vehicle_asset SET state='active_access',updated_at=p_now WHERE id=v_contract.asset_id;
ELSIF p_action='close' AND v_contract.state='return_pending' THEN
  IF NOT EXISTS(SELECT 1 FROM vehicle_access.inspection_evidence WHERE contract_id=p_contract AND kind='return') THEN RAISE EXCEPTION 'return inspection required' USING ERRCODE='23514'; END IF;
  v_next='closed'; v_event='vehicle_access.contract.closed'; UPDATE vehicle_access.vehicle_asset SET state='available',updated_at=p_now WHERE id=v_contract.asset_id;
ELSIF p_action='suspend' AND v_contract.state IN ('approved','active','return_pending') THEN
  IF p_reason IS NULL OR length(p_reason) NOT BETWEEN 3 AND 1000 THEN RAISE EXCEPTION 'suspension reason required' USING ERRCODE='22023'; END IF;
  v_next='suspended'; v_event='vehicle_access.contract.suspended'; UPDATE vehicle_access.vehicle_asset SET state='safety_hold',updated_at=p_now WHERE id=v_contract.asset_id;
ELSIF p_action='begin_safe_return' AND v_contract.state='suspended' THEN
  v_next='return_pending'; v_event='vehicle_access.contract.return_pending'; UPDATE vehicle_access.vehicle_asset SET state='return_pending',updated_at=p_now WHERE id=v_contract.asset_id;
ELSE RAISE EXCEPTION 'invalid contract transition' USING ERRCODE='23514'; END IF;
```

The full function then atomically updates the contract state/timestamps, appends an immutable event, and enqueues one outbox event before returning the new state. `FOR UPDATE` on the contract serializes competing transitions.

## Exact conflict-prevention constraint

```sql
EXCLUDE USING gist (asset_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)
  WHERE (state IN ('approved','active','return_pending'))
```

A single asset therefore cannot have overlapping time ranges in any state that reserves, operates, or awaits return. The `request_contract` function additionally locks the selected active offer, validates the asset is available, validates verified worker eligibility and category overlap, enforces the minimum term, and writes the requested contract plus events. At approval, it checks the asset is still `available` while the contract is locked before changing it to `reserved`.

## Exact price snapshot code

```sql
INSERT INTO vehicle_access.access_contract(worker_user_id,provider_id,asset_id,offer_id,starts_at,ends_at,price_snapshot,created_at,updated_at)
VALUES(p_worker,v_offer.provider_id,v_offer.asset_id,v_offer.id,p_starts,p_ends,jsonb_build_object('currency',v_offer.currency,'weekly_price_minor',v_offer.weekly_price_minor,'deposit_minor',v_offer.deposit_minor,'included_km_per_week',v_offer.included_km_per_week,'excess_km_price_minor',v_offer.excess_km_price_minor),p_now,p_now) RETURNING id INTO v_id;
```

This captures terms at request time rather than relying on a subsequently mutable offer. It does **not** authorize, charge, settle, or split payments.

## Router authorization path

The tRPC router applies `authenticatedProcedure` to offer listing, the worker’s own contract listing, contract request, inspection capture, and the worker-permitted `begin_return`/`cancel` actions. In each mutation, `ctx.user!.id` is passed as `workerUserId` or `actorUserId`, rather than accepting an arbitrary user identifier from the request. Inputs are bounded with UUID, date-time, SHA-256, enum, numeric maximum, and idempotency-key validation.

The more sensitive provider creation, worker verification, asset registration, asset-evidence recording, asset activation, and vehicle-offer creation endpoints use `protectedProcedure`. The PostgreSQL security-definer functions repeat `vehicle_access.is_operator(p_actor)` authorization, with a restricted `pg_catalog, vehicle_access` search path. Database function checks remain decisive if the application router is bypassed or misconfigured.

## Evidence boundary

The code and lifecycle were validated only in a uniquely named local PostgreSQL/PostGIS database and against source/build checks. The review is not evidence of commercial vehicle licensing, insurance, payment approval, identity verification, production database migration, or live vehicle operation.
