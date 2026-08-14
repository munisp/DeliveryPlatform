package main

import (
	"database/sql"
	"os"
	"strings"
	"testing"
)

func TestFundsOutboxAtomicPersistenceAndRecovery(t *testing.T) {
	databaseURL := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL must target an isolated PostgreSQL database")
	}
	if strings.Contains(strings.ToLower(databaseURL), "prod") {
		t.Fatal("refusing to run outbox integration test against a production-looking database URL")
	}

	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(`TRUNCATE mojaloop_funds_outbox, mojaloop_workflow_events, mojaloop_workflows RESTART IDENTITY`); err != nil {
		t.Fatalf("reset isolated outbox tables: %v", err)
	}

	service := &MojaloopService{db: db}
	event := FundsWorkflowEvent{
		WorkflowType: "transfer",
		WorkflowID:   "transfer-outbox-test",
		ResourceID:   "transfer-outbox-test",
		Step:         "initiated",
		Status:       "RESERVED",
		Payload: map[string]any{
			"amountMinor": uint64(1250),
			"currency":    "EUR",
		},
	}

	t.Setenv("FUNDS_OUTBOX_DESTINATIONS", "invalid-destination")
	if err := service.recordFundsWorkflowEvent(event); err == nil {
		t.Fatal("expected invalid destination to abort the entire workflow and outbox transaction")
	}
	var workflowCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM mojaloop_workflows`).Scan(&workflowCount); err != nil {
		t.Fatalf("count workflows after rollback: %v", err)
	}
	if workflowCount != 0 {
		t.Fatalf("expected rolled-back workflow state, got %d rows", workflowCount)
	}

	t.Setenv("FUNDS_OUTBOX_DESTINATIONS", "tigerbeetle,kafka,temporal")
	if err := service.recordFundsWorkflowEvent(event); err != nil {
		t.Fatalf("persist funds workflow and outbox: %v", err)
	}
	var outboxCount int
	if err := db.QueryRow(`SELECT COUNT(*) FROM mojaloop_funds_outbox WHERE workflow_id = $1 AND status = 'pending'`, event.WorkflowID).Scan(&outboxCount); err != nil {
		t.Fatalf("count pending outbox records: %v", err)
	}
	if outboxCount != 3 {
		t.Fatalf("expected three destination-specific outbox records, got %d", outboxCount)
	}

	record, found, err := service.claimFundsOutboxRecord("outbox-test-worker")
	if err != nil || !found {
		t.Fatalf("claim pending outbox record: found=%v err=%v", found, err)
	}
	if record.Destination != "tigerbeetle" {
		t.Fatalf("expected TigerBeetle predecessor to claim first, got %q", record.Destination)
	}
	if err := service.retryFundsOutboxRecord(record.ID, assertableOutboxError{}); err != nil {
		t.Fatalf("record durable retry state: %v", err)
	}
	if _, err := db.Exec(`UPDATE mojaloop_funds_outbox SET next_attempt_at = NOW() WHERE id = $1`, record.ID); err != nil {
		t.Fatalf("make retried record claimable: %v", err)
	}
	retryRecord, found, err := service.claimFundsOutboxRecord("outbox-test-worker")
	if err != nil || !found || retryRecord.ID != record.ID {
		t.Fatalf("reclaim retry record: record=%+v found=%v err=%v", retryRecord, found, err)
	}
	if err := service.markFundsOutboxDelivered(retryRecord.ID); err != nil {
		t.Fatalf("record delivered state: %v", err)
	}
	var status string
	if err := db.QueryRow(`SELECT status FROM mojaloop_funds_outbox WHERE id = $1`, retryRecord.ID).Scan(&status); err != nil {
		t.Fatalf("read delivered status: %v", err)
	}
	if status != "delivered" {
		t.Fatalf("expected delivered outbox status, got %q", status)
	}
	nextRecord, found, err := service.claimFundsOutboxRecord("outbox-test-worker")
	if err != nil || !found {
		t.Fatalf("claim downstream record after ledger delivery: found=%v err=%v", found, err)
	}
	if nextRecord.Destination != "kafka" && nextRecord.Destination != "temporal" {
		t.Fatalf("expected a downstream broker intent after ledger delivery, got %q", nextRecord.Destination)
	}
}

type assertableOutboxError struct{}

func (assertableOutboxError) Error() string { return "simulated broker acknowledgment failure" }
