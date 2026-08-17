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
	defaultOutboxBatchSize = 20
	maximumOutboxAttempts  = 12
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
}

func (s *MojaloopService) storeTransferAndWorkflow(transfer Transfer, event FundsWorkflowEvent) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin transfer and outbox transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.Exec(
		`INSERT INTO mojaloop_transfers (
			transfer_id, payer_fsp, payee_fsp, amount, amount_minor, currency, ilp_packet, condition, expiration, state, completed_time, fulfilment_value, created_at, updated_at
		) VALUES ($1,$2,$3,$4::numeric / 100,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
		ON CONFLICT (transfer_id) DO UPDATE SET
			payer_fsp = EXCLUDED.payer_fsp, payee_fsp = EXCLUDED.payee_fsp, amount = EXCLUDED.amount, amount_minor = EXCLUDED.amount_minor,
			currency = EXCLUDED.currency, ilp_packet = EXCLUDED.ilp_packet, condition = EXCLUDED.condition, expiration = EXCLUDED.expiration,
			state = EXCLUDED.state, completed_time = EXCLUDED.completed_time, fulfilment_value = EXCLUDED.fulfilment_value, updated_at = NOW()`,
		transfer.TransferID, transfer.PayerFSP, transfer.PayeeFSP, int64(transfer.AmountMinor), transfer.Currency, transfer.IlpPacket, transfer.Condition,
		transfer.Expiration, transfer.State, nullableTime(transfer.CompletedTime), nullableString(transfer.FulfilmentValue),
	); err != nil {
		return fmt.Errorf("store transfer with outbox: %w", err)
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
	if _, err = tx.Exec(
		`INSERT INTO mojaloop_quotes (
			quote_id, transaction_id, payer_fsp, payee_fsp, amount, amount_minor, currency, fees, fees_minor, expiration, state, created_at, updated_at
		) VALUES ($1,$2,$3,$4,$5::numeric / 100,$5,$6,$7::numeric / 100,$7,$8,$9,NOW(),NOW())
		ON CONFLICT (quote_id) DO UPDATE SET
			transaction_id = EXCLUDED.transaction_id, payer_fsp = EXCLUDED.payer_fsp, payee_fsp = EXCLUDED.payee_fsp,
			amount = EXCLUDED.amount, amount_minor = EXCLUDED.amount_minor, currency = EXCLUDED.currency, fees = EXCLUDED.fees,
			fees_minor = EXCLUDED.fees_minor, expiration = EXCLUDED.expiration, state = EXCLUDED.state, updated_at = NOW()`,
		quote.QuoteID, quote.TransactionID, quote.PayerFSP, quote.PayeeFSP, int64(quote.AmountMinor), quote.Currency, int64(quote.FeesMinor), quote.Expiration, quote.State,
	); err != nil {
		return fmt.Errorf("store quote with outbox: %w", err)
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
	if _, err := tx.Exec(
		`INSERT INTO mojaloop_refunds (
			refund_id, original_transfer_id, payer_fsp, payee_fsp, amount, amount_minor, currency, reason, state, completed_time, created_at, updated_at
		) VALUES ($1,$2,$3,$4,$5::numeric / 100,$5,$6,$7,$8,$9,NOW(),NOW())
		ON CONFLICT (refund_id) DO UPDATE SET
			original_transfer_id = EXCLUDED.original_transfer_id, payer_fsp = EXCLUDED.payer_fsp, payee_fsp = EXCLUDED.payee_fsp,
			amount = EXCLUDED.amount, amount_minor = EXCLUDED.amount_minor, currency = EXCLUDED.currency, reason = EXCLUDED.reason,
			state = EXCLUDED.state, completed_time = EXCLUDED.completed_time, updated_at = NOW()`,
		refund.RefundID, refund.OriginalTransferID, refund.PayerFSP, refund.PayeeFSP, int64(refund.AmountMinor), refund.Currency,
		nullableString(refund.Reason), refund.State, nullableTime(refund.CompletedTime),
	); err != nil {
		return fmt.Errorf("store refund with outbox: %w", err)
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
		if _, err = tx.Exec(
			`INSERT INTO mojaloop_funds_outbox (
				event_id, destination, idempotency_key, workflow_id, workflow_type, resource_id, step, workflow_status, payload, dispatch_order, status, next_attempt_at, created_at, updated_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, 'pending', NOW(), NOW(), NOW())
			ON CONFLICT (destination, idempotency_key) DO NOTHING`,
			eventID, destination, eventID, event.WorkflowID, event.WorkflowType, event.ResourceID, event.Step, event.Status, string(payloadBytes), dispatchOrder(destination),
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
			if updateErr := s.retryFundsOutboxRecord(record.ID, err); updateErr != nil {
				return processed, updateErr
			}
			continue
		}
		if record.Destination == "tigerbeetle" {
			if err := s.finalizeTigerBeetleDispatch(record); err != nil {
				if updateErr := s.retryFundsOutboxRecord(record.ID, err); updateErr != nil {
					return processed, updateErr
				}
				continue
			}
		}
		if err := s.markFundsOutboxDelivered(record.ID); err != nil {
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
			WHERE candidate.status = 'pending' AND candidate.next_attempt_at <= NOW()
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
		SET status = 'processing', locked_at = NOW(), locked_by = $1, attempt_count = attempt_count + 1, updated_at = NOW()
		FROM candidate
		WHERE outbox.id = candidate.id
		RETURNING outbox.id, outbox.event_id, outbox.destination, outbox.idempotency_key, outbox.workflow_id, outbox.workflow_type, outbox.resource_id, outbox.step, outbox.workflow_status, outbox.payload`,
		workerID,
	)
	record := fundsOutboxRecord{}
	var payload []byte
	if err := row.Scan(&record.ID, &record.EventID, &record.Destination, &record.IdempotencyKey, &record.WorkflowID, &record.WorkflowType, &record.ResourceID, &record.Step, &record.Status, &payload); err != nil {
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
	switch record.WorkflowType {
	case "transfer":
		if err := s.updateTransferState(record.WorkflowID, "COMMITTED"); err != nil {
			return err
		}
		return nil
	case "refund":
		if _, err := s.db.Exec(
			`UPDATE mojaloop_refunds SET state = 'COMPLETED', completed_time = NOW(), updated_at = NOW()
			 WHERE refund_id = $1 AND state = 'PENDING_LEDGER'`,
			record.WorkflowID,
		); err != nil {
			return fmt.Errorf("finalize refunded ledger state: %w", err)
		}
		report, err := s.buildReconciliationReport(record.ResourceID)
		if err != nil {
			return err
		}
		transferState := deriveTransferStateFromRefunds(report.Transfer.AmountMinor, report.PlatformRefundedMinor)
		if err := s.updateTransferState(report.Transfer.TransferID, transferState); err != nil {
			return err
		}
		report.Transfer.State = transferState
		if err := s.storeReconciliationAudit(report); err != nil {
			return err
		}
		return nil
	default:
		return fmt.Errorf("workflow type %q has no TigerBeetle finalization contract", record.WorkflowType)
	}
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

func (s *MojaloopService) retryFundsOutboxRecord(id int64, dispatchErr error) error {
	_, err := s.db.Exec(
		`UPDATE mojaloop_funds_outbox
		SET status = CASE WHEN attempt_count >= $2 THEN 'failed' ELSE 'pending' END,
			next_attempt_at = NOW() + (LEAST(attempt_count, 10) * INTERVAL '5 seconds'),
			locked_at = NULL, locked_by = NULL, last_error = $3, updated_at = NOW()
		WHERE id = $1`,
		id, maximumOutboxAttempts, dispatchErr.Error(),
	)
	if err != nil {
		return fmt.Errorf("record outbox retry: %w", err)
	}
	return nil
}

func (s *MojaloopService) markFundsOutboxDelivered(id int64) error {
	_, err := s.db.Exec(
		`UPDATE mojaloop_funds_outbox
		SET status = 'delivered', delivered_at = NOW(), locked_at = NULL, locked_by = NULL, last_error = NULL, updated_at = NOW()
		WHERE id = $1`,
		id,
	)
	if err != nil {
		return fmt.Errorf("mark outbox delivered: %w", err)
	}
	return nil
}

func (s *MojaloopService) RunFundsOutboxDispatcher(ctx context.Context, workerID string) error {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if _, err := s.DispatchFundsOutbox(ctx, workerID, defaultOutboxBatchSize); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}
