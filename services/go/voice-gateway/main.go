package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"strings"
	"time"
)

type GatewayService struct {
	httpClient           *http.Client
	internalServiceToken string
	longcatCoreURL       string
	speechServiceURL     string
	telephonyMode        string
}

type BootstrapRequest struct {
	UserID             *int64            `json:"userId,omitempty"`
	CustomerPhone      string            `json:"customerPhone,omitempty"`
	CustomerName       string            `json:"customerName,omitempty"`
	AccessibilityFlags []string          `json:"accessibilityFlags,omitempty"`
	VoiceChannel       string            `json:"voiceChannel,omitempty"`
	IdempotencyKey     string            `json:"idempotencyKey,omitempty"`
	TriggerReason      string            `json:"triggerReason,omitempty"`
	ExternalCallID     string            `json:"externalCallId"`
	TelephonyProvider  string            `json:"telephonyProvider,omitempty"`
	Transport          string            `json:"transport,omitempty"`
	SampleRateHz       int               `json:"sampleRateHz,omitempty"`
	Metadata           map[string]string `json:"metadata,omitempty"`
}

type TranscriptRequest struct {
	SessionID         string                 `json:"sessionId"`
	ExternalCallID    string                 `json:"externalCallId"`
	TelephonyProvider string                 `json:"telephonyProvider,omitempty"`
	Transport         string                 `json:"transport,omitempty"`
	Speaker           string                 `json:"speaker,omitempty"`
	Transcript        string                 `json:"transcript"`
	FinalSegment      bool                   `json:"finalSegment"`
	Metadata          map[string]any         `json:"metadata,omitempty"`
}

type GatewaySpeechResult struct {
	Requested    bool    `json:"requested"`
	Synthesized  bool    `json:"synthesized"`
	Engine       string  `json:"engine"`
	AudioFormat  *string `json:"audio_format,omitempty"`
	AudioBase64  *string `json:"audio_base64,omitempty"`
	PlaybackText string  `json:"playback_text,omitempty"`
	LatencyMS    *int64  `json:"latency_ms,omitempty"`
	DegradedMode bool    `json:"degraded_mode"`
	Error        *string `json:"error,omitempty"`
}

type GatewayTranscriptResponse struct {
	SessionID         string               `json:"session_id"`
	AssistantMessage  string               `json:"assistant_message,omitempty"`
	DetectedIntent    string               `json:"detected_intent,omitempty"`
	NextActions       []string             `json:"next_actions,omitempty"`
	CallbackRequested bool                 `json:"callback_requested"`
	Speech            GatewaySpeechResult  `json:"speech"`
	Telephony         map[string]string    `json:"telephony,omitempty"`
}

func main() {
	port := getEnv("PORT", "8104")
	bindHost := getEnv("BIND_HOST", "127.0.0.1")
	service := &GatewayService{
		httpClient:           &http.Client{Timeout: 25 * time.Second},
		internalServiceToken: getEnv("INTERNAL_SERVICE_TOKEN", "switchos-internal-dev-token-change-before-production"),
		longcatCoreURL:       strings.TrimRight(getEnv("LONGCAT_CORE_URL", "http://127.0.0.1:3005"), "/"),
		speechServiceURL:     strings.TrimRight(getEnv("LONGCAT_SPEECH_SERVICE_URL", "http://127.0.0.1:8105"), "/"),
		telephonyMode:        getEnv("LONGCAT_TELEPHONY_MODE", "asterisk-audiosocket"),
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", service.healthHandler)
	mux.HandleFunc("/sessions/bootstrap", service.bootstrapHandler)
	mux.HandleFunc("/sessions/transcript", service.transcriptHandler)
	mux.HandleFunc("/sessions/stream-event", service.streamEventHandler)

	server := &http.Server{
		Addr:              fmt.Sprintf("%s:%s", bindHost, port),
		Handler:           loggingMiddleware(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}

	log.Printf("Starting LongCat voice gateway on %s:%s", bindHost, port)
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal(err)
	}
}

func (s *GatewayService) healthHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{
		"status":            "ok",
		"service":           "longcat-voice-gateway",
		"telephony_mode":    s.telephonyMode,
		"longcat_core_url":  s.longcatCoreURL,
		"speech_service_url": s.speechServiceURL,
		"timestamp":         time.Now().UTC().Format(time.RFC3339),
	})
}

func (s *GatewayService) bootstrapHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	var req BootstrapRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	if strings.TrimSpace(req.ExternalCallID) == "" {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "externalCallId_required"})
		return
	}
	if strings.TrimSpace(req.Transport) == "" {
		req.Transport = s.telephonyMode
	}
	payload, status, err := s.forwardJSON(http.MethodPost, s.longcatCoreURL+"/api/internal/longcat/voice/bootstrap", req)
	if err != nil {
		respondJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	respondRawJSON(w, status, payload)
}

func (s *GatewayService) transcriptHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	var req TranscriptRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	if strings.TrimSpace(req.SessionID) == "" || strings.TrimSpace(req.ExternalCallID) == "" || strings.TrimSpace(req.Transcript) == "" {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "sessionId_externalCallId_transcript_required"})
		return
	}
	if strings.TrimSpace(req.Transport) == "" {
		req.Transport = s.telephonyMode
	}
	if strings.TrimSpace(req.Speaker) == "" {
		req.Speaker = "customer"
	}
	payload, status, err := s.forwardJSON(http.MethodPost, s.longcatCoreURL+"/api/internal/longcat/voice/transcript", req)
	if err != nil {
		respondJSON(w, http.StatusBadGateway, map[string]any{"error": err.Error()})
		return
	}
	respondRawJSON(w, status, payload)
}

func (s *GatewayService) streamEventHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		respondJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method_not_allowed"})
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	var payload map[string]any
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		respondJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid_json"})
		return
	}
	respondJSON(w, http.StatusOK, map[string]any{
		"accepted": true,
		"mode":     s.telephonyMode,
		"message":  "Open-source telephony stream metadata accepted. Use /sessions/bootstrap and /sessions/transcript for LongCat orchestration.",
		"payload":  payload,
	})
}

func (s *GatewayService) requireInternalAccess(w http.ResponseWriter, r *http.Request) bool {
	provided := strings.TrimSpace(r.Header.Get("X-Internal-Service-Token"))
	if provided == "" || provided != s.internalServiceToken {
		respondJSON(w, http.StatusUnauthorized, map[string]any{"error": "unauthorized"})
		return false
	}
	return true
}

func (s *GatewayService) forwardJSON(method string, url string, payload any) ([]byte, int, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, http.StatusInternalServerError, err
	}
	req, err := http.NewRequest(method, url, bytes.NewReader(body))
	if err != nil {
		return nil, http.StatusInternalServerError, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Internal-Service-Token", s.internalServiceToken)
	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, http.StatusBadGateway, err
	}
	defer resp.Body.Close()
	responseBody, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, http.StatusBadGateway, err
	}
	return responseBody, resp.StatusCode, nil
}

func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		next.ServeHTTP(w, r)
		log.Printf("%s %s %s", r.Method, r.URL.Path, time.Since(start))
	})
}

func respondJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func respondRawJSON(w http.ResponseWriter, status int, payload []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(payload)
}

func getEnv(key string, fallback string) string {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	return value
}
