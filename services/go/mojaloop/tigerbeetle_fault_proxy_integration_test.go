//go:build tigerbeetle_fault_proxy

package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const (
	faultProxyRehearsalFlag       = "REAL_TIGERBEETLE_FAULT_PROXY_REHEARSAL"
	faultProxyAPIURL              = "http://127.0.0.1:8474"
	faultProxyAddresses           = "127.0.0.1:3101,127.0.0.1:3102,127.0.0.1:3103"
	faultProxyDirectAddresses     = "127.0.0.1:3001,127.0.0.1:3002,127.0.0.1:3003"
	faultProxyRequestTimeout      = 5 * time.Second
	faultProxyDispatchTimeout     = 10 * time.Second
	faultProxyReconciliationLimit = 10 * time.Second
)

var faultProxySequence atomic.Uint64

type toxiproxyController struct {
	baseURL string
	client  *http.Client
}

type toxiproxyProxy struct {
	Name     string `json:"name"`
	Listen   string `json:"listen"`
	Upstream string `json:"upstream"`
	Enabled  bool   `json:"enabled"`
}

type toxiproxyToxic struct {
	Name       string         `json:"name"`
	Type       string         `json:"type"`
	Stream     string         `json:"stream"`
	Attributes map[string]any `json:"attributes"`
}

func newToxiproxyController(t *testing.T) *toxiproxyController {
	t.Helper()
	if strings.TrimSpace(os.Getenv(faultProxyRehearsalFlag)) != "1" {
		t.Skip("set REAL_TIGERBEETLE_FAULT_PROXY_REHEARSAL=1 only through scripts/rehearse-financial-topology.sh against the disposable topology")
	}
	assertIsolatedTigerBeetleFaultProxyEnvironment(t)
	return &toxiproxyController{
		baseURL: faultProxyAPIURL,
		client:  &http.Client{Timeout: faultProxyRequestTimeout},
	}
}

func assertIsolatedTigerBeetleFaultProxyEnvironment(t *testing.T) {
	t.Helper()
	if databaseURL := os.Getenv("DATABASE_URL"); !strings.Contains(databaseURL, "127.0.0.1:55432/financial_rehearsal") || strings.Contains(strings.ToLower(databaseURL), "prod") {
		t.Fatalf("refusing fault proxy rehearsal against non-isolated DATABASE_URL")
	}
	if clusterID := os.Getenv("TIGERBEETLE_CLUSTER_ID"); clusterID != "1" {
		t.Fatalf("refusing fault proxy rehearsal against non-test TigerBeetle cluster %q", clusterID)
	}
	if direct := os.Getenv("TIGERBEETLE_FAULT_PROXY_DIRECT_ADDRESSES"); direct != faultProxyDirectAddresses {
		t.Fatalf("refusing fault proxy rehearsal against non-local direct TigerBeetle addresses %q", direct)
	}
	if proxyAddresses := os.Getenv("TIGERBEETLE_FAULT_PROXY_ADDRESSES"); proxyAddresses != faultProxyAddresses {
		t.Fatalf("refusing fault proxy rehearsal against unexpected proxy addresses %q", proxyAddresses)
	}
	if apiURL := os.Getenv("TIGERBEETLE_FAULT_PROXY_API_URL"); apiURL != faultProxyAPIURL {
		t.Fatalf("refusing fault proxy rehearsal against unexpected Toxiproxy API URL %q", apiURL)
	}
}

func (c *toxiproxyController) request(t *testing.T, ctx context.Context, method, path string, input any, output any) {
	t.Helper()
	var body io.Reader
	if input != nil {
		encoded, err := json.Marshal(input)
		if err != nil {
			t.Fatalf("encode Toxiproxy request %s %s: %v", method, path, err)
		}
		body = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, body)
	if err != nil {
		t.Fatalf("build Toxiproxy request %s %s: %v", method, path, err)
	}
	if input != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := c.client.Do(request)
	if err != nil {
		t.Fatalf("execute Toxiproxy request %s %s: %v", method, path, err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 64*1024))
	if err != nil {
		t.Fatalf("read Toxiproxy response %s %s: %v", method, path, err)
	}
	if response.StatusCode < http.StatusOK || response.StatusCode >= http.StatusMultipleChoices {
		t.Fatalf("Toxiproxy request %s %s returned %s: %s", method, path, response.Status, strings.TrimSpace(string(responseBody)))
	}
	if output != nil && len(responseBody) > 0 {
		if err := json.Unmarshal(responseBody, output); err != nil {
			t.Fatalf("decode Toxiproxy response %s %s: %v", method, path, err)
		}
	}
}

func (c *toxiproxyController) reset(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), faultProxyRequestTimeout)
	defer cancel()
	c.request(t, ctx, http.MethodPost, "/reset", nil, nil)
}

func (c *toxiproxyController) populate(t *testing.T) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), faultProxyRequestTimeout)
	defer cancel()
	c.request(t, ctx, http.MethodPost, "/populate", []toxiproxyProxy{
		{Name: "financial_rehearsal_tigerbeetle_0", Listen: "127.0.0.1:3101", Upstream: "127.0.0.1:3001", Enabled: true},
		{Name: "financial_rehearsal_tigerbeetle_1", Listen: "127.0.0.1:3102", Upstream: "127.0.0.1:3002", Enabled: true},
		{Name: "financial_rehearsal_tigerbeetle_2", Listen: "127.0.0.1:3103", Upstream: "127.0.0.1:3003", Enabled: true},
	}, nil)
}

func (c *toxiproxyController) setEnabled(t *testing.T, enabled bool) {
	t.Helper()
	for _, name := range []string{
		"financial_rehearsal_tigerbeetle_0",
		"financial_rehearsal_tigerbeetle_1",
		"financial_rehearsal_tigerbeetle_2",
	} {
		ctx, cancel := context.WithTimeout(context.Background(), faultProxyRequestTimeout)
		c.request(t, ctx, http.MethodPost, "/proxies/"+name, map[string]bool{"enabled": enabled}, nil)
		cancel()
	}
}

func (c *toxiproxyController) addDownstreamTimeout(t *testing.T, timeoutMilliseconds int) {
	t.Helper()
	for _, name := range []string{
		"financial_rehearsal_tigerbeetle_0",
		"financial_rehearsal_tigerbeetle_1",
		"financial_rehearsal_tigerbeetle_2",
	} {
		ctx, cancel := context.WithTimeout(context.Background(), faultProxyRequestTimeout)
		c.request(t, ctx, http.MethodPost, "/proxies/"+name+"/toxics", toxiproxyToxic{
			Name:       "fault_response_timeout",
			Type:       "timeout",
			Stream:     "downstream",
			Attributes: map[string]any{"timeout": timeoutMilliseconds},
		}, nil)
		cancel()
	}
}

func prepareToxiproxy(t *testing.T) *toxiproxyController {
	t.Helper()
	controller := newToxiproxyController(t)
	controller.reset(t)
	controller.populate(t)
	t.Cleanup(func() { controller.reset(t) })
	return controller
}

func faultProxyWorkflowID() string {
	sequence := faultProxySequence.Add(1)
	return fmt.Sprintf("%032x", uint64(0x7f00000000000000)+sequence)
}

func faultProxyLedger(t *testing.T, addresses string) *TigerBeetleClient {
	t.Helper()
	t.Setenv("TIGERBEETLE_ADDRESSES", addresses)
	client, err := NewTigerBeetleClient()
	if err != nil {
		t.Fatalf("initialize isolated TigerBeetle client for %s: %v", addresses, err)
	}
	t.Cleanup(client.Close)
	return client
}

func provisionFaultProxyAccounts(t *testing.T, ledger TigerBeetleLedger) {
	t.Helper()
	for _, setup := range []struct {
		alias  string
		create func(string) error
	}{
		{alias: "test-issuer", create: ledger.CreatePayeeAccount},
		{alias: "test-payer", create: ledger.CreatePayerAccount},
		{alias: "test-payee", create: ledger.CreatePayeeAccount},
	} {
		if err := setup.create(setup.alias); err != nil {
			t.Fatalf("provision isolated TigerBeetle account %s: %v", setup.alias, err)
		}
	}
	if err := ledger.ProcessMojaloopTransfer(faultProxyWorkflowID(), "test-issuer", "test-payer", 10000); err != nil {
		t.Fatalf("fund isolated fault-proxy payer: %v", err)
	}
}

func seedFaultProxyTransfer(t *testing.T, db *sql.DB, workflowID string) {
	t.Helper()
	if _, err := db.Exec(
		`INSERT INTO mojaloop_transfers (
			transfer_id, payer_fsp, payee_fsp, amount, amount_minor, currency,
			ilp_packet, condition, expiration, state, created_at, updated_at
		) VALUES ($1, 'test-payer', 'test-payee', 10.00, 1000, 'EUR', 'packet', 'condition', NOW() + INTERVAL '1 hour', 'RESERVED', NOW(), NOW())`,
		workflowID,
	); err != nil {
		t.Fatalf("seed fault-proxy transfer: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO mojaloop_workflows (workflow_id, workflow_type, resource_id, current_step, status, created_at, updated_at)
		 VALUES ($1, 'transfer', $1, 'initiated', 'RESERVED', NOW(), NOW())`,
		workflowID,
	); err != nil {
		t.Fatalf("seed fault-proxy workflow: %v", err)
	}
	if _, err := db.Exec(
		`INSERT INTO mojaloop_funds_outbox (
			event_id, destination, idempotency_key, workflow_id, workflow_type,
			resource_id, step, workflow_status, payload, ledger_debit_fsp,
			dispatch_order, status, next_attempt_at, created_at, updated_at
		) VALUES ($1, 'tigerbeetle', $2, $3, 'transfer', $3, 'initiated', 'RESERVED', $4::jsonb, 'test-payer', 10, 'pending', NOW(), NOW(), NOW())`,
		"fault-proxy-event:"+workflowID,
		"fault-proxy-transfer:"+workflowID,
		workflowID,
		`{"payerFsp":"test-payer","payeeFsp":"test-payee","amountMinor":1000,"currency":"EUR"}`,
	); err != nil {
		t.Fatalf("seed fault-proxy outbox: %v", err)
	}
}

func assertFaultProxyOutboxState(t *testing.T, db *sql.DB, workflowID, expectedStatus, expectedTransferState string, expectedAudits int) {
	t.Helper()
	var status, transferState string
	var audits int
	if err := db.QueryRow(`SELECT status FROM mojaloop_funds_outbox WHERE workflow_id = $1`, workflowID).Scan(&status); err != nil {
		t.Fatalf("read fault-proxy outbox status: %v", err)
	}
	if err := db.QueryRow(`SELECT state FROM mojaloop_transfers WHERE transfer_id = $1`, workflowID).Scan(&transferState); err != nil {
		t.Fatalf("read fault-proxy transfer state: %v", err)
	}
	if err := db.QueryRow(`SELECT count(*) FROM mojaloop_reconciliation_audits WHERE transfer_id = $1`, workflowID).Scan(&audits); err != nil {
		t.Fatalf("count fault-proxy reconciliation audits: %v", err)
	}
	if status != expectedStatus || transferState != expectedTransferState || audits != expectedAudits {
		t.Fatalf("unexpected fault-proxy durable state: outbox=%q transfer=%q audits=%d; want outbox=%q transfer=%q audits=%d", status, transferState, audits, expectedStatus, expectedTransferState, expectedAudits)
	}
}

func makeFaultProxyRetryDue(t *testing.T, db *sql.DB, workflowID string) {
	t.Helper()
	if _, err := db.Exec(`UPDATE mojaloop_funds_outbox SET next_attempt_at = NOW() WHERE workflow_id = $1 AND status = 'pending'`, workflowID); err != nil {
		t.Fatalf("make fault-proxy retry due: %v", err)
	}
}

func waitForFaultProxyLedgerTransfer(t *testing.T, ledger TigerBeetleLedger, workflowID string) {
	t.Helper()
	deadline := time.Now().Add(faultProxyReconciliationLimit)
	for time.Now().Before(deadline) {
		report, err := ledger.GetTransferReconciliation(workflowID)
		if err == nil && report.TransferExists && report.LedgerConsistent {
			return
		}
		time.Sleep(25 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for direct TigerBeetle observer to find transfer %s", workflowID)
}

func TestTigerBeetleFaultProxyRequestDropBeforeReceipt(t *testing.T) {
	controller := prepareToxiproxy(t)
	db := batchTestDatabase(t)
	direct := faultProxyLedger(t, faultProxyDirectAddresses)
	provisionFaultProxyAccounts(t, direct)
	workflowID := faultProxyWorkflowID()
	seedFaultProxyTransfer(t, db, workflowID)

	controller.setEnabled(t, false)
	proxied := faultProxyLedger(t, faultProxyAddresses)
	service := &MojaloopService{db: db, tigerBeetle: proxied}
	if _, err := service.DispatchTigerBeetleTransferBatch("fault-proxy-request-drop", 1); err != nil {
		t.Fatalf("dispatch request-drop batch: %v", err)
	}
	assertFaultProxyOutboxState(t, db, workflowID, "pending", "RESERVED", 0)
	report, err := direct.GetTransferReconciliation(workflowID)
	if err != nil {
		t.Fatalf("observe request-drop ledger state: %v", err)
	}
	if report.TransferExists {
		t.Fatal("request-drop fault unexpectedly created a TigerBeetle transfer")
	}

	controller.setEnabled(t, true)
	makeFaultProxyRetryDue(t, db, workflowID)
	retryLedger := faultProxyLedger(t, faultProxyAddresses)
	if _, err := (&MojaloopService{db: db, tigerBeetle: retryLedger}).DispatchTigerBeetleTransferBatch("fault-proxy-request-retry", 1); err != nil {
		t.Fatalf("dispatch request-drop retry: %v", err)
	}
	waitForFaultProxyLedgerTransfer(t, direct, workflowID)
	assertFaultProxyOutboxState(t, db, workflowID, "delivered", "COMMITTED", 1)
}

func TestTigerBeetleFaultProxyResponseDropAfterCommit(t *testing.T) {
	controller := prepareToxiproxy(t)
	db := batchTestDatabase(t)
	direct := faultProxyLedger(t, faultProxyDirectAddresses)
	provisionFaultProxyAccounts(t, direct)
	workflowID := faultProxyWorkflowID()
	seedFaultProxyTransfer(t, db, workflowID)

	controller.addDownstreamTimeout(t, 0)
	proxied := faultProxyLedger(t, faultProxyAddresses)
	service := &MojaloopService{db: db, tigerBeetle: proxied}
	completed := make(chan error, 1)
	go func() {
		_, err := service.DispatchTigerBeetleTransferBatch("fault-proxy-response-drop", 1)
		completed <- err
	}()
	waitForFaultProxyLedgerTransfer(t, direct, workflowID)
	proxied.Close()
	select {
	case err := <-completed:
		if err != nil {
			t.Fatalf("response-drop dispatch returned an unexpected error: %v", err)
		}
	case <-time.After(faultProxyDispatchTimeout):
		t.Fatal("response-drop dispatch did not exit after the isolated client closed")
	}
	assertFaultProxyOutboxState(t, db, workflowID, "pending", "RESERVED", 0)

	controller.reset(t)
	controller.populate(t)
	makeFaultProxyRetryDue(t, db, workflowID)
	retryLedger := faultProxyLedger(t, faultProxyAddresses)
	if _, err := (&MojaloopService{db: db, tigerBeetle: retryLedger}).DispatchTigerBeetleTransferBatch("fault-proxy-response-retry", 1); err != nil {
		t.Fatalf("dispatch response-drop retry: %v", err)
	}
	waitForFaultProxyLedgerTransfer(t, direct, workflowID)
	assertFaultProxyOutboxState(t, db, workflowID, "delivered", "COMMITTED", 1)
}

func TestTigerBeetleFaultProxyStaleWorkerCannotFinalizeReclaimedBatch(t *testing.T) {
	prepareToxiproxy(t)
	db := batchTestDatabase(t)
	direct := faultProxyLedger(t, faultProxyDirectAddresses)
	provisionFaultProxyAccounts(t, direct)
	workflowID := faultProxyWorkflowID()
	seedFaultProxyTransfer(t, db, workflowID)

	workerALedger := faultProxyLedger(t, faultProxyAddresses)
	workerA := &MojaloopService{db: db, tigerBeetle: workerALedger}
	claimed, err := workerA.claimTigerBeetleTransferBatch("fault-proxy-worker-a", 1)
	if err != nil || len(claimed) != 1 {
		t.Fatalf("claim fault-proxy worker A batch: records=%d err=%v", len(claimed), err)
	}
	request, err := tigerBeetleBatchRequest(claimed[0])
	if err != nil {
		t.Fatalf("build fault-proxy worker A request: %v", err)
	}
	outcomes, err := workerALedger.ProcessMojaloopTransferBatch([]TigerBeetleTransferRequest{request})
	if err != nil || len(outcomes) != 1 || outcomes[0].Err != nil {
		t.Fatalf("submit fault-proxy worker A transfer: outcomes=%#v err=%v", outcomes, err)
	}
	waitForFaultProxyLedgerTransfer(t, direct, workflowID)
	if _, err := db.Exec(`UPDATE mojaloop_funds_outbox SET claim_expires_at = NOW() - INTERVAL '5 minutes' WHERE id = $1`, claimed[0].ID); err != nil {
		t.Fatalf("expire fault-proxy worker A claim: %v", err)
	}

	workerBLedger := faultProxyLedger(t, faultProxyAddresses)
	if _, err := (&MojaloopService{db: db, tigerBeetle: workerBLedger}).DispatchTigerBeetleTransferBatch("fault-proxy-worker-b", 1); err != nil {
		t.Fatalf("dispatch reclaimed fault-proxy worker B batch: %v", err)
	}
	if err := workerA.finalizeTigerBeetleBatchRecordWithLedger(claimed[0], workerALedger); err == nil || !strings.Contains(err.Error(), "stale TigerBeetle batch claim") {
		t.Fatalf("expected stale worker A finalization rejection, got %v", err)
	}
	assertFaultProxyOutboxState(t, db, workflowID, "delivered", "COMMITTED", 1)
}

func TestTigerBeetleFaultProxyPersistentOutageBlocksLaterDebitStream(t *testing.T) {
	controller := prepareToxiproxy(t)
	db := batchTestDatabase(t)
	direct := faultProxyLedger(t, faultProxyDirectAddresses)
	provisionFaultProxyAccounts(t, direct)
	firstWorkflowID := faultProxyWorkflowID()
	secondWorkflowID := faultProxyWorkflowID()
	seedFaultProxyTransfer(t, db, firstWorkflowID)
	seedFaultProxyTransfer(t, db, secondWorkflowID)

	controller.setEnabled(t, false)
	proxied := faultProxyLedger(t, faultProxyAddresses)
	service := &MojaloopService{db: db, tigerBeetle: proxied}
	for attempt := 1; attempt <= maximumOutboxAttempts; attempt++ {
		if _, err := service.DispatchTigerBeetleTransferBatch("fault-proxy-persistent-outage", 1); err != nil {
			t.Fatalf("dispatch persistent-outage attempt %d: %v", attempt, err)
		}
		if attempt < maximumOutboxAttempts {
			makeFaultProxyRetryDue(t, db, firstWorkflowID)
		}
	}

	assertFaultProxyOutboxState(t, db, firstWorkflowID, "dead_letter", "RESERVED", 0)
	assertFaultProxyOutboxState(t, db, secondWorkflowID, "pending", "RESERVED", 0)
	for _, workflowID := range []string{firstWorkflowID, secondWorkflowID} {
		report, err := direct.GetTransferReconciliation(workflowID)
		if err != nil {
			t.Fatalf("observe persistent-outage ledger state for %s: %v", workflowID, err)
		}
		if report.TransferExists {
			t.Fatalf("persistent outage unexpectedly created TigerBeetle transfer %s", workflowID)
		}
	}
}
