package main

import (
	"database/sql"
	"os"
	"strings"
	"sync"
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
	t.Setenv("KAFKA_BROKERS", "broker.test:9092")
	t.Setenv("KAFKA_FUNDS_TOPIC", "switchos.funds")
	t.Setenv("TEMPORAL_BRIDGE_URL", "http://temporal-bridge.test:8080")
	t.Setenv("TEMPORAL_TASK_QUEUE", "switchos-funds")
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

func TestRefundReservationsIncludePendingLedgerAndSerializeConcurrentRequests(t *testing.T) {
	databaseURL := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL must target an isolated PostgreSQL database")
	}
	if strings.Contains(strings.ToLower(databaseURL), "prod") {
		t.Fatal("refusing to run refund reservation test against a production-looking database URL")
	}

	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		t.Fatalf("open test database: %v", err)
	}
	defer db.Close()
	if _, err := db.Exec(`TRUNCATE mojaloop_funds_outbox, mojaloop_workflow_events, mojaloop_workflows, mojaloop_refunds, mojaloop_idempotency_keys, mojaloop_transfers RESTART IDENTITY`); err != nil {
		t.Fatalf("reset isolated refund tables: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO mojaloop_transfers (transfer_id, payer_fsp, payee_fsp, amount, amount_minor, currency, ilp_packet, condition, expiration, state, created_at, updated_at)
		VALUES ('refund-bound-transfer', 'payer', 'payee', 10.00, 1000, 'EUR', 'packet', 'condition', NOW() + INTERVAL '1 hour', 'SETTLED', NOW(), NOW())`); err != nil {
		t.Fatalf("insert settled transfer: %v", err)
	}

	t.Setenv("FUNDS_OUTBOX_DESTINATIONS", "tigerbeetle")
	service := &MojaloopService{db: db}
	payloads := []RefundInitiationPayload{
		{RefundID: "refund-bound-a", OriginalTransferID: "refund-bound-transfer", AmountMinor: 700, Currency: "EUR"},
		{RefundID: "refund-bound-b", OriginalTransferID: "refund-bound-transfer", AmountMinor: 700, Currency: "EUR"},
	}
	results := make(chan error, len(payloads))
	var group sync.WaitGroup
	for _, payload := range payloads {
		payload := payload
		group.Add(1)
		go func() {
			defer group.Done()
			_, err := service.initiateRefund(payload, payload.RefundID)
			results <- err
		}()
	}
	group.Wait()
	close(results)

	successes, failures := 0, 0
	for err := range results {
		if err == nil {
			successes++
			continue
		}
		if !strings.Contains(err.Error(), "refund amount exceeds remaining settled amount") {
			t.Fatalf("unexpected concurrent refund error: %v", err)
		}
		failures++
	}
	if successes != 1 || failures != 1 {
		t.Fatalf("expected one refund reservation and one bounded rejection; successes=%d failures=%d", successes, failures)
	}

	reserved, err := service.getRefundedAmount("refund-bound-transfer")
	if err != nil {
		t.Fatalf("sum pending-ledger refund reservations: %v", err)
	}
	if reserved != 700 {
		t.Fatalf("expected pending-ledger reservation to consume 700 minor units, got %d", reserved)
	}
	if _, err := service.initiateRefund(RefundInitiationPayload{RefundID: "refund-bound-c", OriginalTransferID: "refund-bound-transfer", AmountMinor: 301, Currency: "EUR"}, "refund-bound-c"); err == nil {
		t.Fatal("refund exceeding the remaining 300 minor units was accepted")
	}
}
