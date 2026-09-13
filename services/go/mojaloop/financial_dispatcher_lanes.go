package main

import (
	"context"
	"database/sql"
	"fmt"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultTigerBeetleDispatcherLanes    = 1
	maximumTigerBeetleDispatcherLanes    = 8
	defaultTigerBeetleBatchMinimum       = 64
	defaultTigerBeetleBatchMaximum       = 256
	defaultTigerBeetleIdleWait           = 25 * time.Millisecond
	defaultFinancialDispatcherPoll       = time.Second
	defaultFinancialDatabaseMaxOpenConns = 24
	defaultFinancialDatabaseMaxIdleConns = 8
	defaultFinancialDatabaseConnLifetime = 30 * time.Minute
	defaultFinancialDatabaseConnIdleTime = 5 * time.Minute
)

// financialDispatcherConfig intentionally caps local concurrency. A TigerBeetle
// client has one in-flight request, so the scale unit is a bounded lane with its
// own client session, not an unbounded goroutine. The total configured client
// session budget must remain below the TigerBeetle cluster limit.
type financialDispatcherConfig struct {
	TigerBeetleLanes    int
	TigerBeetleBatchMin int
	TigerBeetleBatchMax int
	TigerBeetleIdleWait time.Duration
	GenericPollInterval time.Duration
}

func parseBoundedEnvInt(name string, fallback, minimum, maximum int) (int, error) {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback, nil
	}
	value, err := strconv.Atoi(raw)
	if err != nil || value < minimum || value > maximum {
		return 0, fmt.Errorf("%s must be an integer from %d through %d", name, minimum, maximum)
	}
	return value, nil
}

func parseBoundedEnvDurationMillis(name string, fallback time.Duration, minimum, maximum int) (time.Duration, error) {
	milliseconds, err := parseBoundedEnvInt(name, int(fallback/time.Millisecond), minimum, maximum)
	if err != nil {
		return 0, err
	}
	return time.Duration(milliseconds) * time.Millisecond, nil
}

func financialDispatcherConfigFromEnv() (financialDispatcherConfig, error) {
	lanes, err := parseBoundedEnvInt(
		"FUNDS_OUTBOX_TIGERBEETLE_LANES",
		defaultTigerBeetleDispatcherLanes,
		1,
		maximumTigerBeetleDispatcherLanes,
	)
	if err != nil {
		return financialDispatcherConfig{}, err
	}
	minimum, err := parseBoundedEnvInt(
		"FUNDS_OUTBOX_TIGERBEETLE_BATCH_MIN",
		defaultTigerBeetleBatchMinimum,
		1,
		maximumTigerBeetleTransferBatch,
	)
	if err != nil {
		return financialDispatcherConfig{}, err
	}
	maximum, err := parseBoundedEnvInt(
		"FUNDS_OUTBOX_TIGERBEETLE_BATCH_MAX",
		defaultTigerBeetleBatchMaximum,
		minimum,
		maximumTigerBeetleTransferBatch,
	)
	if err != nil {
		return financialDispatcherConfig{}, err
	}
	idleWait, err := parseBoundedEnvDurationMillis(
		"FUNDS_OUTBOX_TIGERBEETLE_IDLE_WAIT_MS",
		defaultTigerBeetleIdleWait,
		5,
		1000,
	)
	if err != nil {
		return financialDispatcherConfig{}, err
	}
	poll, err := parseBoundedEnvDurationMillis(
		"FUNDS_OUTBOX_GENERIC_POLL_MS",
		defaultFinancialDispatcherPoll,
		50,
		5000,
	)
	if err != nil {
		return financialDispatcherConfig{}, err
	}
	return financialDispatcherConfig{
		TigerBeetleLanes:    lanes,
		TigerBeetleBatchMin: minimum,
		TigerBeetleBatchMax: maximum,
		TigerBeetleIdleWait: idleWait,
		GenericPollInterval: poll,
	}, nil
}

func configureFinancialDatabasePool(db *sql.DB) error {
	if db == nil {
		return fmt.Errorf("financial dispatcher database is required")
	}
	maxOpen, err := parseBoundedEnvInt("FINANCIAL_DB_MAX_OPEN_CONNS", defaultFinancialDatabaseMaxOpenConns, 1, 256)
	if err != nil {
		return err
	}
	maxIdle, err := parseBoundedEnvInt("FINANCIAL_DB_MAX_IDLE_CONNS", defaultFinancialDatabaseMaxIdleConns, 0, maxOpen)
	if err != nil {
		return err
	}
	maxLifetime, err := parseBoundedEnvDurationMillis("FINANCIAL_DB_CONN_MAX_LIFETIME_MS", defaultFinancialDatabaseConnLifetime, 1000, int((24*time.Hour)/time.Millisecond))
	if err != nil {
		return err
	}
	maxIdleTime, err := parseBoundedEnvDurationMillis("FINANCIAL_DB_CONN_MAX_IDLE_TIME_MS", defaultFinancialDatabaseConnIdleTime, 1000, int((24*time.Hour)/time.Millisecond))
	if err != nil {
		return err
	}
	db.SetMaxOpenConns(maxOpen)
	db.SetMaxIdleConns(maxIdle)
	db.SetConnMaxLifetime(maxLifetime)
	db.SetConnMaxIdleTime(maxIdleTime)
	return nil
}

func (s *MojaloopService) tigerBeetleLaneLedgers(lanes int) ([]TigerBeetleLedger, func(), error) {
	if s.tigerBeetle == nil {
		return nil, nil, fmt.Errorf("TigerBeetle ledger client is required")
	}
	if lanes < 1 || lanes > maximumTigerBeetleDispatcherLanes {
		return nil, nil, fmt.Errorf("TigerBeetle lane count must be from 1 through %d", maximumTigerBeetleDispatcherLanes)
	}
	ledgers := make([]TigerBeetleLedger, 0, lanes)
	ledgers = append(ledgers, s.tigerBeetle)
	closers := make([]interface{ Close() }, 0, lanes-1)
	for len(ledgers) < lanes {
		client, err := NewTigerBeetleClient()
		if err != nil {
			for _, closer := range closers {
				closer.Close()
			}
			return nil, nil, fmt.Errorf("initialize TigerBeetle dispatcher lane %d: %w", len(ledgers), err)
		}
		ledgers = append(ledgers, client)
		closers = append(closers, client)
	}
	return ledgers, func() {
		for _, closer := range closers {
			closer.Close()
		}
	}, nil
}

// adaptiveTigerBeetleBatchLimit increases only after a full observed batch and
// contracts after an under-filled batch. It is intentionally deterministic and
// bounded so backlogs lift batching efficiency without a latency-blind queue.
func adaptiveTigerBeetleBatchLimit(previousProcessed, previousLimit, minimum, maximum int) int {
	if minimum < 1 || maximum < minimum {
		return 1
	}
	if previousProcessed <= 0 {
		return minimum
	}
	if previousProcessed >= previousLimit && previousLimit < maximum {
		next := previousLimit * 2
		if next > maximum {
			return maximum
		}
		return next
	}
	if previousProcessed < minimum {
		return minimum
	}
	if previousProcessed > maximum {
		return maximum
	}
	return previousProcessed
}

func (s *MojaloopService) runTigerBeetleDispatcherLane(ctx context.Context, workerID string, ledger TigerBeetleLedger, config financialDispatcherConfig, lane int) error {
	limit := config.TigerBeetleBatchMin
	laneWorkerID := fmt.Sprintf("%s-tigerbeetle-%02d", workerID, lane)
	for {
		processed, err := s.dispatchTigerBeetleTransferBatchWithLedger(laneWorkerID, limit, ledger)
		if err != nil {
			return err
		}
		limit = adaptiveTigerBeetleBatchLimit(processed, limit, config.TigerBeetleBatchMin, config.TigerBeetleBatchMax)
		if processed > 0 {
			continue
		}
		timer := time.NewTimer(config.TigerBeetleIdleWait)
		select {
		case <-ctx.Done():
			if !timer.Stop() {
				<-timer.C
			}
			return nil
		case <-timer.C:
		}
	}
}

func (s *MojaloopService) runGenericFundsOutboxDispatcher(ctx context.Context, workerID string, pollInterval time.Duration) error {
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for {
		if _, err := s.DispatchFundsOutbox(ctx, workerID, defaultOutboxBatchSize); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return nil
		case <-ticker.C:
		}
	}
}

func runDispatcherGroup(ctx context.Context, runners ...func(context.Context) error) error {
	if len(runners) == 0 {
		return nil
	}
	groupContext, cancel := context.WithCancel(ctx)
	defer cancel()
	errors := make(chan error, len(runners))
	var group sync.WaitGroup
	for _, runner := range runners {
		runner := runner
		group.Add(1)
		go func() {
			defer group.Done()
			if err := runner(groupContext); err != nil {
				errors <- err
				cancel()
			}
		}()
	}
	finished := make(chan struct{})
	go func() {
		group.Wait()
		close(finished)
	}()
	select {
	case err := <-errors:
		<-finished
		return err
	case <-ctx.Done():
		<-finished
		return nil
	case <-finished:
		select {
		case err := <-errors:
			return err
		default:
			return nil
		}
	}
}

func (s *MojaloopService) RunPartitionAwareFundsOutboxDispatcher(ctx context.Context, workerID string) error {
	config, err := financialDispatcherConfigFromEnv()
	if err != nil {
		return fmt.Errorf("configure financial dispatcher: %w", err)
	}
	if err := configureFinancialDatabasePool(s.db); err != nil {
		return fmt.Errorf("configure financial database pool: %w", err)
	}
	ledgers, closeLanes, err := s.tigerBeetleLaneLedgers(config.TigerBeetleLanes)
	if err != nil {
		return err
	}
	defer closeLanes()

	runners := make([]func(context.Context) error, 0, len(ledgers)+1)
	for lane, ledger := range ledgers {
		lane, ledger := lane, ledger
		runners = append(runners, func(laneContext context.Context) error {
			return s.runTigerBeetleDispatcherLane(laneContext, workerID, ledger, config, lane+1)
		})
	}
	runners = append(runners, func(genericContext context.Context) error {
		return s.runGenericFundsOutboxDispatcher(genericContext, workerID+"-generic", config.GenericPollInterval)
	})
	return runDispatcherGroup(ctx, runners...)
}
