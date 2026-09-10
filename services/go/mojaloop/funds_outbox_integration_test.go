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
			"payerFsp":    "payer-outbox-test",
			"payeeFsp":    "payee-outbox-test",
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
	if err != nil || found {
		t.Fatalf("TigerBeetle transfer must be reserved for batch dispatcher: record=%+v found=%v err=%v", record, found, err)
	}
	var tigerBeetleID int64
	if err := db.QueryRow(`SELECT id FROM mojaloop_funds_outbox WHERE workflow_id = $1 AND destination = 'tigerbeetle'`, event.WorkflowID).Scan(&tigerBeetleID); err != nil {
		t.Fatalf("read batch-reserved TigerBeetle record: %v", err)
	}
	if _, err := db.Exec(`UPDATE mojaloop_funds_outbox
		SET status = 'delivered', delivered_at = NOW(), locked_at = NULL, locked_by = NULL,
			claim_token = NULL, claim_expires_at = NULL, last_error = NULL, updated_at = NOW()
		WHERE id = $1`, tigerBeetleID); err != nil {
		t.Fatalf("simulate completed batch ledger record before downstream delivery: %v", err)
	}
	nextRecord, found, err := service.claimFundsOutboxRecord("outbox-test-worker")
	if err != nil || !found {
		t.Fatalf("claim downstream record after batch ledger delivery: found=%v err=%v", found, err)
	}
	if nextRecord.Destination != "kafka" && nextRecord.Destination != "temporal" {
		t.Fatalf("expected a downstream broker intent after ledger delivery, got %q", nextRecord.Destination)
	}
	if err := service.retryFundsOutboxRecord(nextRecord, assertableOutboxError{}); err != nil {
		t.Fatalf("record downstream durable retry state: %v", err)
	}
	if _, err := db.Exec(`UPDATE mojaloop_funds_outbox SET next_attempt_at = NOW() WHERE id = $1`, nextRecord.ID); err != nil {
		t.Fatalf("make retried downstream record claimable: %v", err)
	}
	retryRecord, found, err := service.claimFundsOutboxRecord("outbox-test-worker")
	if err != nil || !found || retryRecord.ID != nextRecord.ID {
		t.Fatalf("reclaim downstream retry record: record=%+v found=%v err=%v", retryRecord, found, err)
	}
	if err := service.markFundsOutboxDelivered(retryRecord); err != nil {
		t.Fatalf("record downstream delivered state: %v", err)
	}
}

func TestGenericOutboxClaimsRejectStaleCompletionAndRetry(t *testing.T) {
	db := batchTestDatabase(t)
	if _, err := db.Exec(`INSERT INTO mojaloop_funds_outbox (
		event_id, destination, idempotency_key, workflow_id, workflow_type,
		resource_id, step, workflow_status, payload, dispatch_order, status,
		next_attempt_at, created_at, updated_at
	) VALUES (
		'generic-fence-event', 'kafka', 'generic-fence-key', 'generic-fence-workflow', 'quote',
		'generic-fence-resource', 'quoted', 'PENDING', '{}'::jsonb, 20, 'pending', NOW(), NOW(), NOW()
	)`); err != nil {
		t.Fatalf("seed generic outbox record: %v", err)
	}
	service := &MojaloopService{db: db}
	first, found, err := service.claimFundsOutboxRecord("generic-worker-a")
	if err != nil || !found || first.ClaimToken == "" {
		t.Fatalf("claim generic outbox record: record=%+v found=%v err=%v", first, found, err)
	}
	if _, err := db.Exec(`UPDATE mojaloop_funds_outbox SET claim_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`, first.ID); err != nil {
		t.Fatalf("expire first generic claim: %v", err)
	}
	second, found, err := service.claimFundsOutboxRecord("generic-worker-b")
	if err != nil || !found || second.ClaimToken == "" || second.ClaimToken == first.ClaimToken {
		t.Fatalf("reclaim expired generic outbox record: first=%+v second=%+v found=%v err=%v", first, second, found, err)
	}
	if err := service.markFundsOutboxDelivered(first); err == nil || !strings.Contains(err.Error(), "stale funds outbox claim") {
		t.Fatalf("expected stale worker completion rejection, got %v", err)
	}
	if err := service.retryFundsOutboxRecord(first, assertableOutboxError{}); err == nil || !strings.Contains(err.Error(), "stale funds outbox retry") {
		t.Fatalf("expected stale worker retry rejection, got %v", err)
	}
	if err := service.markFundsOutboxDelivered(second); err != nil {
		t.Fatalf("complete current generic claim: %v", err)
	}
	var status string
	if err := db.QueryRow(`SELECT status FROM mojaloop_funds_outbox WHERE id = $1`, second.ID).Scan(&status); err != nil {
		t.Fatalf("read generic outbox terminal state: %v", err)
	}
	if status != "delivered" {
		t.Fatalf("expected delivered generic outbox record, got %q", status)
	}
}

func TestTigerBeetleRefundFinalizationRejectsExpiredClaim(t *testing.T) {
	db := batchTestDatabase(t)
	const transferID = "fenced-refund-transfer"
	const refundID = "fenced-refund"
	if _, err := db.Exec(`INSERT INTO mojaloop_transfers (
		transfer_id, payer_fsp, payee_fsp, amount, amount_minor, currency,
		ilp_packet, condition, expiration, state, created_at, updated_at
	) VALUES ($1, 'payer', 'payee', 10.00, 1000, 'EUR', 'packet', 'condition', NOW() + INTERVAL '1 hour', 'SETTLED', NOW(), NOW())`, transferID); err != nil {
		t.Fatalf("seed fenced refund transfer: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO mojaloop_refunds (
		refund_id, original_transfer_id, payer_fsp, payee_fsp, amount, amount_minor,
		currency, reason, state, created_at, updated_at
	) VALUES ($1, $2, 'payer', 'payee', 7.00, 700, 'EUR', 'test', 'PENDING_LEDGER', NOW(), NOW())`, refundID, transferID); err != nil {
		t.Fatalf("seed pending fenced refund: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO mojaloop_funds_outbox (
		event_id, destination, idempotency_key, workflow_id, workflow_type, resource_id,
		step, workflow_status, payload, ledger_debit_fsp, dispatch_order, status,
		next_attempt_at, created_at, updated_at
	) VALUES (
		'fenced-refund-event', 'tigerbeetle', 'fenced-refund-key', $1, 'refund', $2,
		'queued', 'PENDING_LEDGER', '{"payerFsp":"payer","payeeFsp":"payee","amountMinor":700,"currency":"EUR"}'::jsonb,
		'payee', 10, 'pending', NOW(), NOW(), NOW()
	)`, refundID, transferID); err != nil {
		t.Fatalf("seed fenced refund outbox: %v", err)
	}
	ledger := &simulatedTigerBeetleLedger{
		outcomeError: map[string]error{},
		seen:         map[string]int{},
		reconciliations: map[string]TransferReconciliation{
			transferID: {
				TransferID:       transferID,
				TransferExists:   true,
				TransferAmount:   1000,
				RefundedAmount:   700,
				NetSettledAmount: 300,
				LedgerConsistent: true,
			},
		},
	}
	service := &MojaloopService{db: db, tigerBeetle: ledger}
	first, found, err := service.claimFundsOutboxRecord("refund-worker-a")
	if err != nil || !found || first.ClaimToken == "" {
		t.Fatalf("claim fenced refund outbox: record=%+v found=%v err=%v", first, found, err)
	}
	if _, err := db.Exec(`UPDATE mojaloop_funds_outbox SET claim_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1`, first.ID); err != nil {
		t.Fatalf("expire fenced refund claim: %v", err)
	}
	if err := service.finalizeTigerBeetleDispatch(first); err == nil || !strings.Contains(err.Error(), "stale funds outbox claim") {
		t.Fatalf("expected stale refund finalization rejection, got %v", err)
	}
	var refundState string
	if err := db.QueryRow(`SELECT state FROM mojaloop_refunds WHERE refund_id = $1`, refundID).Scan(&refundState); err != nil {
		t.Fatalf("read stale refund state: %v", err)
	}
	if refundState != "PENDING_LEDGER" {
		t.Fatalf("stale refund worker changed local refund state to %q", refundState)
	}
	second, found, err := service.claimFundsOutboxRecord("refund-worker-b")
	if err != nil || !found || second.ClaimToken == "" || second.ClaimToken == first.ClaimToken {
		t.Fatalf("reclaim fenced refund outbox: first=%+v second=%+v found=%v err=%v", first, second, found, err)
	}
	if err := service.finalizeTigerBeetleDispatch(second); err != nil {
		t.Fatalf("finalize current refund claim: %v", err)
	}
	var outboxStatus string
	if err := db.QueryRow(`SELECT state FROM mojaloop_refunds WHERE refund_id = $1`, refundID).Scan(&refundState); err != nil {
		t.Fatalf("read completed refund state: %v", err)
	}
	if err := db.QueryRow(`SELECT status FROM mojaloop_funds_outbox WHERE id = $1`, second.ID).Scan(&outboxStatus); err != nil {
		t.Fatalf("read completed refund outbox status: %v", err)
	}
	if refundState != "COMPLETED" || outboxStatus != "delivered" {
		t.Fatalf("current refund claim did not complete atomically: refund=%q outbox=%q", refundState, outboxStatus)
	}
}

func TestGenericOutboxLeaseTimestampFaultsRemainFailClosed(t *testing.T) {
	db := batchTestDatabase(t)
	service := &MojaloopService{db: db}
	seed := func(eventID, workflowID string, dispatchOrder int) int64 {
		t.Helper()
		var id int64
		if err := db.QueryRow(`INSERT INTO mojaloop_funds_outbox (
			event_id, destination, idempotency_key, workflow_id, workflow_type,
			resource_id, step, workflow_status, payload, dispatch_order, status,
			next_attempt_at, created_at, updated_at
		) VALUES (
			$1, 'kafka', $1 || '-key', $2, 'quote', $1 || '-resource',
			'quoted', 'PENDING', '{}'::jsonb, $3, 'pending', NOW(), NOW(), NOW()
		) RETURNING id`, eventID, workflowID, dispatchOrder).Scan(&id); err != nil {
			t.Fatalf("seed time-fault outbox record %q: %v", eventID, err)
		}
		return id
	}

	// Simulated forward-clock outcome: an expiration timestamp appears far in the
	// past to the database authority. A new worker may reclaim, while the prior
	// claim token remains unable to complete the row.
	forwardID := seed("clock-forward-event", "clock-forward-workflow", 10)
	first, found, err := service.claimFundsOutboxRecord("clock-forward-worker-a")
	if err != nil || !found || first.ID != forwardID || first.ClaimToken == "" {
		t.Fatalf("claim forward-fault record: record=%+v found=%v err=%v", first, found, err)
	}
	if _, err := db.Exec(`UPDATE mojaloop_funds_outbox SET claim_expires_at = NOW() - INTERVAL '5 minutes' WHERE id = $1`, forwardID); err != nil {
		t.Fatalf("simulate forward-clock expired timestamp: %v", err)
	}
	second, found, err := service.claimFundsOutboxRecord("clock-forward-worker-b")
	if err != nil || !found || second.ID != forwardID || second.ClaimToken == first.ClaimToken {
		t.Fatalf("reclaim forward-fault record: first=%+v second=%+v found=%v err=%v", first, second, found, err)
	}
	if err := service.markFundsOutboxDelivered(first); err == nil || !strings.Contains(err.Error(), "stale funds outbox claim") {
		t.Fatalf("forward time-fault allowed stale completion: %v", err)
	}
	if err := service.markFundsOutboxDelivered(second); err != nil {
		t.Fatalf("complete current forward-fault claim: %v", err)
	}

	// Simulated backward-clock outcome: an existing lease appears farther in the
	// future. The authority must fail closed by withholding the row from another
	// worker rather than allowing a concurrent reclaim.
	backwardID := seed("clock-backward-event", "clock-backward-workflow", 20)
	active, found, err := service.claimFundsOutboxRecord("clock-backward-worker-a")
	if err != nil || !found || active.ID != backwardID || active.ClaimToken == "" {
		t.Fatalf("claim backward-fault record: record=%+v found=%v err=%v", active, found, err)
	}
	if _, err := db.Exec(`UPDATE mojaloop_funds_outbox SET claim_expires_at = NOW() + INTERVAL '5 minutes' WHERE id = $1`, backwardID); err != nil {
		t.Fatalf("simulate backward-clock future timestamp: %v", err)
	}
	if contender, found, err := service.claimFundsOutboxRecord("clock-backward-worker-b"); err != nil || found || contender.ID != 0 {
		t.Fatalf("backward time-fault allowed concurrent reclaim: record=%+v found=%v err=%v", contender, found, err)
	}
	if err := service.markFundsOutboxDelivered(active); err != nil {
		t.Fatalf("complete active backward-fault claim: %v", err)
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
