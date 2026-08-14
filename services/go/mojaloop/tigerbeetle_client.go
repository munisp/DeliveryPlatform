package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"

	tb "github.com/tigerbeetle/tigerbeetle-go"
)

const (
	defaultTigerBeetleAccountCode  uint16 = 1
	defaultTigerBeetleTransferCode uint16 = 1
	defaultTigerBeetleRefundCode   uint16 = 2
)

type TigerBeetleClient struct {
	client       tb.Client
	accounts     map[string]tb.Uint128
	ledger       uint32
	accountCode  uint16
	transferCode uint16
	refundCode   uint16
}

type TransferReconciliation struct {
	TransferID       string `json:"transferId"`
	TransferExists   bool   `json:"transferExists"`
	TransferAmount   uint64 `json:"transferAmountCents"`
	RefundedAmount   uint64 `json:"refundedAmountCents"`
	NetSettledAmount uint64 `json:"netSettledAmountCents"`
	RefundCount      int    `json:"refundCount"`
	FullyReversed    bool   `json:"fullyReversed"`
	LedgerConsistent bool   `json:"ledgerConsistent"`
	OriginalPayerID  string `json:"originalPayerId,omitempty"`
	OriginalPayeeID  string `json:"originalPayeeId,omitempty"`
}

func NewTigerBeetleClient() (*TigerBeetleClient, error) {
	addresses := splitAndTrim(os.Getenv("TIGERBEETLE_ADDRESSES"))
	if len(addresses) == 0 {
		return nil, fmt.Errorf("TIGERBEETLE_ADDRESSES is required")
	}

	clusterID, err := parseTigerBeetleID(os.Getenv("TIGERBEETLE_CLUSTER_ID"))
	if err != nil {
		return nil, fmt.Errorf("parse TIGERBEETLE_CLUSTER_ID: %w", err)
	}

	ledger, err := parseRequiredUint32("TIGERBEETLE_LEDGER")
	if err != nil || ledger == 0 {
		if err == nil {
			err = fmt.Errorf("must be greater than zero")
		}
		return nil, fmt.Errorf("parse TIGERBEETLE_LEDGER: %w", err)
	}

	accounts, err := parseTigerBeetleAccountMap(os.Getenv("TIGERBEETLE_ACCOUNT_MAP_JSON"))
	if err != nil {
		return nil, err
	}

	client, err := tb.NewClient(clusterID, addresses)
	if err != nil {
		return nil, fmt.Errorf("initialize TigerBeetle client: %w", err)
	}

	return &TigerBeetleClient{
		client:       client,
		accounts:     accounts,
		ledger:       ledger,
		accountCode:  envUint16OrDefault("TIGERBEETLE_ACCOUNT_CODE", defaultTigerBeetleAccountCode),
		transferCode: envUint16OrDefault("TIGERBEETLE_TRANSFER_CODE", defaultTigerBeetleTransferCode),
		refundCode:   envUint16OrDefault("TIGERBEETLE_REFUND_CODE", defaultTigerBeetleRefundCode),
	}, nil
}

func (tbc *TigerBeetleClient) Close() {
	if tbc != nil && tbc.client != nil {
		tbc.client.Close()
	}
}

func (tbc *TigerBeetleClient) CreatePayerAccount(payerID string) error {
	return tbc.createAccount(payerID, true)
}

func (tbc *TigerBeetleClient) CreatePayeeAccount(payeeID string) error {
	return tbc.createAccount(payeeID, false)
}

func (tbc *TigerBeetleClient) createAccount(accountAlias string, debitLimited bool) error {
	accountID, err := tbc.accountID(accountAlias)
	if err != nil {
		return err
	}

	results, err := tbc.client.CreateAccounts([]tb.Account{{
		ID:     accountID,
		Ledger: tbc.ledger,
		Code:   tbc.accountCode,
		Flags: tb.AccountFlags{
			DebitsMustNotExceedCredits: debitLimited,
			History:                    true,
		}.ToUint16(),
	}})
	if err != nil {
		return fmt.Errorf("create TigerBeetle account %q: %w", accountAlias, err)
	}
	if len(results) != 1 {
		return fmt.Errorf("create TigerBeetle account %q: expected one result, received %d", accountAlias, len(results))
	}
	if results[0].Status != tb.AccountCreated && results[0].Status != tb.AccountExists {
		return fmt.Errorf("create TigerBeetle account %q: %s", accountAlias, results[0].Status)
	}
	return nil
}

func (tbc *TigerBeetleClient) GetAccountBalance(accountAlias string) (uint64, error) {
	accountID, err := tbc.accountID(accountAlias)
	if err != nil {
		return 0, err
	}
	accounts, err := tbc.client.LookupAccounts([]tb.Uint128{accountID})
	if err != nil {
		return 0, fmt.Errorf("lookup TigerBeetle account %q: %w", accountAlias, err)
	}
	if len(accounts) != 1 {
		return 0, fmt.Errorf("TigerBeetle account %q not found", accountAlias)
	}

	credits, err := uint128ToUint64(accounts[0].CreditsPosted)
	if err != nil {
		return 0, fmt.Errorf("read TigerBeetle credits for %q: %w", accountAlias, err)
	}
	debits, err := uint128ToUint64(accounts[0].DebitsPosted)
	if err != nil {
		return 0, fmt.Errorf("read TigerBeetle debits for %q: %w", accountAlias, err)
	}
	if debits > credits {
		return 0, fmt.Errorf("TigerBeetle account %q has invalid negative posted balance", accountAlias)
	}
	return credits - debits, nil
}

func (tbc *TigerBeetleClient) VerifyBalance(accountAlias string, requiredAmount uint64) (bool, error) {
	balance, err := tbc.GetAccountBalance(accountAlias)
	if err != nil {
		return false, err
	}
	return balance >= requiredAmount, nil
}

func (tbc *TigerBeetleClient) ProcessMojaloopTransfer(transferID string, payerID string, payeeID string, amount uint64) error {
	return tbc.processLedgerMovement(transferID, payerID, payeeID, amount, transferID, tbc.transferCode)
}

func (tbc *TigerBeetleClient) ReverseMojaloopTransfer(refundID string, originalTransferID string, payerID string, payeeID string, amount uint64) error {
	originalID, err := parseTigerBeetleID(originalTransferID)
	if err != nil {
		return fmt.Errorf("parse original TigerBeetle transfer id: %w", err)
	}
	original, err := tbc.client.LookupTransfers([]tb.Uint128{originalID})
	if err != nil {
		return fmt.Errorf("lookup original TigerBeetle transfer: %w", err)
	}
	if len(original) != 1 {
		return fmt.Errorf("original TigerBeetle transfer not found")
	}

	return tbc.processLedgerMovement(refundID, payeeID, payerID, amount, originalTransferID, tbc.refundCode)
}

func (tbc *TigerBeetleClient) processLedgerMovement(entryID string, debitAlias string, creditAlias string, amount uint64, correlationID string, code uint16) error {
	if amount == 0 {
		return fmt.Errorf("amount must be greater than zero")
	}
	transferID, err := parseTigerBeetleID(entryID)
	if err != nil {
		return fmt.Errorf("parse TigerBeetle transfer id: %w", err)
	}
	debitAccountID, err := tbc.accountID(debitAlias)
	if err != nil {
		return err
	}
	creditAccountID, err := tbc.accountID(creditAlias)
	if err != nil {
		return err
	}
	correlation, err := parseTigerBeetleID(correlationID)
	if err != nil {
		return fmt.Errorf("parse TigerBeetle transfer correlation id: %w", err)
	}

	results, err := tbc.client.CreateTransfers([]tb.Transfer{{
		ID:              transferID,
		DebitAccountID:  debitAccountID,
		CreditAccountID: creditAccountID,
		Amount:          tb.ToUint128(amount),
		UserData128:     correlation,
		Ledger:          tbc.ledger,
		Code:            code,
	}})
	if err != nil {
		return fmt.Errorf("submit TigerBeetle transfer: %w", err)
	}
	if len(results) != 1 {
		return fmt.Errorf("submit TigerBeetle transfer: expected one result, received %d", len(results))
	}
	if results[0].Status != tb.TransferCreated && results[0].Status != tb.TransferExists {
		return fmt.Errorf("submit TigerBeetle transfer: %s", results[0].Status)
	}
	return nil
}

func (tbc *TigerBeetleClient) ReconcileTransaction(transferID string) (bool, error) {
	id, err := parseTigerBeetleID(transferID)
	if err != nil {
		return false, err
	}
	transfers, err := tbc.client.LookupTransfers([]tb.Uint128{id})
	if err != nil {
		return false, fmt.Errorf("lookup TigerBeetle transfer: %w", err)
	}
	return len(transfers) == 1, nil
}

func (tbc *TigerBeetleClient) GetTransferReconciliation(transferID string) (TransferReconciliation, error) {
	id, err := parseTigerBeetleID(transferID)
	if err != nil {
		return TransferReconciliation{}, err
	}
	transfers, err := tbc.client.LookupTransfers([]tb.Uint128{id})
	if err != nil {
		return TransferReconciliation{}, fmt.Errorf("lookup TigerBeetle transfer: %w", err)
	}
	if len(transfers) != 1 {
		return TransferReconciliation{TransferID: transferID, TransferExists: false}, nil
	}

	transferAmount, err := uint128ToUint64(transfers[0].Amount)
	if err != nil {
		return TransferReconciliation{}, fmt.Errorf("read original TigerBeetle transfer amount: %w", err)
	}
	refunds, err := tbc.client.QueryTransfers(tb.QueryFilter{
		UserData128: id,
		Ledger:      tbc.ledger,
		Code:        tbc.refundCode,
		Limit:       1024,
	})
	if err != nil {
		return TransferReconciliation{}, fmt.Errorf("query TigerBeetle refund transfers: %w", err)
	}

	refunded := uint64(0)
	for _, refund := range refunds {
		amount, amountErr := uint128ToUint64(refund.Amount)
		if amountErr != nil {
			return TransferReconciliation{}, fmt.Errorf("read TigerBeetle refund amount: %w", amountErr)
		}
		if ^uint64(0)-refunded < amount {
			return TransferReconciliation{}, fmt.Errorf("TigerBeetle refund total overflows uint64")
		}
		refunded += amount
	}

	netSettled := uint64(0)
	if refunded <= transferAmount {
		netSettled = transferAmount - refunded
	}
	return TransferReconciliation{
		TransferID:       transferID,
		TransferExists:   true,
		TransferAmount:   transferAmount,
		RefundedAmount:   refunded,
		NetSettledAmount: netSettled,
		RefundCount:      len(refunds),
		FullyReversed:    refunded == transferAmount,
		LedgerConsistent: refunded <= transferAmount,
		OriginalPayerID:  tbc.accountAlias(transfers[0].DebitAccountID),
		OriginalPayeeID:  tbc.accountAlias(transfers[0].CreditAccountID),
	}, nil
}

func (tbc *TigerBeetleClient) accountID(alias string) (tb.Uint128, error) {
	id, ok := tbc.accounts[strings.TrimSpace(alias)]
	if !ok {
		return tb.Uint128{}, fmt.Errorf("TigerBeetle account mapping is not configured for %q", alias)
	}
	return id, nil
}

func (tbc *TigerBeetleClient) accountAlias(id tb.Uint128) string {
	for alias, accountID := range tbc.accounts {
		if accountID == id {
			return alias
		}
	}
	return ""
}

func parseTigerBeetleAccountMap(raw string) (map[string]tb.Uint128, error) {
	if strings.TrimSpace(raw) == "" {
		return nil, fmt.Errorf("TIGERBEETLE_ACCOUNT_MAP_JSON is required")
	}
	var configured map[string]string
	if err := json.Unmarshal([]byte(raw), &configured); err != nil {
		return nil, fmt.Errorf("parse TIGERBEETLE_ACCOUNT_MAP_JSON: %w", err)
	}
	if len(configured) == 0 {
		return nil, fmt.Errorf("TIGERBEETLE_ACCOUNT_MAP_JSON must not be empty")
	}

	accounts := make(map[string]tb.Uint128, len(configured))
	for alias, rawID := range configured {
		trimmedAlias := strings.TrimSpace(alias)
		if trimmedAlias == "" {
			return nil, fmt.Errorf("TIGERBEETLE_ACCOUNT_MAP_JSON contains an empty alias")
		}
		id, err := parseTigerBeetleID(rawID)
		if err != nil {
			return nil, fmt.Errorf("parse TigerBeetle account mapping for %q: %w", trimmedAlias, err)
		}
		accounts[trimmedAlias] = id
	}
	return accounts, nil
}

func parseTigerBeetleID(value string) (tb.Uint128, error) {
	normalized := strings.TrimSpace(strings.ReplaceAll(value, "-", ""))
	if normalized == "" {
		return tb.Uint128{}, fmt.Errorf("identifier is required")
	}
	id, err := tb.HexStringToUint128(normalized)
	if err != nil {
		return tb.Uint128{}, err
	}
	low, high := id.Uint64()
	if low == 0 && high == 0 {
		return tb.Uint128{}, fmt.Errorf("identifier must not be zero")
	}
	return id, nil
}

func uint128ToUint64(value tb.Uint128) (uint64, error) {
	low, high := value.Uint64()
	if high != 0 {
		return 0, fmt.Errorf("value exceeds uint64")
	}
	return low, nil
}

func parseRequiredUint32(name string) (uint32, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return 0, fmt.Errorf("%s is required", name)
	}
	value, err := strconv.ParseUint(raw, 10, 32)
	if err != nil {
		return 0, err
	}
	return uint32(value), nil
}

func envUint16OrDefault(name string, fallback uint16) uint16 {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseUint(raw, 10, 16)
	if err != nil || value == 0 {
		return fallback
	}
	return uint16(value)
}
