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
	"strings"
	"syscall"
	"time"

	_ "github.com/lib/pq"
)

type MojaloopService struct {
	httpClient           *http.Client
	switchURL            string
	participantID        string
	internalServiceToken string
	tigerBeetle          *TigerBeetleClient
	db                   *sql.DB
}

type Transfer struct {
	TransferID      string    `json:"transferId"`
	PayerFSP        string    `json:"payerFsp"`
	PayeeFSP        string    `json:"payeeFsp"`
	Amount          float64   `json:"amount"`
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
	Amount        float64   `json:"amount"`
	Currency      string    `json:"currency"`
	Fees          float64   `json:"transferAmount"`
	Expiration    time.Time `json:"expiration"`
	State         string    `json:"state"`
}

type Refund struct {
	RefundID           string    `json:"refundId"`
	OriginalTransferID string    `json:"originalTransferId"`
	PayerFSP           string    `json:"payerFsp"`
	PayeeFSP           string    `json:"payeeFsp"`
	Amount             float64   `json:"amount"`
	Currency           string    `json:"currency"`
	Reason             string    `json:"reason,omitempty"`
	State              string    `json:"state"`
	CompletedTime      time.Time `json:"completedTimestamp,omitempty"`
}

type TransferInitiationPayload struct {
	TransferID string  `json:"transferId"`
	PayerFSP   string  `json:"payerFsp"`
	PayeeFSP   string  `json:"payeeFsp"`
	Amount     float64 `json:"amount"`
	Currency   string  `json:"currency"`
}

type QuoteInitiationPayload struct {
	QuoteID       string  `json:"quoteId"`
	TransactionID string  `json:"transactionId"`
	PayerFSP      string  `json:"payerFsp"`
	PayeeFSP      string  `json:"payeeFsp"`
	Amount        float64 `json:"amount"`
	Currency      string  `json:"currency"`
}

type RefundInitiationPayload struct {
	RefundID           string  `json:"refundId"`
	OriginalTransferID string  `json:"originalTransferId"`
	Amount             float64 `json:"amount"`
	Currency           string  `json:"currency"`
	Reason             string  `json:"reason"`
}

type ReconciliationReport struct {
	Transfer           Transfer                `json:"transfer"`
	Refunds            []Refund                `json:"refunds"`
	Ledger             *TransferReconciliation `json:"ledger,omitempty"`
	PlatformRefunded   float64                 `json:"platformRefundedAmount"`
	PlatformNetSettled float64                 `json:"platformNetSettledAmount"`
	LedgerConsistent   bool                    `json:"ledgerConsistent"`
	Recommendation     string                  `json:"recommendation"`
	RecordedAt         time.Time               `json:"recordedAt"`
}

func NewMojaloopService(tigerBeetle *TigerBeetleClient) (*MojaloopService, error) {
	databaseURL := getEnv("DATABASE_URL", "postgresql://ubuntu:ubuntu@127.0.0.1:5432/switchos?sslmode=disable")
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		return nil, fmt.Errorf("open mojaloop database: %w", err)
	}
	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("ping mojaloop database: %w", err)
	}

	service := &MojaloopService{
		httpClient:           &http.Client{Timeout: 30 * time.Second},
		switchURL:            getEnv("MOJALOOP_SWITCH_URL", "http://localhost:4001"),
		participantID:        getEnv("MOJALOOP_PARTICIPANT_ID", "switchos"),
		internalServiceToken: getEnv("INTERNAL_SERVICE_TOKEN", "switchos-internal-dev-token-change-before-production"),
		tigerBeetle:          tigerBeetle,
		db:                   db,
	}
	if err := service.ensurePersistence(); err != nil {
		_ = db.Close()
		return nil, err
	}
	if err := service.ensureWorkflowPersistence(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return service, nil
}

func (s *MojaloopService) ensurePersistence() error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS mojaloop_transfers (
			transfer_id TEXT PRIMARY KEY,
			payer_fsp TEXT NOT NULL,
			payee_fsp TEXT NOT NULL,
			amount NUMERIC(18,2) NOT NULL,
			currency TEXT NOT NULL,
			ilp_packet TEXT NOT NULL,
			condition TEXT NOT NULL,
			expiration TIMESTAMPTZ NOT NULL,
			state TEXT NOT NULL,
			completed_time TIMESTAMPTZ,
			fulfilment_value TEXT,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS mojaloop_quotes (
			quote_id TEXT PRIMARY KEY,
			transaction_id TEXT NOT NULL,
			payer_fsp TEXT NOT NULL,
			payee_fsp TEXT NOT NULL,
			amount NUMERIC(18,2) NOT NULL,
			currency TEXT NOT NULL,
			fees NUMERIC(18,2) NOT NULL,
			expiration TIMESTAMPTZ NOT NULL,
			state TEXT NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS mojaloop_refunds (
			refund_id TEXT PRIMARY KEY,
			original_transfer_id TEXT NOT NULL,
			payer_fsp TEXT NOT NULL,
			payee_fsp TEXT NOT NULL,
			amount NUMERIC(18,2) NOT NULL,
			currency TEXT NOT NULL,
			reason TEXT,
			state TEXT NOT NULL,
			completed_time TIMESTAMPTZ,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS mojaloop_idempotency_keys (
			operation TEXT NOT NULL,
			idempotency_key TEXT NOT NULL,
			resource_id TEXT,
			status TEXT NOT NULL,
			response_body JSONB,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY (operation, idempotency_key)
		)`,
		`CREATE TABLE IF NOT EXISTS mojaloop_reconciliation_audits (
			id BIGSERIAL PRIMARY KEY,
			transfer_id TEXT NOT NULL,
			transfer_state TEXT NOT NULL,
			ledger_consistent BOOLEAN NOT NULL,
			platform_refunded_amount NUMERIC(18,2) NOT NULL,
			platform_net_settled_amount NUMERIC(18,2) NOT NULL,
			details JSONB NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
	}
	for _, statement := range statements {
		if _, err := s.db.Exec(statement); err != nil {
			return fmt.Errorf("ensure mojaloop persistence schema: %w", err)
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

		transfer := Transfer{
			TransferID: payload.TransferID,
			PayerFSP:   payload.PayerFSP,
			PayeeFSP:   payload.PayeeFSP,
			Amount:     payload.Amount,
			Currency:   fallbackString(payload.Currency, "EUR"),
			IlpPacket:  generateILPPacket(payload.TransferID, payload.PayeeFSP, payload.Amount),
			Condition:  generateCondition(payload.TransferID),
			Expiration: time.Now().Add(30 * time.Minute),
			State:      "RESERVED",
		}

		if s.tigerBeetle != nil {
			amountCents := amountToCents(payload.Amount)
			if err := s.tigerBeetle.ProcessMojaloopTransfer(payload.TransferID, payload.PayerFSP, payload.PayeeFSP, amountCents); err != nil {
				return nil, fmt.Errorf("ledger transfer failed: %w", err)
			}
		}

		if err := s.storeTransfer(transfer); err != nil {
			return nil, err
		}
		if err := s.sendToSwitch("POST", "/transfers", transfer); err != nil {
			log.Printf("warning: failed to forward transfer to switch: %v", err)
		}
		_ = s.recordFundsWorkflowEvent(FundsWorkflowEvent{
			WorkflowType: "transfer",
			WorkflowID:   payload.TransferID,
			ResourceID:   payload.TransferID,
			Step:         "initiated",
			Status:       transfer.State,
			Payload: map[string]any{
				"payerFsp": transfer.PayerFSP,
				"payeeFsp": transfer.PayeeFSP,
				"amount":   transfer.Amount,
				"currency": transfer.Currency,
			},
		})

		return map[string]any{
			"transferId": transfer.TransferID,
			"state":      transfer.State,
			"message":    "Transfer initiated successfully",
		}, nil
	})
}

func (s *MojaloopService) requestQuote(payload QuoteInitiationPayload, idempotencyKey string) (map[string]any, error) {
	key := fallbackString(idempotencyKey, payload.QuoteID)
	return s.executeIdempotent("quote_request", key, payload.QuoteID, func() (map[string]any, error) {
		if existing, ok := s.getQuote(payload.QuoteID); ok {
			return map[string]any{
				"quoteId":       existing.QuoteID,
				"transactionId": existing.TransactionID,
				"fees":          existing.Fees,
				"totalAmount":   existing.Amount + existing.Fees,
				"currency":      existing.Currency,
				"cached":        true,
			}, nil
		}

		quote := Quote{
			QuoteID:       payload.QuoteID,
			TransactionID: payload.TransactionID,
			PayerFSP:      payload.PayerFSP,
			PayeeFSP:      payload.PayeeFSP,
			Amount:        payload.Amount,
			Currency:      fallbackString(payload.Currency, "EUR"),
			Fees:          calculateFees(payload.Amount),
			Expiration:    time.Now().Add(30 * time.Minute),
			State:         "PENDING",
		}

		if err := s.storeQuote(quote); err != nil {
			return nil, err
		}
		if err := s.sendToSwitch("POST", "/quotes", quote); err != nil {
			log.Printf("warning: failed to forward quote to switch: %v", err)
		}
		_ = s.recordFundsWorkflowEvent(FundsWorkflowEvent{
			WorkflowType: "quote",
			WorkflowID:   payload.QuoteID,
			ResourceID:   payload.TransactionID,
			Step:         "requested",
			Status:       quote.State,
			Payload: map[string]any{
				"payerFsp": quote.PayerFSP,
				"payeeFsp": quote.PayeeFSP,
				"amount":   quote.Amount,
				"fees":     quote.Fees,
				"currency": quote.Currency,
			},
		})

		return map[string]any{
			"quoteId":       quote.QuoteID,
			"transactionId": quote.TransactionID,
			"fees":          quote.Fees,
			"totalAmount":   quote.Amount + quote.Fees,
			"currency":      quote.Currency,
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

		transfer, ok := s.getTransfer(payload.OriginalTransferID)
		if !ok {
			return nil, fmt.Errorf("original transfer not found")
		}
		if !isRefundableTransferState(transfer.State) {
			return nil, fmt.Errorf("transfer state %s cannot be refunded", transfer.State)
		}

		currentRefunded, err := s.getRefundedAmount(payload.OriginalTransferID)
		if err != nil {
			return nil, err
		}
		if currentRefunded+payload.Amount > transfer.Amount+0.00001 {
			return nil, fmt.Errorf("refund amount exceeds remaining settled amount")
		}

		refund := Refund{
			RefundID:           payload.RefundID,
			OriginalTransferID: payload.OriginalTransferID,
			PayerFSP:           transfer.PayerFSP,
			PayeeFSP:           transfer.PayeeFSP,
			Amount:             payload.Amount,
			Currency:           fallbackString(payload.Currency, transfer.Currency),
			Reason:             strings.TrimSpace(payload.Reason),
			State:              "COMPLETED",
			CompletedTime:      time.Now().UTC(),
		}

		if s.tigerBeetle != nil {
			if err := s.tigerBeetle.ReverseMojaloopTransfer(refund.RefundID, refund.OriginalTransferID, transfer.PayerFSP, transfer.PayeeFSP, amountToCents(refund.Amount)); err != nil {
				return nil, fmt.Errorf("ledger refund failed: %w", err)
			}
		}

		if err := s.storeRefund(refund); err != nil {
			return nil, err
		}
		if err := s.sendToSwitch("POST", "/refunds", refund); err != nil {
			log.Printf("warning: failed to forward refund to switch: %v", err)
		}
		_ = s.recordFundsWorkflowEvent(FundsWorkflowEvent{
			WorkflowType: "refund",
			WorkflowID:   payload.RefundID,
			ResourceID:   payload.OriginalTransferID,
			Step:         "completed",
			Status:       refund.State,
			Payload: map[string]any{
				"payerFsp": refund.PayerFSP,
				"payeeFsp": refund.PayeeFSP,
				"amount":   refund.Amount,
				"currency": refund.Currency,
				"reason":   refund.Reason,
			},
		})

		report, err := s.buildReconciliationReport(payload.OriginalTransferID)
		if err != nil {
			return nil, err
		}
		transferState := deriveTransferStateFromRefunds(transfer.Amount, report.PlatformRefunded)
		if err := s.updateTransferState(transfer.TransferID, transferState); err != nil {
			return nil, err
		}
		report.Transfer.State = transferState
		if err := s.storeReconciliationAudit(report); err != nil {
			return nil, err
		}

		return map[string]any{
			"refundId":             refund.RefundID,
			"originalTransferId":   refund.OriginalTransferID,
			"state":                refund.State,
			"platformRefunded":     report.PlatformRefunded,
			"platformNetSettled":   report.PlatformNetSettled,
			"ledgerConsistent":     report.LedgerConsistent,
			"updatedTransferState": transferState,
		}, nil
	})
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
	var body []byte
	if err := s.db.QueryRow(
		`SELECT status, COALESCE(response_body::text, '{}') FROM mojaloop_idempotency_keys WHERE operation = $1 AND idempotency_key = $2`,
		operation,
		key,
	).Scan(&status, &body); err != nil {
		return nil, false, fmt.Errorf("load idempotency record: %w", err)
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
			transfer_id, payer_fsp, payee_fsp, amount, currency, ilp_packet, condition, expiration, state, completed_time, fulfilment_value, created_at, updated_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW(),NOW())
		ON CONFLICT (transfer_id) DO UPDATE SET
			payer_fsp = EXCLUDED.payer_fsp,
			payee_fsp = EXCLUDED.payee_fsp,
			amount = EXCLUDED.amount,
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
		transfer.Amount,
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
			quote_id, transaction_id, payer_fsp, payee_fsp, amount, currency, fees, expiration, state, created_at, updated_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
		ON CONFLICT (quote_id) DO UPDATE SET
			transaction_id = EXCLUDED.transaction_id,
			payer_fsp = EXCLUDED.payer_fsp,
			payee_fsp = EXCLUDED.payee_fsp,
			amount = EXCLUDED.amount,
			currency = EXCLUDED.currency,
			fees = EXCLUDED.fees,
			expiration = EXCLUDED.expiration,
			state = EXCLUDED.state,
			updated_at = NOW()`,
		quote.QuoteID,
		quote.TransactionID,
		quote.PayerFSP,
		quote.PayeeFSP,
		quote.Amount,
		quote.Currency,
		quote.Fees,
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
			refund_id, original_transfer_id, payer_fsp, payee_fsp, amount, currency, reason, state, completed_time, created_at, updated_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW(),NOW())
		ON CONFLICT (refund_id) DO UPDATE SET
			original_transfer_id = EXCLUDED.original_transfer_id,
			payer_fsp = EXCLUDED.payer_fsp,
			payee_fsp = EXCLUDED.payee_fsp,
			amount = EXCLUDED.amount,
			currency = EXCLUDED.currency,
			reason = EXCLUDED.reason,
			state = EXCLUDED.state,
			completed_time = EXCLUDED.completed_time,
			updated_at = NOW()`,
		refund.RefundID,
		refund.OriginalTransferID,
		refund.PayerFSP,
		refund.PayeeFSP,
		refund.Amount,
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
	row := s.db.QueryRow(`SELECT transfer_id, payer_fsp, payee_fsp, amount, currency, ilp_packet, condition, expiration, state, completed_time, fulfilment_value FROM mojaloop_transfers WHERE transfer_id = $1`, id)
	var transfer Transfer
	var completed sql.NullTime
	var fulfilment sql.NullString
	err := row.Scan(
		&transfer.TransferID,
		&transfer.PayerFSP,
		&transfer.PayeeFSP,
		&transfer.Amount,
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
	row := s.db.QueryRow(`SELECT quote_id, transaction_id, payer_fsp, payee_fsp, amount, currency, fees, expiration, state FROM mojaloop_quotes WHERE quote_id = $1`, id)
	var quote Quote
	err := row.Scan(
		&quote.QuoteID,
		&quote.TransactionID,
		&quote.PayerFSP,
		&quote.PayeeFSP,
		&quote.Amount,
		&quote.Currency,
		&quote.Fees,
		&quote.Expiration,
		&quote.State,
	)
	if err != nil {
		return Quote{}, false
	}
	return quote, true
}

func (s *MojaloopService) getRefund(id string) (Refund, bool) {
	row := s.db.QueryRow(`SELECT refund_id, original_transfer_id, payer_fsp, payee_fsp, amount, currency, reason, state, completed_time FROM mojaloop_refunds WHERE refund_id = $1`, id)
	var refund Refund
	var reason sql.NullString
	var completed sql.NullTime
	err := row.Scan(
		&refund.RefundID,
		&refund.OriginalTransferID,
		&refund.PayerFSP,
		&refund.PayeeFSP,
		&refund.Amount,
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
	rows, err := s.db.Query(`SELECT refund_id, original_transfer_id, payer_fsp, payee_fsp, amount, currency, reason, state, completed_time FROM mojaloop_refunds WHERE original_transfer_id = $1 ORDER BY created_at ASC`, transferID)
	if err != nil {
		return nil, fmt.Errorf("list refunds: %w", err)
	}
	defer rows.Close()

	refunds := make([]Refund, 0)
	for rows.Next() {
		var refund Refund
		var reason sql.NullString
		var completed sql.NullTime
		if err := rows.Scan(&refund.RefundID, &refund.OriginalTransferID, &refund.PayerFSP, &refund.PayeeFSP, &refund.Amount, &refund.Currency, &reason, &refund.State, &completed); err != nil {
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

func (s *MojaloopService) getRefundedAmount(transferID string) (float64, error) {
	var amount sql.NullFloat64
	if err := s.db.QueryRow(`SELECT COALESCE(SUM(amount), 0) FROM mojaloop_refunds WHERE original_transfer_id = $1 AND state IN ('PENDING','COMPLETED')`, transferID).Scan(&amount); err != nil {
		return 0, fmt.Errorf("sum refunded amount: %w", err)
	}
	if !amount.Valid {
		return 0, nil
	}
	return amount.Float64, nil
}

func (s *MojaloopService) updateTransferState(transferID, state string) error {
	_, err := s.db.Exec(`UPDATE mojaloop_transfers SET state = $2, updated_at = NOW() WHERE transfer_id = $1`, transferID, state)
	if err != nil {
		return fmt.Errorf("update transfer state: %w", err)
	}
	return nil
}

func (s *MojaloopService) buildReconciliationReport(transferID string) (ReconciliationReport, error) {
	transfer, ok := s.getTransfer(transferID)
	if !ok {
		return ReconciliationReport{}, fmt.Errorf("transfer not found")
	}
	refunds, err := s.listRefundsForTransfer(transferID)
	if err != nil {
		return ReconciliationReport{}, err
	}

	platformRefunded := 0.0
	for _, refund := range refunds {
		platformRefunded += refund.Amount
	}
	platformNetSettled := transfer.Amount - platformRefunded
	if platformNetSettled < 0 {
		platformNetSettled = 0
	}

	var ledger *TransferReconciliation
	ledgerConsistent := true
	if s.tigerBeetle != nil {
		reconciliation, err := s.tigerBeetle.GetTransferReconciliation(transferID)
		if err != nil {
			return ReconciliationReport{}, err
		}
		ledger = &reconciliation
		ledgerConsistent = reconciliation.LedgerConsistent && amountToCents(platformRefunded) == reconciliation.RefundedAmount
	}

	recommendation := "No action required."
	if !ledgerConsistent {
		recommendation = "Investigate ledger and refund divergence before any further settlement or customer communication."
	} else if platformRefunded > 0 && platformRefunded < transfer.Amount {
		recommendation = "Transfer is partially refunded; confirm downstream statements and merchant payout adjustments."
	} else if platformRefunded >= transfer.Amount {
		recommendation = "Transfer is fully refunded; ensure downstream treasury and customer statements reflect full reversal."
	}

	return ReconciliationReport{
		Transfer:           transfer,
		Refunds:            refunds,
		Ledger:             ledger,
		PlatformRefunded:   round2(platformRefunded),
		PlatformNetSettled: round2(platformNetSettled),
		LedgerConsistent:   ledgerConsistent,
		Recommendation:     recommendation,
		RecordedAt:         time.Now().UTC(),
	}, nil
}

func (s *MojaloopService) storeReconciliationAudit(report ReconciliationReport) error {
	details, err := json.Marshal(report)
	if err != nil {
		return fmt.Errorf("marshal reconciliation audit: %w", err)
	}
	_, err = s.db.Exec(
		`INSERT INTO mojaloop_reconciliation_audits (transfer_id, transfer_state, ledger_consistent, platform_refunded_amount, platform_net_settled_amount, details, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())`,
		report.Transfer.TransferID,
		report.Transfer.State,
		report.LedgerConsistent,
		report.PlatformRefunded,
		report.PlatformNetSettled,
		string(details),
	)
	if err != nil {
		return fmt.Errorf("store reconciliation audit: %w", err)
	}
	return nil
}

func generateILPPacket(transferID, payeeFSP string, amount float64) string {
	return fmt.Sprintf("ilp_packet_%s_%s_%.2f", transferID, payeeFSP, amount)
}

func generateCondition(transferID string) string {
	return fmt.Sprintf("condition_%s", transferID)
}

func calculateFees(amount float64) float64 {
	fee := amount * 0.01
	if fee < 0.50 {
		fee = 0.50
	}
	return round2(fee)
}

func amountToCents(amount float64) uint64 {
	return uint64(round2(amount) * 100)
}

func round2(value float64) float64 {
	return float64(int64(value*100+0.5)) / 100
}

func deriveTransferStateFromRefunds(originalAmount, refundedAmount float64) string {
	if refundedAmount <= 0 {
		return "SETTLED"
	}
	if refundedAmount >= originalAmount {
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
	if payload.TransferID == "" || payload.PayerFSP == "" || payload.PayeeFSP == "" || payload.Amount <= 0 {
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
	if payload.QuoteID == "" || payload.TransactionID == "" || payload.PayerFSP == "" || payload.PayeeFSP == "" || payload.Amount <= 0 {
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
	if payload.RefundID == "" || payload.OriginalTransferID == "" || payload.Amount <= 0 {
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
			"platformRefunded":   report.PlatformRefunded,
			"platformNetSettled": report.PlatformNetSettled,
			"recommendation":     report.Recommendation,
		},
	})
	writeJSON(w, http.StatusOK, report)
}

func main() {
	httpPort := getEnv("HTTP_PORT", "8086")
	bindHost := getEnv("BIND_HOST", "127.0.0.1")
	databaseURL := getEnv("DATABASE_URL", "postgresql://ubuntu:ubuntu@127.0.0.1:5432/switchos?sslmode=disable")
	serviceMode := strings.ToLower(strings.TrimSpace(getEnv("MOJALOOP_SERVICE_MODE", "http")))

	var tigerBeetleClient *TigerBeetleClient
	var err error
	if getEnv("TIGERBEETLE_ENABLED", "true") == "true" {
		tigerBeetleClient, err = NewTigerBeetleClient(databaseURL)
		if err != nil {
			log.Fatalf("Failed to initialize TigerBeetle client: %v", err)
		}
		defer tigerBeetleClient.Close()
	}
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

	mux := http.NewServeMux()
	mux.HandleFunc("/health", service.handleHealthHTTP)
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
	if err := http.ListenAndServe(addr, mux); err != nil {
		log.Fatalf("Failed to serve HTTP: %v", err)
	}
}

