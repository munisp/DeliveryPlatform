package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"
)

const (
	defaultOutboxBatchSize       = 20
	maximumOutboxAttempts        = 12
	genericFundsOutboxClaimLease = time.Minute
)

type fundsOutboxRecord struct {
	ID             int64
	EventID        string
	Destination    string
	IdempotencyKey string
	WorkflowID     string
	WorkflowType   string
	ResourceID     string
	Step           string
	Status         string
	Payload        map[string]any
	ClaimToken     string
}

func (s *MojaloopService) storeTransferAndWorkflow(transfer Transfer, event FundsWorkflowEvent) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin transfer and outbox transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.Exec(
		`INSERT INTO mojaloop_transfers (
			transfer_id, payer_fsp, payee_fsp, amount, amount_minor, currency, ilp_packet, condition, expiration, state, completed_time, fulfilment_value, created_at, updated_at
		) VALUES ($1,$2,$3,$4::numeric / 100,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
		ON CONFLICT (transfer_id) DO UPDATE SET updated_at = NOW()
		WHERE mojaloop_transfers.payer_fsp IS NOT DISTINCT FROM EXCLUDED.payer_fsp
			AND mojaloop_transfers.payee_fsp IS NOT DISTINCT FROM EXCLUDED.payee_fsp
			AND mojaloop_transfers.amount_minor IS NOT DISTINCT FROM EXCLUDED.amount_minor
			AND mojaloop_transfers.currency IS NOT DISTINCT FROM EXCLUDED.currency
			AND mojaloop_transfers.ilp_packet IS NOT DISTINCT FROM EXCLUDED.ilp_packet
			AND mojaloop_transfers.condition IS NOT DISTINCT FROM EXCLUDED.condition
			AND mojaloop_transfers.expiration IS NOT DISTINCT FROM EXCLUDED.expiration`,
		transfer.TransferID, transfer.PayerFSP, transfer.PayeeFSP, int64(transfer.AmountMinor), transfer.Currency, transfer.IlpPacket, transfer.Condition,
		transfer.Expiration, transfer.State, nullableTime(transfer.CompletedTime), nullableString(transfer.FulfilmentValue),
	)
	if err != nil {
		return fmt.Errorf("store transfer with outbox: %w", err)
	}
	if rows, rowsErr := result.RowsAffected(); rowsErr != nil || rows != 1 {
		if rowsErr != nil {
			return fmt.Errorf("verify transfer financial identity: %w", rowsErr)
		}
		return fmt.Errorf("transfer id %q is already bound to a different immutable financial identity", transfer.TransferID)
	}
	if err = s.persistFundsWorkflowEvent(tx, event); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("commit transfer and outbox transaction: %w", err)
	}
	return nil
}

func (s *MojaloopService) storeQuoteAndWorkflow(quote Quote, event FundsWorkflowEvent) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin quote and outbox transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	result, err := tx.Exec(
		`INSERT INTO mojaloop_quotes (
			quote_id, transaction_id, payer_fsp, payee_fsp, amount, amount_minor, currency, fees, fees_minor, expiration, state, created_at, updated_at
		) VALUES ($1,$2,$3,$4,$5::numeric / 100,$5,$6,$7::numeric / 100,$7,$8,$9,NOW(),NOW())
		ON CONFLICT (quote_id) DO UPDATE SET updated_at = NOW()
		WHERE mojaloop_quotes.transaction_id IS NOT DISTINCT FROM EXCLUDED.transaction_id
			AND mojaloop_quotes.payer_fsp IS NOT DISTINCT FROM EXCLUDED.payer_fsp
			AND mojaloop_quotes.payee_fsp IS NOT DISTINCT FROM EXCLUDED.payee_fsp
			AND mojaloop_quotes.amount_minor IS NOT DISTINCT FROM EXCLUDED.amount_minor
			AND mojaloop_quotes.fees_minor IS NOT DISTINCT FROM EXCLUDED.fees_minor
			AND mojaloop_quotes.currency IS NOT DISTINCT FROM EXCLUDED.currency
			AND mojaloop_quotes.expiration IS NOT DISTINCT FROM EXCLUDED.expiration`,
		quote.QuoteID, quote.TransactionID, quote.PayerFSP, quote.PayeeFSP, int64(quote.AmountMinor), quote.Currency, int64(quote.FeesMinor), quote.Expiration, quote.State,
	)
	if err != nil {
		return fmt.Errorf("store quote with outbox: %w", err)
	}
	if rows, rowsErr := result.RowsAffected(); rowsErr != nil || rows != 1 {
		if rowsErr != nil {
			return fmt.Errorf("verify quote financial identity: %w", rowsErr)
		}
		return fmt.Errorf("quote id %q is already bound to a different immutable financial identity", quote.QuoteID)
	}
	if err = s.persistFundsWorkflowEvent(tx, event); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("commit quote and outbox transaction: %w", err)
	}
	return nil
}

func (s *MojaloopService) storeRefundAndWorkflow(refund Refund, event FundsWorkflowEvent) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin refund and outbox transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err = s.storeRefundAndWorkflowTx(tx, refund, event); err != nil {
		return err
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("commit refund and outbox transaction: %w", err)
	}
	return nil
}

func (s *MojaloopService) storeRefundAndWorkflowTx(tx *sql.Tx, refund Refund, event FundsWorkflowEvent) error {
	if tx == nil {
		return fmt.Errorf("refund and outbox transaction is required")
	}
	result, err := tx.Exec(
		`INSERT INTO mojaloop_refunds (
			refund_id, original_transfer_id, payer_fsp, payee_fsp, amount, amount_minor, currency, reason, state, completed_time, created_at, updated_at
		) VALUES ($1,$2,$3,$4,$5::numeric / 100,$5,$6,$7,$8,$9,NOW(),NOW())
		ON CONFLICT (refund_id) DO UPDATE SET updated_at = NOW()
		WHERE mojaloop_refunds.original_transfer_id IS NOT DISTINCT FROM EXCLUDED.original_transfer_id
			AND mojaloop_refunds.payer_fsp IS NOT DISTINCT FROM EXCLUDED.payer_fsp
			AND mojaloop_refunds.payee_fsp IS NOT DISTINCT FROM EXCLUDED.payee_fsp
			AND mojaloop_refunds.amount_minor IS NOT DISTINCT FROM EXCLUDED.amount_minor
			AND mojaloop_refunds.currency IS NOT DISTINCT FROM EXCLUDED.currency
			AND mojaloop_refunds.reason IS NOT DISTINCT FROM EXCLUDED.reason`,
		refund.RefundID, refund.OriginalTransferID, refund.PayerFSP, refund.PayeeFSP, int64(refund.AmountMinor), refund.Currency,
		nullableString(refund.Reason), refund.State, nullableTime(refund.CompletedTime),
	)
	if err != nil {
		return fmt.Errorf("store refund with outbox: %w", err)
	}
	if rows, rowsErr := result.RowsAffected(); rowsErr != nil || rows != 1 {
		if rowsErr != nil {
			return fmt.Errorf("verify refund financial identity: %w", rowsErr)
		}
		return fmt.Errorf("refund id %q is already bound to a different immutable financial identity", refund.RefundID)
	}
	if err := s.persistFundsWorkflowEvent(tx, event); err != nil {
		return err
	}
	return nil
}

func requiredFundsOutboxDestinations() ([]string, error) {
	raw := strings.TrimSpace(os.Getenv("FUNDS_OUTBOX_DESTINATIONS"))
	if raw == "" {
		return nil, fmt.Errorf("FUNDS_OUTBOX_DESTINATIONS must explicitly list required destinations")
	}
	seen := map[string]struct{}{}
	destinations := make([]string, 0)
	for _, destination := range strings.Split(raw, ",") {
		normalized := strings.ToLower(strings.TrimSpace(destination))
		switch normalized {
		case "tigerbeetle", "switch", "dapr", "kafka", "fluvio", "temporal":
		default:
			return nil, fmt.Errorf("unsupported funds outbox destination %q", normalized)
		}
		if _, exists := seen[normalized]; !exists {
			seen[normalized] = struct{}{}
			destinations = append(destinations, normalized)
		}
	}
	if len(destinations) == 0 {
		return nil, fmt.Errorf("FUNDS_OUTBOX_DESTINATIONS must contain at least one destination")
	}
	return destinations, nil
}

func validateFundsOutboxDestinationConfiguration(destination string) error {
	configured := func(values ...string) bool {
		for _, value := range values {
			if strings.TrimSpace(value) == "" {
				return false
			}
		}
		return true
	}

	switch destination {
	case "dapr":
		if !configured(os.Getenv("DAPR_HTTP_PORT"), os.Getenv("DAPR_PUBSUB_NAME"), os.Getenv("DAPR_FUNDS_TOPIC")) {
			return fmt.Errorf("required dapr outbox destination needs DAPR_HTTP_PORT, DAPR_PUBSUB_NAME, and DAPR_FUNDS_TOPIC")
		}
	case "kafka":
		if !configured(os.Getenv("KAFKA_BROKERS"), os.Getenv("KAFKA_FUNDS_TOPIC")) {
			return fmt.Errorf("required kafka outbox destination needs KAFKA_BROKERS and KAFKA_FUNDS_TOPIC")
		}
	case "fluvio":
		if !configured(os.Getenv("FLUVIO_KAFKA_BROKERS"), os.Getenv("FLUVIO_FUNDS_TOPIC")) {
			return fmt.Errorf("required fluvio outbox destination needs FLUVIO_KAFKA_BROKERS and FLUVIO_FUNDS_TOPIC")
		}
	case "temporal":
		if !configured(os.Getenv("TEMPORAL_BRIDGE_URL"), os.Getenv("TEMPORAL_TASK_QUEUE")) {
			return fmt.Errorf("required temporal outbox destination needs TEMPORAL_BRIDGE_URL and TEMPORAL_TASK_QUEUE")
		}
	}
	return nil
}

// fundsOutboxDestinationEnvVars lists the environment variables each funds
// outbox destination requires before the dispatcher can deliver to it.
var fundsOutboxDestinationEnvVars = map[string][]string{
	"tigerbeetle": {},
	"switch":      {},
	"dapr":        {"DAPR_HTTP_PORT", "DAPR_PUBSUB_NAME", "DAPR_FUNDS_TOPIC"},
	"kafka":       {"KAFKA_BROKERS", "KAFKA_FUNDS_TOPIC"},
	"fluvio":      {"FLUVIO_KAFKA_BROKERS", "FLUVIO_FUNDS_TOPIC"},
	"temporal":    {"TEMPORAL_BRIDGE_URL", "TEMPORAL_TASK_QUEUE"},
}

// validateFundsOutboxConfiguration is the boot-time validation entrypoint for
// the outbox worker: it verifies the destination list and every per-destination
// dependency, and the returned error names every missing environment variable
// so a misconfigured worker fails fast with an actionable message instead of
// crash-looping on the first dispatch attempt.
func validateFundsOutboxConfiguration() error {
	destinations, err := requiredFundsOutboxDestinations()
	if err != nil {
		return err
	}
	missing := []string{}
	for _, destination := range destinations {
		for _, name := range fundsOutboxDestinationEnvVars[destination] {
			if strings.TrimSpace(os.Getenv(name)) == "" {
				missing = append(missing, fmt.Sprintf("%s (required by the %s outbox destination)", name, destination))
			}
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("funds outbox worker configuration incomplete; missing environment variables: %s", strings.Join(missing, ", "))
	}
	return nil
}

func eventIDFor(event FundsWorkflowEvent) string {
	return strings.Join([]string{event.WorkflowType, event.WorkflowID, event.Step, event.Status}, ":")
}

func destinationsForFundsEvent(event FundsWorkflowEvent) ([]string, error) {
	destinations, err := requiredFundsOutboxDestinations()
	if err != nil {
		return nil, err
	}
	requiresLedger := event.WorkflowType == "transfer" || event.WorkflowType == "refund"
	containsLedger := false
	filtered := make([]string, 0, len(destinations))
	for _, destination := range destinations {
		if err := validateFundsOutboxDestinationConfiguration(destination); err != nil {
			return nil, err
		}
		if destination == "tigerbeetle" {
			containsLedger = true
			if requiresLedger {
				filtered = append(filtered, destination)
			}
			continue
		}
		filtered = append(filtered, destination)
	}
	if requiresLedger && !containsLedger {
		return nil, fmt.Errorf("FUNDS_OUTBOX_DESTINATIONS must include tigerbeetle for %s workflows", event.WorkflowType)
	}
	return filtered, nil
}

func dispatchOrder(destination string) int {
	if destination == "tigerbeetle" {
		return 10
	}
	return 20
}

func (s *MojaloopService) persistFundsWorkflowEvent(tx *sql.Tx, event FundsWorkflowEvent) error {
	payloadBytes, err := json.Marshal(event.Payload)
	if err != nil {
		return fmt.Errorf("marshal workflow event payload: %w", err)
	}

	if _, err = tx.Exec(
		`INSERT INTO mojaloop_workflows (workflow_id, workflow_type, resource_id, current_step, status, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
		 ON CONFLICT (workflow_id) DO UPDATE SET
			workflow_type = EXCLUDED.workflow_type,
			resource_id = EXCLUDED.resource_id,
			current_step = EXCLUDED.current_step,
			status = EXCLUDED.status,
			updated_at = NOW()`,
		event.WorkflowID, event.WorkflowType, event.ResourceID, event.Step, event.Status,
	); err != nil {
		return fmt.Errorf("upsert workflow state: %w", err)
	}
	if _, err = tx.Exec(
		`INSERT INTO mojaloop_workflow_events (workflow_id, workflow_type, resource_id, step, status, payload, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())`,
		event.WorkflowID, event.WorkflowType, event.ResourceID, event.Step, event.Status, string(payloadBytes),
	); err != nil {
		return fmt.Errorf("insert workflow event: %w", err)
	}

	destinations, err := destinationsForFundsEvent(event)
	if err != nil {
		return err
	}
	eventID := eventIDFor(event)
	for _, destination := range destinations {
		ledgerDebit, ledgerErr := ledgerDebitFSP(event, destination)
		if ledgerErr != nil {
			return ledgerErr
		}
		if _, err = tx.Exec(
			`INSERT INTO mojaloop_funds_outbox (
				event_id, destination, idempotency_key, workflow_id, workflow_type, resource_id, step, workflow_status, payload, ledger_debit_fsp, dispatch_order, status, next_attempt_at, created_at, updated_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, 'pending', NOW(), NOW(), NOW())
			ON CONFLICT (destination, idempotency_key) DO NOTHING`,
			eventID, destination, eventID, event.WorkflowID, event.WorkflowType, event.ResourceID, event.Step, event.Status, string(payloadBytes), ledgerDebit, dispatchOrder(destination),
		); err != nil {
			return fmt.Errorf("insert %s funds outbox intent: %w", destination, err)
		}
	}
	return nil
}

func (s *MojaloopService) DispatchFundsOutbox(ctx context.Context, workerID string, batchSize int) (int, error) {
	if batchSize <= 0 || batchSize > defaultOutboxBatchSize {
		batchSize = defaultOutboxBatchSize
	}
	processed := 0
	for processed < batchSize {
		record, found, err := s.claimFundsOutboxRecord(workerID)
		if err != nil {
			return processed, err
		}
		if !found {
			return processed, nil
		}
		processed++
		if err := s.dispatchFundsOutboxRecord(ctx, record); err != nil {
			if updateErr := s.retryFundsOutboxRecord(record, err); updateErr != nil {
				return processed, updateErr
			}
			continue
		}
		if record.Destination == "tigerbeetle" {
			// Refund finalization and generic-outbox completion are committed under
			// the same claim fence so an expired worker cannot change local money
			// state after a successor has reclaimed the row.
			if err := s.finalizeTigerBeetleDispatch(record); err != nil {
				if updateErr := s.retryFundsOutboxRecord(record, err); updateErr != nil {
					return processed, updateErr
				}
				continue
			}
			continue
		}
		if err := s.markFundsOutboxDelivered(record); err != nil {
			return processed, err
		}
	}
	return processed, nil
}

func (s *MojaloopService) claimFundsOutboxRecord(workerID string) (fundsOutboxRecord, bool, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return fundsOutboxRecord{}, false, fmt.Errorf("begin outbox claim: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	row := tx.QueryRow(
		`WITH candidate AS (
			SELECT candidate.id FROM mojaloop_funds_outbox AS candidate
			WHERE (
				(candidate.status = 'pending' AND candidate.next_attempt_at <= NOW())
				OR (candidate.status = 'processing' AND candidate.claim_expires_at <= NOW())
			)
			AND NOT (candidate.destination = 'tigerbeetle' AND candidate.workflow_type = 'transfer')
			AND NOT EXISTS (
				SELECT 1 FROM mojaloop_funds_outbox AS predecessor
				WHERE predecessor.workflow_id = candidate.workflow_id
				AND predecessor.dispatch_order < candidate.dispatch_order
				AND predecessor.status <> 'delivered'
			)
			ORDER BY candidate.dispatch_order, candidate.id
			FOR UPDATE SKIP LOCKED
			LIMIT 1
		)
		UPDATE mojaloop_funds_outbox AS outbox
			SET status = 'processing', locked_at = NOW(), locked_by = $1,
				claim_token = gen_random_uuid(),
				claim_expires_at = NOW() + $2::interval,
				attempt_count = attempt_count + 1, updated_at = NOW()
			FROM candidate
			WHERE outbox.id = candidate.id
			RETURNING outbox.id, outbox.event_id, outbox.destination, outbox.idempotency_key, outbox.workflow_id, outbox.workflow_type, outbox.resource_id, outbox.step, outbox.workflow_status, outbox.payload, outbox.claim_token::text`,
		workerID,
		fmt.Sprintf("%f seconds", genericFundsOutboxClaimLease.Seconds()),
	)
	record := fundsOutboxRecord{}
	var payload []byte
	if err := row.Scan(&record.ID, &record.EventID, &record.Destination, &record.IdempotencyKey, &record.WorkflowID, &record.WorkflowType, &record.ResourceID, &record.Step, &record.Status, &payload, &record.ClaimToken); err != nil {
		if err == sql.ErrNoRows {
			return fundsOutboxRecord{}, false, nil
		}
		return fundsOutboxRecord{}, false, fmt.Errorf("claim outbox record: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.UseNumber()
	if err := decoder.Decode(&record.Payload); err != nil {
		return fundsOutboxRecord{}, false, fmt.Errorf("decode outbox payload: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fundsOutboxRecord{}, false, fmt.Errorf("commit outbox claim: %w", err)
	}
	return record, true, nil
}

func (s *MojaloopService) dispatchFundsOutboxRecord(ctx context.Context, record fundsOutboxRecord) error {
	event := FundsWorkflowEvent{WorkflowType: record.WorkflowType, WorkflowID: record.WorkflowID, ResourceID: record.ResourceID, Step: record.Step, Status: record.Status, Payload: record.Payload}
	switch record.Destination {
	case "tigerbeetle":
		return s.dispatchFundsEventToTigerBeetle(event)
	case "dapr":
		return s.publishWorkflowEventToDapr(event)
	case "kafka":
		return s.publishWorkflowEventToKafka(event)
	case "fluvio":
		return s.publishWorkflowEventToFluvio(event)
	case "temporal":
		return s.enqueueTemporalWorkflowTask(event)
	case "switch":
		return s.dispatchFundsEventToSwitch(event)
	default:
		return fmt.Errorf("unsupported funds outbox destination %q", record.Destination)
	}
}

func outboxMinor(payload map[string]any, field string) (uint64, error) {
	raw, ok := payload[field]
	if !ok {
		return 0, fmt.Errorf("outbox payload missing %s", field)
	}
	number, ok := raw.(json.Number)
	if !ok {
		return 0, fmt.Errorf("outbox %s must be an exact JSON integer", field)
	}
	return DecodeMinorUnitJSON(json.RawMessage(number.String()))
}

func (s *MojaloopService) dispatchFundsEventToTigerBeetle(event FundsWorkflowEvent) error {
	amountMinor, err := outboxMinor(event.Payload, "amountMinor")
	if err != nil {
		return err
	}
	payerFSP, payerOK := event.Payload["payerFsp"].(string)
	payeeFSP, payeeOK := event.Payload["payeeFsp"].(string)
	if !payerOK || !payeeOK || strings.TrimSpace(payerFSP) == "" || strings.TrimSpace(payeeFSP) == "" {
		return fmt.Errorf("outbox ledger payload requires payerFsp and payeeFsp")
	}
	switch event.WorkflowType {
	case "transfer":
		return s.tigerBeetle.ProcessMojaloopTransfer(event.WorkflowID, payerFSP, payeeFSP, amountMinor)
	case "refund":
		return s.tigerBeetle.ReverseMojaloopTransfer(event.WorkflowID, event.ResourceID, payerFSP, payeeFSP, amountMinor)
	default:
		return fmt.Errorf("workflow type %q has no TigerBeetle dispatch contract", event.WorkflowType)
	}
}

func (s *MojaloopService) finalizeTigerBeetleDispatch(record fundsOutboxRecord) error {
	if record.WorkflowType != "refund" {
		return fmt.Errorf("workflow type %q has no generic TigerBeetle finalization contract", record.WorkflowType)
	}

	// Reconcile before changing the platform state. The external ledger transfer
	// has a deterministic refund ID, so a retry after an ambiguous network result
	// is idempotent; the local state still changes only under the active claim.
	report, err := s.buildReconciliationReport(record.ResourceID)
	if err != nil {
		return err
	}
	if report.Ledger == nil || !report.Ledger.TransferExists || !report.LedgerConsistent {
		return fmt.Errorf("TigerBeetle refund reconciliation is inconsistent for transfer %q", record.ResourceID)
	}

	tx, err := s.db.BeginTx(context.Background(), nil)
	if err != nil {
		return fmt.Errorf("begin TigerBeetle refund finalization: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := requireActiveFundsOutboxClaim(tx, record); err != nil {
		return err
	}

	result, err := tx.Exec(
		`UPDATE mojaloop_refunds SET state = 'COMPLETED', completed_time = NOW(), updated_at = NOW()
		 WHERE refund_id = $1 AND state = 'PENDING_LEDGER'`,
		record.WorkflowID,
	)
	if err != nil {
		return fmt.Errorf("finalize refunded ledger state: %w", err)
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err != nil {
			return fmt.Errorf("verify refunded ledger state: %w", err)
		}
		return fmt.Errorf("refund %q is not pending ledger finalization", record.WorkflowID)
	}

	transferState := deriveTransferStateFromRefunds(report.Transfer.AmountMinor, report.PlatformRefundedMinor)
	if _, err := tx.Exec(`UPDATE mojaloop_transfers SET state = $2, updated_at = NOW() WHERE transfer_id = $1`, report.Transfer.TransferID, transferState); err != nil {
		return fmt.Errorf("finalize refunded transfer state: %w", err)
	}
	report.Transfer.State = transferState
	if err := storeReconciliationAuditTx(tx, report); err != nil {
		return err
	}
	if err := markFundsOutboxDeliveredTx(tx, record); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit TigerBeetle refund finalization: %w", err)
	}
	return nil
}

func (s *MojaloopService) dispatchFundsEventToSwitch(event FundsWorkflowEvent) error {
	payload := make(map[string]any, len(event.Payload)+1)
	for key, value := range event.Payload {
		payload[key] = value
	}
	switch event.WorkflowType {
	case "transfer":
		payload["transferId"] = event.WorkflowID
		return s.sendToSwitch("POST", "/transfers", payload)
	case "quote":
		payload["quoteId"] = event.WorkflowID
		return s.sendToSwitch("POST", "/quotes", payload)
	case "refund":
		payload["refundId"] = event.WorkflowID
		return s.sendToSwitch("POST", "/refunds", payload)
	default:
		return fmt.Errorf("workflow type %q has no switch dispatch contract", event.WorkflowType)
	}
}

func requireActiveFundsOutboxClaim(tx *sql.Tx, record fundsOutboxRecord) error {
	if tx == nil {
		return fmt.Errorf("outbox claim transaction is required")
	}
	if strings.TrimSpace(record.ClaimToken) == "" {
		return fmt.Errorf("outbox claim token is required")
	}
	var workflowID, workflowType, resourceID string
	if err := tx.QueryRow(
		`SELECT workflow_id, workflow_type, resource_id
		 FROM mojaloop_funds_outbox
		 WHERE id = $1 AND status = 'processing' AND claim_token::text = $2 AND claim_expires_at > NOW()
		 FOR UPDATE`,
		record.ID,
		record.ClaimToken,
	).Scan(&workflowID, &workflowType, &resourceID); err != nil {
		if err == sql.ErrNoRows {
			return fmt.Errorf("stale funds outbox claim for row %d", record.ID)
		}
		return fmt.Errorf("lock funds outbox claim for row %d: %w", record.ID, err)
	}
	if workflowID != record.WorkflowID || workflowType != record.WorkflowType || resourceID != record.ResourceID {
		return fmt.Errorf("funds outbox row %d changed during claim", record.ID)
	}
	return nil
}

func storeReconciliationAuditTx(tx *sql.Tx, report ReconciliationReport) error {
	details, err := json.Marshal(report)
	if err != nil {
		return fmt.Errorf("marshal reconciliation audit: %w", err)
	}
	if _, err := tx.Exec(
		`INSERT INTO mojaloop_reconciliation_audits (transfer_id, transfer_state, ledger_consistent, platform_refunded_amount, platform_net_settled_amount, platform_refunded_minor, platform_net_settled_minor, details, created_at)
		 VALUES ($1, $2, $3, $4::numeric / 100, $5::numeric / 100, $4, $5, $6::jsonb, NOW())`,
		report.Transfer.TransferID,
		report.Transfer.State,
		report.LedgerConsistent,
		int64(report.PlatformRefundedMinor),
		int64(report.PlatformNetSettledMinor),
		string(details),
	); err != nil {
		return fmt.Errorf("store reconciliation audit: %w", err)
	}
	return nil
}

func markFundsOutboxDeliveredTx(tx *sql.Tx, record fundsOutboxRecord) error {
	if err := requireActiveFundsOutboxClaim(tx, record); err != nil {
		return err
	}
	result, err := tx.Exec(
		`UPDATE mojaloop_funds_outbox
		 SET status = 'delivered', delivered_at = NOW(), locked_at = NULL, locked_by = NULL,
			 claim_token = NULL, claim_expires_at = NULL, last_error = NULL, updated_at = NOW()
		 WHERE id = $1 AND status = 'processing' AND claim_token::text = $2 AND claim_expires_at > NOW()`,
		record.ID,
		record.ClaimToken,
	)
	if err != nil {
		return fmt.Errorf("mark outbox delivered: %w", err)
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err != nil {
			return fmt.Errorf("verify outbox delivery completion: %w", err)
		}
		return fmt.Errorf("stale funds outbox completion for row %d", record.ID)
	}
	return nil
}

func (s *MojaloopService) retryFundsOutboxRecord(record fundsOutboxRecord, dispatchErr error) error {
	if strings.TrimSpace(record.ClaimToken) == "" {
		return fmt.Errorf("outbox claim token is required")
	}
	result, err := s.db.Exec(
		`UPDATE mojaloop_funds_outbox
		 SET status = CASE WHEN attempt_count >= $3 THEN 'failed' ELSE 'pending' END,
			 next_attempt_at = NOW() + (LEAST(attempt_count, 10) * INTERVAL '5 seconds'),
			 locked_at = NULL, locked_by = NULL, claim_token = NULL, claim_expires_at = NULL,
			 last_error = $4, updated_at = NOW()
		 WHERE id = $1 AND status = 'processing' AND claim_token::text = $2 AND claim_expires_at > NOW()`,
		record.ID,
		record.ClaimToken,
		maximumOutboxAttempts,
		dispatchErr.Error(),
	)
	if err != nil {
		return fmt.Errorf("record outbox retry: %w", err)
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err != nil {
			return fmt.Errorf("verify outbox retry transition: %w", err)
		}
		return fmt.Errorf("stale funds outbox retry for row %d", record.ID)
	}
	return nil
}

func (s *MojaloopService) markFundsOutboxDelivered(record fundsOutboxRecord) error {
	tx, err := s.db.BeginTx(context.Background(), nil)
	if err != nil {
		return fmt.Errorf("begin outbox delivery completion: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if err := markFundsOutboxDeliveredTx(tx, record); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit outbox delivery completion: %w", err)
	}
	return nil
}

// RunFundsOutboxDispatcher retains the public worker entrypoint while routing
// production callers through the bounded, partition-aware implementation.
func (s *MojaloopService) RunFundsOutboxDispatcher(ctx context.Context, workerID string) error {
	return s.RunPartitionAwareFundsOutboxDispatcher(ctx, workerID)
}
