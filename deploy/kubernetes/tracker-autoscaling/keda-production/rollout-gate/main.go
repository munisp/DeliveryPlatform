package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

type configuration struct {
	namespace                   string
	prometheusURL               string
	prometheusUsernameFile      string
	prometheusPasswordFile      string
	prometheusCAFile            string
	expectedPoolers             float64
	maxBackendConnections       float64
	maxClientWaiting            float64
	maxOldestWaitSeconds        float64
	maxWorkerClientConnections  float64
	requestTimeout              time.Duration
}

type deployment struct {
	Spec struct {
		Strategy struct {
			RollingUpdate struct {
				MaxSurge json.RawMessage `json:"maxSurge"`
			} `json:"rollingUpdate"`
		} `json:"strategy"`
	} `json:"spec"`
	Status struct {
		AvailableReplicas int `json:"availableReplicas"`
		Replicas          int `json:"replicas"`
	} `json:"status"`
}

type promResponse struct {
	Status string `json:"status"`
	Data   struct {
		ResultType string `json:"resultType"`
		Result     []struct {
			Value []json.RawMessage `json:"value"`
		} `json:"result"`
	} `json:"data"`
}

type gateResult struct {
	Name      string  `json:"name"`
	Value     float64 `json:"value"`
	Threshold float64 `json:"threshold"`
	Operator  string  `json:"operator"`
}

func mustEnv(name string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		panic(fmt.Sprintf("%s is required", name))
	}
	return value
}

func parseFloatEnv(name string, fallback float64, min float64, max float64) float64 {
	raw := strings.TrimSpace(os.Getenv(name))
	if raw == "" {
		return fallback
	}
	value, err := strconv.ParseFloat(raw, 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) || value < min || value > max {
		panic(fmt.Sprintf("%s must be a finite number between %v and %v", name, min, max))
	}
	return value
}

func readTrimmed(path string) string {
	contents, err := os.ReadFile(path)
	if err != nil {
		panic(fmt.Sprintf("read %s: %v", path, err))
	}
	value := strings.TrimSpace(string(contents))
	if value == "" {
		panic(fmt.Sprintf("%s is empty", path))
	}
	return value
}

func loadConfig() configuration {
	namespace := mustEnv("POD_NAMESPACE")
	if !strings.Contains(namespace, "prod") && !strings.Contains(namespace, "switchos") {
		panic("POD_NAMESPACE must be the dedicated tracker application namespace")
	}
	parsedURL, err := url.Parse(mustEnv("PROMETHEUS_URL"))
	if err != nil || parsedURL.Scheme != "https" || !strings.HasSuffix(parsedURL.Hostname(), ".svc") {
		panic("PROMETHEUS_URL must be an in-cluster HTTPS service URL")
	}
	return configuration{
		namespace:                  namespace,
		prometheusURL:              strings.TrimSuffix(parsedURL.String(), "/"),
		prometheusUsernameFile:     mustEnv("PROMETHEUS_USERNAME_FILE"),
		prometheusPasswordFile:     mustEnv("PROMETHEUS_PASSWORD_FILE"),
		prometheusCAFile:           mustEnv("PROMETHEUS_CA_FILE"),
		expectedPoolers:            parseFloatEnv("EXPECTED_POOLERS", 4, 1, 32),
		maxBackendConnections:      parseFloatEnv("MAX_BACKEND_CONNECTIONS", 48, 0, 80),
		maxClientWaiting:           parseFloatEnv("MAX_CLIENT_WAITING", 0, 0, 1_000_000),
		maxOldestWaitSeconds:       parseFloatEnv("MAX_OLDEST_WAIT_SECONDS", 0.5, 0, 60),
		maxWorkerClientConnections: parseFloatEnv("MAX_WORKER_CLIENT_CONNECTIONS", 256, 1, 256),
		requestTimeout:             5 * time.Second,
	}
}

func inClusterClient(timeout time.Duration) *http.Client {
	caBytes, err := os.ReadFile("/var/run/secrets/kubernetes.io/serviceaccount/ca.crt")
	if err != nil {
		panic(fmt.Sprintf("read Kubernetes CA: %v", err))
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caBytes) {
		panic("invalid Kubernetes service-account CA")
	}
	return &http.Client{Timeout: timeout, Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: pool}}}
}

func kubernetesURL(path string) string {
	host := mustEnv("KUBERNETES_SERVICE_HOST")
	port := os.Getenv("KUBERNETES_SERVICE_PORT_HTTPS")
	if port == "" {
		port = "443"
	}
	return "https://" + host + ":" + port + path
}

func kubeGet(ctx context.Context, client *http.Client, path string, destination any) (bool, error) {
	token := readTrimmed("/var/run/secrets/kubernetes.io/serviceaccount/token")
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, kubernetesURL(path), nil)
	if err != nil {
		return false, err
	}
	request.Header.Set("Authorization", "Bearer "+token)
	response, err := client.Do(request)
	if err != nil {
		return false, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		return false, nil
	}
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 2048))
		return false, fmt.Errorf("Kubernetes GET %s: status=%d body=%q", path, response.StatusCode, body)
	}
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(destination); err != nil {
		return false, err
	}
	return true, nil
}

func maxSurgeIsZero(raw json.RawMessage) bool {
	value := strings.Trim(string(raw), "\" \n\t")
	return value == "0"
}

func prometheusClient(config configuration) *http.Client {
	caBytes, err := os.ReadFile(config.prometheusCAFile)
	if err != nil {
		panic(fmt.Sprintf("read Prometheus CA: %v", err))
	}
	pool := x509.NewCertPool()
	if !pool.AppendCertsFromPEM(caBytes) {
		panic("invalid Prometheus CA")
	}
	return &http.Client{Timeout: config.requestTimeout, Transport: &http.Transport{TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: pool}}}
}

func queryPrometheus(ctx context.Context, client *http.Client, config configuration, expression string) (float64, error) {
	endpoint := config.prometheusURL + "/api/v1/query"
	parsed, err := url.Parse(endpoint)
	if err != nil {
		return 0, err
	}
	parameters := parsed.Query()
	parameters.Set("query", expression)
	parsed.RawQuery = parameters.Encode()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return 0, err
	}
	request.SetBasicAuth(readTrimmed(config.prometheusUsernameFile), readTrimmed(config.prometheusPasswordFile))
	response, err := client.Do(request)
	if err != nil {
		return 0, err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(response.Body, 2048))
		return 0, fmt.Errorf("Prometheus query status=%d body=%q", response.StatusCode, body)
	}
	var decoded promResponse
	if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&decoded); err != nil {
		return 0, err
	}
	if decoded.Status != "success" || decoded.Data.ResultType != "vector" || len(decoded.Data.Result) != 1 || len(decoded.Data.Result[0].Value) != 2 {
		return 0, errors.New("Prometheus query must return exactly one instant-vector sample")
	}
	var text string
	if err := json.Unmarshal(decoded.Data.Result[0].Value[1], &text); err != nil {
		return 0, errors.New("Prometheus sample value is not a string")
	}
	value, err := strconv.ParseFloat(text, 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return 0, errors.New("Prometheus sample value is not finite")
	}
	return value, nil
}

func expect(results *[]gateResult, name string, value float64, threshold float64, operator string, ok bool) error {
	*results = append(*results, gateResult{Name: name, Value: value, Threshold: threshold, Operator: operator})
	if !ok {
		return fmt.Errorf("gate condition failed: %s value=%v operator=%s threshold=%v", name, value, operator, threshold)
	}
	return nil
}

func run() error {
	config := loadConfig()
	context, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	kube := inClusterClient(config.requestTimeout)
	var tracker deployment
	exists, err := kubeGet(context, kube, "/apis/apps/v1/namespaces/"+url.PathEscape(config.namespace)+"/deployments/vehicle-tracker-ingest", &tracker)
	if err != nil {
		return err
	}
	// On a first installation there is no workload to protect. The gate allows
	// bootstrap so that subsequent syncs inspect the live rollout envelope.
	if !exists {
		fmt.Println(`{"gate":"vehicle-tracker-pre-rollout","outcome":"bootstrap_pass","reason":"tracker deployment does not yet exist"}`)
		return nil
	}
	var pooler deployment
	poolerExists, err := kubeGet(context, kube, "/apis/apps/v1/namespaces/"+url.PathEscape(config.namespace)+"/deployments/vehicle-tracker-pgbouncer", &pooler)
	if err != nil {
		return err
	}
	if !poolerExists {
		return errors.New("PgBouncer deployment is absent")
	}

	results := make([]gateResult, 0, 9)
	if err := expect(&results, "tracker_available_workers", float64(tracker.Status.AvailableReplicas), 16, ">=", tracker.Status.AvailableReplicas >= 16 && tracker.Status.AvailableReplicas <= 64); err != nil {
		return err
	}
	if err := expect(&results, "tracker_desired_workers", float64(tracker.Status.Replicas), 64, "<=", tracker.Status.Replicas >= 16 && tracker.Status.Replicas <= 64); err != nil {
		return err
	}
	if !maxSurgeIsZero(tracker.Spec.Strategy.RollingUpdate.MaxSurge) {
		return fmt.Errorf("gate condition failed: max_surge_zero_overlay_not_observed value=%s", tracker.Spec.Strategy.RollingUpdate.MaxSurge)
	}
	if err := expect(&results, "ready_poolers", float64(pooler.Status.AvailableReplicas), config.expectedPoolers, "=", float64(pooler.Status.AvailableReplicas) == config.expectedPoolers); err != nil {
		return err
	}

	prometheus := prometheusClient(config)
	queries := []struct {
		name      string
		expression string
		threshold float64
		operator  string
		matches   func(float64) bool
	}{
		{"exporter_target_count", `count(pgbouncer_up{namespace="` + config.namespace + `",service="vehicle-tracker-pgbouncer"})`, config.expectedPoolers, "=", func(value float64) bool { return value == config.expectedPoolers }},
		{"exporter_min_up", `min(pgbouncer_up{namespace="` + config.namespace + `",service="vehicle-tracker-pgbouncer"})`, 1, "=", func(value float64) bool { return value == 1 }},
		{"backend_connections", `sum(vehicle_tracker_pgbouncer_server_connections{namespace="` + config.namespace + `"})`, config.maxBackendConnections, "<=", func(value float64) bool { return value <= config.maxBackendConnections }},
		{"queued_clients", `sum(pgbouncer_pools_client_waiting_connections{namespace="` + config.namespace + `",service="vehicle-tracker-pgbouncer"})`, config.maxClientWaiting, "<=", func(value float64) bool { return value <= config.maxClientWaiting }},
		{"oldest_client_wait_seconds", `max(pgbouncer_pools_client_maxwait_seconds{namespace="` + config.namespace + `",service="vehicle-tracker-pgbouncer"})`, config.maxOldestWaitSeconds, "<=", func(value float64) bool { return value <= config.maxOldestWaitSeconds }},
		{"worker_client_ceiling", `sum(vehicle_tracker_pool_max_connections{namespace="` + config.namespace + `"})`, config.maxWorkerClientConnections, "<=", func(value float64) bool { return value <= config.maxWorkerClientConnections }},
	}
	for _, query := range queries {
		value, err := queryPrometheus(context, prometheus, config, query.expression)
		if err != nil {
			return fmt.Errorf("%s: %w", query.name, err)
		}
		if err := expect(&results, query.name, value, query.threshold, query.operator, query.matches(value)); err != nil {
			return err
		}
	}
	encoded, err := json.Marshal(struct {
		Gate     string       `json:"gate"`
		Outcome  string       `json:"outcome"`
		Checks   []gateResult `json:"checks"`
		Observed string       `json:"observed_at"`
	}{"vehicle-tracker-pre-rollout", "pass", results, time.Now().UTC().Format(time.RFC3339)})
	if err != nil {
		return err
	}
	fmt.Println(string(encoded))
	return nil
}

func main() {
	defer func() {
		if recovered := recover(); recovered != nil {
			fmt.Fprintf(os.Stderr, "vehicle_tracker_pre_rollout_gate=FAIL panic=%v\n", recovered)
			os.Exit(2)
		}
	}()
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "vehicle_tracker_pre_rollout_gate=FAIL reason=%v\n", err)
		os.Exit(1)
	}
}
