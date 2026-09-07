CREATE TABLE IF NOT EXISTS operations.route_plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  work_order_id uuid NOT NULL REFERENCES operations.work_order(id) ON DELETE RESTRICT,
  plan_version integer NOT NULL CHECK (plan_version > 0),
  algorithm_version text NOT NULL,
  state text NOT NULL CHECK (state IN ('planned', 'superseded', 'cancelled')),
  total_distance_m numeric(14,2) NOT NULL CHECK (total_distance_m >= 0),
  planning_snapshot jsonb NOT NULL,
  created_by integer REFERENCES public.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (work_order_id, plan_version)
);
CREATE INDEX IF NOT EXISTS operations_route_plan_current_idx
  ON operations.route_plan (tenant_id, work_order_id, created_at DESC)
  WHERE state = 'planned';

CREATE TABLE IF NOT EXISTS operations.route_plan_stop (
  route_plan_id uuid NOT NULL REFERENCES operations.route_plan(id) ON DELETE CASCADE,
  work_order_stop_id uuid NOT NULL REFERENCES operations.work_order_stop(id) ON DELETE RESTRICT,
  visit_sequence integer NOT NULL CHECK (visit_sequence > 0),
  leg_distance_m numeric(14,2) NOT NULL CHECK (leg_distance_m >= 0),
  estimated_arrival_offset_s integer NOT NULL CHECK (estimated_arrival_offset_s >= 0),
  PRIMARY KEY (route_plan_id, visit_sequence),
  UNIQUE (route_plan_id, work_order_stop_id)
);
CREATE INDEX IF NOT EXISTS operations_route_plan_stop_stop_idx
  ON operations.route_plan_stop (work_order_stop_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'switchos_service') THEN
    GRANT SELECT, INSERT, UPDATE ON operations.route_plan, operations.route_plan_stop TO switchos_service;
  END IF;
END $$;
