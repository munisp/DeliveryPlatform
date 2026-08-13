-- Rehearsal-only down migration. Do not apply to a live database while code still writes users.phone.
ALTER TABLE users DROP COLUMN IF EXISTS phone;
