-- Rollback for 0097_settlement_disputes.sql: drop the dispute workflow and
-- restore the rental_operations_event aggregate_type CHECK to the 0096 set
-- (NOT VALID so pre-existing event rows do not block the rollback).
DROP FUNCTION IF EXISTS vehicle_access.get_settlement_dispute(integer,uuid);
DROP FUNCTION IF EXISTS vehicle_access.list_settlement_disputes(integer,uuid,vehicle_access.dispute_status,integer);
DROP FUNCTION IF EXISTS vehicle_access.decide_settlement_dispute(integer,uuid,vehicle_access.dispute_status,bigint,text,text,timestamptz);
DROP FUNCTION IF EXISTS vehicle_access.open_settlement_dispute(integer,uuid,vehicle_access.dispute_reason,text,text,timestamptz);
DROP TABLE IF EXISTS vehicle_access.settlement_dispute;
DROP TYPE IF EXISTS vehicle_access.dispute_status;
DROP TYPE IF EXISTS vehicle_access.dispute_reason;
ALTER TABLE vehicle_access.rental_operations_event DROP CONSTRAINT IF EXISTS rental_operations_event_aggregate_type_check;
ALTER TABLE vehicle_access.rental_operations_event ADD CONSTRAINT rental_operations_event_aggregate_type_check
  CHECK (aggregate_type IN ('location','asset','availability_block','add_on','agreement','extension','insurance_tier','condition_report','settlement')) NOT VALID;
