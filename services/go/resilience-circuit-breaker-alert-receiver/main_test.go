package main

import (
	"encoding/json"
	"io"
	"log"
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
	lastPatch   []map[string]string
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
		var patches []map[string]string
		if err := json.NewDecoder(r.Body).Decode(&patches); err != nil {
			http.Error(w, "invalid patch", http.StatusBadRequest)
			return
		}
		f.patches++
		f.lastPatch = patches
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
	cfg := config{token: testWebhookToken, namespace: "resilience-test", configMap: "resilience-validation-circuit-breaker", kubeAPI: strings.TrimPrefix(server.URL, "https://"), kubeScheme: "https"}
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
	if len(fake.lastPatch) < 3 || fake.lastPatch[0]["op"] != "test" || fake.lastPatch[0]["path"] != "/metadata/resourceVersion" || fake.lastPatch[0]["value"] != "7" {
		t.Fatalf("missing resourceVersion test in patch: %#v", fake.lastPatch)
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

func TestCriticalAlertReopensHalfOpenBreaker(t *testing.T) {
	handler, fake, _ := testHandler(t, "half_open", http.StatusOK)
	response := request(t, handler, allowlistedPayload(t, "firing", "firing", nil), testWebhookToken)
	if response.Code != http.StatusAccepted {
		t.Fatalf("status = %d", response.Code)
	}
	if fake.patches != 1 || fake.state != "open" {
		t.Fatalf("patches=%d state=%s", fake.patches, fake.state)
	}
	if len(fake.lastPatch) < 3 || fake.lastPatch[1]["path"] != "/data/state" || fake.lastPatch[1]["value"] != "half_open" {
		t.Fatalf("missing half_open state test in patch: %#v", fake.lastPatch)
	}
}

func TestUnknownStateFailsClosed(t *testing.T) {
	handler, fake, _ := testHandler(t, "unexpected", http.StatusOK)
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

type strictPatchAudit struct {
	Method          string
	ResourceVersion string
	ExpectedState   string
	Status          int
}

type strictKubernetes struct {
	mu              sync.Mutex
	state           string
	resourceVersion string
	expectedGETs    int
	gets            int
	getBarrier      chan struct{}
	barrierOnce     sync.Once
	patches         []strictPatchAudit
}

func (f *strictKubernetes) serveHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Header.Get("Authorization") != "Bearer service-account-token" {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	switch r.Method {
	case http.MethodGet:
		f.mu.Lock()
		version, state := f.resourceVersion, f.state
		f.gets++
		if f.gets == f.expectedGETs {
			f.barrierOnce.Do(func() { close(f.getBarrier) })
		}
		f.mu.Unlock()
		<-f.getBarrier
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"metadata":{"resourceVersion":"`+version+`"},"data":{"state":"`+state+`"}}`)
	case http.MethodPatch:
		var patches []map[string]string
		if err := json.NewDecoder(r.Body).Decode(&patches); err != nil {
			http.Error(w, "invalid patch", http.StatusBadRequest)
			return
		}
		f.mu.Lock()
		defer f.mu.Unlock()
		observedVersion, observedState := "", ""
		if len(patches) >= 2 {
			observedVersion = patches[0]["value"]
			observedState = patches[1]["value"]
		}
		status := http.StatusConflict
		if len(patches) >= 3 && patches[0]["op"] == "test" && patches[0]["path"] == "/metadata/resourceVersion" &&
			patches[1]["op"] == "test" && patches[1]["path"] == "/data/state" &&
			patches[2]["op"] == "replace" && patches[2]["path"] == "/data/state" && patches[2]["value"] == "open" &&
			observedVersion == f.resourceVersion && observedState == f.state {
			f.state = "open"
			f.resourceVersion = "8"
			status = http.StatusOK
		}
		f.patches = append(f.patches, strictPatchAudit{Method: http.MethodPatch, ResourceVersion: observedVersion, ExpectedState: observedState, Status: status})
		w.WriteHeader(status)
	default:
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func TestThirtyTwoConcurrentReceiversUseStrictOptimisticLocking(t *testing.T) {
	fake := &strictKubernetes{state: "closed", resourceVersion: "7", expectedGETs: 32, getBarrier: make(chan struct{})}
	server := httptest.NewTLSServer(http.HandlerFunc(fake.serveHTTP))
	server.Config.ErrorLog = log.New(io.Discard, "", 0)
	defer server.Close()
	metrics := newReceiverMetrics()
	cfg := config{token: testWebhookToken, namespace: "resilience-test", configMap: "resilience-validation-circuit-breaker", kubeAPI: strings.TrimPrefix(server.URL, "https://"), kubeScheme: "https"}
	handler := newHandler(cfg, server.Client(), func() ([]byte, error) { return []byte("service-account-token"), nil }, metrics)
	payload := allowlistedPayload(t, "firing", "firing", nil)
	statuses := make(chan int, 32)
	var workers sync.WaitGroup
	for worker := 0; worker < 32; worker++ {
		workers.Add(1)
		go func() {
			defer workers.Done()
			statuses <- request(t, handler, payload, testWebhookToken).Code
		}()
	}
	workers.Wait()
	close(statuses)
	accepted, conflicts := 0, 0
	for status := range statuses {
		switch status {
		case http.StatusAccepted:
			accepted++
		case http.StatusServiceUnavailable:
			conflicts++
		default:
			t.Fatalf("unexpected concurrent receiver status %d", status)
		}
	}
	fake.mu.Lock()
	defer fake.mu.Unlock()
	if fake.state != "open" || fake.resourceVersion != "8" || len(fake.patches) != 32 {
		t.Fatalf("final state=%s resourceVersion=%s patches=%d", fake.state, fake.resourceVersion, len(fake.patches))
	}
	if accepted != 1 || conflicts != 31 {
		t.Fatalf("accepted=%d conflicts=%d; expected one winning patch and 31 stale conflicts", accepted, conflicts)
	}
	winningPatches := 0
	for _, audit := range fake.patches {
		if audit.ResourceVersion != "7" || audit.ExpectedState != "closed" {
			t.Fatalf("patch lost strict preconditions: %#v", audit)
		}
		if audit.Status == http.StatusOK {
			winningPatches++
		}
	}
	if winningPatches != 1 {
		t.Fatalf("successful state-changing patches=%d", winningPatches)
	}
	for index, audit := range fake.patches {
		t.Logf("strict_mock_api_audit sequence=%02d method=%s tested_resource_version=%s tested_state=%s status=%d", index+1, audit.Method, audit.ResourceVersion, audit.ExpectedState, audit.Status)
	}
	metricOutput := metricsText(t, handler)
	if !strings.Contains(metricOutput, `failure_class="conflict"} 31`) {
		t.Fatalf("strict conflict metric missing:\n%s", metricOutput)
	}
}
