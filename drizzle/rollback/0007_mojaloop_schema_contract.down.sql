-- The contract marker is reversible; business tables remain migration-owned and are never dropped by runtime rollback.

DELETE FROM platform_schema_contracts WHERE component = 'mojaloop_funds' AND version = 7;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_schema_contracts) THEN
    DROP TABLE platform_schema_contracts;
  END IF;
END $$;
