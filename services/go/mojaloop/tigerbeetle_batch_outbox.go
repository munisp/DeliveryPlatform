package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"
)

const (
	defaultTigerBeetleDispatchBatch = 256
	tigerBeetleClaimLease           = time.Minute
)

type claimedTigerBeetleOutboxRecord struct {
	fundsOutboxRecord
	ClaimToken string
}

func ledgerDebitFSP(event FundsWorkflowEvent, destination string) (any, error) {
	if destination != "tigerbeetle" {
		return nil, nil
	}
	payer, payerOK := event.Payload["payerFsp"].(string)
	payee, payeeOK := event.Payload["payeeFsp"].(string)
	if !payerOK || !payeeOK || strings.TrimSpace(payer) == "" || strings.TrimSpace(payee) == "" {
		return nil, fmt.Errorf("TigerBeetle outbox payload requires payerFsp and payeeFsp")
	}
	switch event.WorkflowType {
	case "transfer":
		return payer, nil
	case "refund":
		return payee, nil
	default:
		return nil, fmt.Errorf("workflow type %q has no TigerBeetle debit account", event.WorkflowType)
	}
}

func (s *MojaloopService) claimTigerBeetleTransferBatch(workerID string, limit int) ([]claimedTigerBeetleOutboxRecord, error) {
	if limit <= 0 || limit > maximumTigerBeetleTransferBatch {
		limit = defaultTigerBeetleDispatchBatch
	}
	if strings.TrimSpace(workerID) == "" {
		return nil, fmt.Errorf("TigerBeetle batch worker ID is required")
	}

	tx, err := s.db.BeginTx(context.Background(), nil)
	if err != nil {
		return nil, fmt.Errorf("begin TigerBeetle batch claim: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	rows, err := tx.Query(
		`WITH ready AS MATERIALIZED (
			SELECT candidate.id
			FROM mojaloop_funds_outbox AS candidate
			WHERE candidate.destination = 'tigerbeetle'
			  AND candidate.workflow_type = 'transfer'
			  AND (
				(candidate.status = 'pending' AND candidate.next_attempt_at <= NOW())
				OR (candidate.status = 'processing' AND candidate.claim_expires_at <= NOW())
			  )
			  -- Keep one payer/FSP debit stream ordered. Independent debit
			  -- streams remain eligible for concurrent workers and one batch.
			  AND NOT EXISTS (
				SELECT 1
				FROM mojaloop_funds_outbox AS earlier
				WHERE earlier.destination = 'tigerbeetle'
				  AND earlier.workflow_type = 'transfer'
				  AND earlier.ledger_debit_fsp = candidate.ledger_debit_fsp
				  AND earlier.id < candidate.id
				  AND earlier.status <> 'delivered'
			  )
			ORDER BY candidate.id
			FOR UPDATE SKIP LOCKED
			LIMIT $2
		), claimed AS (
			UPDATE mojaloop_funds_outbox AS outbox
			SET status = 'processing',
				locked_at = NOW(),
				locked_by = $1,
				claim_token = gen_random_uuid(),
				claim_expires_at = NOW() + $3::interval,
				attempt_count = outbox.attempt_count + 1,
				updated_at = NOW()
			FROM ready
			WHERE outbox.id = ready.id
			RETURNING outbox.id, outbox.event_id, outbox.destination,
				outbox.idempotency_key, outbox.workflow_id, outbox.workflow_type,
				outbox.resource_id, outbox.step, outbox.workflow_status,
				outbox.payload, outbox.claim_token::text
		)
		SELECT * FROM claimed ORDER BY id`,
		workerID,
		limit,
		fmt.Sprintf("%f seconds", tigerBeetleClaimLease.Seconds()),
	)
	if err != nil {
		return nil, fmt.Errorf("claim TigerBeetle transfer batch: %w", err)
	}
	defer rows.Close()

	claimed := make([]claimedTigerBeetleOutboxRecord, 0, limit)
	for rows.Next() {
		var record claimedTigerBeetleOutboxRecord
		var payload []byte
		if err := rows.Scan(
			&record.ID,
			&record.EventID,
			&record.Destination,
			&record.IdempotencyKey,
			&record.WorkflowID,
			&record.WorkflowType,
			&record.ResourceID,
			&record.Step,
			&record.Status,
			&payload,
			&record.ClaimToken,
		); err != nil {
			return nil, fmt.Errorf("scan TigerBeetle batch claim: %w", err)
		}
		decoder := json.NewDecoder(bytes.NewReader(payload))
		decoder.UseNumber()
		if err := decoder.Decode(&record.Payload); err != nil {
			return nil, fmt.Errorf("decode TigerBeetle batch payload: %w", err)
		}
		claimed = append(claimed, record)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate TigerBeetle batch claim: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit TigerBeetle batch claim: %w", err)
	}
	return claimed, nil
}

func tigerBeetleBatchRequest(record claimedTigerBeetleOutboxRecord) (TigerBeetleTransferRequest, error) {
	amountMinor, err := outboxMinor(record.Payload, "amountMinor")
	if err != nil {
		return TigerBeetleTransferRequest{}, err
	}
	payer, payerOK := record.Payload["payerFsp"].(string)
	payee, payeeOK := record.Payload["payeeFsp"].(string)
	if !payerOK || !payeeOK || strings.TrimSpace(payer) == "" || strings.TrimSpace(payee) == "" {
		return TigerBeetleTransferRequest{}, fmt.Errorf("TigerBeetle batch payload requires payerFsp and payeeFsp")
	}
	return TigerBeetleTransferRequest{
		TransferID:    record.WorkflowID,
		DebitAlias:    payer,
		CreditAlias:   payee,
		Amount:        amountMinor,
		CorrelationID: record.WorkflowID,
		Code:          defaultTigerBeetleTransferCode,
	}, nil
}

func (s *MojaloopService) verifyTigerBeetleTransferReconciliation(transferID string) (ReconciliationReport, error) {
	report, err := s.buildReconciliationReport(transferID)
	if err != nil {
		return ReconciliationReport{}, fmt.Errorf("build TigerBeetle reconciliation: %w", err)
	}
	if report.Ledger == nil || !report.Ledger.TransferExists || !report.LedgerConsistent {
		return ReconciliationReport{}, fmt.Errorf("TigerBeetle reconciliation is inconsistent for transfer %q", transferID)
	}
	return report, nil
}

func (s *MojaloopService) finalizeTigerBeetleBatchRecord(record claimedTigerBeetleOutboxRecord) error {
	// Reconcile before committing the platform state. The report is recomputed
	// after any retry so an ambiguous network result cannot become final solely
	// because the batch call returned.
	report, err := s.verifyTigerBeetleTransferReconciliation(record.WorkflowID)
	if err != nil {
		return err
	}

	tx, err := s.db.BeginTx(context.Background(), nil)
	if err != nil {
		return fmt.Errorf("begin TigerBeetle batch finalization: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var workflowID string
	if err := tx.QueryRow(
		`SELECT workflow_id
		 FROM mojaloop_funds_outbox
		 WHERE id = $1
		   AND status = 'processing'
		   AND claim_token::text = $2
		   AND claim_expires_at > NOW()
		 FOR UPDATE`,
		record.ID,
		record.ClaimToken,
	).Scan(&workflowID); err != nil {
		if err == sql.ErrNoRows {
			return fmt.Errorf("stale TigerBeetle batch claim for outbox row %d", record.ID)
		}
		return fmt.Errorf("lock TigerBeetle batch outbox record: %w", err)
	}
	if workflowID != record.WorkflowID {
		return fmt.Errorf("TigerBeetle batch workflow changed during claim")
	}
	if _, err := tx.Exec(
		`UPDATE mojaloop_transfers
		 SET state = 'COMMITTED', updated_at = NOW()
		 WHERE transfer_id = $1`,
		record.WorkflowID,
	); err != nil {
		return fmt.Errorf("finalize TigerBeetle transfer state: %w", err)
	}
	if _, err := tx.Exec(
		`INSERT INTO mojaloop_reconciliation_audits (
			transfer_id, transfer_state, ledger_consistent,
			platform_refunded_amount, platform_net_settled_amount,
			platform_refunded_minor, platform_net_settled_minor, details, created_at
		) VALUES ($1, 'COMMITTED', true, $2::numeric / 100, $3::numeric / 100, $2, $3, $4::jsonb, NOW())`,
		report.Transfer.TransferID,
		int64(report.PlatformRefundedMinor),
		int64(report.PlatformNetSettledMinor),
		mustMarshalJSON(report),
	); err != nil {
		return fmt.Errorf("store TigerBeetle reconciliation audit: %w", err)
	}
	result, err := tx.Exec(
		`UPDATE mojaloop_funds_outbox
		 SET status = 'delivered', delivered_at = NOW(), locked_at = NULL,
			locked_by = NULL, claim_token = NULL, claim_expires_at = NULL,
			last_error = NULL, updated_at = NOW()
		 WHERE id = $1 AND status = 'processing' AND claim_token::text = $2`,
		record.ID,
		record.ClaimToken,
	)
	if err != nil {
		return fmt.Errorf("mark TigerBeetle batch record delivered: %w", err)
	}
	if count, err := result.RowsAffected(); err != nil || count != 1 {
		if err != nil {
			return fmt.Errorf("verify TigerBeetle batch completion: %w", err)
		}
		return fmt.Errorf("stale TigerBeetle batch completion for outbox row %d", record.ID)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit TigerBeetle batch finalization: %w", err)
	}
	return nil
}

func mustMarshalJSON(value any) string {
	payload, err := json.Marshal(value)
	if err != nil {
		return fmt.Sprintf(`{"serialization_error":%q}`, err.Error())
	}
	return string(payload)
}

func (s *MojaloopService) retryOrDeadLetterTigerBeetleBatchRecord(record claimedTigerBeetleOutboxRecord, dispatchErr error) error {
	tx, err := s.db.BeginTx(context.Background(), nil)
	if err != nil {
		return fmt.Errorf("begin TigerBeetle batch retry: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var attemptCount int
	if err := tx.QueryRow(
		`SELECT attempt_count
		 FROM mojaloop_funds_outbox
		 WHERE id = $1 AND status = 'processing' AND claim_token::text = $2
			   AND claim_expires_at > NOW()
			 FOR UPDATE`,
		record.ID,
		record.ClaimToken,
	).Scan(&attemptCount); err != nil {
		if err == sql.ErrNoRows {
			return fmt.Errorf("stale TigerBeetle batch retry for outbox row %d", record.ID)
		}
		return fmt.Errorf("lock TigerBeetle batch retry row: %w", err)
	}

	if attemptCount >= maximumOutboxAttempts {
		if _, err := tx.Exec(
			`UPDATE mojaloop_funds_outbox
			 SET status = 'dead_letter', locked_at = NULL, locked_by = NULL,
				claim_token = NULL, claim_expires_at = NULL, last_error = $3,
				updated_at = NOW()
			 WHERE id = $1 AND status = 'processing' AND claim_token::text = $2
			   AND claim_expires_at > NOW()`,
			record.ID,
			record.ClaimToken,
			dispatchErr.Error(),
		); err != nil {
			return fmt.Errorf("dead-letter TigerBeetle batch row: %w", err)
		}
		if _, err := tx.Exec(
			`INSERT INTO mojaloop_workflow_events (
				workflow_id, workflow_type, resource_id, step, status, payload, created_at
			) VALUES ($1, $2, $3, 'ledger_dead_lettered', 'FAILED', $4::jsonb, NOW())`,
			record.WorkflowID,
			record.WorkflowType,
			record.ResourceID,
			mustMarshalJSON(map[string]any{
				"destination":  "tigerbeetle",
				"outboxId":     record.ID,
				"attemptCount": attemptCount,
				"error":        dispatchErr.Error(),
			}),
		); err != nil {
			return fmt.Errorf("append TigerBeetle dead-letter workflow event: %w", err)
		}
	} else if _, err := tx.Exec(
		`UPDATE mojaloop_funds_outbox
		 SET status = 'pending',
			next_attempt_at = NOW() + (LEAST(attempt_count, 10) * INTERVAL '5 seconds'),
			locked_at = NULL, locked_by = NULL, claim_token = NULL,
			claim_expires_at = NULL, last_error = $3, updated_at = NOW()
		 WHERE id = $1 AND status = 'processing' AND claim_token::text = $2
			   AND claim_expires_at > NOW()`,
		record.ID,
		record.ClaimToken,
		dispatchErr.Error(),
	); err != nil {
		return fmt.Errorf("retry TigerBeetle batch row: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit TigerBeetle batch retry: %w", err)
	}
	return nil
}

func (s *MojaloopService) DispatchTigerBeetleTransferBatch(workerID string, limit int) (int, error) {
	claimed, err := s.claimTigerBeetleTransferBatch(workerID, limit)
	if err != nil || len(claimed) == 0 {
		return len(claimed), err
	}

	requests := make([]TigerBeetleTransferRequest, 0, len(claimed))
	valid := make([]claimedTigerBeetleOutboxRecord, 0, len(claimed))
	for _, record := range claimed {
		request, requestErr := tigerBeetleBatchRequest(record)
		if requestErr != nil {
			if retryErr := s.retryOrDeadLetterTigerBeetleBatchRecord(record, requestErr); retryErr != nil {
				return len(claimed), retryErr
			}
			continue
		}
		requests = append(requests, request)
		valid = append(valid, record)
	}
	if len(valid) == 0 {
		return len(claimed), nil
	}

	outcomes, submitErr := s.tigerBeetle.ProcessMojaloopTransferBatch(requests)
	if submitErr != nil {
		for _, record := range valid {
			if retryErr := s.retryOrDeadLetterTigerBeetleBatchRecord(record, submitErr); retryErr != nil {
				return len(claimed), retryErr
			}
		}
		return len(claimed), nil
	}
	if len(outcomes) != len(valid) {
		outcomeErr := fmt.Errorf("TigerBeetle batch returned %d outcomes for %d valid records", len(outcomes), len(valid))
		for _, record := range valid {
			if retryErr := s.retryOrDeadLetterTigerBeetleBatchRecord(record, outcomeErr); retryErr != nil {
				return len(claimed), retryErr
			}
		}
		return len(claimed), nil
	}
	for index, outcome := range outcomes {
		record := valid[index]
		if outcome.TransferID != record.WorkflowID {
			outcomeErr := fmt.Errorf("TigerBeetle batch outcome order mismatch at %d", index)
			for _, pending := range valid {
				if retryErr := s.retryOrDeadLetterTigerBeetleBatchRecord(pending, outcomeErr); retryErr != nil {
					return len(claimed), retryErr
				}
			}
			return len(claimed), nil
		}
		if outcome.Err != nil {
			if err := s.retryOrDeadLetterTigerBeetleBatchRecord(record, outcome.Err); err != nil {
				return len(claimed), err
			}
			continue
		}
		if err := s.finalizeTigerBeetleBatchRecord(record); err != nil {
			if retryErr := s.retryOrDeadLetterTigerBeetleBatchRecord(record, err); retryErr != nil {
				return len(claimed), retryErr
			}
		}
	}
	return len(claimed), nil
}
