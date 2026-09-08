package main

import (
	"database/sql"
	"fmt"
	"os"
	"strings"
	"sync"
	"testing"
)

type simulatedTigerBeetleLedger struct {
	mu           sync.Mutex
	batches      [][]TigerBeetleTransferRequest
	outcomeError map[string]error
	seen         map[string]int
}

func (s *simulatedTigerBeetleLedger) CreatePayerAccount(string) error { return nil }
func (s *simulatedTigerBeetleLedger) CreatePayeeAccount(string) error { return nil }
func (s *simulatedTigerBeetleLedger) ProcessMojaloopTransfer(string, string, string, uint64) error {
	return nil
}
func (s *simulatedTigerBeetleLedger) ReverseMojaloopTransfer(string, string, string, string, uint64) error {
	return nil
}
func (s *simulatedTigerBeetleLedger) ProcessMojaloopTransferBatch(requests []TigerBeetleTransferRequest) ([]TigerBeetleTransferOutcome, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	copyRequests := append([]TigerBeetleTransferRequest(nil), requests...)
	s.batches = append(s.batches, copyRequests)
	outcomes := make([]TigerBeetleTransferOutcome, len(requests))
	for index, request := range requests {
		s.seen[request.TransferID]++
		outcomes[index] = TigerBeetleTransferOutcome{TransferID: request.TransferID, Err: s.outcomeError[request.TransferID]}
	}
	return outcomes, nil
}
func (s *simulatedTigerBeetleLedger) GetTransferReconciliation(transferID string) (TransferReconciliation, error) {
	return TransferReconciliation{
		TransferID:       transferID,
		TransferExists:   true,
		TransferAmount:   1000,
		RefundedAmount:   0,
		NetSettledAmount: 1000,
		LedgerConsistent: true,
	}, nil
}

func batchTestDatabase(t *testing.T) *sql.DB {
	t.Helper()
	databaseURL := strings.TrimSpace(os.Getenv("TEST_DATABASE_URL"))
	if databaseURL == "" {
		t.Skip("TEST_DATABASE_URL must target an isolated PostgreSQL database")
	}
	if strings.Contains(strings.ToLower(databaseURL), "prod") {
		t.Fatal("refusing to run TigerBeetle batch test against a production-looking database URL")
	}
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		t.Fatalf("open isolated TigerBeetle batch database: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	if _, err := db.Exec(`TRUNCATE mojaloop_reconciliation_audits, mojaloop_funds_outbox, mojaloop_workflow_events, mojaloop_workflows, mojaloop_transfers RESTART IDENTITY`); err != nil {
		t.Fatalf("reset isolated TigerBeetle batch database: %v", err)
	}
	return db
}

func seedTigerBeetleBatchTransfer(t *testing.T, db *sql.DB, id int, payer string) string {
	t.Helper()
	workflowID := fmt.Sprintf("00000000-0000-0000-0000-%012x", id+1)
	payee := fmt.Sprintf("payee-%03d", id)
	if _, err := db.Exec(
		`INSERT INTO mojaloop_transfers (
			transfer_id, payer_fsp, payee_fsp, amount, amount_minor, currency,
			ilp_packet, condition, expiration, state, created_at, updated_at
		) VALUES ($1, $2, $3, 10.00, 1000, 'EUR', 'packet', 'condition', NOW() + INTERVAL '1 hour', 'RESERVED', NOW(), NOW())`,
		workflowID, payer, payee,
	); err != nil {
		t.Fatalf("insert transfer %s: %v", workflowID, err)
	}
	if _, err := db.Exec(
		`INSERT INTO mojaloop_workflows (workflow_id, workflow_type, resource_id, current_step, status, created_at, updated_at)
		 VALUES ($1, 'transfer', $1, 'initiated', 'RESERVED', NOW(), NOW())`,
		workflowID,
	); err != nil {
		t.Fatalf("insert workflow %s: %v", workflowID, err)
	}
	payload := fmt.Sprintf(`{"payerFsp":%q,"payeeFsp":%q,"amountMinor":1000,"currency":"EUR"}`, payer, payee)
	if _, err := db.Exec(
		`INSERT INTO mojaloop_funds_outbox (
			event_id, destination, idempotency_key, workflow_id, workflow_type,
			resource_id, step, workflow_status, payload, ledger_debit_fsp,
			dispatch_order, status, next_attempt_at, created_at, updated_at
		) VALUES ($1, 'tigerbeetle', $2, $3, 'transfer', $3, 'initiated', 'RESERVED', $4::jsonb, $5, 10, 'pending', NOW(), NOW(), NOW())`,
		"event:"+workflowID, "transfer:"+workflowID, workflowID, payload, payer,
	); err != nil {
		t.Fatalf("insert outbox %s: %v", workflowID, err)
	}
	var persistedTransferID, persistedWorkflowID string
	if err := db.QueryRow(`SELECT transfer_id FROM mojaloop_transfers WHERE transfer_id = $1`, workflowID).Scan(&persistedTransferID); err != nil || persistedTransferID != workflowID {
		t.Fatalf("verify seeded transfer %s: persisted=%q err=%v", workflowID, persistedTransferID, err)
	}
	if err := db.QueryRow(`SELECT workflow_id FROM mojaloop_funds_outbox WHERE idempotency_key = $1`, "transfer:"+workflowID).Scan(&persistedWorkflowID); err != nil || persistedWorkflowID != workflowID {
		t.Fatalf("verify seeded outbox %s: persisted=%q err=%v", workflowID, persistedWorkflowID, err)
	}
	return workflowID
}

func TestTigerBeetleBatchDispatchClaimsOnceAcrossConcurrentWorkers(t *testing.T) {
	db := batchTestDatabase(t)
	const records = 512
	for index := 0; index < records; index++ {
		seedTigerBeetleBatchTransfer(t, db, index, fmt.Sprintf("payer-%03d", index))
	}
	ledger := &simulatedTigerBeetleLedger{outcomeError: map[string]error{}, seen: map[string]int{}}
	service := &MojaloopService{db: db, tigerBeetle: ledger}

	results := make(chan error, 2)
	for _, workerID := range []string{"batch-worker-a", "batch-worker-b", "batch-worker-c", "batch-worker-d"} {
		workerID := workerID
		go func() {
			_, err := service.DispatchTigerBeetleTransferBatch(workerID, defaultTigerBeetleDispatchBatch)
			results <- err
		}()
	}
	for range 4 {
		if err := <-results; err != nil {
			t.Fatalf("dispatch concurrent TigerBeetle batch: %v", err)
		}
	}

	var delivered int
	if err := db.QueryRow(`SELECT count(*) FROM mojaloop_funds_outbox WHERE status = 'delivered'`).Scan(&delivered); err != nil {
		t.Fatalf("count delivered batch rows: %v", err)
	}
	if delivered != records {
		var status, lastError string
		if err := db.QueryRow(`SELECT status, COALESCE(last_error, '') FROM mojaloop_funds_outbox ORDER BY id LIMIT 1`).Scan(&status, &lastError); err != nil {
			t.Fatalf("read failed batch diagnostic: %v", err)
		}
		t.Fatalf("expected %d delivered batch records, got %d; first status=%q error=%q", records, delivered, status, lastError)
	}
	ledger.mu.Lock()
	defer ledger.mu.Unlock()
	if len(ledger.batches) == 0 {
		t.Fatal("expected at least one TigerBeetle batch request")
	}
	for workflowID, count := range ledger.seen {
		if count != 1 {
			t.Fatalf("workflow %s submitted %d times; expected exactly one claim", workflowID, count)
		}
	}
	if len(ledger.seen) != records {
		t.Fatalf("expected %d unique ledger submissions, got %d", records, len(ledger.seen))
	}
}

func TestTigerBeetleBatchDispatchKeepsOneDebitAccountOrdered(t *testing.T) {
	db := batchTestDatabase(t)
	for index := 0; index < 3; index++ {
		seedTigerBeetleBatchTransfer(t, db, 700+index, "payer-ordered")
	}
	ledger := &simulatedTigerBeetleLedger{outcomeError: map[string]error{}, seen: map[string]int{}}
	service := &MojaloopService{db: db, tigerBeetle: ledger}
	for attempt := 0; attempt < 3; attempt++ {
		if _, err := service.DispatchTigerBeetleTransferBatch("batch-worker-ordered", defaultTigerBeetleDispatchBatch); err != nil {
			t.Fatalf("dispatch ordered TigerBeetle batch %d: %v", attempt, err)
		}
	}
	ledger.mu.Lock()
	defer ledger.mu.Unlock()
	if len(ledger.batches) != 3 {
		t.Fatalf("expected three serial batches for one debit account, got %d", len(ledger.batches))
	}
	for index, batch := range ledger.batches {
		if len(batch) != 1 {
			t.Fatalf("expected ordered batch %d to have one transfer, got %d", index, len(batch))
		}
	}
}

func TestTigerBeetleBatchDispatchHonorsRetryDeadline(t *testing.T) {
	db := batchTestDatabase(t)
	workflowID := seedTigerBeetleBatchTransfer(t, db, 888, "payer-retry-deadline")
	ledger := &simulatedTigerBeetleLedger{
		outcomeError: map[string]error{workflowID: fmt.Errorf("simulated transient TigerBeetle batch error")},
		seen:         map[string]int{},
	}
	service := &MojaloopService{db: db, tigerBeetle: ledger}
	if _, err := service.DispatchTigerBeetleTransferBatch("batch-worker-retry", 1); err != nil {
		t.Fatalf("dispatch initial failing batch: %v", err)
	}
	if processed, err := service.DispatchTigerBeetleTransferBatch("batch-worker-retry", 1); err != nil || processed != 0 {
		t.Fatalf("retry was claimed before durable deadline: processed=%d err=%v", processed, err)
	}
	ledger.mu.Lock()
	seen := ledger.seen[workflowID]
	ledger.mu.Unlock()
	if seen != 1 {
		t.Fatalf("expected one ledger attempt before retry deadline, got %d", seen)
	}
}

func TestTigerBeetleBatchDispatchDeadLettersExhaustedPerRowFailure(t *testing.T) {
	db := batchTestDatabase(t)
	workflowID := seedTigerBeetleBatchTransfer(t, db, 999, "payer-dead-letter")
	ledger := &simulatedTigerBeetleLedger{
		outcomeError: map[string]error{workflowID: fmt.Errorf("simulated TigerBeetle unexpected batch status")},
		seen:         map[string]int{},
	}
	service := &MojaloopService{db: db, tigerBeetle: ledger}

	for attempt := 1; attempt <= maximumOutboxAttempts; attempt++ {
		if _, err := service.DispatchTigerBeetleTransferBatch("batch-worker-dead-letter", 1); err != nil {
			t.Fatalf("dispatch failed batch attempt %d: %v", attempt, err)
		}
		if attempt < maximumOutboxAttempts {
			if _, err := db.Exec(`UPDATE mojaloop_funds_outbox SET next_attempt_at = NOW() WHERE workflow_id = $1`, workflowID); err != nil {
				t.Fatalf("make retry %d due: %v", attempt, err)
			}
		}
	}
	var status string
	var events int
	if err := db.QueryRow(`SELECT status FROM mojaloop_funds_outbox WHERE workflow_id = $1`, workflowID).Scan(&status); err != nil {
		var outboxCount int
		if countErr := db.QueryRow(`SELECT count(*) FROM mojaloop_funds_outbox`).Scan(&outboxCount); countErr != nil {
			t.Fatalf("read terminal batch status: %v (and count diagnostic failed: %v)", err, countErr)
		}
		t.Fatalf("read terminal batch status: %v; total outbox rows=%d", err, outboxCount)
	}
	if status != "dead_letter" {
		t.Fatalf("expected dead_letter after %d attempts, got %q", maximumOutboxAttempts, status)
	}
	if err := db.QueryRow(`SELECT count(*) FROM mojaloop_workflow_events WHERE workflow_id = $1 AND step = 'ledger_dead_lettered'`, workflowID).Scan(&events); err != nil {
		t.Fatalf("count dead-letter events: %v", err)
	}
	if events != 1 {
		t.Fatalf("expected one immutable dead-letter event, got %d", events)
	}
}
