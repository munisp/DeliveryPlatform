package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
)

const (
	serviceName             = "resilience-circuit-breaker-alert-receiver"
	serviceAccountTokenPath = "/var/run/secrets/kubernetes.io/serviceaccount/token"
	serviceAccountCAPath    = "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"
)

var allowedAlerts = map[string]bool{
	"ResilienceInvariantProbeFailed":  true,
	"ResilienceInvariantProbeStalled": true,
	"ResilienceInvariantProbeMissing": true,
}

var errUnsafeBreakerState = errors.New("breaker is not safely openable")

type config struct {
	token, namespace, configMap, kubeAPI, kubeScheme, certFile, keyFile, serviceAccountTokenFile, serviceAccountCAFile string
}

type alertmanagerPayload struct {
	Status string  `json:"status"`
	Alerts []alert `json:"alerts"`
}

type alert struct {
	Status, Fingerprint string
	Labels              map[string]string `json:"labels"`
}

type configMap struct {
	Metadata struct {
		ResourceVersion string `json:"resourceVersion"`
	} `json:"metadata"`
	Data map[string]string `json:"data"`
}

type receiverMetrics struct {
	mu         sync.Mutex
	successes  map[string]uint64
	failures   map[string]map[string]uint64
	idempotent map[string]uint64
}

func newReceiverMetrics() *receiverMetrics {
	return &receiverMetrics{
		successes:  make(map[string]uint64),
		failures:   make(map[string]map[string]uint64),
		idempotent: make(map[string]uint64),
	}
}

func (m *receiverMetrics) incSuccess(alertName string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.successes[alertName]++
}

func (m *receiverMetrics) incFailure(alertName, class string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.failures[alertName] == nil {
		m.failures[alertName] = make(map[string]uint64)
	}
	m.failures[alertName][class]++
}

func (m *receiverMetrics) incIdempotent(alertName string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.idempotent[alertName]++
}

func (m *receiverMetrics) serveHTTP(w http.ResponseWriter, _ *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()

	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	_, _ = io.WriteString(w, "# HELP resilience_circuit_breaker_patch_success_total Successful conditional ConfigMap patches that opened the breaker.\n")
	_, _ = io.WriteString(w, "# TYPE resilience_circuit_breaker_patch_success_total counter\n")
	for _, alertName := range sortedMetricKeys(m.successes) {
		_, _ = fmt.Fprintf(w, "resilience_circuit_breaker_patch_success_total{alertname=%q} %d\n", alertName, m.successes[alertName])
	}
	_, _ = io.WriteString(w, "# HELP resilience_circuit_breaker_patch_failures_total Failed attempts to open the breaker, classified from a bounded set.\n")
	_, _ = io.WriteString(w, "# TYPE resilience_circuit_breaker_patch_failures_total counter\n")
	for _, alertName := range sortedNestedMetricKeys(m.failures) {
		for _, class := range sortedMetricKeys(m.failures[alertName]) {
			_, _ = fmt.Fprintf(w, "resilience_circuit_breaker_patch_failures_total{alertname=%q,failure_class=%q} %d\n", alertName, class, m.failures[alertName][class])
		}
	}
	_, _ = io.WriteString(w, "# HELP resilience_circuit_breaker_open_idempotent_total Accepted alerts that found the breaker already open.\n")
	_, _ = io.WriteString(w, "# TYPE resilience_circuit_breaker_open_idempotent_total counter\n")
	for _, alertName := range sortedMetricKeys(m.idempotent) {
		_, _ = fmt.Fprintf(w, "resilience_circuit_breaker_open_idempotent_total{alertname=%q} %d\n", alertName, m.idempotent[alertName])
	}
}

func sortedMetricKeys(values map[string]uint64) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func sortedNestedMetricKeys(values map[string]map[string]uint64) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	client, err := kubeClient(cfg)
	if err != nil {
		log.Fatal(err)
	}
	tokenReader := func() ([]byte, error) { return os.ReadFile(cfg.serviceAccountTokenFile) }
	server := &http.Server{
		Addr:              ":8443",
		Handler:           newHandler(cfg, client, tokenReader, newReceiverMetrics()),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      10 * time.Second,
		IdleTimeout:       30 * time.Second,
		TLSConfig:         &tls.Config{MinVersion: tls.VersionTLS12},
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	serverErrors := make(chan error, 1)
	go func() {
		log.Printf("%s listening", serviceName)
		serverErrors <- server.ListenAndServeTLS(cfg.certFile, cfg.keyFile)
	}()

	select {
	case err := <-serverErrors:
		if err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	case <-ctx.Done():
		log.Printf("shutdown signal received; draining in-flight requests")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("graceful shutdown failed: %v", err)
		}
		if err := <-serverErrors; err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}
}

func newHandler(cfg config, client *http.Client, tokenReader func() ([]byte, error), metrics *receiverMetrics) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
	mux.HandleFunc("/metrics", metrics.serveHTTP)
	mux.HandleFunc("/v1/alertmanager/open", func(w http.ResponseWriter, r *http.Request) {
		handleAlert(w, r, cfg, client, tokenReader, metrics)
	})
	return mux
}

func loadConfig() (config, error) {
	cfg := config{
		token:                   strings.TrimSpace(os.Getenv("ALERTMANAGER_WEBHOOK_TOKEN")),
		namespace:               getenv("TARGET_NAMESPACE", "resilience-test"),
		configMap:               getenv("TARGET_CONFIGMAP", "resilience-validation-circuit-breaker"),
		kubeAPI:                 getenv("KUBERNETES_SERVICE_HOST", "kubernetes.default.svc"),
		kubeScheme:              getenv("KUBERNETES_API_SCHEME", "https"),
		certFile:                getenv("TLS_CERT_FILE", "/var/run/receiver-tls/tls.crt"),
		keyFile:                 getenv("TLS_KEY_FILE", "/var/run/receiver-tls/tls.key"),
		serviceAccountTokenFile: getenv("SERVICE_ACCOUNT_TOKEN_FILE", serviceAccountTokenPath),
		serviceAccountCAFile:    getenv("SERVICE_ACCOUNT_CA_FILE", serviceAccountCAPath),
	}
	if len(cfg.token) < 32 || cfg.namespace != "resilience-test" || cfg.configMap != "resilience-validation-circuit-breaker" {
		return config{}, errors.New("invalid fixed-scope receiver configuration")
	}
	if cfg.kubeScheme != "https" && !(cfg.kubeScheme == "http" && getenv("LOCAL_RESILIENCE_TEST", "") == "true") {
		return config{}, errors.New("Kubernetes API must use HTTPS outside explicit local testing")
	}
	return cfg, nil
}

func getenv(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func kubeClient(cfg config) (*http.Client, error) {
	if cfg.kubeScheme == "http" {
		if getenv("LOCAL_RESILIENCE_TEST", "") != "true" {
			return nil, errors.New("plaintext Kubernetes API is restricted to explicit local testing")
		}
		return &http.Client{Timeout: 8 * time.Second}, nil
	}
	ca, err := os.ReadFile(cfg.serviceAccountCAFile)
	if err != nil {
		return nil, err
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(ca) {
		return nil, errors.New("invalid Kubernetes CA")
	}
	return &http.Client{Timeout: 8 * time.Second, Transport: &http.Transport{TLSClientConfig: &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}}}, nil
}

func handleAlert(w http.ResponseWriter, r *http.Request, cfg config, client *http.Client, tokenReader func() ([]byte, error), metrics *receiverMetrics) {
	if r.Method != http.MethodPost || !authorized(r, cfg.token) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	defer r.Body.Close()
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		http.Error(w, "invalid payload", http.StatusBadRequest)
		return
	}
	var payload alertmanagerPayload
	if json.Unmarshal(body, &payload) != nil || payload.Status != "firing" {
		http.Error(w, "invalid alert", http.StatusBadRequest)
		return
	}
	for _, item := range payload.Alerts {
		if item.Status != "firing" || !isAllowed(item) {
			continue
		}
		patched, openErr := openBreaker(cfg, client, tokenReader, item)
		if openErr != nil {
			class := failureClass(openErr)
			metrics.incFailure(item.Labels["alertname"], class)
			log.Printf(`{"service":"%s","event":"breaker.open_failed","alertname":"%s","error_class":"%s"}`, serviceName, item.Labels["alertname"], class)
			http.Error(w, "breaker update failed", http.StatusServiceUnavailable)
			return
		}
		if patched {
			metrics.incSuccess(item.Labels["alertname"])
		} else {
			metrics.incIdempotent(item.Labels["alertname"])
		}
		log.Printf(`{"service":"%s","event":"breaker.opened","alertname":"%s","patched":%t}`, serviceName, item.Labels["alertname"], patched)
		w.WriteHeader(http.StatusAccepted)
		return
	}
	http.Error(w, "alert not allowlisted", http.StatusForbidden)
}

func authorized(r *http.Request, expected string) bool {
	provided := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
	return len(provided) == len(expected) && subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

func isAllowed(a alert) bool {
	return allowedAlerts[a.Labels["alertname"]] &&
		a.Labels["severity"] == "critical" &&
		a.Labels["namespace"] == "resilience-test" &&
		a.Labels["circuit_breaker"] == "open" &&
		a.Labels["resilience.delivery-platform.io/environment"] == "non-production" &&
		a.Fingerprint != ""
}

func openBreaker(cfg config, client *http.Client, tokenReader func() ([]byte, error), a alert) (bool, error) {
	token, err := tokenReader()
	if err != nil {
		return false, fmt.Errorf("service account token: %w", err)
	}
	url := fmt.Sprintf("%s://%s/api/v1/namespaces/%s/configmaps/%s", cfg.kubeScheme, cfg.kubeAPI, cfg.namespace, cfg.configMap)
	req, err := http.NewRequest(http.MethodGet, url, nil)
	if err != nil {
		return false, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	response, err := client.Do(req)
	if err != nil {
		return false, fmt.Errorf("kubernetes transport: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return false, fmt.Errorf("read breaker: %s", response.Status)
	}
	var breaker configMap
	if err := json.NewDecoder(response.Body).Decode(&breaker); err != nil {
		return false, fmt.Errorf("decode breaker: %w", err)
	}
	currentState := breaker.Data["state"]
	if currentState == "open" {
		return false, nil
	}
	if (currentState != "closed" && currentState != "half_open") || breaker.Metadata.ResourceVersion == "" {
		return false, errUnsafeBreakerState
	}
	patches := []map[string]string{
		{"op": "test", "path": "/metadata/resourceVersion", "value": breaker.Metadata.ResourceVersion},
		{"op": "test", "path": "/data/state", "value": currentState},
		{"op": "replace", "path": "/data/state", "value": "open"},
		{"op": "replace", "path": "/data/incident_id", "value": a.Fingerprint},
		{"op": "replace", "path": "/data/opened_at", "value": time.Now().UTC().Format(time.RFC3339)},
		{"op": "replace", "path": "/data/opened_by", "value": serviceName},
		{"op": "replace", "path": "/data/reason", "value": a.Labels["alertname"]},
	}
	encoded, err := json.Marshal(patches)
	if err != nil {
		return false, fmt.Errorf("encode patch: %w", err)
	}
	req, err = http.NewRequest(http.MethodPatch, url, bytes.NewReader(encoded))
	if err != nil {
		return false, err
	}
	req.Header.Set("Authorization", "Bearer "+strings.TrimSpace(string(token)))
	req.Header.Set("Content-Type", "application/json-patch+json")
	response, err = client.Do(req)
	if err != nil {
		return false, fmt.Errorf("kubernetes transport: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode < http.StatusOK || response.StatusCode > http.StatusIMUsed {
		return false, fmt.Errorf("patch breaker: %s", response.Status)
	}
	return true, nil
}

func failureClass(err error) string {
	message := err.Error()
	switch {
	case errors.Is(err, errUnsafeBreakerState):
		return "invalid_breaker_state"
	case strings.Contains(message, "service account token"):
		return "token_read"
	case strings.Contains(message, " 401") || strings.Contains(message, " 403"):
		return "authorization"
	case strings.Contains(message, " 409"):
		return "conflict"
	case strings.Contains(message, "read breaker:") || strings.Contains(message, "patch breaker:"):
		return "kubernetes_api"
	default:
		return "transport"
	}
}
