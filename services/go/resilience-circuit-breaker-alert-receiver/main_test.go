package main

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

const testWebhookToken = "0123456789abcdef0123456789abcdef"

type fakeKubernetes struct {
	mu          sync.Mutex
	state       string
	patchStatus int
	patches     int
}

func (f *fakeKubernetes) serveHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if r.Header.Get("Authorization") != "Bearer service-account-token" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	switch r.Method {
	case http.MethodGet:
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"metadata":{"resourceVersion":"7"},"data":{"state":"`+f.state+`"}}`)
	case http.MethodPatch:
		f.patches++
		if f.patchStatus == http.StatusOK {
			f.state = "open"
		}
		w.WriteHeader(f.patchStatus)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func testHandler(t *testing.T, state string, patchStatus int) (http.Handler, *fakeKubernetes, *receiverMetrics) {
	t.Helper()
	fake := &fakeKubernetes{state: state, patchStatus: patchStatus}
	server := httptest.NewTLSServer(http.HandlerFunc(fake.serveHTTP))
	t.Cleanup(server.Close)
	metrics := newReceiverMetrics()
	cfg := config{token: testWebhookToken, namespace: "resilience-test", configMap: "resilience-validation-circuit-breaker", kubeAPI: strings.TrimPrefix(server.URL, "https://")}
	return newHandler(cfg, server.Client(), func() ([]byte, error) { return []byte("service-account-token"), nil }, metrics), fake, metrics
}

func allowlistedPayload(t *testing.T, status, alertStatus string, labels map[string]string) []byte {
	t.Helper()
	if labels == nil {
		labels = map[string]string{
			"alertname":       "ResilienceInvariantProbeFailed",
			"severity":        "critical",
			"namespace":       "resilience-test",
			"circuit_breaker": "open",
			"resilience.delivery-platform.io/environment": "non-production",
		}
	}
	body, err := json.Marshal(alertmanagerPayload{Status: status, Alerts: []alert{{Status: alertStatus, Fingerprint: "test-fingerprint", Labels: labels}}})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func request(t *testing.T, handler http.Handler, body []byte, token string) *httptest.ResponseRecorder {
	t.Helper()
	req := httptest.NewRequest(http.MethodPost, "/v1/alertmanager/open", strings.NewReader(string(body)))
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	return response
}

func metricsText(t *testing.T, handler http.Handler) string {
	t.Helper()
	req := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, req)
	if response.Code != http.StatusOK {
		t.Fatalf("metrics status = %d", response.Code)
	}
	return response.Body.String()
}

func TestAllowlistedCriticalAlertOpensBreakerAndEmitsSuccessMetric(t *testing.T) {
	handler, fake, _ := testHandler(t, "closed", http.StatusOK)
	response := request(t, handler, allowlistedPayload(t, "firing", "firing", nil), testWebhookToken)
	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d, body = %s", response.Code, response.Body.String())
	}
	if fake.patches != 1 || fake.state != "open" {
		t.Fatalf("patches=%d state=%s", fake.patches, fake.state)
	}
	if !strings.Contains(metricsText(t, handler), `resilience_circuit_breaker_patch_success_total{alertname="ResilienceInvariantProbeFailed"} 1`) {
		t.Fatal("success metric missing")
	}
}

func TestAlreadyOpenAlertIsIdempotent(t *testing.T) {
	handler, fake, _ := testHandler(t, "open", http.StatusOK)
	response := request(t, handler, allowlistedPayload(t, "firing", "firing", nil), testWebhookToken)
	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d", response.Code)
	}
	if fake.patches != 0 {
		t.Fatalf("unexpected patch count %d", fake.patches)
	}
	if !strings.Contains(metricsText(t, handler), `resilience_circuit_breaker_open_idempotent_total{alertname="ResilienceInvariantProbeFailed"} 1`) {
		t.Fatal("idempotent metric missing")
	}
}

func TestRejectedInputsCannotOpenBreaker(t *testing.T) {
	handler, fake, _ := testHandler(t, "closed", http.StatusOK)
	invalidToken := request(t, handler, allowlistedPayload(t, "firing", "firing", nil), "wrong-token")
	if invalidToken.Code != http.StatusUnauthorized {
		t.Fatalf("invalid token status = %d", invalidToken.Code)
	}
	labels := map[string]string{
		"alertname":       "ResilienceInvariantProbeFailed",
		"severity":        "warning",
		"namespace":       "resilience-test",
		"circuit_breaker": "open",
		"resilience.delivery-platform.io/environment": "non-production",
	}
	warning := request(t, handler, allowlistedPayload(t, "firing", "firing", labels), testWebhookToken)
	if warning.Code != http.StatusForbidden {
		t.Fatalf("warning status = %d", warning.Code)
	}
	resolved := request(t, handler, allowlistedPayload(t, "resolved", "resolved", nil), testWebhookToken)
	if resolved.Code != http.StatusBadRequest {
		t.Fatalf("resolved status = %d", resolved.Code)
	}
	if fake.patches != 0 || fake.state != "closed" {
		t.Fatalf("rejected payload changed state: patches=%d state=%s", fake.patches, fake.state)
	}
}

func TestThreePatchFailuresExposeBoundedFailureCounter(t *testing.T) {
	handler, fake, _ := testHandler(t, "closed", http.StatusInternalServerError)
	for attempt := 0; attempt < 3; attempt++ {
		response := request(t, handler, allowlistedPayload(t, "firing", "firing", nil), testWebhookToken)
		if response.Code != http.StatusServiceUnavailable {
			t.Fatalf("attempt %d status = %d", attempt+1, response.Code)
		}
	}
	if fake.patches != 3 || fake.state != "closed" {
		t.Fatalf("patches=%d state=%s", fake.patches, fake.state)
	}
	metrics := metricsText(t, handler)
	if !strings.Contains(metrics, `resilience_circuit_breaker_patch_failures_total{alertname="ResilienceInvariantProbeFailed",failure_class="kubernetes_api"} 3`) {
		t.Fatalf("three-failure metric missing:\n%s", metrics)
	}
}

func TestHalfOpenOrUnknownStateFailsClosed(t *testing.T) {
	handler, fake, _ := testHandler(t, "half_open", http.StatusOK)
	response := request(t, handler, allowlistedPayload(t, "firing", "firing", nil), testWebhookToken)
	if response.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d", response.Code)
	}
	if fake.patches != 0 {
		t.Fatalf("unsafe state received patch count %d", fake.patches)
	}
	if !strings.Contains(metricsText(t, handler), `failure_class="invalid_breaker_state"`) {
		t.Fatal("invalid breaker state metric missing")
	}
}
