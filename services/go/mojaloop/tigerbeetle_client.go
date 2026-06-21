package main

import (
	"database/sql"
	"fmt"
	"time"

	_ "github.com/lib/pq"
)

type TigerBeetleClient struct {
	db *sql.DB
}

type LedgerEntry struct {
	EntryID           string
	EntryType         string
	PayerID           string
	PayeeID           string
	AmountCents       uint64
	RelatedTransferID string
	CreatedAt         time.Time
}

type TransferReconciliation struct {
	TransferID         string `json:"transferId"`
	TransferExists     bool   `json:"transferExists"`
	TransferAmount     uint64 `json:"transferAmountCents"`
	RefundedAmount     uint64 `json:"refundedAmountCents"`
	NetSettledAmount   uint64 `json:"netSettledAmountCents"`
	RefundCount        int    `json:"refundCount"`
	FullyReversed      bool   `json:"fullyReversed"`
	LedgerConsistent   bool   `json:"ledgerConsistent"`
	OriginalPayerID    string `json:"originalPayerId,omitempty"`
	OriginalPayeeID    string `json:"originalPayeeId,omitempty"`
}

func NewTigerBeetleClient(databaseURL string) (*TigerBeetleClient, error) {
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		return nil, fmt.Errorf("open ledger database: %w", err)
	}
	if err := db.Ping(); err != nil {
		return nil, fmt.Errorf("ping ledger database: %w", err)
	}

	client := &TigerBeetleClient{db: db}
	if err := client.ensureSchema(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return client, nil
}

func (tbc *TigerBeetleClient) ensureSchema() error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS ledger_accounts (
			account_id TEXT PRIMARY KEY,
			balance_cents BIGINT NOT NULL DEFAULT 0,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS ledger_entries (
			transfer_id TEXT PRIMARY KEY,
			payer_id TEXT NOT NULL,
			payee_id TEXT NOT NULL,
			amount_cents BIGINT NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			entry_type TEXT NOT NULL DEFAULT 'transfer',
			related_transfer_id TEXT
		)`,
		`ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS entry_type TEXT NOT NULL DEFAULT 'transfer'`,
		`ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS related_transfer_id TEXT`,
		`CREATE INDEX IF NOT EXISTS idx_ledger_entries_related_transfer ON ledger_entries (related_transfer_id)`,
	}

	for _, statement := range statements {
		if _, err := tbc.db.Exec(statement); err != nil {
			return fmt.Errorf("ensure ledger schema: %w", err)
		}
	}
	return nil
}

func (tbc *TigerBeetleClient) CreatePayerAccount(payerID string) error {
	_, err := tbc.db.Exec(
		`INSERT INTO ledger_accounts (account_id, balance_cents, created_at, updated_at)
		 VALUES ($1, $2, $3, $3)
		 ON CONFLICT (account_id) DO NOTHING`,
		payerID,
		int64(1_000_000),
		time.Now().UTC(),
	)
	if err != nil {
		return fmt.Errorf("create payer account: %w", err)
	}
	return nil
}

func (tbc *TigerBeetleClient) CreatePayeeAccount(payeeID string) error {
	_, err := tbc.db.Exec(
		`INSERT INTO ledger_accounts (account_id, balance_cents, created_at, updated_at)
		 VALUES ($1, $2, $3, $3)
		 ON CONFLICT (account_id) DO NOTHING`,
		payeeID,
		int64(0),
		time.Now().UTC(),
	)
	if err != nil {
		return fmt.Errorf("create payee account: %w", err)
	}
	return nil
}

func (tbc *TigerBeetleClient) ensureAccount(accountID string, startingBalance int64) error {
	_, err := tbc.db.Exec(
		`INSERT INTO ledger_accounts (account_id, balance_cents, created_at, updated_at)
		 VALUES ($1, $2, NOW(), NOW())
		 ON CONFLICT (account_id) DO NOTHING`,
		accountID,
		startingBalance,
	)
	if err != nil {
		return fmt.Errorf("ensure account %s: %w", accountID, err)
	}
	return nil
}

func (tbc *TigerBeetleClient) GetAccountBalance(accountID string) (uint64, error) {
	var balance int64
	err := tbc.db.QueryRow(`SELECT balance_cents FROM ledger_accounts WHERE account_id = $1`, accountID).Scan(&balance)
	if err != nil {
		if err == sql.ErrNoRows {
			return 0, fmt.Errorf("account not found")
		}
		return 0, fmt.Errorf("get account balance: %w", err)
	}
	if balance < 0 {
		balance = 0
	}
	return uint64(balance), nil
}

func (tbc *TigerBeetleClient) VerifyBalance(accountID string, requiredAmount uint64) (bool, error) {
	balance, err := tbc.GetAccountBalance(accountID)
	if err != nil {
		return false, err
	}
	return balance >= requiredAmount, nil
}

func (tbc *TigerBeetleClient) Close() {
	if tbc != nil && tbc.db != nil {
		_ = tbc.db.Close()
	}
}

func (tbc *TigerBeetleClient) ProcessMojaloopTransfer(transferID string, payerID string, payeeID string, amount uint64) error {
	return tbc.processLedgerMovement(transferID, "transfer", payerID, payeeID, amount, "")
}

func (tbc *TigerBeetleClient) ReverseMojaloopTransfer(refundID string, originalTransferID string, payerID string, payeeID string, amount uint64) error {
	var exists bool
	err := tbc.db.QueryRow(
		`SELECT EXISTS(SELECT 1 FROM ledger_entries WHERE transfer_id = $1 AND entry_type = 'transfer')`,
		originalTransferID,
	).Scan(&exists)
	if err != nil {
		return fmt.Errorf("check original transfer before reversal: %w", err)
	}
	if !exists {
		return fmt.Errorf("original transfer not found")
	}

	return tbc.processLedgerMovement(refundID, "refund", payeeID, payerID, amount, originalTransferID)
}

func (tbc *TigerBeetleClient) processLedgerMovement(entryID string, entryType string, payerID string, payeeID string, amount uint64, relatedTransferID string) (err error) {
	if entryID == "" {
		return fmt.Errorf("entry id is required")
	}
	if payerID == "" || payeeID == "" {
		return fmt.Errorf("payer and payee are required")
	}
	if amount == 0 {
		return fmt.Errorf("amount must be greater than zero")
	}

	startingBalance := int64(0)
	if entryType == "transfer" {
		startingBalance = int64(1_000_000)
	}
	if err := tbc.ensureAccount(payerID, startingBalance); err != nil {
		return err
	}
	if err := tbc.ensureAccount(payeeID, 0); err != nil {
		return err
	}

	tx, err := tbc.db.Begin()
	if err != nil {
		return fmt.Errorf("begin ledger transaction: %w", err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	var existing string
	scanErr := tx.QueryRow(`SELECT transfer_id FROM ledger_entries WHERE transfer_id = $1`, entryID).Scan(&existing)
	if scanErr == nil {
		return nil
	}
	if scanErr != nil && scanErr != sql.ErrNoRows {
		return fmt.Errorf("check duplicate ledger entry: %w", scanErr)
	}

	var payerBalance int64
	if err = tx.QueryRow(`SELECT balance_cents FROM ledger_accounts WHERE account_id = $1 FOR UPDATE`, payerID).Scan(&payerBalance); err != nil {
		return fmt.Errorf("lock payer account: %w", err)
	}
	if err = tx.QueryRow(`SELECT balance_cents FROM ledger_accounts WHERE account_id = $1 FOR UPDATE`, payeeID).Err(); err != nil {
		if err != nil {
			return fmt.Errorf("lock payee account: %w", err)
		}
	}
	if payerBalance < int64(amount) {
		return fmt.Errorf("insufficient balance")
	}
	if _, err = tx.Exec(`UPDATE ledger_accounts SET balance_cents = balance_cents - $2, updated_at = NOW() WHERE account_id = $1`, payerID, int64(amount)); err != nil {
		return fmt.Errorf("debit payer account: %w", err)
	}
	if _, err = tx.Exec(`UPDATE ledger_accounts SET balance_cents = balance_cents + $2, updated_at = NOW() WHERE account_id = $1`, payeeID, int64(amount)); err != nil {
		return fmt.Errorf("credit payee account: %w", err)
	}
	if _, err = tx.Exec(
		`INSERT INTO ledger_entries (transfer_id, payer_id, payee_id, amount_cents, created_at, entry_type, related_transfer_id)
		 VALUES ($1, $2, $3, $4, NOW(), $5, NULLIF($6, ''))`,
		entryID,
		payerID,
		payeeID,
		int64(amount),
		entryType,
		relatedTransferID,
	); err != nil {
		return fmt.Errorf("insert ledger entry: %w", err)
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("commit ledger transaction: %w", err)
	}
	return nil
}

func (tbc *TigerBeetleClient) ReconcileTransaction(transferID string) (bool, error) {
	var existing string
	err := tbc.db.QueryRow(`SELECT transfer_id FROM ledger_entries WHERE transfer_id = $1`, transferID).Scan(&existing)
	if err != nil {
		if err == sql.ErrNoRows {
			return false, nil
		}
		return false, fmt.Errorf("reconcile transaction: %w", err)
	}
	return true, nil
}

func (tbc *TigerBeetleClient) GetTransferReconciliation(transferID string) (TransferReconciliation, error) {
	var transferAmount sql.NullInt64
	var payerID sql.NullString
	var payeeID sql.NullString
	err := tbc.db.QueryRow(
		`SELECT amount_cents, payer_id, payee_id FROM ledger_entries WHERE transfer_id = $1 AND entry_type = 'transfer'`,
		transferID,
	).Scan(&transferAmount, &payerID, &payeeID)
	if err != nil {
		if err == sql.ErrNoRows {
			return TransferReconciliation{TransferID: transferID, TransferExists: false}, nil
		}
		return TransferReconciliation{}, fmt.Errorf("load transfer reconciliation: %w", err)
	}

	var refunded sql.NullInt64
	var refundCount sql.NullInt64
	if err := tbc.db.QueryRow(
		`SELECT COALESCE(SUM(amount_cents), 0), COUNT(*) FROM ledger_entries WHERE related_transfer_id = $1 AND entry_type = 'refund'`,
		transferID,
	).Scan(&refunded, &refundCount); err != nil {
		return TransferReconciliation{}, fmt.Errorf("load refund reconciliation: %w", err)
	}

	transferAmountValue := uint64(maxInt64(transferAmount.Int64, 0))
	refundedAmountValue := uint64(maxInt64(refunded.Int64, 0))
	net := uint64(0)
	if transferAmountValue > refundedAmountValue {
		net = transferAmountValue - refundedAmountValue
	}

	return TransferReconciliation{
		TransferID:       transferID,
		TransferExists:   true,
		TransferAmount:   transferAmountValue,
		RefundedAmount:   refundedAmountValue,
		NetSettledAmount: net,
		RefundCount:      int(refundCount.Int64),
		FullyReversed:    refundedAmountValue >= transferAmountValue,
		LedgerConsistent: refundedAmountValue <= transferAmountValue,
		OriginalPayerID:  payerID.String,
		OriginalPayeeID:  payeeID.String,
	}, nil
}

func maxInt64(value int64, floor int64) int64 {
	if value < floor {
		return floor
	}
	return value
}
