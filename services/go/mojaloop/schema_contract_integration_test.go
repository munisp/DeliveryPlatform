package main

import (
	"database/sql"
	"os"
	"testing"

	_ "github.com/lib/pq"
)

func TestMojaloopSchemaContractIntegration(t *testing.T) {
	databaseURL := os.Getenv("TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL is required for migration contract integration")
	}

	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	defer db.Close()

	service := &MojaloopService{db: db}
	if err := service.verifyPersistenceContract(); err != nil {
		t.Fatalf("expected applied migration contract to verify: %v", err)
	}

	if _, err := db.Exec(`DELETE FROM platform_schema_contracts WHERE component = 'mojaloop_funds'`); err != nil {
		t.Fatalf("remove schema contract marker: %v", err)
	}
	defer func() {
		if _, err := db.Exec(`INSERT INTO platform_schema_contracts (component, version) VALUES ('mojaloop_funds', 7) ON CONFLICT (component) DO UPDATE SET version = EXCLUDED.version, applied_at = NOW()`); err != nil {
			t.Fatalf("restore schema contract marker: %v", err)
		}
	}()
	if err := service.verifyPersistenceContract(); err == nil {
		t.Fatal("expected missing schema contract to fail closed")
	}
}
