package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strings"
	"syscall"
	"time"

	_ "github.com/lib/pq"
)

type Channel string

const (
	ChannelSMS   Channel = "sms"
	ChannelEmail Channel = "email"
	ChannelPush  Channel = "push"
	ChannelVoice Channel = "voice"
)

type DispatchRequest struct {
	Type      string            `json:"type"`
	Recipient Recipient         `json:"recipient"`
	Payload   map[string]any    `json:"payload"`
	Channels  []Channel         `json:"channels"`
	Metadata  map[string]string `json:"metadata"`
}

type Recipient struct {
	Phone string `json:"phone"`
	Email string `json:"email"`
	Name  string `json:"name"`
	Token string `json:"token"`
}

type DispatchResult struct {
	Success      bool    `json:"success"`
	Channel      Channel `json:"channel"`
	MessageID    string  `json:"messageId,omitempty"`
	Error        string  `json:"error,omitempty"`
	Provider     string  `json:"provider"`
	AttemptCount int     `json:"attemptCount,omitempty"`
	EscalatedTo  string  `json:"escalatedTo,omitempty"`
	RenderedBody string  `json:"renderedBody,omitempty"`
}

type DispatchResponse struct {
	Accepted     bool             `json:"accepted"`
	Results      []DispatchResult `json:"results"`
	DurationMS   int64            `json:"durationMs"`
	RequestID    string           `json:"requestId,omitempty"`
	FallbackUsed bool             `json:"fallbackUsed,omitempty"`
	DegradedMode bool             `json:"degradedMode,omitempty"`
	Idempotent   bool             `json:"idempotent,omitempty"`
}

type DeadLetterRecord struct {
	RequestID string            `json:"requestId"`
	Reason    string            `json:"reason"`
	Type      string            `json:"type"`
	Channels  []Channel         `json:"channels"`
	Metadata  map[string]string `json:"metadata,omitempty"`
	CreatedAt string            `json:"createdAt"`
}

type DispatchMetrics struct {
	SuccessByChannel map[string]uint64 `json:"successByChannel"`
	FailureByChannel map[string]uint64 `json:"failureByChannel"`
	FallbackRequests uint64            `json:"fallbackRequests"`
	DeadLetters      uint64            `json:"deadLetters"`
	TotalRequests    uint64            `json:"totalRequests"`
	LastLatencyMS    int64             `json:"lastLatencyMs"`
}

type Service struct {
	db                   *sql.DB
	httpClient           *http.Client
	internalServiceToken string
	smsProviderURL       string
	emailProviderURL     string
	pushProviderURL      string
	voiceProviderURL     string
}

type providerPayload struct {
	RequestID    string            `json:"requestId"`
	Type         string            `json:"type"`
	Channel      string            `json:"channel"`
	Recipient    Recipient         `json:"recipient"`
	RenderedBody string            `json:"renderedBody"`
	Metadata     map[string]string `json:"metadata,omitempty"`
	Payload      map[string]any    `json:"payload,omitempty"`
}

var (
	port     = getEnv("PORT", "8099")
	bindHost = getEnv("BIND_HOST", "127.0.0.1")
)

func main() {
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		log.Fatal("DATABASE_URL must be explicitly configured")
	}
	internalServiceToken := strings.TrimSpace(os.Getenv("INTERNAL_SERVICE_TOKEN"))
	if len(internalServiceToken) < 32 {
		log.Fatal("INTERNAL_SERVICE_TOKEN must be explicitly configured with at least 32 characters")
	}
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		log.Fatalf("open database: %v", err)
	}
	defer db.Close()
	if err := db.Ping(); err != nil {
		log.Fatalf("ping database: %v", err)
	}

	service := &Service{
		db:                   db,
		httpClient:           &http.Client{Timeout: 20 * time.Second},
		internalServiceToken: internalServiceToken,
		smsProviderURL:       strings.TrimSpace(os.Getenv("SMS_PROVIDER_URL")),
		emailProviderURL:     strings.TrimSpace(os.Getenv("EMAIL_PROVIDER_URL")),
		pushProviderURL:      strings.TrimSpace(os.Getenv("PUSH_PROVIDER_URL")),
		voiceProviderURL:     strings.TrimSpace(os.Getenv("VOICE_PROVIDER_URL")),
	}
	if err := service.ensureSchema(); err != nil {
		log.Fatalf("ensure schema: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/metrics", service.metricsHandler)
	mux.HandleFunc("/health", service.healthHandler)
	mux.HandleFunc("/business-health", service.businessHealthHandler)
	mux.HandleFunc("/dead-letters", service.deadLettersHandler)
	mux.HandleFunc("/dispatch", service.dispatchHandler)

	server := &http.Server{
		Addr:              fmt.Sprintf("%s:%s", bindHost, port),
		Handler:           loggingMiddleware(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	serverErrors := make(chan error, 1)
	go func() {
		log.Printf("Starting notification dispatcher on %s:%s", bindHost, port)
		serverErrors <- server.ListenAndServe()
	}()

	select {
	case err := <-serverErrors:
		if err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	case <-ctx.Done():
		log.Printf("shutdown signal received; draining in-flight requests")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("graceful shutdown failed: %v", err)
		}
		if err := <-serverErrors; err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}
}

func (s *Service) ensureSchema() error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS notification_dispatches (
			request_id TEXT PRIMARY KEY,
			dispatch_type TEXT NOT NULL,
			recipient_phone TEXT,
			recipient_email TEXT,
			recipient_name TEXT,
			recipient_token TEXT,
			payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
			metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
			channels_json JSONB NOT NULL DEFAULT '[]'::jsonb,
			response_json JSONB,
			accepted BOOLEAN NOT NULL DEFAULT FALSE,
			fallback_used BOOLEAN NOT NULL DEFAULT FALSE,
			degraded_mode BOOLEAN NOT NULL DEFAULT FALSE,
			duration_ms BIGINT NOT NULL DEFAULT 0,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS notification_attempts (
			id BIGSERIAL PRIMARY KEY,
			request_id TEXT NOT NULL REFERENCES notification_dispatches(request_id) ON DELETE CASCADE,
			channel TEXT NOT NULL,
			provider TEXT NOT NULL,
			success BOOLEAN NOT NULL DEFAULT FALSE,
			attempt_count INT NOT NULL DEFAULT 1,
			escalated_to TEXT,
			message_id TEXT,
			error_text TEXT,
			rendered_body TEXT,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS notification_dead_letters (
			id BIGSERIAL PRIMARY KEY,
			request_id TEXT NOT NULL,
			reason TEXT NOT NULL,
			dispatch_type TEXT NOT NULL,
			channels_json JSONB NOT NULL DEFAULT '[]'::jsonb,
			metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
	}
	for _, statement := range statements {
		if _, err := s.db.Exec(statement); err != nil {
			return err
		}
	}
	return nil
}

func (s *Service) requireInternalAccess(w http.ResponseWriter, r *http.Request) bool {
	provided := strings.TrimSpace(r.Header.Get("X-Internal-Service-Token"))
	if subtle.ConstantTimeCompare([]byte(provided), []byte(s.internalServiceToken)) != 1 {
		respondError(w, http.StatusUnauthorized, "unauthorized")
		return false
	}
	return true
}

func (s *Service) healthHandler(w http.ResponseWriter, _ *http.Request) {
	respondJSON(w, http.StatusOK, map[string]any{
		"status":    "ok",
		"service":   "notification-dispatcher",
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
}

func (s *Service) metricsHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}

	metrics, err := s.loadMetrics()
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	respondJSON(w, http.StatusOK, metrics)
}

func (s *Service) businessHealthHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}

	metrics, err := s.loadMetrics()
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	fallbackRate := 0.0
	if metrics.TotalRequests > 0 {
		fallbackRate = float64(metrics.FallbackRequests) / float64(metrics.TotalRequests)
	}
	status := "healthy"
	if fallbackRate >= 0.25 || metrics.LastLatencyMS > 400 || metrics.DeadLetters > 0 {
		status = "degraded"
	}

	lastRequestAt, err := s.loadLastRequestTime()
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}

	respondJSON(w, http.StatusOK, map[string]any{
		"status":              status,
		"service":             "notification-dispatcher",
		"totalRequests":       metrics.TotalRequests,
		"fallbackRequests":    metrics.FallbackRequests,
		"fallbackRate":        fallbackRate,
		"lastLatencyMs":       metrics.LastLatencyMS,
		"lastRequestAt":       lastRequestAt,
		"deadLetterCount":     metrics.DeadLetters,
		"latencyHealthy":      metrics.LastLatencyMS <= 400,
		"fallbackRateHealthy": fallbackRate < 0.25,
	})
}

func (s *Service) deadLettersHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}

	records, err := s.loadDeadLetters()
	if err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{
		"count":   len(records),
		"records": records,
	})
}

func (s *Service) dispatchHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}

	var req DispatchRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondError(w, http.StatusBadRequest, "invalid json payload")
		return
	}
	if len(req.Channels) == 0 {
		respondError(w, http.StatusBadRequest, "at least one channel is required")
		return
	}

	requestID := strings.TrimSpace(r.Header.Get("X-Request-Id"))
	if requestID == "" && req.Metadata != nil {
		requestID = strings.TrimSpace(req.Metadata["requestId"])
	}
	if requestID == "" {
		requestID = fmt.Sprintf("notif-%d", time.Now().UnixNano())
	}

	if cached, ok, err := s.getStoredDispatch(requestID); err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	} else if ok {
		cached.Idempotent = true
		respondJSON(w, http.StatusOK, cached)
		return
	}

	resolvedChannels := normalizeChannels(req.Channels)
	start := time.Now()
	results := make([]DispatchResult, 0, len(resolvedChannels))
	fallbackUsed := false

	for _, channel := range resolvedChannels {
		result := s.dispatchWithFallback(requestID, channel, req)
		if !result.Success || result.EscalatedTo != "" {
			fallbackUsed = true
		}
		results = append(results, result)
	}

	sort.Slice(results, func(i, j int) bool {
		return string(results[i].Channel) < string(results[j].Channel)
	})

	response := DispatchResponse{
		Accepted:     allSuccessful(results),
		Results:      results,
		DurationMS:   time.Since(start).Milliseconds(),
		RequestID:    requestID,
		FallbackUsed: fallbackUsed,
		DegradedMode: fallbackUsed || !allSuccessful(results),
	}

	if err := s.storeDispatch(requestID, req, response); err != nil {
		respondError(w, http.StatusInternalServerError, err.Error())
		return
	}
	for _, result := range results {
		if err := s.storeAttempt(requestID, result); err != nil {
			respondError(w, http.StatusInternalServerError, err.Error())
			return
		}
		if !result.Success {
			_ = s.storeDeadLetter(DeadLetterRecord{
				RequestID: requestID,
				Reason:    result.Error,
				Type:      req.Type,
				Channels:  resolvedChannels,
				Metadata:  req.Metadata,
				CreatedAt: time.Now().UTC().Format(time.RFC3339),
			})
		}
	}

	respondJSON(w, http.StatusOK, response)
}

func (s *Service) dispatchWithFallback(requestID string, channel Channel, req DispatchRequest) DispatchResult {
	primary := s.dispatchToProvider(requestID, channel, req, 1)
	if primary.Success {
		return primary
	}

	fallbackChannel := resolveFallbackChannel(channel, req.Recipient)
	if fallbackChannel == "" || fallbackChannel == channel {
		return primary
	}

	fallback := s.dispatchToProvider(requestID, fallbackChannel, req, 2)
	if fallback.Success {
		fallback.Channel = channel
		fallback.EscalatedTo = string(fallbackChannel)
		return fallback
	}

	primary.AttemptCount = 2
	primary.Error = fmt.Sprintf("%s; fallback %s also failed: %s", primary.Error, fallbackChannel, fallback.Error)
	return primary
}

func (s *Service) dispatchToProvider(requestID string, channel Channel, req DispatchRequest, attempt int) DispatchResult {
	renderedBody := renderTemplate(req.Type, req.Payload, req.Recipient)
	providerURL, providerName, recipientError := s.resolveProvider(channel, req.Recipient)
	if recipientError != "" {
		return DispatchResult{Success: false, Channel: channel, Error: recipientError, Provider: "unconfigured", AttemptCount: attempt, RenderedBody: renderedBody}
	}
	if providerURL == "" {
		return DispatchResult{Success: false, Channel: channel, Error: fmt.Sprintf("provider not configured for %s", channel), Provider: providerName, AttemptCount: attempt, RenderedBody: renderedBody}
	}

	payload := providerPayload{
		RequestID:    requestID,
		Type:         req.Type,
		Channel:      string(channel),
		Recipient:    req.Recipient,
		RenderedBody: renderedBody,
		Metadata:     req.Metadata,
		Payload:      req.Payload,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return DispatchResult{Success: false, Channel: channel, Error: err.Error(), Provider: providerName, AttemptCount: attempt, RenderedBody: renderedBody}
	}

	httpReq, err := http.NewRequest(http.MethodPost, providerURL, bytes.NewReader(body))
	if err != nil {
		return DispatchResult{Success: false, Channel: channel, Error: err.Error(), Provider: providerName, AttemptCount: attempt, RenderedBody: renderedBody}
	}
	httpReq.Header.Set("Content-Type", "application/json")
	httpReq.Header.Set("X-Internal-Service-Token", s.internalServiceToken)
	httpReq.Header.Set("X-Request-Id", requestID)

	resp, err := s.httpClient.Do(httpReq)
	if err != nil {
		return DispatchResult{Success: false, Channel: channel, Error: err.Error(), Provider: providerName, AttemptCount: attempt, RenderedBody: renderedBody}
	}
	defer resp.Body.Close()
	respBody, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		message := strings.TrimSpace(string(respBody))
		if message == "" {
			message = fmt.Sprintf("provider returned status %d", resp.StatusCode)
		}
		return DispatchResult{Success: false, Channel: channel, Error: message, Provider: providerName, AttemptCount: attempt, RenderedBody: renderedBody}
	}

	messageID := fmt.Sprintf("%s-%d", channel, time.Now().UnixNano())
	var providerResponse map[string]any
	if len(respBody) > 0 {
		_ = json.Unmarshal(respBody, &providerResponse)
		if rawMessageID, ok := providerResponse["messageId"]; ok {
			trimmed := strings.TrimSpace(fmt.Sprint(rawMessageID))
			if trimmed != "" && trimmed != "<nil>" {
				messageID = trimmed
			}
		}
	}

	return DispatchResult{Success: true, Channel: channel, MessageID: messageID, Provider: providerName, AttemptCount: attempt, RenderedBody: renderedBody}
}

func (s *Service) resolveProvider(channel Channel, recipient Recipient) (string, string, string) {
	switch channel {
	case ChannelSMS:
		if strings.TrimSpace(recipient.Phone) == "" {
			return "", "sms-webhook", "missing phone recipient"
		}
		return s.smsProviderURL, "sms-webhook", ""
	case ChannelEmail:
		if strings.TrimSpace(recipient.Email) == "" {
			return "", "email-webhook", "missing email recipient"
		}
		return s.emailProviderURL, "email-webhook", ""
	case ChannelPush:
		if strings.TrimSpace(recipient.Token) == "" {
			return "", "push-webhook", "missing push token"
		}
		return s.pushProviderURL, "push-webhook", ""
	case ChannelVoice:
		if strings.TrimSpace(recipient.Phone) == "" {
			return "", "voice-webhook", "missing phone recipient"
		}
		return s.voiceProviderURL, "voice-webhook", ""
	default:
		return "", "unsupported", "unsupported channel"
	}
}

func renderTemplate(dispatchType string, payload map[string]any, recipient Recipient) string {
	customerName := strings.TrimSpace(recipient.Name)
	if customerName == "" {
		customerName = "customer"
	}
	orderID := valueOrDefault(payload, "order_id", "unknown-order")
	eta := valueOrDefault(payload, "eta_minutes", "soon")
	merchant := valueOrDefault(payload, "merchant_name", "your merchant")

	switch strings.ToLower(strings.TrimSpace(dispatchType)) {
	case "order_confirmed":
		return fmt.Sprintf("Hi %s, your order %s has been confirmed by %s.", customerName, orderID, merchant)
	case "courier_assigned":
		return fmt.Sprintf("Hi %s, a courier has been assigned to order %s. ETA is %s minutes.", customerName, orderID, eta)
	case "order_delivered":
		return fmt.Sprintf("Hi %s, order %s has been delivered. Thanks for using SwitchOS.", customerName, orderID)
	case "longcat_voice_callback":
		callbackReason := valueOrDefault(payload, "callback_reason", "operator follow-up")
		return fmt.Sprintf("Hello %s, this is your SwitchOS callback regarding %s. An operator will continue your order shortly.", customerName, callbackReason)
	default:
		return fmt.Sprintf("Hi %s, there is an update for order %s.", customerName, orderID)
	}
}

func valueOrDefault(payload map[string]any, key string, fallback string) string {
	if payload == nil {
		return fallback
	}
	if value, ok := payload[key]; ok {
		trimmed := strings.TrimSpace(fmt.Sprint(value))
		if trimmed != "" && trimmed != "<nil>" {
			return trimmed
		}
	}
	return fallback
}

func resolveFallbackChannel(channel Channel, recipient Recipient) Channel {
	switch channel {
	case ChannelPush:
		if strings.TrimSpace(recipient.Phone) != "" {
			return ChannelSMS
		}
		if strings.TrimSpace(recipient.Email) != "" {
			return ChannelEmail
		}
	case ChannelVoice:
		if strings.TrimSpace(recipient.Phone) != "" {
			return ChannelSMS
		}
		if strings.TrimSpace(recipient.Email) != "" {
			return ChannelEmail
		}
	case ChannelSMS:
		if strings.TrimSpace(recipient.Token) != "" {
			return ChannelPush
		}
		if strings.TrimSpace(recipient.Email) != "" {
			return ChannelEmail
		}
	case ChannelEmail:
		if strings.TrimSpace(recipient.Token) != "" {
			return ChannelPush
		}
		if strings.TrimSpace(recipient.Phone) != "" {
			return ChannelSMS
		}
	}
	return ""
}

func normalizeChannels(channels []Channel) []Channel {
	seen := map[Channel]struct{}{}
	resolved := make([]Channel, 0, len(channels))
	for _, channel := range channels {
		if _, ok := seen[channel]; ok {
			continue
		}
		seen[channel] = struct{}{}
		resolved = append(resolved, channel)
	}
	return resolved
}

func allSuccessful(results []DispatchResult) bool {
	if len(results) == 0 {
		return false
	}
	for _, result := range results {
		if !result.Success {
			return false
		}
	}
	return true
}

func (s *Service) storeDispatch(requestID string, req DispatchRequest, response DispatchResponse) error {
	payloadJSON, _ := json.Marshal(req.Payload)
	metadataJSON, _ := json.Marshal(req.Metadata)
	channelsJSON, _ := json.Marshal(req.Channels)
	responseJSON, _ := json.Marshal(response)
	_, err := s.db.Exec(
		`INSERT INTO notification_dispatches (
			request_id, dispatch_type, recipient_phone, recipient_email, recipient_name, recipient_token, payload_json, metadata_json, channels_json, response_json, accepted, fallback_used, degraded_mode, duration_ms, created_at, updated_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,$9::jsonb,$10::jsonb,$11,$12,$13,$14,NOW(),NOW())`,
		requestID,
		req.Type,
		nullIfEmpty(req.Recipient.Phone),
		nullIfEmpty(req.Recipient.Email),
		nullIfEmpty(req.Recipient.Name),
		nullIfEmpty(req.Recipient.Token),
		string(payloadJSON),
		string(metadataJSON),
		string(channelsJSON),
		string(responseJSON),
		response.Accepted,
		response.FallbackUsed,
		response.DegradedMode,
		response.DurationMS,
	)
	return err
}

func (s *Service) storeAttempt(requestID string, result DispatchResult) error {
	_, err := s.db.Exec(
		`INSERT INTO notification_attempts (
			request_id, channel, provider, success, attempt_count, escalated_to, message_id, error_text, rendered_body, created_at
		) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NOW())`,
		requestID,
		string(result.Channel),
		result.Provider,
		result.Success,
		result.AttemptCount,
		nullIfEmpty(result.EscalatedTo),
		nullIfEmpty(result.MessageID),
		nullIfEmpty(result.Error),
		nullIfEmpty(result.RenderedBody),
	)
	return err
}

func (s *Service) storeDeadLetter(record DeadLetterRecord) error {
	channelsJSON, _ := json.Marshal(record.Channels)
	metadataJSON, _ := json.Marshal(record.Metadata)
	_, err := s.db.Exec(
		`INSERT INTO notification_dead_letters (request_id, reason, dispatch_type, channels_json, metadata_json, created_at)
		 VALUES ($1,$2,$3,$4::jsonb,$5::jsonb,$6::timestamptz)`,
		record.RequestID,
		record.Reason,
		record.Type,
		string(channelsJSON),
		string(metadataJSON),
		record.CreatedAt,
	)
	return err
}

func (s *Service) getStoredDispatch(requestID string) (DispatchResponse, bool, error) {
	var raw string
	err := s.db.QueryRow(`SELECT response_json::text FROM notification_dispatches WHERE request_id = $1`, requestID).Scan(&raw)
	if err != nil {
		if err == sql.ErrNoRows {
			return DispatchResponse{}, false, nil
		}
		return DispatchResponse{}, false, err
	}
	var response DispatchResponse
	if err := json.Unmarshal([]byte(raw), &response); err != nil {
		return DispatchResponse{}, false, err
	}
	return response, true, nil
}

func (s *Service) loadMetrics() (DispatchMetrics, error) {
	metrics := DispatchMetrics{
		SuccessByChannel: map[string]uint64{},
		FailureByChannel: map[string]uint64{},
	}

	rows, err := s.db.Query(`SELECT channel, success, COUNT(*) FROM notification_attempts GROUP BY channel, success`)
	if err != nil {
		return metrics, err
	}
	defer rows.Close()
	for rows.Next() {
		var channel string
		var success bool
		var count uint64
		if err := rows.Scan(&channel, &success, &count); err != nil {
			return metrics, err
		}
		if success {
			metrics.SuccessByChannel[channel] = count
		} else {
			metrics.FailureByChannel[channel] = count
		}
	}

	_ = s.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(CASE WHEN fallback_used THEN 1 ELSE 0 END), 0), COALESCE(MAX(duration_ms), 0) FROM notification_dispatches`).Scan(&metrics.TotalRequests, &metrics.FallbackRequests, &metrics.LastLatencyMS)
	_ = s.db.QueryRow(`SELECT COUNT(*) FROM notification_dead_letters`).Scan(&metrics.DeadLetters)
	return metrics, nil
}

func (s *Service) loadLastRequestTime() (string, error) {
	var ts sql.NullTime
	if err := s.db.QueryRow(`SELECT MAX(created_at) FROM notification_dispatches`).Scan(&ts); err != nil {
		return "", err
	}
	if !ts.Valid {
		return "", nil
	}
	return ts.Time.UTC().Format(time.RFC3339), nil
}

func (s *Service) loadDeadLetters() ([]DeadLetterRecord, error) {
	rows, err := s.db.Query(`SELECT request_id, reason, dispatch_type, channels_json::text, metadata_json::text, created_at FROM notification_dead_letters ORDER BY created_at DESC LIMIT 100`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	records := make([]DeadLetterRecord, 0)
	for rows.Next() {
		var record DeadLetterRecord
		var channelsRaw string
		var metadataRaw string
		var createdAt time.Time
		if err := rows.Scan(&record.RequestID, &record.Reason, &record.Type, &channelsRaw, &metadataRaw, &createdAt); err != nil {
			return nil, err
		}
		_ = json.Unmarshal([]byte(channelsRaw), &record.Channels)
		_ = json.Unmarshal([]byte(metadataRaw), &record.Metadata)
		record.CreatedAt = createdAt.UTC().Format(time.RFC3339)
		records = append(records, record)
	}
	return records, nil
}

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		requestID := strings.TrimSpace(r.Header.Get("X-Request-Id"))
		next.ServeHTTP(w, r)
		log.Printf("request complete method=%s path=%s requestId=%s duration=%s", r.Method, r.URL.Path, requestID, time.Since(start))
	})
}

func respondJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func respondError(w http.ResponseWriter, status int, message string) {
	respondJSON(w, status, map[string]any{"error": message})
}

func nullIfEmpty(value string) any {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return trimmed
}

func getEnv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
