package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"strings"
	"time"

	_ "github.com/lib/pq"
	"github.com/segmentio/kafka-go"
)

type gatewayService struct {
	db                   *sql.DB
	httpClient           *http.Client
	internalServiceToken string
	serviceName          string
}

type planRequest struct {
	City              string                 `json:"city"`
	CustomerSegment   string                 `json:"customer_segment"`
	Categories        []string               `json:"categories"`
	Request           string                 `json:"request"`
	MembershipSummary map[string]any         `json:"membership_summary"`
	Allocation        map[string]any         `json:"allocation"`
	Forecast          map[string]any         `json:"forecast"`
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
}

type envelope struct {
	Source    string         `json:"source"`
	Timestamp string         `json:"timestamp"`
	EventType string         `json:"event_type"`
	EventID   string         `json:"event_id"`
	Payload   map[string]any `json:"payload"`
}

func main() {
	databaseURL := getenv("DATABASE_URL", "postgresql://ubuntu:ubuntu@127.0.0.1:5432/switchos?sslmode=disable")
	service := &gatewayService{
		db: openDB(databaseURL),
		httpClient: &http.Client{Timeout: 5 * time.Second},
		internalServiceToken: getenv("INTERNAL_SERVICE_TOKEN", "switchos-internal-dev-token-change-before-production"),
		serviceName:          "switchos-local-commerce-gateway",
	}
	if err := service.ensureSchema(); err != nil {
		log.Fatalf("ensure schema: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", service.healthHandler)
	mux.HandleFunc("/plan", service.planHandler)
	mux.HandleFunc("/middleware-status", service.middlewareStatusHandler)

	addr := fmt.Sprintf("%s:%s", getenv("BIND_HOST", "127.0.0.1"), getenv("PORT", "8114"))
	log.Printf("local commerce gateway listening on %s", addr)
	log.Fatal(http.ListenAndServe(addr, mux))
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
	writeJSON(w, http.StatusOK, map[string]any{
		"status":  "healthy",
		"service": s.serviceName,
		"events":  s.middlewareStatus(),
	})
}

func (s *gatewayService) middlewareStatusHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.middlewareStatus())
}

func (s *gatewayService) planHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"})
		return
	}
	if err := s.requireInternalAccess(r); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": err.Error()})
		return
	}

	var request planRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON payload"})
		return
	}
	if strings.TrimSpace(request.Request) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "request is required"})
		return
	}

	eventID := fmt.Sprintf("lcg-%d", time.Now().UnixNano())
	plan := buildPlan(request)
	payload := map[string]any{
		"city":               request.City,
		"customer_segment":   request.CustomerSegment,
		"categories":         request.Categories,
		"request":            request.Request,
		"membership_summary": request.MembershipSummary,
		"allocation":         request.Allocation,
		"forecast":           request.Forecast,
		"action_plan":        plan,
	}

	if err := s.storeEvent(eventID, "local_commerce_plan_created", request, payload); err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	if err := s.publishEnvelope(envelope{
		Source:    s.serviceName,
		Timestamp: time.Now().UTC().Format(time.RFC3339),
		EventType: "local_commerce_plan_created",
		EventID:   eventID,
		Payload:   payload,
	}); err != nil {
		payload["publish_warning"] = err.Error()
	}

	strategy := "cross_category_concierge"
	if request.Forecast != nil || request.Allocation != nil {
		strategy = "cross_category_concierge_with_retail_ops"
	}
	writeJSON(w, http.StatusOK, planResponse{
		Service:    s.serviceName,
		Strategy:   strategy,
		EventID:    eventID,
		ActionPlan: plan,
		Middleware: s.middlewareStatus(),
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

func (s *gatewayService) storeEvent(eventID string, eventType string, request planRequest, payload map[string]any) error {
	categories, _ := json.Marshal(request.Categories)
	body, _ := json.Marshal(payload)
	_, err := s.db.Exec(`
		INSERT INTO local_commerce_gateway_events (event_id, event_type, customer_segment, city, categories, request_text, payload)
		VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb)
	`, eventID, eventType, nullable(request.CustomerSegment), nullable(request.City), string(categories), request.Request, string(body))
	return err
}

func (s *gatewayService) publishEnvelope(evt envelope) error {
	if err := s.publishToDapr(evt); err != nil {
		return err
	}
	if err := s.publishToKafkaCompatible(getenv("KAFKA_BROKERS", ""), getenv("KAFKA_LOCAL_COMMERCE_TOPIC", ""), evt, "kafka"); err != nil {
		return err
	}
	if err := s.publishToKafkaCompatible(getenv("FLUVIO_KAFKA_BROKERS", ""), getenv("FLUVIO_LOCAL_COMMERCE_TOPIC", ""), evt, "fluvio"); err != nil {
		return err
	}
	if err := s.publishToTemporal(evt); err != nil {
		return err
	}
	return nil
}

func (s *gatewayService) publishToDapr(evt envelope) error {
	daprPort := strings.TrimSpace(getenv("DAPR_HTTP_PORT", ""))
	pubsubName := strings.TrimSpace(getenv("DAPR_PUBSUB_NAME", ""))
	topicName := strings.TrimSpace(getenv("DAPR_LOCAL_COMMERCE_TOPIC", ""))
	if daprPort == "" || pubsubName == "" || topicName == "" {
		return nil
	}
	body, _ := json.Marshal(evt)
	request, err := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%s/v1.0/publish/%s/%s", daprPort, pubsubName, topicName), bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := s.httpClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode >= 400 {
		return fmt.Errorf("dapr publish returned status %d", response.StatusCode)
	}
	return nil
}

func (s *gatewayService) publishToKafkaCompatible(brokersRaw string, topic string, evt envelope, brokerName string) error {
	brokers := splitAndTrim(brokersRaw)
	if len(brokers) == 0 || strings.TrimSpace(topic) == "" {
		return nil
	}
	body, _ := json.Marshal(evt)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	writer := &kafka.Writer{Addr: kafka.TCP(brokers...), Topic: topic, RequiredAcks: kafka.RequireAll, Balancer: &kafka.LeastBytes{}}
	defer writer.Close()
	return writer.WriteMessages(ctx, kafka.Message{
		Key:   []byte(evt.EventID),
		Value: body,
		Time:  time.Now().UTC(),
		Headers: []kafka.Header{{Key: "event-type", Value: []byte(evt.EventType)}, {Key: "broker", Value: []byte(brokerName)}},
	})
}

func (s *gatewayService) publishToTemporal(evt envelope) error {
	temporalBridgeURL := strings.TrimSpace(getenv("TEMPORAL_BRIDGE_URL", ""))
	taskQueue := strings.TrimSpace(getenv("TEMPORAL_TASK_QUEUE", ""))
	if temporalBridgeURL == "" && taskQueue == "" {
		return nil
	}
	payload := map[string]any{"taskQueue": taskQueue, "event": evt}
	body, _ := json.Marshal(payload)
	if temporalBridgeURL != "" {
		request, err := http.NewRequest(http.MethodPost, strings.TrimRight(temporalBridgeURL, "/")+"/local-commerce/workflows", bytes.NewReader(body))
		if err != nil {
			return err
		}
		request.Header.Set("Content-Type", "application/json")
		response, err := s.httpClient.Do(request)
		if err != nil {
			return err
		}
		defer response.Body.Close()
		if response.StatusCode >= 400 {
			return fmt.Errorf("temporal bridge returned status %d", response.StatusCode)
		}
	}
	return nil
}

func (s *gatewayService) middlewareStatus() map[string]any {
	return map[string]any{
		"dapr": map[string]any{"configured": getenv("DAPR_HTTP_PORT", "") != "" && getenv("DAPR_PUBSUB_NAME", "") != "" && getenv("DAPR_LOCAL_COMMERCE_TOPIC", "") != ""},
		"kafka": map[string]any{"configured": getenv("KAFKA_BROKERS", "") != "" && getenv("KAFKA_LOCAL_COMMERCE_TOPIC", "") != ""},
		"fluvio": map[string]any{"configured": getenv("FLUVIO_KAFKA_BROKERS", "") != "" && getenv("FLUVIO_LOCAL_COMMERCE_TOPIC", "") != ""},
		"temporal": map[string]any{"configured": getenv("TEMPORAL_TASK_QUEUE", "") != "" || getenv("TEMPORAL_BRIDGE_URL", "") != ""},
	}
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

func getenv(name string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback
	}
	return value
}
