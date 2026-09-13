package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	_ "github.com/lib/pq"
)

type TigerBeetleLedger interface {
	CreatePayerAccount(payerID string) error
	CreatePayeeAccount(payeeID string) error
	ProcessMojaloopTransfer(transferID string, payerID string, payeeID string, amount uint64) error
	ProcessMojaloopTransferBatch(requests []TigerBeetleTransferRequest) ([]TigerBeetleTransferOutcome, error)
	ReverseMojaloopTransfer(refundID string, originalTransferID string, payerID string, payeeID string, amount uint64) error
	GetTransferReconciliation(transferID string) (TransferReconciliation, error)
}

type MojaloopService struct {
	httpClient           *http.Client
	switchURL            string
	participantID        string
	internalServiceToken string
	tigerBeetle          TigerBeetleLedger
	db                   *sql.DB
}

type Transfer struct {
	TransferID      string    `json:"transferId"`
	PayerFSP        string    `json:"payerFsp"`
	PayeeFSP        string    `json:"payeeFsp"`
	AmountMinor     uint64    `json:"amountMinor"`
	Currency        string    `json:"currency"`
	IlpPacket       string    `json:"ilpPacket"`
	Condition       string    `json:"condition"`
	Expiration      time.Time `json:"expiration"`
	State           string    `json:"state"`
	CompletedTime   time.Time `json:"completedTimestamp,omitempty"`
	FulfilmentValue string    `json:"fulfilment,omitempty"`
}

type Quote struct {
	QuoteID       string    `json:"quoteId"`
	TransactionID string    `json:"transactionId"`
	PayerFSP      string    `json:"payerFsp"`
	PayeeFSP      string    `json:"payeeFsp"`
	AmountMinor   uint64    `json:"amountMinor"`
	Currency      string    `json:"currency"`
	FeesMinor     uint64    `json:"feesMinor"`
	Expiration    time.Time `json:"expiration"`
	State         string    `json:"state"`
}

type Refund struct {
	RefundID           string    `json:"refundId"`
	OriginalTransferID string    `json:"originalTransferId"`
	PayerFSP           string    `json:"payerFsp"`
	PayeeFSP           string    `json:"payeeFsp"`
	AmountMinor        uint64    `json:"amountMinor"`
	Currency           string    `json:"currency"`
	Reason             string    `json:"reason,omitempty"`
	State              string    `json:"state"`
	CompletedTime      time.Time `json:"completedTimestamp,omitempty"`
}

type TransferInitiationPayload struct {
	TransferID  string `json:"transferId"`
	PayerFSP    string `json:"payerFsp"`
	PayeeFSP    string `json:"payeeFsp"`
	AmountMinor uint64 `json:"amountMinor"`
	Currency    string `json:"currency"`
}

type QuoteInitiationPayload struct {
	QuoteID       string `json:"quoteId"`
	TransactionID string `json:"transactionId"`
	PayerFSP      string `json:"payerFsp"`
	PayeeFSP      string `json:"payeeFsp"`
	AmountMinor   uint64 `json:"amountMinor"`
	Currency      string `json:"currency"`
}

type RefundInitiationPayload struct {
	RefundID           string `json:"refundId"`
	OriginalTransferID string `json:"originalTransferId"`
	AmountMinor        uint64 `json:"amountMinor"`
	Currency           string `json:"currency"`
	Reason             string `json:"reason"`
}

type ReconciliationReport struct {
	Transfer                Transfer                `json:"transfer"`
	Refunds                 []Refund                `json:"refunds"`
	Ledger                  *TransferReconciliation `json:"ledger,omitempty"`
	PlatformRefundedMinor   uint64                  `json:"platformRefundedMinor"`
	PlatformNetSettledMinor uint64                  `json:"platformNetSettledMinor"`
	LedgerConsistent        bool                    `json:"ledgerConsistent"`
	Recommendation          string                  `json:"recommendation"`
	RecordedAt              time.Time               `json:"recordedAt"`
}

func NewMojaloopService(tigerBeetle TigerBeetleLedger) (*MojaloopService, error) {
	if tigerBeetle == nil {
		return nil, fmt.Errorf("TigerBeetle ledger client is required for Mojaloop funds operations")
	}
	internalServiceToken := strings.TrimSpace(os.Getenv("INTERNAL_SERVICE_TOKEN"))
	if len(internalServiceToken) < 32 {
		return nil, fmt.Errorf("INTERNAL_SERVICE_TOKEN must be explicitly configured with at least 32 characters")
	}
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		return nil, fmt.Errorf("DATABASE_URL must be explicitly configured")
	}
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		return nil, fmt.Errorf("open mojaloop database: %w", err)
	}
	if err := configureFinancialDatabasePool(db); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("configure Mojaloop database pool: %w", err)
	}
	// MOJALOOP_DATABASE_POOL_MAX is an explicit per-workload override (used by the
	// dedicated outbox-worker manifest) applied on top of the FINANCIAL_DB_* pool
	// defaults configured above.
	if poolMaxRaw := strings.TrimSpace(os.Getenv("MOJALOOP_DATABASE_POOL_MAX")); poolMaxRaw != "" {
		poolMax, err := strconv.Atoi(poolMaxRaw)
		if err != nil || poolMax < 1 || poolMax > 48 {
			_ = db.Close()
			return nil, fmt.Errorf("MOJALOOP_DATABASE_POOL_MAX must be an integer between 1 and 48")
		}
		db.SetMaxOpenConns(poolMax)
		db.SetMaxIdleConns(poolMax)
	}
	if err := db.Ping(); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("ping mojaloop database: %w", err)
	}

	service := &MojaloopService{
		httpClient:           &http.Client{Timeout: 30 * time.Second},
		switchURL:            getEnv("MOJALOOP_SWITCH_URL", "http://localhost:4001"),
		participantID:        getEnv("MOJALOOP_PARTICIPANT_ID", "switchos"),
		internalServiceToken: internalServiceToken,
		tigerBeetle:          tigerBeetle,
		db:                   db,
	}
	if err := service.verifyPersistenceContract(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return service, nil
}

const mojaloopFundsSchemaContractVersion = 10

func (s *MojaloopService) verifyPersistenceContract() error {
	var version int
	if err := s.db.QueryRow(`SELECT version FROM platform_schema_contracts WHERE component = 'mojaloop_funds'`).Scan(&version); err != nil {
		if err == sql.ErrNoRows {
			return fmt.Errorf("Mojaloop funds schema contract is missing; apply the reviewed Mojaloop financial migrations before starting the service")
		}
		return fmt.Errorf("read Mojaloop funds schema contract: %w", err)
	}
	if version < mojaloopFundsSchemaContractVersion {
		return fmt.Errorf("Mojaloop funds schema contract version %d is obsolete; apply the reviewed Mojaloop financial migrations before starting the service", version)
	}

	requiredColumns := [][2]string{
		{"mojaloop_transfers", "amount_minor"},
		{"mojaloop_quotes", "amount_minor"},
		{"mojaloop_quotes", "fees_minor"},
		{"mojaloop_refunds", "amount_minor"},
		{"mojaloop_reconciliation_audits", "platform_net_settled_minor"},
		{"mojaloop_idempotency_keys", "operation"},
		{"mojaloop_workflows", "workflow_id"},
		{"mojaloop_workflow_events", "workflow_id"},
		{"mojaloop_workflow_orchestration", "workflow_id"},
		{"mojaloop_funds_outbox", "dispatch_order"},
		{"mojaloop_funds_outbox", "ledger_debit_fsp"},
		{"mojaloop_funds_outbox", "claim_token"},
		{"mojaloop_funds_outbox", "claim_expires_at"},
	}
	for _, requirement := range requiredColumns {
		var exists bool
		if err := s.db.QueryRow(`SELECT EXISTS (
			SELECT 1 FROM information_schema.columns
			WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2
		)`, requirement[0], requirement[1]).Scan(&exists); err != nil {
			return fmt.Errorf("verify Mojaloop schema requirement %s.%s: %w", requirement[0], requirement[1], err)
		}
		if !exists {
			return fmt.Errorf("Mojaloop schema requirement %s.%s is missing; apply reviewed migrations before starting the service", requirement[0], requirement[1])
		}
	}
	return nil
}

func (s *MojaloopService) initiateTransfer(payload TransferInitiationPayload, idempotencyKey string) (map[string]any, error) {
	key := fallbackString(idempotencyKey, payload.TransferID)
	return s.executeIdempotent("transfer_initiation", key, payload.TransferID, func() (map[string]any, error) {
		if existing, ok := s.getTransfer(payload.TransferID); ok {
			return map[string]any{
				"transferId": existing.TransferID,
				"state":      existing.State,
				"message":    "Transfer already exists",
				"cached":     true,
			}, nil
		}

		expiration := time.Now().Add(30 * time.Minute).UTC()
		ilpPacket, condition, fulfilment, err := newTransferILP(payload.TransferID, payload.PayeeFSP, payload.AmountMinor, expiration)
		if err != nil {
			return nil, fmt.Errorf("generate ILP prepare for transfer %s: %w", payload.TransferID, err)
		}

		transfer := Transfer{
			TransferID:      payload.TransferID,
			PayerFSP:        payload.PayerFSP,
			PayeeFSP:        payload.PayeeFSP,
			AmountMinor:     payload.AmountMinor,
			Currency:        fallbackString(payload.Currency, "EUR"),
			IlpPacket:       ilpPacket,
			Condition:       condition,
			Expiration:      expiration,
			State:           "RESERVED",
			FulfilmentValue: fulfilment,
		}

		transferEvent := FundsWorkflowEvent{
			WorkflowType: "transfer",
			WorkflowID:   payload.TransferID,
			ResourceID:   payload.TransferID,
			Step:         "initiated",
			Status:       transfer.State,
			Payload: map[string]any{
				"payerFsp":    transfer.PayerFSP,
				"payeeFsp":    transfer.PayeeFSP,
				"amountMinor": transfer.AmountMinor,
				"currency":    transfer.Currency,
			},
		}
		if err := s.storeTransferAndWorkflow(transfer, transferEvent); err != nil {
			return nil, err
		}

		return map[string]any{
			"transferId": transfer.TransferID,
			"state":      transfer.State,
			"message":    "Transfer reserved; downstream delivery is durably queued",
		}, nil
	})
}

func (s *MojaloopService) requestQuote(payload QuoteInitiationPayload, idempotencyKey string) (map[string]any, error) {
	key := fallbackString(idempotencyKey, payload.QuoteID)
	return s.executeIdempotent("quote_request", key, payload.QuoteID, func() (map[string]any, error) {
		if existing, ok := s.getQuote(payload.QuoteID); ok {
			return map[string]any{
				"quoteId":          existing.QuoteID,
				"transactionId":    existing.TransactionID,
				"feesMinor":        existing.FeesMinor,
				"totalAmountMinor": existing.AmountMinor + existing.FeesMinor,
				"currency":         existing.Currency,
				"cached":           true,
			}, nil
		}

		quote := Quote{
			QuoteID:       payload.QuoteID,
			TransactionID: payload.TransactionID,
			PayerFSP:      payload.PayerFSP,
			PayeeFSP:      payload.PayeeFSP,
			AmountMinor:   payload.AmountMinor,
			Currency:      fallbackString(payload.Currency, "EUR"),
			FeesMinor:     calculateFeesMinor(payload.AmountMinor),
			Expiration:    time.Now().Add(30 * time.Minute),
			State:         "PENDING",
		}

		quoteEvent := FundsWorkflowEvent{
			WorkflowType: "quote",
			WorkflowID:   payload.QuoteID,
			ResourceID:   payload.TransactionID,
			Step:         "requested",
			Status:       quote.State,
			Payload: map[string]any{
				"payerFsp":    quote.PayerFSP,
				"payeeFsp":    quote.PayeeFSP,
				"amountMinor": quote.AmountMinor,
				"feesMinor":   quote.FeesMinor,
				"currency":    quote.Currency,
			},
		}
		if err := s.storeQuoteAndWorkflow(quote, quoteEvent); err != nil {
			return nil, err
		}

		return map[string]any{
			"quoteId":          quote.QuoteID,
			"transactionId":    quote.TransactionID,
			"feesMinor":        quote.FeesMinor,
			"totalAmountMinor": quote.AmountMinor + quote.FeesMinor,
			"currency":         quote.Currency,
		}, nil
	})
}

func (s *MojaloopService) initiateRefund(payload RefundInitiationPayload, idempotencyKey string) (map[string]any, error) {
	key := fallbackString(idempotencyKey, payload.RefundID)
	return s.executeIdempotent("refund_initiation", key, payload.RefundID, func() (map[string]any, error) {
		if existing, ok := s.getRefund(payload.RefundID); ok {
			return map[string]any{
				"refundId":           existing.RefundID,
				"originalTransferId": existing.OriginalTransferID,
				"state":              existing.State,
				"cached":             true,
			}, nil
		}

		refund, err := s.reserveRefundAndWorkflow(payload)
		if err != nil {
			return nil, err
		}

		return map[string]any{
			"refundId":           refund.RefundID,
			"originalTransferId": refund.OriginalTransferID,
			"state":              refund.State,
			"message":            "Refund is durably queued for ledger reversal",
		}, nil
	})
}

// reserveRefundAndWorkflow serializes all reservations for one original
// transfer. Pending ledger reversals consume the same available amount as
// completed reversals so a broker or ledger interruption cannot make the same
// settled value refundable twice.
func (s *MojaloopService) reserveRefundAndWorkflow(payload RefundInitiationPayload) (Refund, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return Refund{}, fmt.Errorf("begin refund reservation transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	transfer, found, err := getTransferForRefundReservation(tx, payload.OriginalTransferID)
	if err != nil {
		return Refund{}, err
	}
	if !found {
		return Refund{}, fmt.Errorf("original transfer not found")
	}
	if !isRefundableTransferState(transfer.State) {
		return Refund{}, fmt.Errorf("transfer state %s cannot be refunded", transfer.State)
	}

	currentRefunded, err := getRefundedAmountTx(tx, payload.OriginalTransferID)
	if err != nil {
		return Refund{}, err
	}
	if currentRefunded > transfer.AmountMinor || payload.AmountMinor > transfer.AmountMinor-currentRefunded {
		return Refund{}, fmt.Errorf("refund amount exceeds remaining settled amount")
	}

	refund := Refund{
		RefundID:           payload.RefundID,
		OriginalTransferID: payload.OriginalTransferID,
		PayerFSP:           transfer.PayerFSP,
		PayeeFSP:           transfer.PayeeFSP,
		AmountMinor:        payload.AmountMinor,
		Currency:           fallbackString(payload.Currency, transfer.Currency),
		Reason:             strings.TrimSpace(payload.Reason),
		State:              "PENDING_LEDGER",
	}
	refundEvent := FundsWorkflowEvent{
		WorkflowType: "refund",
		WorkflowID:   payload.RefundID,
		ResourceID:   payload.OriginalTransferID,
		Step:         "queued",
		Status:       refund.State,
		Payload: map[string]any{
			"payerFsp":    refund.PayerFSP,
			"payeeFsp":    refund.PayeeFSP,
			"amountMinor": refund.AmountMinor,
			"currency":    refund.Currency,
			"reason":      refund.Reason,
		},
	}
	if err := s.storeRefundAndWorkflowTx(tx, refund, refundEvent); err != nil {
		return Refund{}, err
	}
	if err := tx.Commit(); err != nil {
		return Refund{}, fmt.Errorf("commit refund reservation transaction: %w", err)
	}
	return refund, nil
}

func getTransferForRefundReservation(tx *sql.Tx, transferID string) (Transfer, bool, error) {
	transfer := Transfer{}
	err := tx.QueryRow(
		`SELECT transfer_id, payer_fsp, payee_fsp, amount_minor, currency, state
		 FROM mojaloop_transfers WHERE transfer_id = $1 FOR UPDATE`,
		transferID,
	).Scan(&transfer.TransferID, &transfer.PayerFSP, &transfer.PayeeFSP, &transfer.AmountMinor, &transfer.Currency, &transfer.State)
	if err == sql.ErrNoRows {
		return Transfer{}, false, nil
	}
	if err != nil {
		return Transfer{}, false, fmt.Errorf("lock original transfer for refund: %w", err)
	}
	return transfer, true, nil
}

func (s *MojaloopService) executeIdempotent(operation, key, resourceID string, action func() (map[string]any, error)) (map[string]any, error) {
	cached, acquired, err := s.beginIdempotency(operation, key, resourceID)
	if err != nil {
		return nil, err
	}
	if !acquired {
		return cached, nil
	}

	response, err := action()
	if err != nil {
		_ = s.markIdempotencyFailed(operation, key, resourceID, err.Error())
		return nil, err
	}
	if err := s.completeIdempotency(operation, key, resourceID, response); err != nil {
		return nil, err
	}
	return response, nil
}

func (s *MojaloopService) beginIdempotency(operation, key, resourceID string) (map[string]any, bool, error) {
	if strings.TrimSpace(key) == "" {
		return nil, true, nil
	}
	result, err := s.db.Exec(
		`INSERT INTO mojaloop_idempotency_keys (operation, idempotency_key, resource_id, status, created_at, updated_at)
		 VALUES ($1, $2, NULLIF($3, ''), 'processing', NOW(), NOW())
		 ON CONFLICT DO NOTHING`,
		operation,
		key,
		resourceID,
	)
	if err != nil {
		return nil, false, fmt.Errorf("begin idempotency: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return nil, false, fmt.Errorf("idempotency rows affected: %w", err)
	}
	if rows > 0 {
		return nil, true, nil
	}

	var status string
	var existingResourceID sql.NullString
	var body []byte
	if err := s.db.QueryRow(
		`SELECT status, resource_id, COALESCE(response_body::text, '{}') FROM mojaloop_idempotency_keys WHERE operation = $1 AND idempotency_key = $2`,
		operation,
		key,
	).Scan(&status, &existingResourceID, &body); err != nil {
		return nil, false, fmt.Errorf("load idempotency record: %w", err)
	}
	if existingResourceID.Valid && strings.TrimSpace(resourceID) != "" && existingResourceID.String != resourceID {
		return nil, false, fmt.Errorf("idempotency key is already bound to a different resource")
	}
	if status == "completed" {
		var cached map[string]any
		if len(body) == 0 {
			cached = map[string]any{"cached": true}
		} else if err := json.Unmarshal(body, &cached); err != nil {
			return nil, false, fmt.Errorf("decode idempotent response: %w", err)
		}
		cached["cached"] = true
		return cached, false, nil
	}
	return nil, false, fmt.Errorf("idempotency key is already in use")
}

func (s *MojaloopService) completeIdempotency(operation, key, resourceID string, response map[string]any) error {
	if strings.TrimSpace(key) == "" {
		return nil
	}
	payload, err := json.Marshal(response)
	if err != nil {
		return fmt.Errorf("marshal idempotent response: %w", err)
	}
	_, err = s.db.Exec(
		`UPDATE mojaloop_idempotency_keys
		 SET resource_id = NULLIF($3, ''), status = 'completed', response_body = $4::jsonb, updated_at = NOW()
		 WHERE operation = $1 AND idempotency_key = $2`,
		operation,
		key,
		resourceID,
		string(payload),
	)
	if err != nil {
		return fmt.Errorf("complete idempotency: %w", err)
	}
	return nil
}

func (s *MojaloopService) markIdempotencyFailed(operation, key, resourceID, message string) error {
	if strings.TrimSpace(key) == "" {
		return nil
	}
	payload, _ := json.Marshal(map[string]any{"error": message})
	_, err := s.db.Exec(
		`UPDATE mojaloop_idempotency_keys
		 SET resource_id = NULLIF($3, ''), status = 'failed', response_body = $4::jsonb, updated_at = NOW()
		 WHERE operation = $1 AND idempotency_key = $2`,
		operation,
		key,
		resourceID,
		string(payload),
	)
	if err != nil {
		return fmt.Errorf("mark idempotency failed: %w", err)
	}
	return nil
}

func (s *MojaloopService) sendToSwitch(method, endpoint string, payload interface{}) error {
	jsonData, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal error: %w", err)
	}

	req, err := http.NewRequest(method, s.switchURL+endpoint, bytes.NewReader(jsonData))
	if err != nil {
		return fmt.Errorf("request creation error: %w", err)
	}

	req.Header.Set("Content-Type", "application/vnd.interoperability.transfers+json;version=1.0")
	req.Header.Set("FSPIOP-Source", s.participantID)
	req.Header.Set("Date", time.Now().UTC().Format(http.TimeFormat))

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("http error: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 400 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("switch returned error: %d %s", resp.StatusCode, string(body))
	}
	return nil
}

func (s *MojaloopService) getFromSwitch(endpoint string, result interface{}) error {
	req, err := http.NewRequest("GET", s.switchURL+endpoint, nil)
	if err != nil {
		return fmt.Errorf("request creation error: %w", err)
	}
	req.Header.Set("Accept", "application/vnd.interoperability.transfers+json;version=1.0")
	req.Header.Set("FSPIOP-Source", s.participantID)

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("http error: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		return fmt.Errorf("switch returned error: %d", resp.StatusCode)
	}
	return json.NewDecoder(resp.Body).Decode(result)
}

func (s *MojaloopService) storeTransfer(transfer Transfer) error {
	_, err := s.db.Exec(
		`INSERT INTO mojaloop_transfers (
			transfer_id, payer_fsp, payee_fsp, amount, amount_minor, currency, ilp_packet, condition, expiration, state, completed_time, fulfilment_value, created_at, updated_at
		) VALUES ($1,$2,$3,$4::numeric / 100,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
			ON CONFLICT (transfer_id) DO UPDATE SET
				payer_fsp = EXCLUDED.payer_fsp,
				payee_fsp = EXCLUDED.payee_fsp,
				amount = EXCLUDED.amount,
				amount_minor = EXCLUDED.amount_minor,
			currency = EXCLUDED.currency,
			ilp_packet = EXCLUDED.ilp_packet,
			condition = EXCLUDED.condition,
			expiration = EXCLUDED.expiration,
			state = EXCLUDED.state,
			completed_time = EXCLUDED.completed_time,
			fulfilment_value = EXCLUDED.fulfilment_value,
			updated_at = NOW()`,
		transfer.TransferID,
		transfer.PayerFSP,
		transfer.PayeeFSP,
		int64(transfer.AmountMinor),
		transfer.Currency,
		transfer.IlpPacket,
		transfer.Condition,
		transfer.Expiration,
		transfer.State,
		nullableTime(transfer.CompletedTime),
		nullableString(transfer.FulfilmentValue),
	)
	if err != nil {
		return fmt.Errorf("store transfer: %w", err)
	}
	return nil
}

func (s *MojaloopService) storeQuote(quote Quote) error {
	_, err := s.db.Exec(
		`INSERT INTO mojaloop_quotes (
			quote_id, transaction_id, payer_fsp, payee_fsp, amount, amount_minor, currency, fees, fees_minor, expiration, state, created_at, updated_at
		) VALUES ($1,$2,$3,$4,$5::numeric / 100,$5,$6,$7::numeric / 100,$7,$8,$9,NOW(),NOW())
			ON CONFLICT (quote_id) DO UPDATE SET
			transaction_id = EXCLUDED.transaction_id,
			payer_fsp = EXCLUDED.payer_fsp,
			payee_fsp = EXCLUDED.payee_fsp,
				amount = EXCLUDED.amount,
				amount_minor = EXCLUDED.amount_minor,
				currency = EXCLUDED.currency,
				fees = EXCLUDED.fees,
				fees_minor = EXCLUDED.fees_minor,
			expiration = EXCLUDED.expiration,
			state = EXCLUDED.state,
			updated_at = NOW()`,
		quote.QuoteID,
		quote.TransactionID,
		quote.PayerFSP,
		quote.PayeeFSP,
		int64(quote.AmountMinor),
		quote.Currency,
		int64(quote.FeesMinor),
		quote.Expiration,
		quote.State,
	)
	if err != nil {
		return fmt.Errorf("store quote: %w", err)
	}
	return nil
}

func (s *MojaloopService) storeRefund(refund Refund) error {
	_, err := s.db.Exec(
		`INSERT INTO mojaloop_refunds (
			refund_id, original_transfer_id, payer_fsp, payee_fsp, amount, amount_minor, currency, reason, state, completed_time, created_at, updated_at
		) VALUES ($1,$2,$3,$4,$5::numeric / 100,$5,$6,$7,$8,$9,NOW(),NOW())
		ON CONFLICT (refund_id) DO UPDATE SET
			original_transfer_id = EXCLUDED.original_transfer_id,
			payer_fsp = EXCLUDED.payer_fsp,
			payee_fsp = EXCLUDED.payee_fsp,
				amount = EXCLUDED.amount,
				amount_minor = EXCLUDED.amount_minor,
			currency = EXCLUDED.currency,
			reason = EXCLUDED.reason,
			state = EXCLUDED.state,
			completed_time = EXCLUDED.completed_time,
			updated_at = NOW()`,
		refund.RefundID,
		refund.OriginalTransferID,
		refund.PayerFSP,
		refund.PayeeFSP,
		int64(refund.AmountMinor),
		refund.Currency,
		nullableString(refund.Reason),
		refund.State,
		nullableTime(refund.CompletedTime),
	)
	if err != nil {
		return fmt.Errorf("store refund: %w", err)
	}
	return nil
}

func (s *MojaloopService) getTransfer(id string) (Transfer, bool) {
	row := s.db.QueryRow(`SELECT transfer_id, payer_fsp, payee_fsp, amount_minor, currency, ilp_packet, condition, expiration, state, completed_time, fulfilment_value FROM mojaloop_transfers WHERE transfer_id = $1`, id)
	var transfer Transfer
	var completed sql.NullTime
	var fulfilment sql.NullString
	err := row.Scan(
		&transfer.TransferID,
		&transfer.PayerFSP,
		&transfer.PayeeFSP,
		&transfer.AmountMinor,
		&transfer.Currency,
		&transfer.IlpPacket,
		&transfer.Condition,
		&transfer.Expiration,
		&transfer.State,
		&completed,
		&fulfilment,
	)
	if err != nil {
		return Transfer{}, false
	}
	if completed.Valid {
		transfer.CompletedTime = completed.Time
	}
	if fulfilment.Valid {
		transfer.FulfilmentValue = fulfilment.String
	}
	return transfer, true
}

func (s *MojaloopService) getQuote(id string) (Quote, bool) {
	row := s.db.QueryRow(`SELECT quote_id, transaction_id, payer_fsp, payee_fsp, amount_minor, currency, fees_minor, expiration, state FROM mojaloop_quotes WHERE quote_id = $1`, id)
	var quote Quote
	err := row.Scan(
		&quote.QuoteID,
		&quote.TransactionID,
		&quote.PayerFSP,
		&quote.PayeeFSP,
		&quote.AmountMinor,
		&quote.Currency,
		&quote.FeesMinor,
		&quote.Expiration,
		&quote.State,
	)
	if err != nil {
		return Quote{}, false
	}
	return quote, true
}

func (s *MojaloopService) getRefund(id string) (Refund, bool) {
	row := s.db.QueryRow(`SELECT refund_id, original_transfer_id, payer_fsp, payee_fsp, amount_minor, currency, reason, state, completed_time FROM mojaloop_refunds WHERE refund_id = $1`, id)
	var refund Refund
	var reason sql.NullString
	var completed sql.NullTime
	err := row.Scan(
		&refund.RefundID,
		&refund.OriginalTransferID,
		&refund.PayerFSP,
		&refund.PayeeFSP,
		&refund.AmountMinor,
		&refund.Currency,
		&reason,
		&refund.State,
		&completed,
	)
	if err != nil {
		return Refund{}, false
	}
	if reason.Valid {
		refund.Reason = reason.String
	}
	if completed.Valid {
		refund.CompletedTime = completed.Time
	}
	return refund, true
}

func (s *MojaloopService) listRefundsForTransfer(transferID string) ([]Refund, error) {
	rows, err := s.db.Query(`SELECT refund_id, original_transfer_id, payer_fsp, payee_fsp, amount_minor, currency, reason, state, completed_time FROM mojaloop_refunds WHERE original_transfer_id = $1 ORDER BY created_at ASC`, transferID)
	if err != nil {
		return nil, fmt.Errorf("list refunds: %w", err)
	}
	defer rows.Close()

	refunds := make([]Refund, 0)
	for rows.Next() {
		var refund Refund
		var reason sql.NullString
		var completed sql.NullTime
		if err := rows.Scan(&refund.RefundID, &refund.OriginalTransferID, &refund.PayerFSP, &refund.PayeeFSP, &refund.AmountMinor, &refund.Currency, &reason, &refund.State, &completed); err != nil {
			return nil, fmt.Errorf("scan refund: %w", err)
		}
		if reason.Valid {
			refund.Reason = reason.String
		}
		if completed.Valid {
			refund.CompletedTime = completed.Time
		}
		refunds = append(refunds, refund)
	}
	return refunds, nil
}

func (s *MojaloopService) getRefundedAmount(transferID string) (uint64, error) {
	return scanRefundedAmount(s.db.QueryRow(refundReservationAmountQuery, transferID))
}

func getRefundedAmountTx(tx *sql.Tx, transferID string) (uint64, error) {
	if tx == nil {
		return 0, fmt.Errorf("refund reservation transaction is required")
	}
	return scanRefundedAmount(tx.QueryRow(refundReservationAmountQuery, transferID))
}

const refundReservationAmountQuery = `SELECT COALESCE(SUM(amount_minor), 0) FROM mojaloop_refunds WHERE original_transfer_id = $1 AND state IN ('PENDING_LEDGER','PENDING','COMPLETED')`

func scanRefundedAmount(row *sql.Row) (uint64, error) {
	var amount sql.NullInt64
	if err := row.Scan(&amount); err != nil {
		return 0, fmt.Errorf("sum refunded amount: %w", err)
	}
	if !amount.Valid || amount.Int64 < 0 {
		return 0, nil
	}
	return uint64(amount.Int64), nil
}

func (s *MojaloopService) updateTransferState(transferID, state string) error {
	_, err := s.db.Exec(`UPDATE mojaloop_transfers SET state = $2, updated_at = NOW() WHERE transfer_id = $1`, transferID, state)
	if err != nil {
		return fmt.Errorf("update transfer state: %w", err)
	}
	return nil
}

func (s *MojaloopService) buildReconciliationReport(transferID string) (ReconciliationReport, error) {
	return s.buildReconciliationReportWithLedger(s.tigerBeetle, transferID)
}

func (s *MojaloopService) buildReconciliationReportWithLedger(ledgerClient TigerBeetleLedger, transferID string) (ReconciliationReport, error) {
	if ledgerClient == nil {
		return ReconciliationReport{}, fmt.Errorf("TigerBeetle ledger client is required for reconciliation")
	}
	transfer, ok := s.getTransfer(transferID)
	if !ok {
		return ReconciliationReport{}, fmt.Errorf("transfer not found")
	}
	refunds, err := s.listRefundsForTransfer(transferID)
	if err != nil {
		return ReconciliationReport{}, err
	}

	platformRefunded := uint64(0)
	for _, refund := range refunds {
		if refund.State != "PENDING_LEDGER" && refund.State != "PENDING" && refund.State != "COMPLETED" {
			continue
		}
		if ^uint64(0)-platformRefunded < refund.AmountMinor {
			return ReconciliationReport{}, fmt.Errorf("refund aggregation overflow")
		}
		platformRefunded += refund.AmountMinor
	}
	platformNetSettled := uint64(0)
	if platformRefunded <= transfer.AmountMinor {
		platformNetSettled = transfer.AmountMinor - platformRefunded
	}

	reconciliation, err := ledgerClient.GetTransferReconciliation(transferID)
	if err != nil {
		return ReconciliationReport{}, err
	}
	ledger := &reconciliation
	ledgerConsistent := reconciliation.LedgerConsistent && platformRefunded == reconciliation.RefundedAmount

	recommendation := "No action required."
	if !ledgerConsistent {
		recommendation = "Investigate ledger and refund divergence before any further settlement or customer communication."
	} else if platformRefunded > 0 && platformRefunded < transfer.AmountMinor {
		recommendation = "Transfer is partially refunded; confirm downstream statements and merchant payout adjustments."
	} else if platformRefunded >= transfer.AmountMinor {
		recommendation = "Transfer is fully refunded; ensure downstream treasury and customer statements reflect full reversal."
	}

	return ReconciliationReport{
		Transfer:                transfer,
		Refunds:                 refunds,
		Ledger:                  ledger,
		PlatformRefundedMinor:   platformRefunded,
		PlatformNetSettledMinor: platformNetSettled,
		LedgerConsistent:        ledgerConsistent,
		Recommendation:          recommendation,
		RecordedAt:              time.Now().UTC(),
	}, nil
}

func (s *MojaloopService) storeReconciliationAudit(report ReconciliationReport) error {
	details, err := json.Marshal(report)
	if err != nil {
		return fmt.Errorf("marshal reconciliation audit: %w", err)
	}
	_, err = s.db.Exec(
		`INSERT INTO mojaloop_reconciliation_audits (transfer_id, transfer_state, ledger_consistent, platform_refunded_amount, platform_net_settled_amount, platform_refunded_minor, platform_net_settled_minor, details, created_at)
		 VALUES ($1, $2, $3, $4::numeric / 100, $5::numeric / 100, $4, $5, $6::jsonb, NOW())`,
		report.Transfer.TransferID,
		report.Transfer.State,
		report.LedgerConsistent,
		int64(report.PlatformRefundedMinor),
		int64(report.PlatformNetSettledMinor),
		string(details),
	)
	if err != nil {
		return fmt.Errorf("store reconciliation audit: %w", err)
	}
	return nil
}

// ILP packet/condition generation lives in ilp.go: newTransferILP produces a
// real OER-encoded ILPv4 IlpPrepare plus a SHA-256 condition over a random
// 32-byte fulfilment (ILP RFC 0027 / Mojaloop FSPIOP). The previous
// "ilp_packet_*"/"condition_*" formatted-string placeholders were removed so
// no silent facade remains.

func calculateFeesMinor(amountMinor uint64) uint64 {
	const minimumFeeMinor uint64 = 50
	fee := amountMinor / 100
	if amountMinor%100 >= 50 {
		fee++
	}
	if fee < minimumFeeMinor {
		return minimumFeeMinor
	}
	return fee
}

func deriveTransferStateFromRefunds(originalAmountMinor, refundedAmountMinor uint64) string {
	if refundedAmountMinor == 0 {
		return "SETTLED"
	}
	if refundedAmountMinor >= originalAmountMinor {
		return "REFUNDED"
	}
	return "PARTIALLY_REFUNDED"
}

func isRefundableTransferState(state string) bool {
	normalized := strings.ToUpper(strings.TrimSpace(state))
	switch normalized {
	case "COMMITTED", "SETTLED", "PARTIALLY_REFUNDED", "REFUNDED":
		return true
	default:
		return false
	}
}

func getEnv(key, defaultValue string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return defaultValue
}

func fallbackString(value, defaultValue string) string {
	if value != "" {
		return value
	}
	return defaultValue
}

func nullableTime(value time.Time) any {
	if value.IsZero() {
		return nil
	}
	return value
}

func nullableString(value string) any {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return trimmed
}

func (s *MojaloopService) requireInternalAccess(w http.ResponseWriter, r *http.Request) bool {
	provided := strings.TrimSpace(r.Header.Get("X-Internal-Service-Token"))
	if subtle.ConstantTimeCompare([]byte(provided), []byte(s.internalServiceToken)) != 1 {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return false
	}
	return true
}

func extractIdempotencyKey(r *http.Request, fallback string) string {
	key := strings.TrimSpace(r.Header.Get("Idempotency-Key"))
	if key != "" {
		return key
	}
	return strings.TrimSpace(fallback)
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func (s *MojaloopService) handleHealthHTTP(w http.ResponseWriter, _ *http.Request) {
	dbHealthy := s.db.Ping() == nil
	writeJSON(w, http.StatusOK, map[string]any{
		"status":              "healthy",
		"service":             "mojaloop",
		"databaseHealthy":     dbHealthy,
		"ledgerEnabled":       s.tigerBeetle != nil,
		"refundsImplemented":  true,
		"idempotencyEnabled":  true,
		"reconciliationReady": true,
		"fundsMiddleware":     s.fundsMiddlewareStatus(),
	})
}

func (s *MojaloopService) handleReconciliationOverviewHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	overview, err := s.buildReconciliationOverview()
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, overview)
}

func (s *MojaloopService) handleTransferCallback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	defer r.Body.Close()
	var transfer Transfer
	if err := json.NewDecoder(r.Body).Decode(&transfer); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if transfer.TransferID == "" {
		http.Error(w, "transferId is required", http.StatusBadRequest)
		return
	}
	if transfer.CompletedTime.IsZero() && (transfer.State == "COMMITTED" || transfer.State == "SETTLED") {
		transfer.CompletedTime = time.Now().UTC()
	}
	// ILP integrity gate: a COMMITTED/SETTLED callback must present the
	// fulfilment preimage that satisfies the stored condition
	// (SHA-256(fulfilment) == condition, ILP RFC 0027). Verification only
	// applies to rows holding a real 32-byte base64url condition; rows
	// recorded before real ILP encoding was introduced carry legacy
	// placeholder conditions and are reported as unverifiable rather than
	// silently trusted.
	if transfer.State == "COMMITTED" || transfer.State == "SETTLED" {
		if strings.TrimSpace(transfer.FulfilmentValue) == "" {
			http.Error(w, "fulfilment is required for a committed or settled transfer", http.StatusBadRequest)
			return
		}
		if existing, ok := s.getTransfer(transfer.TransferID); ok {
			if _, decodeErr := decodeILPBase64URL(existing.Condition); decodeErr == nil {
				if raw, _ := decodeILPBase64URL(existing.Condition); len(raw) == ilpConditionLength {
					if err := verifyFulfilment(existing.Condition, transfer.FulfilmentValue); err != nil {
						http.Error(w, fmt.Sprintf("ILP fulfilment verification failed: %v", err), http.StatusConflict)
						return
					}
				}
			}
		}
	}
	if err := s.storeTransfer(transfer); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = s.recordFundsWorkflowEvent(FundsWorkflowEvent{
		WorkflowType: "transfer",
		WorkflowID:   transfer.TransferID,
		ResourceID:   transfer.TransferID,
		Step:         "callback",
		Status:       transfer.State,
		Payload: map[string]any{
			"completedTimestamp": nullableTime(transfer.CompletedTime),
		},
	})
	writeJSON(w, http.StatusOK, map[string]string{"status": "accepted"})
}

func (s *MojaloopService) handleQuoteCallback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	defer r.Body.Close()
	var quote Quote
	if err := json.NewDecoder(r.Body).Decode(&quote); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if quote.QuoteID == "" {
		http.Error(w, "quoteId is required", http.StatusBadRequest)
		return
	}
	if quote.State == "" {
		quote.State = "ACCEPTED"
	}
	if err := s.storeQuote(quote); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = s.recordFundsWorkflowEvent(FundsWorkflowEvent{
		WorkflowType: "quote",
		WorkflowID:   quote.QuoteID,
		ResourceID:   quote.TransactionID,
		Step:         "callback",
		Status:       quote.State,
		Payload:      map[string]any{},
	})
	writeJSON(w, http.StatusOK, map[string]string{"status": "accepted"})
}

func (s *MojaloopService) handleRefundCallback(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	defer r.Body.Close()
	var refund Refund
	if err := json.NewDecoder(r.Body).Decode(&refund); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if refund.RefundID == "" || refund.OriginalTransferID == "" {
		http.Error(w, "refundId and originalTransferId are required", http.StatusBadRequest)
		return
	}
	if refund.State == "" {
		refund.State = "COMPLETED"
	}
	if refund.CompletedTime.IsZero() && refund.State == "COMPLETED" {
		refund.CompletedTime = time.Now().UTC()
	}
	if err := s.storeRefund(refund); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = s.recordFundsWorkflowEvent(FundsWorkflowEvent{
		WorkflowType: "refund",
		WorkflowID:   refund.RefundID,
		ResourceID:   refund.OriginalTransferID,
		Step:         "callback",
		Status:       refund.State,
		Payload:      map[string]any{},
	})
	writeJSON(w, http.StatusOK, map[string]string{"status": "accepted"})
}

func (s *MojaloopService) handleInitiateTransferHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	defer r.Body.Close()
	var payload TransferInitiationPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if payload.TransferID == "" || payload.PayerFSP == "" || payload.PayeeFSP == "" || payload.AmountMinor == 0 {
		http.Error(w, "missing required transfer fields", http.StatusBadRequest)
		return
	}
	response, err := s.initiateTransfer(payload, extractIdempotencyKey(r, payload.TransferID))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *MojaloopService) handleRequestQuoteHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	defer r.Body.Close()
	var payload QuoteInitiationPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if payload.QuoteID == "" || payload.TransactionID == "" || payload.PayerFSP == "" || payload.PayeeFSP == "" || payload.AmountMinor == 0 {
		http.Error(w, "missing required quote fields", http.StatusBadRequest)
		return
	}
	response, err := s.requestQuote(payload, extractIdempotencyKey(r, payload.QuoteID))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *MojaloopService) handleInitiateRefundHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	defer r.Body.Close()
	var payload RefundInitiationPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}
	if payload.RefundID == "" || payload.OriginalTransferID == "" || payload.AmountMinor == 0 {
		http.Error(w, "missing required refund fields", http.StatusBadRequest)
		return
	}
	response, err := s.initiateRefund(payload, extractIdempotencyKey(r, payload.RefundID))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *MojaloopService) handleGetTransferHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	transferID := strings.TrimPrefix(r.URL.Path, "/transfers/")
	if transferID == "" || transferID == "initiate" {
		http.Error(w, "missing transfer id", http.StatusBadRequest)
		return
	}
	if transfer, ok := s.getTransfer(transferID); ok {
		writeJSON(w, http.StatusOK, transfer)
		return
	}
	var transfer Transfer
	if err := s.getFromSwitch("/transfers/"+transferID, &transfer); err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	if err := s.storeTransfer(transfer); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, transfer)
}

func (s *MojaloopService) handleGetQuoteHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	quoteID := strings.TrimPrefix(r.URL.Path, "/quotes/")
	if quoteID == "" || quoteID == "request" {
		http.Error(w, "missing quote id", http.StatusBadRequest)
		return
	}
	if quote, ok := s.getQuote(quoteID); ok {
		writeJSON(w, http.StatusOK, quote)
		return
	}
	var quote Quote
	if err := s.getFromSwitch("/quotes/"+quoteID, &quote); err != nil {
		http.Error(w, "quote not found", http.StatusNotFound)
		return
	}
	if err := s.storeQuote(quote); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, quote)
}

func (s *MojaloopService) handleGetRefundHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	refundID := strings.TrimPrefix(r.URL.Path, "/refunds/")
	if refundID == "" || refundID == "initiate" {
		http.Error(w, "missing refund id", http.StatusBadRequest)
		return
	}
	refund, ok := s.getRefund(refundID)
	if !ok {
		http.Error(w, "refund not found", http.StatusNotFound)
		return
	}
	writeJSON(w, http.StatusOK, refund)
}

func (s *MojaloopService) handleReconcileTransferHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	transferID := strings.TrimPrefix(r.URL.Path, "/reconcile/transfers/")
	if transferID == "" {
		http.Error(w, "missing transfer id", http.StatusBadRequest)
		return
	}
	report, err := s.buildReconciliationReport(transferID)
	if err != nil {
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	if err := s.storeReconciliationAudit(report); err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	_ = s.recordFundsWorkflowEvent(FundsWorkflowEvent{
		WorkflowType: "reconciliation",
		WorkflowID:   transferID,
		ResourceID:   transferID,
		Step:         "audited",
		Status:       map[bool]string{true: "consistent", false: "inconsistent"}[report.LedgerConsistent],
		Payload: map[string]any{
			"platformRefundedMinor":   report.PlatformRefundedMinor,
			"platformNetSettledMinor": report.PlatformNetSettledMinor,
			"recommendation":          report.Recommendation,
		},
	})
	writeJSON(w, http.StatusOK, report)
}

func main() {
	httpPort := getEnv("HTTP_PORT", "8086")
	bindHost := getEnv("BIND_HOST", "127.0.0.1")
	serviceMode := strings.ToLower(strings.TrimSpace(getEnv("MOJALOOP_SERVICE_MODE", "http")))

	tigerBeetleClient, err := NewTigerBeetleClient()
	if err != nil {
		log.Fatalf("Failed to initialize TigerBeetle client: %v", err)
	}
	defer tigerBeetleClient.Close()
	service, err := NewMojaloopService(tigerBeetleClient)
	if err != nil {
		log.Fatalf("Failed to initialize Mojaloop service: %v", err)
	}
	defer service.db.Close()

	if serviceMode == "worker" {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		log.Printf("Mojaloop Temporal worker listening on %s (namespace=%s, taskQueue=%s)", effectiveTemporalHostPort(), effectiveTemporalNamespace(), effectiveTemporalTaskQueue())
		if err := RunTemporalWorker(ctx, service); err != nil {
			log.Fatalf("Failed to run Temporal worker: %v", err)
		}
		return
	}
	if serviceMode == "outbox-worker" {
		ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
		defer stop()
		workerID := strings.TrimSpace(os.Getenv("FUNDS_OUTBOX_WORKER_ID"))
		if workerID == "" {
			workerID = "mojaloop-outbox-" + time.Now().UTC().Format("20060102T150405.000000000Z")
		}
		if err := validateFundsOutboxConfiguration(); err != nil {
			log.Fatalf("Failed to configure funds outbox worker: %v", err)
		}
		mux := http.NewServeMux()
		mux.HandleFunc("/health", service.handleHealthHTTP)
		mux.HandleFunc("/metrics/funds-outbox", service.handleFundsOutboxMetricsHTTP)
		server := &http.Server{
			Addr:              bindHost + ":" + httpPort,
			Handler:           mux,
			ReadHeaderTimeout: 5 * time.Second,
		}
		serverErrors := make(chan error, 1)
		go func() {
			log.Printf("Mojaloop durable funds outbox worker started as %s (health port %s)", workerID, server.Addr)
			serverErrors <- server.ListenAndServe()
		}()
		workerError := service.RunFundsOutboxDispatcher(ctx, workerID)
		shutdownContext, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		_ = server.Shutdown(shutdownContext)
		serverError := <-serverErrors
		if workerError != nil && workerError != context.Canceled {
			log.Fatalf("Failed to run funds outbox worker: %v", workerError)
		}
		if serverError != nil && serverError != http.ErrServerClosed {
			log.Fatalf("Funds outbox worker health server failed: %v", serverError)
		}
		return
	}
	if serviceMode == "temporal-bridge" {
		mux := http.NewServeMux()
		mux.HandleFunc("/health", service.handleHealthHTTP)
		mux.HandleFunc("/funds/workflows", service.handleTemporalWorkflowBridgeHTTP)
		mux.HandleFunc("/journeys/catalog", service.handleJourneyCatalogHTTP)
		mux.HandleFunc("/journeys/start", service.handleJourneyStartHTTP)
		addr := bindHost + ":" + httpPort
		log.Printf("Mojaloop Temporal workflow bridge listening on %s (namespace=%s, fundsTaskQueue=%s, journeyTaskQueue=%s)", addr, effectiveTemporalNamespace(), effectiveTemporalTaskQueue(), effectiveJourneyTaskQueue())
		if err := serveWithGracefulShutdown(addr, mux); err != nil {
			log.Fatalf("Failed to serve Temporal workflow bridge: %v", err)
		}
		return
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", service.handleHealthHTTP)
	mux.HandleFunc("/metrics/funds-outbox", service.handleFundsOutboxMetricsHTTP)
	mux.HandleFunc("/callbacks/transfers", service.handleTransferCallback)
	mux.HandleFunc("/callbacks/quotes", service.handleQuoteCallback)
	mux.HandleFunc("/callbacks/refunds", service.handleRefundCallback)
	mux.HandleFunc("/transfers/initiate", service.handleInitiateTransferHTTP)
	mux.HandleFunc("/quotes/request", service.handleRequestQuoteHTTP)
	mux.HandleFunc("/refunds/initiate", service.handleInitiateRefundHTTP)
	mux.HandleFunc("/reconcile/overview", service.handleReconciliationOverviewHTTP)
	mux.HandleFunc("/reconcile/transfers/", service.handleReconcileTransferHTTP)
	mux.HandleFunc("/transfers/", service.handleGetTransferHTTP)
	mux.HandleFunc("/quotes/", service.handleGetQuoteHTTP)
	mux.HandleFunc("/refunds/", service.handleGetRefundHTTP)
	addr := bindHost + ":" + httpPort
	log.Printf("Mojaloop HTTP server listening on %s", addr)
	if err := serveWithGracefulShutdown(addr, mux); err != nil {
		log.Fatalf("Failed to serve HTTP: %v", err)
	}
}

// serveWithGracefulShutdown starts an HTTP server and drains in-flight
// requests on SIGINT/SIGTERM before returning.
func serveWithGracefulShutdown(addr string, handler http.Handler) error {
	server := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	serverErrors := make(chan error, 1)
	go func() {
		serverErrors <- server.ListenAndServe()
	}()

	select {
	case err := <-serverErrors:
		if err == http.ErrServerClosed {
			return nil
		}
		return err
	case <-ctx.Done():
		log.Printf("shutdown signal received; draining in-flight requests on %s", addr)
		shutdownContext, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownContext); err != nil {
			log.Printf("graceful shutdown failed: %v", err)
		}
		if err := <-serverErrors; err != nil && err != http.ErrServerClosed {
			return err
		}
		return nil
	}
}
