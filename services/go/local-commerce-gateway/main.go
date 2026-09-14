package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	_ "github.com/lib/pq"

	sharedmetrics "switchos-metrics"
	"switchos-resilience"
	"github.com/segmentio/kafka-go"
)

type gatewayService struct {
	db                   *sql.DB
	httpClient           *http.Client
	internalServiceToken string
	serviceName          string
}

type planRequest struct {
	City              string         `json:"city"`
	CustomerSegment   string         `json:"customer_segment"`
	Categories        []string       `json:"categories"`
	Request           string         `json:"request"`
	MembershipSummary map[string]any `json:"membership_summary"`
	Allocation        map[string]any `json:"allocation"`
	Forecast          map[string]any `json:"forecast"`
	PayloadMetrics    map[string]any `json:"payload_metrics"`
	// IdempotencyKey is the partition-agnostic broker event id supplied by
	// event-driven callers; when present the plan is recorded and published
	// at most once per key.
	IdempotencyKey string `json:"idempotency_key,omitempty"`
}

type planStep struct {
	Step    string `json:"step"`
	Action  string `json:"action"`
	Target  string `json:"target"`
	Urgency string `json:"urgency"`
}

type planResponse struct {
	Service    string         `json:"service"`
	Strategy   string         `json:"strategy"`
	EventID    string         `json:"event_id"`
	ActionPlan []planStep     `json:"action_plan"`
	Middleware map[string]any `json:"middleware"`
	Metrics    map[string]any `json:"metrics"`
	Idempotent bool           `json:"idempotent,omitempty"`
}

type logisticsControlTowerResponse struct {
	Service         string         `json:"service"`
	Status          string         `json:"status"`
	RecentPlanCount int            `json:"recent_plan_count"`
	Middleware      map[string]any `json:"middleware"`
	Metrics         map[string]any `json:"metrics"`
	Recommendations []string       `json:"recommendations"`
}

type envelope struct {
	Source    string         `json:"source"`
	Timestamp string         `json:"timestamp"`
	EventType string         `json:"event_type"`
	EventID   string         `json:"event_id"`
	Payload   map[string]any `json:"payload"`
}

func main() {
	if err := validateBootConfiguration(); err != nil {
		log.Fatal(err)
	}
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	internalServiceToken := strings.TrimSpace(os.Getenv("INTERNAL_SERVICE_TOKEN"))
	service := &gatewayService{
		db:                   openDB(databaseURL),
		httpClient: resilience.NewClient(5*time.Second,
			resilience.RetryPolicy{MaxAttempts: 3, BackoffBase: 100 * time.Millisecond, BackoffMax: 2 * time.Second},
			resilience.BreakerConfig{FailureThreshold: 5, ResetTimeout: 30 * time.Second, HalfOpenMaxProbes: 1}),
		internalServiceToken: internalServiceToken,
		serviceName:          "switchos-local-commerce-gateway",
	}
	if err := service.db.Ping(); err != nil {
		log.Fatalf("ping database: %v", err)
	}
	if err := service.ensureSchema(); err != nil {
		log.Fatalf("ensure schema: %v", err)
	}

	httpMetrics := sharedmetrics.New("local-commerce-gateway", getenv("SERVICE_VERSION", ""))
	mux := http.NewServeMux()
	mux.HandleFunc("/health", service.healthHandler)
	mux.Handle("/metrics", httpMetrics.Handler())
	mux.HandleFunc("/plan", service.planHandler)
	mux.HandleFunc("/middleware-status", service.middlewareStatusHandler)
	mux.HandleFunc("/logistics-control-tower", service.logisticsControlTowerHandler)

	addr := fmt.Sprintf("%s:%s", getenv("BIND_HOST", "127.0.0.1"), getenv("PORT", "8114"))
	server := &http.Server{Addr: addr, Handler: httpMetrics.Middleware(mux), ReadHeaderTimeout: 5 * time.Second}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	serverErrors := make(chan error, 1)
	go func() {
		log.Printf("local commerce gateway listening on %s", addr)
		serverErrors <- server.ListenAndServe()
	}()

	select {
	case err := <-serverErrors:
		if err != nil && err != http.ErrServerClosed {
			log.Fatalf("local commerce gateway server failed: %v", err)
		}
	case <-ctx.Done():
		log.Printf("shutdown signal received; draining in-flight requests")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("graceful shutdown failed: %v", err)
		}
		if err := <-serverErrors; err != nil && err != http.ErrServerClosed {
			log.Fatalf("local commerce gateway server failed: %v", err)
		}
	}
}

func openDB(databaseURL string) *sql.DB {
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	db.SetMaxOpenConns(4)
	db.SetConnMaxLifetime(15 * time.Minute)
	return db
}

func (s *gatewayService) ensureSchema() error {
	_, err := s.db.Exec(`
		CREATE TABLE IF NOT EXISTS local_commerce_gateway_events (
			id BIGSERIAL PRIMARY KEY,
			event_id TEXT NOT NULL UNIQUE,
			event_type TEXT NOT NULL,
			customer_segment TEXT,
			city TEXT,
			categories JSONB NOT NULL DEFAULT '[]'::jsonb,
			request_text TEXT,
			payload JSONB NOT NULL DEFAULT '{}'::jsonb,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)
	`)
	return err
}

func (s *gatewayService) healthHandler(w http.ResponseWriter, r *http.Request) {
	traceID := requestTraceID(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"status":   "healthy",
		"service":  s.serviceName,
		"events":   s.middlewareStatus(),
		"trace_id": traceID,
	})
}

func (s *gatewayService) middlewareStatusHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.middlewareStatus())
}

func (s *gatewayService) logisticsControlTowerHandler(w http.ResponseWriter, r *http.Request) {
	traceID := requestTraceID(r)
	if err := s.requireInternalAccess(r); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": err.Error(), "trace_id": traceID})
		return
	}

	recentPlanCount, err := s.countRecentPlans(6 * time.Hour)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error(), "trace_id": traceID})
		return
	}
	middleware := s.middlewareStatus()
	recommendations := buildControlTowerRecommendations(middleware, recentPlanCount)
	status := "healthy"
	if recentPlanCount == 0 {
		status = "watch"
	}
	if hasUnconfiguredCriticalMiddleware(middleware) {
		status = "watch"
	}

	writeJSON(w, http.StatusOK, logisticsControlTowerResponse{
		Service:         s.serviceName,
		Status:          status,
		RecentPlanCount: recentPlanCount,
		Middleware:      middleware,
		Metrics: map[string]any{
			"trace_id":               traceID,
			"evaluated_window_hours": 6,
		},
		Recommendations: recommendations,
	})
}

func (s *gatewayService) planHandler(w http.ResponseWriter, r *http.Request) {
	startedAt := time.Now()
	traceID := requestTraceID(r)
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed", "trace_id": traceID})
		return
	}
	if err := s.requireInternalAccess(r); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": err.Error(), "trace_id": traceID})
		return
	}

	var request planRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON payload", "trace_id": traceID})
		return
	}
	if strings.TrimSpace(request.Request) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "request is required", "trace_id": traceID})
		return
	}

	// Consumer-side idempotency for at-least-once broker/event delivery: when
	// the caller supplies an idempotency key (payload field or header), the
	// event id becomes a deterministic digest of that key and the event row
	// insert doubles as the processed-event claim. A redelivered key replays
	// the stored plan and is not re-published to downstream middleware.
	idempotencyKey := strings.TrimSpace(request.IdempotencyKey)
	if idempotencyKey == "" {
		idempotencyKey = strings.TrimSpace(r.Header.Get("X-Idempotency-Key"))
	}
	eventID := fmt.Sprintf("lcg-%d", time.Now().UnixNano())
	if idempotencyKey != "" {
		if len(idempotencyKey) > 160 {
			writeJSON(w, http.StatusBadRequest, map[string]any{"error": "idempotency_key is too long", "trace_id": traceID})
			return
		}
		eventID = idempotentEventID(idempotencyKey)
	}
	plan := buildPlan(request)
	payloadMetrics := summarizeRequestPayload(request)
	payload := map[string]any{
		"city":               request.City,
		"customer_segment":   request.CustomerSegment,
		"categories":         request.Categories,
		"request":            request.Request,
		"membership_summary": request.MembershipSummary,
		"allocation":         request.Allocation,
		"forecast":           request.Forecast,
		"action_plan":        plan,
		"payload_metrics":    payloadMetrics,
		"trace_id":           traceID,
	}

	storeStartedAt := time.Now()
	stored, err := s.storeEvent(eventID, "local_commerce_plan_created", request, payload)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error(), "trace_id": traceID})
		return
	}
	storeDuration := time.Since(storeStartedAt)
	if !stored {
		// Duplicate delivery of an idempotency-keyed event: replay the stored
		// plan without re-publishing downstream.
		storedPayload, loadErr := s.loadEventPayload(eventID)
		if loadErr != nil {
			writeJSON(w, http.StatusInternalServerError, map[string]any{"error": loadErr.Error(), "trace_id": traceID})
			return
		}
		storedPlan := decodeStoredPlan(storedPayload["action_plan"])
		storedStrategy := "cross_category_concierge"
		if request.Forecast != nil || request.Allocation != nil {
			storedStrategy = "cross_category_concierge_with_retail_ops"
		}
		writeJSON(w, http.StatusOK, planResponse{
			Service:    s.serviceName,
			Strategy:   storedStrategy,
			EventID:    eventID,
			ActionPlan: storedPlan,
			Middleware: s.middlewareStatus(),
			Metrics: map[string]any{
				"trace_id":   traceID,
				"timings_ms": map[string]any{"store_event": roundDurationMs(storeDuration), "total": roundDurationMs(time.Since(startedAt))},
			},
			Idempotent: true,
		})
		return
	}
	publishMetrics := s.publishEnvelope(envelope{
		Source:    s.serviceName,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		EventType: "local_commerce_plan_created",
		EventID:   eventID,
		Payload:   payload,
	})
	if publishMetrics.Error != "" {
		payload["publish_warning"] = publishMetrics.Error
	}

	strategy := "cross_category_concierge"
	if request.Forecast != nil || request.Allocation != nil {
		strategy = "cross_category_concierge_with_retail_ops"
	}
	responseMetrics := map[string]any{
		"trace_id": traceID,
		"payload":  payloadMetrics,
		"timings_ms": map[string]any{
			"store_event":   roundDurationMs(storeDuration),
			"publish_total": publishMetrics.TotalDurationMs,
			"total":         roundDurationMs(time.Since(startedAt)),
		},
		"middleware_publish": publishMetrics.ByTarget,
	}
	trace(traceID, "gateway.plan.complete", responseMetrics)
	writeJSON(w, http.StatusOK, planResponse{
		Service:    s.serviceName,
		Strategy:   strategy,
		EventID:    eventID,
		ActionPlan: plan,
		Middleware: s.middlewareStatus(),
		Metrics:    responseMetrics,
	})
}

func buildPlan(request planRequest) []planStep {
	categories := normalizeCategories(request.Categories)
	steps := []planStep{
		{Step: "triage", Action: "Interpret the cross-category request and bind it to the best operational lane.", Target: firstOrDefault(categories, "delivery"), Urgency: "high"},
		{Step: "loyalty", Action: "Apply unified benefits, credits, and service-level entitlements before quoting next actions.", Target: request.CustomerSegment, Urgency: "medium"},
	}

	if request.Forecast != nil || request.Allocation != nil {
		steps = append(steps, planStep{Step: "retail_ops", Action: "Use restock and warehouse signals to protect fill rate and ETA honesty.", Target: "instant_retail", Urgency: "high"})
	}
	if contains(categories, "travel") || contains(categories, "business") {
		steps = append(steps, planStep{Step: "travel", Action: "Convert the request into an executable itinerary, approval, or reservation-ready plan.", Target: "business_travel", Urgency: "medium"})
	}
	if contains(categories, "mobility") || contains(categories, "rideshare") {
		steps = append(steps, planStep{Step: "mobility", Action: "Blend ride, courier, and scheduled-transfer options into one promised journey.", Target: "mobility_ops", Urgency: "medium"})
	}
	steps = append(steps, planStep{Step: "follow_through", Action: "Record the plan and hand the next action to the correct channel or workflow runtime.", Target: "middleware_fanout", Urgency: "high"})
	return steps
}

// storeEvent inserts the event row as the processed-event claim. It returns
// stored=false (without error) when the event id was already recorded by an
// earlier delivery of the same idempotency key.
func (s *gatewayService) storeEvent(eventID string, eventType string, request planRequest, payload map[string]any) (bool, error) {
	categories, _ := json.Marshal(request.Categories)
	body, _ := json.Marshal(payload)
	var storedID string
	err := s.db.QueryRow(`
		INSERT INTO local_commerce_gateway_events (event_id, event_type, customer_segment, city, categories, request_text, payload)
		VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb)
		ON CONFLICT (event_id) DO NOTHING
		RETURNING event_id
	`, eventID, eventType, nullable(request.CustomerSegment), nullable(request.City), string(categories), request.Request, string(body)).Scan(&storedID)
	if err == sql.ErrNoRows {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	return true, nil
}

func (s *gatewayService) loadEventPayload(eventID string) (map[string]any, error) {
	var raw string
	if err := s.db.QueryRow(`SELECT payload::text FROM local_commerce_gateway_events WHERE event_id = $1`, eventID).Scan(&raw); err != nil {
		return nil, err
	}
	var payload map[string]any
	if err := json.Unmarshal([]byte(raw), &payload); err != nil {
		return nil, err
	}
	return payload, nil
}

// idempotentEventID maps a caller-supplied idempotency key to a deterministic,
// bounded event id so redeliveries collide on the event-row primary key.
func idempotentEventID(idempotencyKey string) string {
	digest := sha256.Sum256([]byte("local-commerce-plan:" + idempotencyKey))
	return fmt.Sprintf("lcg-idem-%x", digest[:16])
}

func decodeStoredPlan(raw any) []planStep {
	encoded, err := json.Marshal(raw)
	if err != nil {
		return nil
	}
	var steps []planStep
	if err := json.Unmarshal(encoded, &steps); err != nil {
		return nil
	}
	return steps
}

func (s *gatewayService) countRecentPlans(window time.Duration) (int, error) {
	var count int
	err := s.db.QueryRow(`
		SELECT COUNT(*)
		FROM local_commerce_gateway_events
		WHERE event_type = 'local_commerce_plan_created' AND created_at >= NOW() - ($1::text)::interval
	`, fmt.Sprintf("%d seconds", int(window.Seconds()))).Scan(&count)
	return count, err
}

type publishMetrics struct {
	TotalDurationMs float64        `json:"total_duration_ms"`
	ByTarget        map[string]any `json:"by_target"`
	Error           string         `json:"error,omitempty"`
}

func (s *gatewayService) publishEnvelope(evt envelope) publishMetrics {
	startedAt := time.Now()
	metrics := publishMetrics{ByTarget: map[string]any{}}
	if duration, err := s.publishToDapr(evt); err != nil {
		metrics.TotalDurationMs = roundDurationMs(time.Since(startedAt))
		metrics.ByTarget["dapr"] = map[string]any{"duration_ms": duration, "ok": false, "error": err.Error()}
		metrics.Error = err.Error()
		return metrics
	} else {
		metrics.ByTarget["dapr"] = map[string]any{"duration_ms": duration, "ok": true}
	}
	if duration, err := s.publishToKafkaCompatible(getenv("KAFKA_BROKERS", ""), getenv("KAFKA_LOCAL_COMMERCE_TOPIC", ""), evt, "kafka"); err != nil {
		metrics.TotalDurationMs = roundDurationMs(time.Since(startedAt))
		metrics.ByTarget["kafka"] = map[string]any{"duration_ms": duration, "ok": false, "error": err.Error()}
		metrics.Error = err.Error()
		return metrics
	} else {
		metrics.ByTarget["kafka"] = map[string]any{"duration_ms": duration, "ok": true}
	}
	if duration, err := s.publishToKafkaCompatible(getenv("FLUVIO_KAFKA_BROKERS", ""), getenv("FLUVIO_LOCAL_COMMERCE_TOPIC", ""), evt, "fluvio"); err != nil {
		metrics.TotalDurationMs = roundDurationMs(time.Since(startedAt))
		metrics.ByTarget["fluvio"] = map[string]any{"duration_ms": duration, "ok": false, "error": err.Error()}
		metrics.Error = err.Error()
		return metrics
	} else {
		metrics.ByTarget["fluvio"] = map[string]any{"duration_ms": duration, "ok": true}
	}
	if duration, err := s.publishToTemporal(evt); err != nil {
		metrics.TotalDurationMs = roundDurationMs(time.Since(startedAt))
		metrics.ByTarget["temporal"] = map[string]any{"duration_ms": duration, "ok": false, "error": err.Error()}
		metrics.Error = err.Error()
		return metrics
	} else {
		metrics.ByTarget["temporal"] = map[string]any{"duration_ms": duration, "ok": true}
	}
	metrics.TotalDurationMs = roundDurationMs(time.Since(startedAt))
	return metrics
}

func (s *gatewayService) publishToDapr(evt envelope) (float64, error) {
	startedAt := time.Now()
	daprPort := strings.TrimSpace(getenv("DAPR_HTTP_PORT", ""))
	pubsubName := strings.TrimSpace(getenv("DAPR_PUBSUB_NAME", ""))
	topicName := strings.TrimSpace(getenv("DAPR_LOCAL_COMMERCE_TOPIC", ""))
	if daprPort == "" || pubsubName == "" || topicName == "" {
		return roundDurationMs(time.Since(startedAt)), nil
	}
	body, _ := json.Marshal(evt)
	request, err := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%s/v1.0/publish/%s/%s", daprPort, pubsubName, topicName), bytes.NewReader(body))
	if err != nil {
		return roundDurationMs(time.Since(startedAt)), err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := s.httpClient.Do(request)
	if err != nil {
		return roundDurationMs(time.Since(startedAt)), err
	}
	defer response.Body.Close()
	if response.StatusCode >= 400 {
		return roundDurationMs(time.Since(startedAt)), fmt.Errorf("dapr publish returned status %d", response.StatusCode)
	}
	return roundDurationMs(time.Since(startedAt)), nil
}

func (s *gatewayService) publishToKafkaCompatible(brokersRaw string, topic string, evt envelope, brokerName string) (float64, error) {
	startedAt := time.Now()
	brokers := splitAndTrim(brokersRaw)
	if len(brokers) == 0 || strings.TrimSpace(topic) == "" {
		return roundDurationMs(time.Since(startedAt)), nil
	}
	body, _ := json.Marshal(evt)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	writer := &kafka.Writer{Addr: kafka.TCP(brokers...), Topic: topic, RequiredAcks: kafka.RequireAll, Balancer: &kafka.LeastBytes{}}
	defer writer.Close()
	err := writer.WriteMessages(ctx, kafka.Message{
		Key:     []byte(evt.EventID),
		Value:   body,
		Time:    time.Now().UTC(),
		Headers: []kafka.Header{{Key: "event-type", Value: []byte(evt.EventType)}, {Key: "broker", Value: []byte(brokerName)}},
	})
	return roundDurationMs(time.Since(startedAt)), err
}

func (s *gatewayService) publishToTemporal(evt envelope) (float64, error) {
	startedAt := time.Now()
	temporalBridgeURL := strings.TrimSpace(getenv("TEMPORAL_BRIDGE_URL", ""))
	taskQueue := strings.TrimSpace(getenv("TEMPORAL_TASK_QUEUE", ""))
	if temporalBridgeURL == "" && taskQueue == "" {
		return roundDurationMs(time.Since(startedAt)), nil
	}
	payload := map[string]any{"taskQueue": taskQueue, "event": evt}
	body, _ := json.Marshal(payload)
	if temporalBridgeURL != "" {
		request, err := http.NewRequest(http.MethodPost, strings.TrimRight(temporalBridgeURL, "/")+"/local-commerce/workflows", bytes.NewReader(body))
		if err != nil {
			return roundDurationMs(time.Since(startedAt)), err
		}
		request.Header.Set("Content-Type", "application/json")
		response, err := s.httpClient.Do(request)
		if err != nil {
			return roundDurationMs(time.Since(startedAt)), err
		}
		defer response.Body.Close()
		if response.StatusCode >= 400 {
			return roundDurationMs(time.Since(startedAt)), fmt.Errorf("temporal bridge returned status %d", response.StatusCode)
		}
	}
	return roundDurationMs(time.Since(startedAt)), nil
}

func (s *gatewayService) middlewareStatus() map[string]any {
	return map[string]any{
		"dapr":     map[string]any{"configured": getenv("DAPR_HTTP_PORT", "") != "" && getenv("DAPR_PUBSUB_NAME", "") != "" && getenv("DAPR_LOCAL_COMMERCE_TOPIC", "") != ""},
		"kafka":    map[string]any{"configured": getenv("KAFKA_BROKERS", "") != "" && getenv("KAFKA_LOCAL_COMMERCE_TOPIC", "") != ""},
		"fluvio":   map[string]any{"configured": getenv("FLUVIO_KAFKA_BROKERS", "") != "" && getenv("FLUVIO_LOCAL_COMMERCE_TOPIC", "") != ""},
		"temporal": map[string]any{"configured": getenv("TEMPORAL_TASK_QUEUE", "") != "" || getenv("TEMPORAL_BRIDGE_URL", "") != ""},
	}
}

func hasUnconfiguredCriticalMiddleware(middleware map[string]any) bool {
	for _, key := range []string{"dapr", "temporal"} {
		entry, ok := middleware[key].(map[string]any)
		if !ok {
			continue
		}
		configured, _ := entry["configured"].(bool)
		if !configured {
			return true
		}
	}
	return false
}

func buildControlTowerRecommendations(middleware map[string]any, recentPlanCount int) []string {
	recommendations := []string{}
	if recentPlanCount == 0 {
		recommendations = append(recommendations, "No recent local-commerce plans were recorded in the last six hours; verify upstream request flow and operator demand routing.")
	}
	for target, raw := range middleware {
		entry, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		configured, _ := entry["configured"].(bool)
		if !configured {
			recommendations = append(recommendations, fmt.Sprintf("%s is not configured; middleware fan-out resilience remains limited until this target is enabled.", strings.ToUpper(target)))
		}
	}
	if len(recommendations) == 0 {
		recommendations = append(recommendations, "Planning event flow and critical middleware configuration look healthy for the current local stack.")
	}
	return recommendations
}

func (s *gatewayService) requireInternalAccess(r *http.Request) error {
	if s.internalServiceToken == "" {
		return nil
	}
	if r.Header.Get("X-Internal-Service-Token") != s.internalServiceToken {
		return fmt.Errorf("invalid internal service token")
	}
	return nil
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func splitAndTrim(raw string) []string {
	parts := strings.Split(raw, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func normalizeCategories(values []string) []string {
	if len(values) == 0 {
		return []string{"delivery", "retail", "travel"}
	}
	result := make([]string, 0, len(values))
	for _, value := range values {
		trimmed := strings.ToLower(strings.TrimSpace(value))
		if trimmed != "" {
			result = append(result, trimmed)
		}
	}
	if len(result) == 0 {
		return []string{"delivery"}
	}
	return result
}

func firstOrDefault(values []string, fallback string) string {
	if len(values) == 0 {
		return fallback
	}
	return values[0]
}

func contains(values []string, target string) bool {
	for _, value := range values {
		if strings.EqualFold(strings.TrimSpace(value), target) {
			return true
		}
	}
	return false
}

func nullable(value string) any {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return trimmed
}

func summarizeRequestPayload(request planRequest) map[string]any {
	requestChars := len(strings.TrimSpace(request.Request))
	categories := len(request.Categories)
	membershipKeys := len(request.MembershipSummary)
	forecastKeys := len(request.Forecast)
	allocationKeys := len(request.Allocation)
	return map[string]any{
		"request_chars":            requestChars,
		"category_count":           categories,
		"membership_keys":          membershipKeys,
		"forecast_keys":            forecastKeys,
		"allocation_keys":          allocationKeys,
		"provided_payload_metrics": request.PayloadMetrics,
	}
}

func requestTraceID(r *http.Request) string {
	traceID := strings.TrimSpace(r.Header.Get("X-Trace-Id"))
	if traceID != "" {
		return traceID
	}
	return fmt.Sprintf("lcg-%d", time.Now().UnixNano())
}

func roundDurationMs(duration time.Duration) float64 {
	return float64(duration.Microseconds()) / 1000
}

func trace(traceID string, event string, payload map[string]any) {
	log.Printf("[local-commerce-gateway-trace] event=%s trace_id=%s payload=%v", event, traceID, payload)
}

func getenv(name string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return value
}
