package main

import (
	"flag"
	"fmt"
	"sync"
	"testing"
	"time"
)

var (
	financialLoadTransfers = flag.Int("financial-load-transfers", 4096, "number of disposable financial transfer records to dispatch")
	financialLoadLanes     = flag.Int("financial-load-lanes", 4, "bounded dispatcher lanes for the disposable throughput test")
	financialLoadBatchMax  = flag.Int("financial-load-batch-max", 256, "maximum TigerBeetle transfer batch size for the disposable throughput test")
)

// TestFinancialDispatcherPartitionedLoad is deliberately acknowledgement-gated
// by TEST_DATABASE_URL through batchTestDatabase. It exercises real PostgreSQL
// claim/fence/finalization code and a deterministic ledger contract simulator;
// it is not a substitute for a separately approved multi-node TigerBeetle
// cluster rehearsal with real account provisioning and provider simulators.
func TestFinancialDispatcherPartitionedLoad(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping disposable financial dispatcher load rehearsal in short mode")
	}
	if *financialLoadTransfers < 1 || *financialLoadTransfers > 50000 {
		t.Fatalf("financial-load-transfers must be 1 through 50000, got %d", *financialLoadTransfers)
	}
	if *financialLoadLanes < 1 || *financialLoadLanes > maximumTigerBeetleDispatcherLanes {
		t.Fatalf("financial-load-lanes must be 1 through %d, got %d", maximumTigerBeetleDispatcherLanes, *financialLoadLanes)
	}
	if *financialLoadBatchMax < 1 || *financialLoadBatchMax > maximumTigerBeetleTransferBatch {
		t.Fatalf("financial-load-batch-max must be 1 through %d, got %d", maximumTigerBeetleTransferBatch, *financialLoadBatchMax)
	}

	db := batchTestDatabase(t)
	for index := 0; index < *financialLoadTransfers; index++ {
		// Distribute ready work across independent debit partitions. The test does
		// not create two eligible debits for the same partition at once, preserving
		// the production ordering model while exercising concurrent claims.
		payer := fmt.Sprintf("load-payer-%05d", index)
		seedTigerBeetleBatchTransfer(t, db, 100000+index, payer)
	}
	service := &MojaloopService{db: db}
	ledgers := make([]*simulatedTigerBeetleLedger, *financialLoadLanes)
	for index := range ledgers {
		ledgers[index] = &simulatedTigerBeetleLedger{outcomeError: map[string]error{}, seen: map[string]int{}}
	}

	started := time.Now()
	var workers sync.WaitGroup
	errors := make(chan error, len(ledgers))
	for lane, ledger := range ledgers {
		lane, ledger := lane, ledger
		workers.Add(1)
		go func() {
			defer workers.Done()
			for {
				processed, err := service.dispatchTigerBeetleTransferBatchWithLedger(fmt.Sprintf("load-lane-%d", lane), *financialLoadBatchMax, ledger)
				if err != nil {
					errors <- err
					return
				}
				if processed == 0 {
					return
				}
			}
		}()
	}
	workers.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatalf("partitioned financial dispatch failed: %v", err)
		}
	}

	var delivered int
	if err := db.QueryRow(`SELECT count(*) FROM mojaloop_funds_outbox WHERE status = 'delivered'`).Scan(&delivered); err != nil {
		t.Fatalf("count delivered financial load rows: %v", err)
	}
	if delivered != *financialLoadTransfers {
		t.Fatalf("delivered=%d want=%d", delivered, *financialLoadTransfers)
	}
	seen := map[string]int{}
	for _, ledger := range ledgers {
		ledger.mu.Lock()
		for transferID, count := range ledger.seen {
			seen[transferID] += count
		}
		ledger.mu.Unlock()
	}
	if len(seen) != *financialLoadTransfers {
		t.Fatalf("ledger submissions=%d want=%d", len(seen), *financialLoadTransfers)
	}
	for transferID, count := range seen {
		if count != 1 {
			t.Fatalf("transfer %s submitted %d times; expected one idempotent ledger submission", transferID, count)
		}
	}
	elapsed := time.Since(started)
	if elapsed <= 0 {
		t.Fatal("invalid elapsed duration")
	}
	t.Logf("financial_dispatcher_load=PASS transfers=%d lanes=%d batch_max=%d elapsed_ms=%d local_simulated_dispatch_per_second=%.2f", *financialLoadTransfers, *financialLoadLanes, *financialLoadBatchMax, elapsed.Milliseconds(), float64(*financialLoadTransfers)/elapsed.Seconds())
}
