-- 0073_mobility_surfaces.sql
-- Operational tables backing the rider app, business travel, freight, and
-- healthcare transport surfaces. Additive only: CREATE TABLE IF NOT EXISTS,
-- no drops, no alterations of existing tables.

-- Rider-facing trip bookings (complements mobility.ride_trip dispatch records
-- with the operational fields the rider experience surfaces need).
CREATE TABLE IF NOT EXISTS rider_trips (
  id BIGSERIAL PRIMARY KEY,
  rider_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  driver_id INTEGER REFERENCES drivers(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'assigned', 'in_progress', 'completed', 'cancelled')),
  trip_type TEXT NOT NULL DEFAULT 'standard'
    CHECK (trip_type IN ('standard', 'airport', 'business', 'healthcare')),
  vehicle_class TEXT NOT NULL DEFAULT 'standard'
    CHECK (vehicle_class IN ('standard', 'comfort', 'xl')),
  modality TEXT NOT NULL DEFAULT 'car'
    CHECK (modality IN ('car', 'scooter', 'transit_connect')),
  pickup_latitude NUMERIC(10, 7),
  pickup_longitude NUMERIC(10, 7),
  pickup_label TEXT,
  dropoff_latitude NUMERIC(10, 7),
  dropoff_longitude NUMERIC(10, 7),
  dropoff_label TEXT,
  fare_minor BIGINT NOT NULL DEFAULT 0 CHECK (fare_minor >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'NGN',
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  assigned_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rider_trips_status_idx ON rider_trips (status);
CREATE INDEX IF NOT EXISTS rider_trips_rider_recent_idx ON rider_trips (rider_user_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS rider_trips_requested_idx ON rider_trips (requested_at DESC);

-- Enterprise travel program accounts.
CREATE TABLE IF NOT EXISTS business_travel_accounts (
  id BIGSERIAL PRIMARY KEY,
  company_name TEXT NOT NULL CHECK (length(company_name) BETWEEN 2 AND 160),
  billing_email TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended', 'closed')),
  approval_mode TEXT NOT NULL DEFAULT 'manager-review'
    CHECK (approval_mode IN ('auto-with-cap', 'manager-review', 'care-coordinator')),
  service_mix TEXT NOT NULL DEFAULT 'business rides',
  monthly_budget_minor BIGINT CHECK (monthly_budget_minor IS NULL OR monthly_budget_minor >= 0),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS business_travel_accounts_status_idx ON business_travel_accounts (status);

-- Trips booked under an enterprise travel account.
CREATE TABLE IF NOT EXISTS business_travel_trips (
  id BIGSERIAL PRIMARY KEY,
  account_id BIGINT NOT NULL REFERENCES business_travel_accounts(id) ON DELETE RESTRICT,
  traveler_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  rider_trip_id BIGINT REFERENCES rider_trips(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'requested'
    CHECK (status IN ('requested', 'approved', 'in_progress', 'completed', 'cancelled', 'rejected')),
  expense_state TEXT NOT NULL DEFAULT 'open'
    CHECK (expense_state IN ('open', 'submitted', 'reconciled')),
  fare_minor BIGINT NOT NULL DEFAULT 0 CHECK (fare_minor >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'NGN',
  cost_center TEXT,
  purpose TEXT,
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS business_travel_trips_account_idx ON business_travel_trips (account_id);
CREATE INDEX IF NOT EXISTS business_travel_trips_traveler_idx ON business_travel_trips (traveler_user_id, requested_at DESC);
CREATE INDEX IF NOT EXISTS business_travel_trips_expense_state_idx ON business_travel_trips (expense_state);

-- Freight load board.
CREATE TABLE IF NOT EXISTS freight_loads (
  id BIGSERIAL PRIMARY KEY,
  shipper_provider_id INTEGER REFERENCES service_providers(id) ON DELETE SET NULL,
  lane_code TEXT,
  origin_label TEXT,
  destination_label TEXT,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'tendered', 'assigned', 'picked_up', 'in_transit', 'delivered', 'cancelled')),
  weight_kg NUMERIC(12, 2) CHECK (weight_kg IS NULL OR weight_kg >= 0),
  equipment TEXT NOT NULL DEFAULT 'box_truck'
    CHECK (equipment IN ('box_truck', 'sprinter', 'reefer', 'flatbed')),
  value_minor BIGINT NOT NULL DEFAULT 0 CHECK (value_minor >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'NGN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS freight_loads_status_idx ON freight_loads (status);
CREATE INDEX IF NOT EXISTS freight_loads_shipper_idx ON freight_loads (shipper_provider_id);
CREATE INDEX IF NOT EXISTS freight_loads_lane_idx ON freight_loads (lane_code);

-- Non-emergency healthcare transport bookings.
CREATE TABLE IF NOT EXISTS healthcare_transport_bookings (
  id BIGSERIAL PRIMARY KEY,
  patient_ref TEXT NOT NULL CHECK (length(patient_ref) BETWEEN 1 AND 128),
  rider_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  program TEXT NOT NULL DEFAULT 'Non-emergency medical transport',
  service_line TEXT NOT NULL DEFAULT 'patient_trip'
    CHECK (service_line IN ('patient_trip', 'regulated_delivery')),
  schedule_mode TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (schedule_mode IN ('scheduled', 'same_day', 'recurring')),
  mobility_needs TEXT,
  compliance_notes TEXT,
  appointment_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'scheduled'
    CHECK (status IN ('scheduled', 'en_route', 'arrived', 'completed', 'cancelled')),
  fare_minor BIGINT NOT NULL DEFAULT 0 CHECK (fare_minor >= 0),
  currency CHAR(3) NOT NULL DEFAULT 'NGN',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS healthcare_transport_bookings_status_idx ON healthcare_transport_bookings (status);
CREATE INDEX IF NOT EXISTS healthcare_transport_bookings_appointment_idx ON healthcare_transport_bookings (appointment_at);
