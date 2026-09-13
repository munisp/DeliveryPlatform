-- Courier self-serve: rental charge ledger link for vehicle-access contracts.
--
-- When a courier's vehicle-access contract transitions to `active`, the
-- platform owes the courier a transparent, itemized charge trail. This table
-- records every rental charge (activation, weekly rent, add-ons, deposit,
-- excess km, adjustments) linked to the vehicle_access.access_contract row
-- and to the courier's users.id, so the courier portal can show exactly what
-- was charged, when, and with which ledger reference.
--
-- Idempotency: (contract_id, charge_type) is UNIQUE so re-posting the same
-- charge class for a contract is a no-op (ON CONFLICT DO NOTHING in
-- recordRentalCharge). ledger_reference is UNIQUE so a posted charge can be
-- reconciled against the financial ledger exactly once.

BEGIN;

CREATE TABLE IF NOT EXISTS public.vehicle_rental_charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_id uuid NOT NULL REFERENCES vehicle_access.access_contract(id) ON DELETE RESTRICT,
  driver_user_id integer NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  charge_type text NOT NULL CHECK (charge_type IN ('activation','weekly','addon','deposit','excess_km','adjustment')),
  amount_minor bigint NOT NULL CHECK (amount_minor >= 0),
  currency char(3) NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','posted','paid','void')),
  ledger_reference text NOT NULL UNIQUE CHECK (ledger_reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  idempotency_key text NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz,
  paid_at timestamptz,
  UNIQUE (contract_id, charge_type)
);

CREATE INDEX IF NOT EXISTS vehicle_rental_charges_driver_status_idx
  ON public.vehicle_rental_charges (driver_user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS vehicle_rental_charges_contract_idx
  ON public.vehicle_rental_charges (contract_id, created_at DESC);

COMMENT ON TABLE public.vehicle_rental_charges IS
  'Courier-visible rental charge trail linked to vehicle_access.access_contract; one row per (contract_id, charge_type), posted idempotently by recordRentalCharge and reconciled via ledger_reference.';

COMMIT;
