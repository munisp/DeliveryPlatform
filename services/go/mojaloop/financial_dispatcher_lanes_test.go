package main

import (
	"fmt"
	"sync"
	"testing"
)

func TestAdaptiveTigerBeetleBatchLimitIsBounded(t *testing.T) {
	cases := []struct {
		name      string
		processed int
		previous  int
		minimum   int
		maximum   int
		want      int
	}{
		{name: "empty work resets to minimum", processed: 0, previous: 256, minimum: 64, maximum: 1024, want: 64},
		{name: "full batch doubles", processed: 64, previous: 64, minimum: 64, maximum: 1024, want: 128},
		{name: "full maximum stays capped", processed: 1024, previous: 1024, minimum: 64, maximum: 1024, want: 1024},
		{name: "partial batch follows measured work", processed: 192, previous: 256, minimum: 64, maximum: 1024, want: 192},
		{name: "under minimum clamps", processed: 5, previous: 256, minimum: 64, maximum: 1024, want: 64},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			got := adaptiveTigerBeetleBatchLimit(testCase.processed, testCase.previous, testCase.minimum, testCase.maximum)
			if got != testCase.want {
				t.Fatalf("adaptive limit=%d, want %d", got, testCase.want)
			}
		})
	}
}

func TestFinancialDispatcherConfigRejectsUnsafeLaneCount(t *testing.T) {
	t.Setenv("FUNDS_OUTBOX_TIGERBEETLE_LANES", "999")
	if _, err := financialDispatcherConfigFromEnv(); err == nil {
		t.Fatal("expected unsafe TigerBeetle lane count to be rejected")
	}
}

func TestPartitionedTigerBeetleLanesSubmitIndependentDebitStreamsOnce(t *testing.T) {
	db := batchTestDatabase(t)
	const records = 768
	for index := 0; index < records; index++ {
		seedTigerBeetleBatchTransfer(t, db, 4000+index, fmt.Sprintf("payer-lane-%04d", index))
	}
	service := &MojaloopService{db: db}
	ledgers := make([]*simulatedTigerBeetleLedger, 3)
	for index := range ledgers {
		ledgers[index] = &simulatedTigerBeetleLedger{outcomeError: map[string]error{}, seen: map[string]int{}}
	}

	var group sync.WaitGroup
	errors := make(chan error, len(ledgers))
	for index, ledger := range ledgers {
		index, ledger := index, ledger
		group.Add(1)
		go func() {
			defer group.Done()
			for {
				processed, err := service.dispatchTigerBeetleTransferBatchWithLedger(fmt.Sprintf("partition-lane-%d", index), 128, ledger)
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
	group.Wait()
	close(errors)
	for err := range errors {
		if err != nil {
			t.Fatalf("dispatch partition lane: %v", err)
		}
	}

	var delivered int
	if err := db.QueryRow(`SELECT count(*) FROM mojaloop_funds_outbox WHERE status = 'delivered'`).Scan(&delivered); err != nil {
		t.Fatalf("count delivered partition-lane rows: %v", err)
	}
	if delivered != records {
		t.Fatalf("delivered=%d, want %d", delivered, records)
	}
	seen := map[string]int{}
	for _, ledger := range ledgers {
		ledger.mu.Lock()
		for transferID, count := range ledger.seen {
			seen[transferID] += count
		}
		ledger.mu.Unlock()
	}
	if len(seen) != records {
		t.Fatalf("unique TigerBeetle submissions=%d, want %d", len(seen), records)
	}
	for transferID, count := range seen {
		if count != 1 {
			t.Fatalf("transfer %s submitted %d times, want exactly once", transferID, count)
		}
	}
}
