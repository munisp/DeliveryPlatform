package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

type Channel string

const (
	ChannelSMS   Channel = "sms"
	ChannelEmail Channel = "email"
	ChannelPush  Channel = "push"
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

type CachedDispatch struct {
	Response  DispatchResponse
	CreatedAt time.Time
}

type DispatchMetrics struct {
	SuccessByChannel map[string]uint64 `json:"successByChannel"`
	FailureByChannel map[string]uint64 `json:"failureByChannel"`
	FallbackRequests uint64            `json:"fallbackRequests"`
	DeadLetters      uint64            `json:"deadLetters"`
	TotalRequests    uint64            `json:"totalRequests"`
	LastLatencyMS    int64             `json:"lastLatencyMs"`
}

var (
	port = getEnv("PORT", "8099")

	healthState = struct {
		totalRequests     uint64
		fallbackRequests  uint64
		lastLatencyMS     int64
		lastRequestAtUnix int64
	}{}
	metricsState = struct {
		sync.Mutex
		successByChannel map[string]uint64
		failureByChannel map[string]uint64
	}{
		successByChannel: map[string]uint64{},
		failureByChannel: map[string]uint64{},
	}
	deadLetters   = make([]DeadLetterRecord, 0, 32)
	deadLettersMu sync.Mutex
	cacheMu       sync.Mutex
	dispatchCache = map[string]CachedDispatch{}
)

func main() {
	mux := http.NewServeMux()
	mux.HandleFunc("/metrics", metricsHandler)
	mux.HandleFunc("/health", healthHandler)
	mux.HandleFunc("/business-health", businessHealthHandler)
	mux.HandleFunc("/dead-letters", deadLettersHandler)
	mux.HandleFunc("/dispatch", dispatchHandler)

	server := &http.Server{
		Addr:              fmt.Sprintf(":%s", port),
		Handler:           loggingMiddleware(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("Starting notification dispatcher on :%s", port)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func healthHandler(w http.ResponseWriter, _ *http.Request) {
	respondJSON(w, http.StatusOK, map[string]any{
		"status":    "ok",
		"service":   "notification-dispatcher",
		"timestamp": time.Now().UTC().Format(time.RFC3339),
	})
}

func metricsHandler(w http.ResponseWriter, _ *http.Request) {
	metricsState.Lock()
	defer metricsState.Unlock()
	deadLettersMu.Lock()
	deadLetterCount := len(deadLetters)
	deadLettersMu.Unlock()
	respondJSON(w, http.StatusOK, DispatchMetrics{
		SuccessByChannel: cloneCounterMap(metricsState.successByChannel),
		FailureByChannel: cloneCounterMap(metricsState.failureByChannel),
		FallbackRequests: atomic.LoadUint64(&healthState.fallbackRequests),
		DeadLetters:      uint64(deadLetterCount),
		TotalRequests:    atomic.LoadUint64(&healthState.totalRequests),
		LastLatencyMS:    atomic.LoadInt64(&healthState.lastLatencyMS),
	})
}

func businessHealthHandler(w http.ResponseWriter, _ *http.Request) {
	total := atomic.LoadUint64(&healthState.totalRequests)
	fallbacks := atomic.LoadUint64(&healthState.fallbackRequests)
	latency := atomic.LoadInt64(&healthState.lastLatencyMS)
	lastRequestUnix := atomic.LoadInt64(&healthState.lastRequestAtUnix)
	fallbackRate := 0.0
	if total > 0 {
		fallbackRate = float64(fallbacks) / float64(total)
	}
	status := "healthy"
	if fallbackRate >= 0.25 || latency > 400 {
		status = "degraded"
	}
	deadLettersMu.Lock()
	deadLetterCount := len(deadLetters)
	deadLettersMu.Unlock()
	respondJSON(w, http.StatusOK, map[string]any{
		"status":              status,
		"service":             "notification-dispatcher",
		"totalRequests":       total,
		"fallbackRequests":    fallbacks,
		"fallbackRate":        fallbackRate,
		"lastLatencyMs":       latency,
		"lastRequestAt":       time.Unix(lastRequestUnix, 0).UTC().Format(time.RFC3339),
		"deadLetterCount":     deadLetterCount,
		"latencyHealthy":      latency <= 400,
		"fallbackRateHealthy": fallbackRate < 0.25,
	})
}

func deadLettersHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondError(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	deadLettersMu.Lock()
	defer deadLettersMu.Unlock()
	respondJSON(w, http.StatusOK, map[string]any{
		"count":   len(deadLetters),
		"records": deadLetters,
	})
}

func dispatchHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondError(w, http.StatusMethodNotAllowed, "method not allowed")
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

	if cached, ok := getCachedDispatch(requestID); ok {
		cached.Response.Idempotent = true
		respondJSON(w, http.StatusOK, cached.Response)
		return
	}

	start := time.Now()
	results := make([]DispatchResult, 0, len(req.Channels))
	resultsCh := make(chan DispatchResult, len(req.Channels))
	var wg sync.WaitGroup

	resolvedChannels := normalizeChannels(req.Channels)
	for _, channel := range resolvedChannels {
		wg.Add(1)
		go func(ch Channel) {
			defer wg.Done()
			resultsCh <- dispatchWithFallback(ch, req)
		}(channel)
	}

	wg.Wait()
	close(resultsCh)

	fallbackUsed := false
	for result := range resultsCh {
		status := "success"
		if !result.Success {
			status = "failure"
			fallbackUsed = true
			recordDeadLetter(DeadLetterRecord{
				RequestID: requestID,
				Reason:    result.Error,
				Type:      req.Type,
				Channels:  resolvedChannels,
				Metadata:  req.Metadata,
				CreatedAt: time.Now().UTC().Format(time.RFC3339),
			})
		} else if result.EscalatedTo != "" {
			fallbackUsed = true
		}
		incrementMetric(string(result.Channel), status)
		results = append(results, result)
	}

	sort.Slice(results, func(i, j int) bool {
		return string(results[i].Channel) < string(results[j].Channel)
	})

	duration := time.Since(start).Milliseconds()
	atomic.AddUint64(&healthState.totalRequests, 1)
	atomic.StoreInt64(&healthState.lastLatencyMS, duration)
	atomic.StoreInt64(&healthState.lastRequestAtUnix, time.Now().Unix())
	if fallbackUsed {
		atomic.AddUint64(&healthState.fallbackRequests, 1)
	}

	response := DispatchResponse{
		Accepted:     true,
		Results:      results,
		DurationMS:   duration,
		RequestID:    requestID,
		FallbackUsed: fallbackUsed,
		DegradedMode: fallbackUsed,
	}
	storeCachedDispatch(requestID, response)
	respondJSON(w, http.StatusOK, response)
}

func dispatchWithFallback(channel Channel, req DispatchRequest) DispatchResult {
	primary := simulateDispatch(channel, req, 1)
	if primary.Success {
		return primary
	}

	fallbackChannel := resolveFallbackChannel(channel, req.Recipient)
	if fallbackChannel == "" || fallbackChannel == channel {
		return primary
	}

	fallback := simulateDispatch(fallbackChannel, req, 2)
	if fallback.Success {
		fallback.Channel = channel
		fallback.EscalatedTo = string(fallbackChannel)
		return fallback
	}

	primary.AttemptCount = 2
	primary.Error = fmt.Sprintf("%s; fallback %s also failed: %s", primary.Error, fallbackChannel, fallback.Error)
	return primary
}

func simulateDispatch(channel Channel, req DispatchRequest, attempt int) DispatchResult {
	messageID := fmt.Sprintf("%s-%d", channel, time.Now().UnixNano())
	renderedBody := renderTemplate(req.Type, req.Payload, req.Recipient)

	switch channel {
	case ChannelSMS:
		if strings.TrimSpace(req.Recipient.Phone) == "" {
			return DispatchResult{Success: false, Channel: channel, Error: "missing phone recipient", Provider: "go-dispatcher", AttemptCount: attempt}
		}
		return DispatchResult{Success: true, Channel: channel, MessageID: messageID, Provider: "twilio-compatible", AttemptCount: attempt, RenderedBody: renderedBody}
	case ChannelEmail:
		if strings.TrimSpace(req.Recipient.Email) == "" {
			return DispatchResult{Success: false, Channel: channel, Error: "missing email recipient", Provider: "go-dispatcher", AttemptCount: attempt}
		}
		return DispatchResult{Success: true, Channel: channel, MessageID: messageID, Provider: "ses-compatible", AttemptCount: attempt, RenderedBody: renderedBody}
	case ChannelPush:
		if strings.TrimSpace(req.Recipient.Token) == "" {
			return DispatchResult{Success: false, Channel: channel, Error: "missing push token", Provider: "go-dispatcher", AttemptCount: attempt}
		}
		return DispatchResult{Success: true, Channel: channel, MessageID: messageID, Provider: "fcm-compatible", AttemptCount: attempt, RenderedBody: renderedBody}
	default:
		return DispatchResult{Success: false, Channel: channel, Error: "unsupported channel", Provider: "go-dispatcher", AttemptCount: attempt}
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

func incrementMetric(channel string, status string) {
	metricsState.Lock()
	defer metricsState.Unlock()
	if status == "success" {
		metricsState.successByChannel[channel]++
	} else {
		metricsState.failureByChannel[channel]++
	}
}

func cloneCounterMap(source map[string]uint64) map[string]uint64 {
	cloned := make(map[string]uint64, len(source))
	for key, value := range source {
		cloned[key] = value
	}
	return cloned
}

func recordDeadLetter(record DeadLetterRecord) {
	deadLettersMu.Lock()
	defer deadLettersMu.Unlock()
	if len(deadLetters) >= 100 {
		deadLetters = deadLetters[1:]
	}
	deadLetters = append(deadLetters, record)
}

func getCachedDispatch(requestID string) (CachedDispatch, bool) {
	cacheMu.Lock()
	defer cacheMu.Unlock()
	cached, ok := dispatchCache[requestID]
	if !ok {
		return CachedDispatch{}, false
	}
	if time.Since(cached.CreatedAt) > 30*time.Minute {
		delete(dispatchCache, requestID)
		return CachedDispatch{}, false
	}
	return cached, true
}

func storeCachedDispatch(requestID string, response DispatchResponse) {
	cacheMu.Lock()
	defer cacheMu.Unlock()
	dispatchCache[requestID] = CachedDispatch{Response: response, CreatedAt: time.Now().UTC()}
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

func getEnv(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
