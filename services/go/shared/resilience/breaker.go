// Package resilience provides the shared inter-service HTTP resilience
// standard for SwitchOS Go services: a circuit breaker (closed/open/half-open)
// plus bounded retries with exponential backoff and jitter, implemented as an
// http.RoundTripper so existing *http.Client call sites adopt it by swapping
// client construction only. Standard library only.
package resilience

import (
	"errors"
	"sync"
	"time"
)

// State describes the circuit breaker state machine.
type State int

const (
	// StateClosed allows all traffic and counts consecutive failures.
	StateClosed State = iota
	// StateOpen rejects traffic until the reset timeout elapses.
	StateOpen
	// StateHalfOpen allows a bounded number of probe requests.
	StateHalfOpen
)

func (s State) String() string {
	switch s {
	case StateClosed:
		return "closed"
	case StateOpen:
		return "open"
	case StateHalfOpen:
		return "half-open"
	default:
		return "unknown"
	}
}

// ErrCircuitOpen is returned when a request is rejected by an open breaker.
var ErrCircuitOpen = errors.New("resilience: circuit breaker is open")

// BreakerConfig tunes a Breaker.
type BreakerConfig struct {
	// FailureThreshold is the number of consecutive failures that opens the
	// breaker. Defaults to 5.
	FailureThreshold int
	// ResetTimeout is how long the breaker stays open before allowing
	// half-open probes. Defaults to 30s.
	ResetTimeout time.Duration
	// HalfOpenMaxProbes is the number of concurrent probe requests allowed
	// while half-open. A single probe success closes the breaker; a probe
	// failure re-opens it. Defaults to 1.
	HalfOpenMaxProbes int
}

func (c BreakerConfig) withDefaults() BreakerConfig {
	if c.FailureThreshold <= 0 {
		c.FailureThreshold = 5
	}
	if c.ResetTimeout <= 0 {
		c.ResetTimeout = 30 * time.Second
	}
	if c.HalfOpenMaxProbes <= 0 {
		c.HalfOpenMaxProbes = 1
	}
	return c
}

// Breaker is a goroutine-safe circuit breaker.
type Breaker struct {
	cfg BreakerConfig
	// now is injectable for deterministic tests.
	now func() time.Time

	mu                  sync.Mutex
	state               State
	consecutiveFailures int
	openedAt            time.Time
	halfOpenInFlight    int
}

// NewBreaker builds a Breaker with the given configuration.
func NewBreaker(cfg BreakerConfig) *Breaker {
	return &Breaker{cfg: cfg.withDefaults(), now: time.Now}
}

// State reports the current breaker state.
func (b *Breaker) State() State {
	b.mu.Lock()
	defer b.mu.Unlock()
	return b.stateLocked()
}

func (b *Breaker) stateLocked() State {
	if b.state == StateOpen && b.now().Sub(b.openedAt) >= b.cfg.ResetTimeout {
		b.state = StateHalfOpen
		b.halfOpenInFlight = 0
	}
	return b.state
}

// Allow reports whether a request may proceed. While half-open it reserves a
// probe slot that is released by ReportSuccess/ReportFailure.
func (b *Breaker) Allow() bool {
	b.mu.Lock()
	defer b.mu.Unlock()
	switch b.stateLocked() {
	case StateClosed:
		return true
	case StateHalfOpen:
		if b.halfOpenInFlight >= b.cfg.HalfOpenMaxProbes {
			return false
		}
		b.halfOpenInFlight++
		return true
	default: // StateOpen
		return false
	}
}

// ReportSuccess records a successful call.
func (b *Breaker) ReportSuccess() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.state == StateHalfOpen {
		if b.halfOpenInFlight > 0 {
			b.halfOpenInFlight--
		}
		b.state = StateClosed
	}
	b.consecutiveFailures = 0
}

// ReportFailure records a failed call.
func (b *Breaker) ReportFailure() {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.state == StateHalfOpen {
		if b.halfOpenInFlight > 0 {
			b.halfOpenInFlight--
		}
		b.openLocked()
		return
	}
	b.consecutiveFailures++
	if b.consecutiveFailures >= b.cfg.FailureThreshold {
		b.openLocked()
	}
}

func (b *Breaker) openLocked() {
	b.state = StateOpen
	b.openedAt = b.now()
	b.consecutiveFailures = 0
	b.halfOpenInFlight = 0
}
