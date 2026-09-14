package resilience

import (
	"io"
	"math/rand"
	"net/http"
	"sync"
	"time"
)

// idempotentMethods are the HTTP methods that are safe to retry per RFC 9110.
var idempotentMethods = map[string]bool{
	http.MethodGet:     true,
	http.MethodHead:    true,
	http.MethodOptions: true,
	http.MethodPut:     true,
	http.MethodDelete:  true,
}

// RetryPolicy configures bounded retries with exponential backoff + jitter.
type RetryPolicy struct {
	// MaxAttempts is the total number of attempts including the first.
	// Defaults to 3 (i.e. two retries). Only idempotent methods are retried.
	MaxAttempts int
	// BackoffBase is the base delay for attempt 2. Defaults to 100ms.
	BackoffBase time.Duration
	// BackoffMax caps the backoff delay. Defaults to 2s.
	BackoffMax time.Duration
}

func (p RetryPolicy) withDefaults() RetryPolicy {
	if p.MaxAttempts <= 0 {
		p.MaxAttempts = 3
	}
	if p.BackoffBase <= 0 {
		p.BackoffBase = 100 * time.Millisecond
	}
	if p.BackoffMax <= 0 {
		p.BackoffMax = 2 * time.Second
	}
	return p
}

// Transport is an http.RoundTripper that applies a per-host circuit breaker
// plus bounded retries (idempotent methods only) with exponential backoff and
// jitter. Wrap it around any base transport or use NewClient.
type Transport struct {
	// Base is the wrapped transport. Defaults to http.DefaultTransport.
	Base http.RoundTripper

	Retry   RetryPolicy
	Breaker BreakerConfig

	mu       sync.Mutex
	breakers map[string]*Breaker
	rand     *rand.Rand
}

func (t *Transport) base() http.RoundTripper {
	if t.Base != nil {
		return t.Base
	}
	return http.DefaultTransport
}

func (t *Transport) breakerFor(host string) *Breaker {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.breakers == nil {
		t.breakers = make(map[string]*Breaker)
		t.rand = rand.New(rand.NewSource(time.Now().UnixNano()))
	}
	b, ok := t.breakers[host]
	if !ok {
		b = NewBreaker(t.Breaker)
		t.breakers[host] = b
	}
	return b
}

// BreakerState exposes the current breaker state for a host (observability).
func (t *Transport) BreakerState(host string) State {
	return t.breakerFor(host).State()
}

// backoff returns the delay before the given retry attempt (1-based retry
// index) with full jitter: random in [0, min(max, base*2^(n-1))].
func (t *Transport) backoff(retry int) time.Duration {
	p := t.Retry.withDefaults()
	delay := p.BackoffBase
	for i := 1; i < retry; i++ {
		delay *= 2
		if delay >= p.BackoffMax {
			delay = p.BackoffMax
			break
		}
	}
	if delay > p.BackoffMax {
		delay = p.BackoffMax
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.rand == nil {
		t.rand = rand.New(rand.NewSource(time.Now().UnixNano()))
	}
	if delay <= 0 {
		return 0
	}
	return time.Duration(t.rand.Int63n(int64(delay) + 1))
}

// RoundTrip executes the request through the breaker and retry policy.
func (t *Transport) RoundTrip(req *http.Request) (*http.Response, error) {
	policy := t.Retry.withDefaults()
	breaker := t.breakerFor(req.URL.Host)

	retryable := idempotentMethods[req.Method]
	attempts := 1
	if retryable {
		attempts = policy.MaxAttempts
	}

	var lastErr error
	for attempt := 1; attempt <= attempts; attempt++ {
		if attempt > 1 {
			// Rewind the request body for the retry when possible.
			if req.Body != nil && req.Body != http.NoBody {
				if req.GetBody == nil {
					// Cannot rewind; stop retrying.
					break
				}
				body, err := req.GetBody()
				if err != nil {
					break
				}
				req.Body = body
			}
			timer := time.NewTimer(t.backoff(attempt - 1))
			select {
			case <-req.Context().Done():
				timer.Stop()
				return nil, req.Context().Err()
			case <-timer.C:
			}
		}

		if !breaker.Allow() {
			return nil, ErrCircuitOpen
		}

		resp, err := t.base().RoundTrip(req)
		if err != nil {
			breaker.ReportFailure()
			lastErr = err
			continue
		}
		if resp.StatusCode >= 500 {
			breaker.ReportFailure()
			lastErr = &StatusError{StatusCode: resp.StatusCode}
			if attempt < attempts {
				// Drain and close so the connection can be reused.
				_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 4096))
				resp.Body.Close()
				continue
			}
			return resp, nil
		}
		breaker.ReportSuccess()
		return resp, nil
	}
	return nil, lastErr
}

// StatusError describes a terminal 5xx response observed by the transport.
type StatusError struct {
	StatusCode int
}

func (e *StatusError) Error() string {
	return "resilience: upstream returned status " + http.StatusText(e.StatusCode)
}

// NewClient builds an *http.Client with the given overall timeout whose
// transport enforces the shared resilience standard.
func NewClient(timeout time.Duration, retry RetryPolicy, breaker BreakerConfig) *http.Client {
	return &http.Client{
		Timeout:   timeout,
		Transport: &Transport{Retry: retry, Breaker: breaker},
	}
}

// WrapClient retrofits an existing client with the resilience transport,
// preserving its timeout and other settings.
func WrapClient(client *http.Client, retry RetryPolicy, breaker BreakerConfig) *http.Client {
	if client == nil {
		client = &http.Client{}
	}
	client.Transport = &Transport{Base: client.Transport, Retry: retry, Breaker: breaker}
	return client
}
