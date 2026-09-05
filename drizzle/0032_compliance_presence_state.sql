-- Distinguish automatic Lagos compliance suspension from independent safety, fraud, or manual suspensions.
-- Existing generic suspended records remain conservatively unchanged and require their owning control to reactivate.
ALTER TYPE mobility.driver_presence_state ADD VALUE IF NOT EXISTS 'compliance_suspended' BEFORE 'suspended';
