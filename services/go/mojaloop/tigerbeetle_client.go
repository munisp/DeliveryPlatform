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
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
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
	if err := tbc.CreatePayerAccount(payerID); err != nil {
		return err
	}
	if err := tbc.CreatePayeeAccount(payeeID); err != nil {
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
	scanErr := tx.QueryRow(`SELECT transfer_id FROM ledger_entries WHERE transfer_id = $1`, transferID).Scan(&existing)
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
	if payerBalance < int64(amount) {
		return fmt.Errorf("insufficient balance")
	}
	if _, err = tx.Exec(`UPDATE ledger_accounts SET balance_cents = balance_cents - $2, updated_at = NOW() WHERE account_id = $1`, payerID, int64(amount)); err != nil {
		return fmt.Errorf("debit payer account: %w", err)
	}
	if _, err = tx.Exec(`UPDATE ledger_accounts SET balance_cents = balance_cents + $2, updated_at = NOW() WHERE account_id = $1`, payeeID, int64(amount)); err != nil {
		return fmt.Errorf("credit payee account: %w", err)
	}
	if _, err = tx.Exec(`INSERT INTO ledger_entries (transfer_id, payer_id, payee_id, amount_cents, created_at) VALUES ($1, $2, $3, $4, NOW())`, transferID, payerID, payeeID, int64(amount)); err != nil {
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
