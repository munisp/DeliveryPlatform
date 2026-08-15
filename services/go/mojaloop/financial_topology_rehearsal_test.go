package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

const financialRehearsalWorkflowID = "00000000000000000000000000000026"

type financialOutboxStatus struct {
	Destination string
	Status      string
	Attempts    int
}

func TestRealFinancialTopologyRehearsal(t *testing.T) {
	if os.Getenv("REAL_FINANCIAL_REHEARSAL") != "1" {
		t.Skip("set REAL_FINANCIAL_REHEARSAL=1 only through scripts/rehearse-financial-topology.sh against the disposable topology")
	}
	assertIsolatedFinancialRehearsalEnvironment(t)

	client, err := NewTigerBeetleClient()
	if err != nil {
		t.Fatalf("initialize real TigerBeetle client: %v", err)
	}
	defer client.Close()
	service, err := NewMojaloopService(client)
	if err != nil {
		t.Fatalf("initialize real Mojaloop service: %v", err)
	}
	defer service.db.Close()

	switch os.Getenv("FINANCIAL_REHEARSAL_PHASE") {
	case "broker-partition":
		rehearseLedgerAndBrokerPartition(t, service)
	case "broker-recovery":
		rehearseBrokerRecovery(t, service.db)
	case "temporal-recovery":
		rehearseTemporalRecovery(t, service.db)
	case "temporal-worker-recovery":
		rehearseTemporalWorkerRecovery(t, service.db)
	default:
		t.Fatalf("unsupported FINANCIAL_REHEARSAL_PHASE %q", os.Getenv("FINANCIAL_REHEARSAL_PHASE"))
	}
}

func assertIsolatedFinancialRehearsalEnvironment(t *testing.T) {
	t.Helper()
	databaseURL := os.Getenv("DATABASE_URL")
	if !strings.Contains(databaseURL, "127.0.0.1:55432/financial_rehearsal") || strings.Contains(strings.ToLower(databaseURL), "prod") {
		t.Fatalf("refusing financial rehearsal against non-isolated DATABASE_URL")
	}
	if os.Getenv("TIGERBEETLE_CLUSTER_ID") != "1" {
		t.Fatalf("refusing financial rehearsal against non-test TigerBeetle cluster")
	}
	if os.Getenv("TIGERBEETLE_ADDRESSES") != "127.0.0.1:3001,127.0.0.1:3002,127.0.0.1:3003" {
		t.Fatalf("refusing financial rehearsal against non-local TigerBeetle addresses")
	}
}

func rehearseLedgerAndBrokerPartition(t *testing.T, service *MojaloopService) {
	t.Helper()
	ledger := service.tigerBeetle
	for _, setup := range []struct {
		alias  string
		create func(string) error
	}{
		{alias: "test-issuer", create: ledger.CreatePayeeAccount},
		{alias: "test-payer", create: ledger.CreatePayerAccount},
		{alias: "test-payee", create: ledger.CreatePayeeAccount},
	} {
		if err := setup.create(setup.alias); err != nil {
			t.Fatalf("create real TigerBeetle account %s: %v", setup.alias, err)
		}
	}

	if err := ledger.ProcessMojaloopTransfer("00000000000000000000000000000020", "test-issuer", "test-payer", 10000); err != nil {
		t.Fatalf("fund isolated payer account: %v", err)
	}
	if err := ledger.ProcessMojaloopTransfer("00000000000000000000000000000021", "test-payer", "test-payee", 4000); err != nil {
		t.Fatalf("create real transfer: %v", err)
	}
	if err := ledger.ProcessMojaloopTransfer("00000000000000000000000000000021", "test-payer", "test-payee", 4000); err != nil {
		t.Fatalf("duplicate transfer replay must be idempotent: %v", err)
	}
	if err := ledger.ProcessMojaloopTransfer("00000000000000000000000000000022", "test-payer", "test-payee", 10001); err == nil {
		t.Fatal("insufficient-funds transfer was accepted by real TigerBeetle")
	}
	if err := ledger.ReverseMojaloopTransfer("00000000000000000000000000000023", "00000000000000000000000000000021", "test-payer", "test-payee", 1250); err != nil {
		t.Fatalf("post partial refund: %v", err)
	}
	partial, err := ledger.GetTransferReconciliation("00000000000000000000000000000021")
	if err != nil {
		t.Fatalf("read partial-refund reconciliation: %v", err)
	}
	if !partial.LedgerConsistent || partial.RefundedAmount != 1250 || partial.NetSettledAmount != 2750 || partial.FullyReversed {
		t.Fatalf("unexpected partial-refund reconciliation: %#v", partial)
	}
	if err := ledger.ReverseMojaloopTransfer("00000000000000000000000000000024", "00000000000000000000000000000021", "test-payer", "test-payee", 2750); err != nil {
		t.Fatalf("post full refund remainder: %v", err)
	}
	full, err := ledger.GetTransferReconciliation("00000000000000000000000000000021")
	if err != nil {
		t.Fatalf("read full-refund reconciliation: %v", err)
	}
	if !full.LedgerConsistent || full.RefundedAmount != 4000 || full.NetSettledAmount != 0 || !full.FullyReversed {
		t.Fatalf("unexpected full-refund reconciliation: %#v", full)
	}

	if err := service.recordFundsWorkflowEvent(FundsWorkflowEvent{
		WorkflowType: "transfer",
		WorkflowID:   financialRehearsalWorkflowID,
		ResourceID:   "00000000000000000000000000000021",
		Step:         "committed",
		Status:       "COMMITTED",
		Payload: map[string]any{
			"payerFsp":    "test-payer",
			"payeeFsp":    "test-payee",
			"amountMinor": json.Number("500"),
		},
	}); err != nil {
		t.Fatalf("persist real funds workflow and durable outbox intent: %v", err)
	}

	pollFinancialOutbox(t, service.db, func(statuses map[string]financialOutboxStatus) bool {
		return statuses["tigerbeetle"].Status == "delivered" && statuses["kafka"].Status == "pending" && statuses["kafka"].Attempts >= 1 && statuses["temporal"].Status == "pending" && statuses["temporal"].Attempts >= 1
	}, "TigerBeetle delivery followed by broker and Temporal outage retry")
}

func rehearseBrokerRecovery(t *testing.T, db *sql.DB) {
	t.Helper()
	pollFinancialOutbox(t, db, func(statuses map[string]financialOutboxStatus) bool {
		return statuses["tigerbeetle"].Status == "delivered" && statuses["kafka"].Status == "delivered" && statuses["temporal"].Status == "pending" && statuses["temporal"].Attempts >= 2
	}, "broker delivery after Redpanda recovery while Temporal remains unavailable")
}

func rehearseTemporalRecovery(t *testing.T, db *sql.DB) {
	t.Helper()
	pollFinancialOutbox(t, db, func(statuses map[string]financialOutboxStatus) bool {
		return statuses["tigerbeetle"].Status == "delivered" && statuses["kafka"].Status == "delivered" && statuses["temporal"].Status == "delivered"
	}, "Temporal bridge delivery after Temporal server recovery")

	var status string
	if err := db.QueryRow(`SELECT status FROM mojaloop_workflow_orchestration WHERE workflow_id = $1 AND orchestrator = 'temporal' ORDER BY id DESC LIMIT 1`, financialRehearsalWorkflowID).Scan(&status); err != nil {
		t.Fatalf("read submitted Temporal orchestration record: %v", err)
	}
	if status != "submitted" {
		t.Fatalf("expected submitted workflow before worker recovery, got %q", status)
	}
}

func rehearseTemporalWorkerRecovery(t *testing.T, db *sql.DB) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	for time.Now().Before(deadline) {
		var orchestrationStatus, workflowStatus string
		err := db.QueryRow(`SELECT status FROM mojaloop_workflow_orchestration WHERE workflow_id = $1 AND orchestrator = 'temporal' ORDER BY id DESC LIMIT 1`, financialRehearsalWorkflowID).Scan(&orchestrationStatus)
		if err == nil {
			err = db.QueryRow(`SELECT status FROM mojaloop_workflows WHERE workflow_id = $1`, financialRehearsalWorkflowID).Scan(&workflowStatus)
		}
		if err == nil && orchestrationStatus == "completed" && workflowStatus == "completed" {
			return
		}
		if err != nil && err != sql.ErrNoRows {
			t.Fatalf("read Temporal recovery state: %v", err)
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatal("Temporal worker did not complete the durable workflow after restart")
}

func pollFinancialOutbox(t *testing.T, db *sql.DB, predicate func(map[string]financialOutboxStatus) bool, description string) {
	t.Helper()
	deadline := time.Now().Add(30 * time.Second)
	var last map[string]financialOutboxStatus
	for time.Now().Before(deadline) {
		statuses, err := readFinancialOutboxStatuses(db)
		if err != nil {
			t.Fatalf("read durable outbox status: %v", err)
		}
		last = statuses
		if predicate(statuses) {
			return
		}
		time.Sleep(500 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s; last outbox state: %#v", description, last)
}

func readFinancialOutboxStatuses(db *sql.DB) (map[string]financialOutboxStatus, error) {
	rows, err := db.Query(`SELECT destination, status, attempt_count FROM mojaloop_funds_outbox WHERE workflow_id = $1`, financialRehearsalWorkflowID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	statuses := map[string]financialOutboxStatus{}
	for rows.Next() {
		var status financialOutboxStatus
		if err := rows.Scan(&status.Destination, &status.Status, &status.Attempts); err != nil {
			return nil, err
		}
		statuses[status.Destination] = status
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(statuses) != 3 {
		return nil, fmt.Errorf("expected three outbox destinations, found %d", len(statuses))
	}
	return statuses, nil
}
