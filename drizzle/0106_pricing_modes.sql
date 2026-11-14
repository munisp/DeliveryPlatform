-- Flexible pricing modes (P7, lead-approved migration exception per
-- P7_SPEC.md; same exception class as 0105): commission / flat_fee /
-- zero_commission / subsidized pricing on the ride-hailing substrate.
--
-- Trigger: THROO_COMPARISON.md §4 — zero-commission + flat-fee models are a
-- live market wedge (Throo/TADA) with Nigeria named as a target market. The
-- versioned, zone-scoped, operator-approved fare_rule_version table gains a
-- pricing block so a market can run any of four pricing models without a
-- schema rewrite.
--
-- What changes:
--   a. mobility.fare_rule_version gains pricing_model
--      ('commission'|'flat_fee'|'zero_commission'|'subsidized', default
--      'commission'), platform_fee_flat_kobo (required iff flat_fee), and
--      platform_fee_payer ('rider'|'driver', default 'rider').
--   b. mobility.fare_quote gains platform_fee_kobo (default 0). The
--      table-level total CHECK is REPLACED: the old identity
--      (total = base+distance+time+demand+taxes_and_fees) becomes
--        total = base+distance+time+demand+taxes_and_fees
--         OR total = base+distance+time+demand+taxes_and_fees+platform_fee
--      IDENTITY CHANGE, documented: a RIDER-PAID platform fee is inside
--      total_kobo (the rider pays fare + fee; rider_total = total_kobo
--      always); a DRIVER-PAID platform fee is recorded on the quote row but
--      sits OUTSIDE total_kobo (the rider pays the bare fare; the fee comes
--      out of the driver share at settlement). fare_quote carries no payer
--      column (the payer is a property of the fare rule version, referenced
--      via fare_rule_id), so the CHECK admits both identities.
--   c. public.take_rate_registry rate_bps CHECK widens from
--      BETWEEN 0 AND 5000 to BETWEEN -2000 AND 5000: a negative rate down to
--      -20% is a BOUNDED subsidy (the platform pays the driver a bonus of
--      |rate| x gross on top of the fare); +50% remains the commission
--      ceiling.
--   d. mobility.trip_settlement gains platform_fee_kobo (default 0) and
--      fee_payer ('rider'|'driver', default 'rider'). The commission CHECK
--      is REPLACED with platform_commission_kobo >= -1 * gross_fare_kobo
--      (subsidy bounded by the fare). The identity CHECK is REPLACED with
--        gross = driver_earnings + commission + tax
--               + (platform_fee_kobo when fee_payer = 'driver')
--      BOTH IDENTITIES, documented: driver-paid fees come out of the driver
--      share (inside the identity); rider-paid fees sit OUTSIDE gross — the
--      settlement row carries platform_fee_kobo for reporting, and
--      settlement gross_fare_kobo is the fare portion only, even though the
--      rider-facing quote total included the fee. For legacy rows
--      (platform_fee_kobo = 0) the new identity reduces to the old one.
--
-- The entire file is idempotent: every ALTER is guarded (IF NOT EXISTS,
-- DROP CONSTRAINT IF EXISTS, pg_constraint DO blocks). The old CHECK drops
-- match on the constraint DEFINITION (pg_get_constraintdef) and only match
-- constraints that predate this migration (they exclude any definition
-- already referencing platform_fee_kobo / the widened bounds), so a
-- double-run is a no-op.
--
-- Reversal (no down-migration required by program precedent; manual steps):
--   ALTER TABLE mobility.trip_settlement DROP CONSTRAINT
--     trip_settlement_identity_check, ... ; re-add the 0026 definitions;
--   ALTER TABLE mobility.fare_quote DROP CONSTRAINT fare_quote_total_check;
--   re-add the 0026 total identity; ALTER TABLE public.take_rate_registry
--   DROP CONSTRAINT take_rate_registry_rate_bps_check; re-add
--   BETWEEN 0 AND 5000; then DROP the new columns. Reversal is only safe
--   when no flat_fee/subsidized rows exist.

BEGIN;

-- ---------------------------------------------------------------------------
-- a. fare_rule_version: pricing block
-- ---------------------------------------------------------------------------

ALTER TABLE mobility.fare_rule_version
  ADD COLUMN IF NOT EXISTS pricing_model text NOT NULL DEFAULT 'commission';
ALTER TABLE mobility.fare_rule_version
  ADD COLUMN IF NOT EXISTS platform_fee_flat_kobo bigint;
ALTER TABLE mobility.fare_rule_version
  ADD COLUMN IF NOT EXISTS platform_fee_payer text NOT NULL DEFAULT 'rider';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'mobility.fare_rule_version'::regclass
      AND conname = 'fare_rule_version_pricing_model_check'
  ) THEN
    ALTER TABLE mobility.fare_rule_version
      ADD CONSTRAINT fare_rule_version_pricing_model_check
      CHECK (pricing_model IN ('commission', 'flat_fee', 'zero_commission', 'subsidized'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'mobility.fare_rule_version'::regclass
      AND conname = 'fare_rule_version_platform_fee_flat_kobo_check'
  ) THEN
    ALTER TABLE mobility.fare_rule_version
      ADD CONSTRAINT fare_rule_version_platform_fee_flat_kobo_check
      CHECK (platform_fee_flat_kobo IS NULL OR platform_fee_flat_kobo >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'mobility.fare_rule_version'::regclass
      AND conname = 'fare_rule_version_platform_fee_payer_check'
  ) THEN
    ALTER TABLE mobility.fare_rule_version
      ADD CONSTRAINT fare_rule_version_platform_fee_payer_check
      CHECK (platform_fee_payer IN ('rider', 'driver'));
  END IF;
END $$;

-- Fee-required invariant, expressible as a CHECK: the flat_fee model must
-- carry a flat fee and no other model may (existing commission rows are
-- NULL and therefore pass).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'mobility.fare_rule_version'::regclass
      AND conname = 'fare_rule_version_flat_fee_required_check'
  ) THEN
    ALTER TABLE mobility.fare_rule_version
      ADD CONSTRAINT fare_rule_version_flat_fee_required_check
      CHECK ((pricing_model = 'flat_fee') = (platform_fee_flat_kobo IS NOT NULL));
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- b. fare_quote: platform_fee_kobo + REPLACED total identity
-- ---------------------------------------------------------------------------

ALTER TABLE mobility.fare_quote
  ADD COLUMN IF NOT EXISTS platform_fee_kobo bigint NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'mobility.fare_quote'::regclass
      AND conname = 'fare_quote_platform_fee_kobo_check'
  ) THEN
    ALTER TABLE mobility.fare_quote
      ADD CONSTRAINT fare_quote_platform_fee_kobo_check
      CHECK (platform_fee_kobo >= 0);
  END IF;
END $$;

-- Drop the 0026 total identity. It is an unnamed table-level CHECK, so match
-- by definition: it references the fare components and total, and (unlike
-- the replacement below) does NOT reference platform_fee_kobo.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'mobility.fare_quote'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%total_kobo%'
      AND pg_get_constraintdef(oid) LIKE '%taxes_and_fees_kobo%'
      AND pg_get_constraintdef(oid) NOT LIKE '%platform_fee_kobo%'
  LOOP
    EXECUTE format('ALTER TABLE mobility.fare_quote DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'mobility.fare_quote'::regclass
      AND conname = 'fare_quote_total_check'
  ) THEN
    ALTER TABLE mobility.fare_quote
      ADD CONSTRAINT fare_quote_total_check
      CHECK (
        total_kobo = base_kobo + distance_kobo + time_kobo + demand_kobo + taxes_and_fees_kobo
        OR total_kobo = base_kobo + distance_kobo + time_kobo + demand_kobo + taxes_and_fees_kobo + platform_fee_kobo
      );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- c. take_rate_registry: widen rate_bps bounds to the bounded-subsidy range
-- ---------------------------------------------------------------------------

-- The 0026..0084 column-level CHECK is auto-named
-- take_rate_registry_rate_bps_check; match by definition anyway so renamed
-- or restored databases are handled, excluding the widened replacement.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'public.take_rate_registry'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%rate_bps%'
      AND pg_get_constraintdef(oid) NOT LIKE '%-2000%'
      AND pg_get_constraintdef(oid) NOT LIKE '%(-)2000%'
  LOOP
    EXECUTE format('ALTER TABLE public.take_rate_registry DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.take_rate_registry'::regclass
      AND conname = 'take_rate_registry_rate_bps_check'
  ) THEN
    ALTER TABLE public.take_rate_registry
      ADD CONSTRAINT take_rate_registry_rate_bps_check
      CHECK (rate_bps BETWEEN -2000 AND 5000);
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- d. trip_settlement: fee columns + REPLACED commission and identity CHECKs
-- ---------------------------------------------------------------------------

ALTER TABLE mobility.trip_settlement
  ADD COLUMN IF NOT EXISTS platform_fee_kobo bigint NOT NULL DEFAULT 0;
ALTER TABLE mobility.trip_settlement
  ADD COLUMN IF NOT EXISTS fee_payer text NOT NULL DEFAULT 'rider';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'mobility.trip_settlement'::regclass
      AND conname = 'trip_settlement_platform_fee_kobo_check'
  ) THEN
    ALTER TABLE mobility.trip_settlement
      ADD CONSTRAINT trip_settlement_platform_fee_kobo_check
      CHECK (platform_fee_kobo >= 0);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'mobility.trip_settlement'::regclass
      AND conname = 'trip_settlement_fee_payer_check'
  ) THEN
    ALTER TABLE mobility.trip_settlement
      ADD CONSTRAINT trip_settlement_fee_payer_check
      CHECK (fee_payer IN ('rider', 'driver'));
  END IF;
END $$;

-- Replace the commission >= 0 CHECK with the subsidy-bounded form. Match by
-- definition (auto-named trip_settlement_platform_commission_kobo_check on
-- the 0026 schema), excluding any definition that already bounds by gross.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'mobility.trip_settlement'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%platform_commission_kobo%'
      AND pg_get_constraintdef(oid) NOT LIKE '%gross_fare_kobo%'
  LOOP
    EXECUTE format('ALTER TABLE mobility.trip_settlement DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'mobility.trip_settlement'::regclass
      AND conname = 'trip_settlement_platform_commission_kobo_check'
  ) THEN
    ALTER TABLE mobility.trip_settlement
      ADD CONSTRAINT trip_settlement_platform_commission_kobo_check
      CHECK (platform_commission_kobo >= (-1 * gross_fare_kobo));
  END IF;
END $$;

-- Replace the 0026 identity (gross = driver + commission + tax). Match by
-- definition, excluding any definition already referencing platform_fee_kobo.
DO $$
DECLARE
  c record;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'mobility.trip_settlement'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) LIKE '%gross_fare_kobo%'
      AND pg_get_constraintdef(oid) LIKE '%driver_earnings_kobo%'
      AND pg_get_constraintdef(oid) LIKE '%tax_and_statutory_kobo%'
      AND pg_get_constraintdef(oid) NOT LIKE '%platform_fee_kobo%'
  LOOP
    EXECUTE format('ALTER TABLE mobility.trip_settlement DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'mobility.trip_settlement'::regclass
      AND conname = 'trip_settlement_identity_check'
  ) THEN
    ALTER TABLE mobility.trip_settlement
      ADD CONSTRAINT trip_settlement_identity_check
      CHECK (
        gross_fare_kobo = driver_earnings_kobo + platform_commission_kobo
          + tax_and_statutory_kobo
          + CASE WHEN fee_payer = 'driver' THEN platform_fee_kobo ELSE 0 END
      );
  END IF;
END $$;

COMMIT;
