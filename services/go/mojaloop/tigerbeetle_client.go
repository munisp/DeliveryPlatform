package main

import (
	"fmt"
	"sync"
)

type TigerBeetleClient struct {
	mu       sync.Mutex
	balances map[string]uint64
}

func NewTigerBeetleClient() *TigerBeetleClient {
	return &TigerBeetleClient{
		balances: map[string]uint64{},
	}
}

func (tbc *TigerBeetleClient) CreatePayerAccount(payerID string) error {
	tbc.mu.Lock()
	defer tbc.mu.Unlock()
	if _, ok := tbc.balances[payerID]; !ok {
		tbc.balances[payerID] = 1_000_000
	}
	return nil
}

func (tbc *TigerBeetleClient) CreatePayeeAccount(payeeID string) error {
	tbc.mu.Lock()
	defer tbc.mu.Unlock()
	if _, ok := tbc.balances[payeeID]; !ok {
		tbc.balances[payeeID] = 0
	}
	return nil
}

func (tbc *TigerBeetleClient) GetAccountBalance(accountID string) (uint64, error) {
	tbc.mu.Lock()
	defer tbc.mu.Unlock()
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

	tbc.mu.Lock()
	defer tbc.mu.Unlock()
	payerBalance, ok := tbc.balances[payerID]
	if !ok {
		return fmt.Errorf("failed to verify balance for %s: account not found", transferID)
	}
	if payerBalance < amount {
		return fmt.Errorf("insufficient balance")
	}
	tbc.balances[payerID] = payerBalance - amount
	tbc.balances[payeeID] += amount
	return nil
}

func (tbc *TigerBeetleClient) ReconcileTransaction(transferID string) (bool, error) {
	return transferID != "", nil
}
