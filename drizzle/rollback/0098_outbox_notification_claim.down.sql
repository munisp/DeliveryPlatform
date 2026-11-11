-- Rollback for 0098_outbox_notification_claim.sql.
DROP FUNCTION IF EXISTS vehicle_access.get_contract_event_detail(uuid,text);
DROP FUNCTION IF EXISTS vehicle_access.claim_outbox_events(integer);
