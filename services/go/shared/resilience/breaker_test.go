package resilience

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestBreakerClosedToOpenAfterThreshold(t *testing.T) {
	b := NewBreaker(BreakerConfig{FailureThreshold: 3, ResetTimeout: time.Minute})
	if b.State() != StateClosed {
		t.Fatalf("expected closed, got %s", b.State())
	}
	for i := 0; i < 2; i++ {
		if !b.Allow() {
			t.Fatalf("attempt %d should be allowed while closed", i)
		}
		b.ReportFailure()
		if b.State() != StateClosed {
			t.Fatalf("expected closed after %d failures, got %s", i+1, b.State())
		}
	}
	if !b.Allow() {
		t.Fatal("third attempt should be allowed")
	}
	b.ReportFailure()
	if b.State() != StateOpen {
		t.Fatalf("expected open after threshold, got %s", b.State())
	}
	if b.Allow() {
		t.Fatal("open breaker must reject requests")
	}
}

func TestBreakerSuccessResetsFailureCount(t *testing.T) {
	b := NewBreaker(BreakerConfig{FailureThreshold: 2, ResetTimeout: time.Minute})
	b.Allow()
	b.ReportFailure()
	b.Allow()
	b.ReportSuccess()
	b.Allow()
	b.ReportFailure()
	if b.State() != StateClosed {
		t.Fatalf("success must reset consecutive failures, got %s", b.State())
	}
}

func TestBreakerHalfOpenProbeAndReset(t *testing.T) {
	now := time.Now()
	b := NewBreaker(BreakerConfig{FailureThreshold: 1, ResetTimeout: 30 * time.Second, HalfOpenMaxProbes: 1})
	b.now = func() time.Time { return now }

	b.Allow()
	b.ReportFailure()
	if b.State() != StateOpen {
		t.Fatalf("expected open, got %s", b.State())
	}
	if b.Allow() {
		t.Fatal("open breaker must reject before reset timeout")
	}

	now = now.Add(31 * time.Second)
	if !b.Allow() {
		t.Fatal("half-open probe should be allowed after reset timeout")
	}
	if b.State() != StateHalfOpen {
		t.Fatalf("expected half-open, got %s", b.State())
	}
	// Only one probe at a time.
	if b.Allow() {
		t.Fatal("second concurrent probe must be rejected")
	}
	b.ReportSuccess()
	if b.State() != StateClosed {
		t.Fatalf("successful probe must close breaker, got %s", b.State())
	}
}

func TestBreakerHalfOpenFailureReopens(t *testing.T) {
	now := time.Now()
	b := NewBreaker(BreakerConfig{FailureThreshold: 1, ResetTimeout: 10 * time.Second})
	b.now = func() time.Time { return now }

	b.Allow()
	b.ReportFailure()
	now = now.Add(11 * time.Second)
	if !b.Allow() {
		t.Fatal("probe should be allowed")
	}
	b.ReportFailure()
	if b.State() != StateOpen {
		t.Fatalf("failed probe must re-open breaker, got %s", b.State())
	}
	if b.Allow() {
		t.Fatal("re-opened breaker must reject")
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestTransportRetriesIdempotentOnFailure(t *testing.T) {
	var calls atomic.Int32
	transport := &Transport{
		Retry:   RetryPolicy{MaxAttempts: 3, BackoffBase: time.Millisecond, BackoffMax: 5 * time.Millisecond},
		Breaker: BreakerConfig{FailureThreshold: 100},
		Base: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			if calls.Add(1) < 3 {
				return nil, errors.New("connection refused")
			}
			return &http.Response{StatusCode: 200, Body: http.NoBody, Header: make(http.Header)}, nil
		}),
	}
	req := httptest.NewRequest(http.MethodGet, "http://example.test/resource", nil)
	resp, err := transport.RoundTrip(req)
	if err != nil {
		t.Fatalf("expected success after retries, got %v", err)
	}
	if resp.StatusCode != 200 {
		t.Fatalf("unexpected status %d", resp.StatusCode)
	}
	if calls.Load() != 3 {
		t.Fatalf("expected 3 attempts, got %d", calls.Load())
	}
}

func TestTransportDoesNotRetryNonIdempotent(t *testing.T) {
	var calls atomic.Int32
	transport := &Transport{
		Retry:   RetryPolicy{MaxAttempts: 3, BackoffBase: time.Millisecond},
		Breaker: BreakerConfig{FailureThreshold: 100},
		Base: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			calls.Add(1)
			return nil, errors.New("connection refused")
		}),
	}
	req := httptest.NewRequest(http.MethodPost, "http://example.test/submit", strings.NewReader("{}"))
	if _, err := transport.RoundTrip(req); err == nil {
		t.Fatal("expected error")
	}
	if calls.Load() != 1 {
		t.Fatalf("POST must not be retried, got %d calls", calls.Load())
	}
}

func TestTransportOpensBreakerAndShortCircuits(t *testing.T) {
	var calls atomic.Int32
	transport := &Transport{
		Retry:   RetryPolicy{MaxAttempts: 1},
		Breaker: BreakerConfig{FailureThreshold: 2, ResetTimeout: time.Minute},
		Base: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			calls.Add(1)
			return &http.Response{StatusCode: 503, Body: http.NoBody, Header: make(http.Header)}, nil
		}),
	}
	for i := 0; i < 2; i++ {
		req := httptest.NewRequest(http.MethodGet, "http://flaky.test/", nil)
		resp, err := transport.RoundTrip(req)
		if err != nil {
			t.Fatalf("attempt %d: %v", i, err)
		}
		resp.Body.Close()
	}
	if transport.BreakerState("flaky.test") != StateOpen {
		t.Fatalf("expected open breaker, got %s", transport.BreakerState("flaky.test"))
	}
	req := httptest.NewRequest(http.MethodGet, "http://flaky.test/", nil)
	if _, err := transport.RoundTrip(req); !errors.Is(err, ErrCircuitOpen) {
		t.Fatalf("expected ErrCircuitOpen, got %v", err)
	}
	if calls.Load() != 2 {
		t.Fatalf("open breaker must short-circuit, got %d calls", calls.Load())
	}
}

func TestTransportRetriesRewindableBody(t *testing.T) {
	var calls atomic.Int32
	transport := &Transport{
		Retry:   RetryPolicy{MaxAttempts: 2, BackoffBase: time.Millisecond},
		Breaker: BreakerConfig{FailureThreshold: 100},
		Base: roundTripFunc(func(r *http.Request) (*http.Response, error) {
			calls.Add(1)
			return nil, errors.New("reset by peer")
		}),
	}
	// http.NewRequest sets GetBody for *strings.Reader, so PUT can be retried.
	req, err := http.NewRequest(http.MethodPut, "http://example.test/item", strings.NewReader("payload"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := transport.RoundTrip(req); err == nil {
		t.Fatal("expected terminal error")
	}
	if calls.Load() != 2 {
		t.Fatalf("expected 2 attempts for rewindable PUT, got %d", calls.Load())
	}
}

func TestNewClientEndToEnd(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	defer server.Close()
	client := NewClient(2*time.Second, RetryPolicy{}, BreakerConfig{})
	resp, err := client.Get(server.URL)
	if err != nil {
		t.Fatalf("request through resilient client failed: %v", err)
	}
	resp.Body.Close()
}
