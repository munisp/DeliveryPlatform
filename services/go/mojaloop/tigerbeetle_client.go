package main

import "fmt"

type TigerBeetleClient struct {
	balances map[string]uint64
}

func NewTigerBeetleClient() *TigerBeetleClient {
	return &TigerBeetleClient{
		balances: map[string]uint64{},
	}
}

func (tbc *TigerBeetleClient) CreatePayerAccount(payerID string) error {
	if _, ok := tbc.balances[payerID]; !ok {
		tbc.balances[payerID] = 1_000_000
	}
	return nil
}

func (tbc *TigerBeetleClient) CreatePayeeAccount(payeeID string) error {
	if _, ok := tbc.balances[payeeID]; !ok {
		tbc.balances[payeeID] = 0
	}
	return nil
}

func (tbc *TigerBeetleClient) GetAccountBalance(accountID string) (uint64, error) {
	balance, ok := tbc.balances[accountID]
	if !ok {
		return 0, fmt.Errorf("account not found")
	}
	return balance, nil
}

func (tbc *TigerBeetleClient) VerifyBalance(accountID string, requiredAmount uint64) (bool, error) {
	balance, err := tbc.GetAccountBalance(accountID)
	if err != nil {
		return false, err
	}
	return balance >= requiredAmount, nil
}

func (tbc *TigerBeetleClient) Close() {}

func (tbc *TigerBeetleClient) ProcessMojaloopTransfer(transferID string, payerID string, payeeID string, amount uint64) error {
	if err := tbc.CreatePayerAccount(payerID); err != nil {
		return err
	}
	if err := tbc.CreatePayeeAccount(payeeID); err != nil {
		return err
	}
	hasBalance, err := tbc.VerifyBalance(payerID, amount)
	if err != nil {
		return fmt.Errorf("failed to verify balance for %s: %w", transferID, err)
	}
	if !hasBalance {
		return fmt.Errorf("insufficient balance")
	}
	tbc.balances[payerID] -= amount
	tbc.balances[payeeID] += amount
	return nil
}

func (tbc *TigerBeetleClient) ReconcileTransaction(transferID string) (bool, error) {
	return transferID != "", nil
}
