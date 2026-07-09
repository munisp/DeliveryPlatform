package main

import (
	"bytes"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"time"
)

const (
	audioSocketTypeUUID = 0x01
	audioSocketTypeDTMF = 0x03
)

type GatewayService struct {
	httpClient           *http.Client
	internalServiceToken string
	longcatCoreURL       string
	speechServiceURL     string
	telephonyMode        string
	audioSocketAddr      string
	nextConnectionID     atomic.Uint64
}

var errTerminalSessionConflict = errors.New("terminal_session_conflict")

type HTTPStatusError struct {
	Status int
	Body   []byte
}

func (e *HTTPStatusError) Error() string {
	if len(e.Body) == 0 {
		return fmt.Sprintf("upstream_status_%d", e.Status)
	}
	return fmt.Sprintf("upstream_status_%d: %s", e.Status, strings.TrimSpace(string(e.Body)))
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
	SessionID         string         `json:"sessionId"`
	ExternalCallID    string         `json:"externalCallId"`
	TelephonyProvider string         `json:"telephonyProvider,omitempty"`
	Transport         string         `json:"transport,omitempty"`
	Speaker           string         `json:"speaker,omitempty"`
	Transcript        string         `json:"transcript"`
	FinalSegment      bool           `json:"finalSegment"`
	Metadata          map[string]any `json:"metadata,omitempty"`
}

type CloseRequest struct {
	SessionID      string         `json:"sessionId"`
	ExternalCallID string         `json:"externalCallId"`
	Status         string         `json:"status,omitempty"`
	Reason         string         `json:"reason,omitempty"`
	Metadata       map[string]any `json:"metadata,omitempty"`
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
	SessionID         string              `json:"session_id"`
	AssistantMessage  string              `json:"assistant_message,omitempty"`
	DetectedIntent    string              `json:"detected_intent,omitempty"`
	NextActions       []string            `json:"next_actions,omitempty"`
	CallbackRequested bool                `json:"callback_requested"`
	Speech            GatewaySpeechResult `json:"speech"`
	Telephony         map[string]string   `json:"telephony,omitempty"`
}

type SpeechChunkResponse struct {
	Transcript     string `json:"transcript"`
	Final          bool   `json:"final"`
	Engine         string `json:"engine"`
	EngineReady    bool   `json:"engine_ready"`
	DegradedMode   bool   `json:"degraded_mode"`
	DegradedReason string `json:"degraded_reason"`
	LatencyMS      int64  `json:"latency_ms"`
	ChunkID        string `json:"chunk_id"`
	SessionID      string `json:"session_id"`
	AudioBytes     int    `json:"audio_bytes"`
	Error          string `json:"error"`
}

type AudioSocketFrame struct {
	PacketType byte
	Payload    []byte
}

type AudioSocketStreamState struct {
	ExternalCallID string
	SessionID      string
	SampleRateHz   int
	ChunkIndex     int
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
		audioSocketAddr:      getEnv("LONGCAT_AUDIOSOCKET_ADDR", "127.0.0.1:9104"),
	}

	if strings.Contains(strings.ToLower(service.telephonyMode), "audiosocket") {
		go service.runAudioSocketListener()
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
		"status":             "ok",
		"service":            "longcat-voice-gateway",
		"telephony_mode":     s.telephonyMode,
		"audio_socket_addr":  s.audioSocketAddr,
		"longcat_core_url":   s.longcatCoreURL,
		"speech_service_url": s.speechServiceURL,
		"timestamp":          time.Now().UTC().Format(time.RFC3339),
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
		respondForwardingError(w, status, err)
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
		respondForwardingError(w, status, err)
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

func (s *GatewayService) runAudioSocketListener() {
	listener, err := net.Listen("tcp", s.audioSocketAddr)
	if err != nil {
		log.Printf("[LongCat Voice Gateway] AudioSocket listener disabled: %v", err)
		return
	}
	log.Printf("[LongCat Voice Gateway] AudioSocket-style listener active on %s", s.audioSocketAddr)
	for {
		conn, err := listener.Accept()
		if err != nil {
			log.Printf("[LongCat Voice Gateway] Accept failed: %v", err)
			continue
		}
		go s.handleAudioSocketConnection(conn)
	}
}

func (s *GatewayService) handleAudioSocketConnection(conn net.Conn) {
	defer conn.Close()
	connectionID := s.nextConnectionID.Add(1)
	state := &AudioSocketStreamState{
		ExternalCallID: fmt.Sprintf("audiosocket-%d", connectionID),
		SampleRateHz:   16000,
	}
	closeStatus := "completed"
	closeReason := "audiosocket_disconnect"
	defer func() {
		if strings.TrimSpace(state.SessionID) == "" {
			return
		}
		if err := s.closeTelephonySession(CloseRequest{
			SessionID:      state.SessionID,
			ExternalCallID: state.ExternalCallID,
			Status:         closeStatus,
			Reason:         closeReason,
			Metadata: map[string]any{
				"transport":   "audiosocket",
				"chunk_count": state.ChunkIndex,
			},
		}); err != nil {
			log.Printf("[LongCat Voice Gateway] Failed to close AudioSocket session %s: %v", state.SessionID, err)
		}
	}()

	for {
		_ = conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		frame, err := readAudioSocketFrame(conn)
		if err != nil {
			if err != io.EOF {
				closeStatus = "failed"
				closeReason = fmt.Sprintf("audiosocket_error:%v", err)
				log.Printf("[LongCat Voice Gateway] AudioSocket connection error: %v", err)
			}
			return
		}

		if err := s.handleAudioSocketFrame(state, frame); err != nil {
			if errors.Is(err, errTerminalSessionConflict) {
				closeStatus = "completed"
				closeReason = "terminal_session_conflict"
				log.Printf("[LongCat Voice Gateway] AudioSocket session %s reached terminal state; stopping stream ingestion", state.SessionID)
				return
			}
			closeStatus = "failed"
			closeReason = err.Error()
			log.Printf("[LongCat Voice Gateway] AudioSocket frame handling failed: %v", err)
			return
		}
	}
}

func (s *GatewayService) handleAudioSocketFrame(state *AudioSocketStreamState, frame AudioSocketFrame) error {
	switch {
	case frame.PacketType == audioSocketTypeUUID:
		candidate := strings.TrimSpace(string(frame.Payload))
		if candidate != "" {
			state.ExternalCallID = sanitizeExternalCallID(candidate)
		}
		if state.SessionID == "" {
			sessionID, err := s.bootstrapTelephonySession(state)
			if err != nil {
				return fmt.Errorf("bootstrap audiosocket session: %w", err)
			}
			state.SessionID = sessionID
		}
		return nil
	case frame.PacketType == audioSocketTypeDTMF:
		if state.SessionID == "" {
			sessionID, err := s.bootstrapTelephonySession(state)
			if err != nil {
				return fmt.Errorf("bootstrap dtmf session: %w", err)
			}
			state.SessionID = sessionID
		}
		digits := strings.TrimSpace(string(frame.Payload))
		if digits == "" {
			return nil
		}
					_, err := s.forwardTranscript(TranscriptRequest{

			SessionID:         state.SessionID,
			ExternalCallID:    state.ExternalCallID,
			TelephonyProvider: "asterisk",
			Transport:         "audiosocket",
			Speaker:           "customer",
			Transcript:        fmt.Sprintf("DTMF %s", digits),
			FinalSegment:      true,
			Metadata: map[string]any{
				"signal": "dtmf",
			},
		})
					if err != nil {
				if isHTTPStatus(err, http.StatusConflict) {
					return errTerminalSessionConflict
				}
				return fmt.Errorf("forward dtmf transcript: %w", err)
			}

		return nil
	case isPCMFrameType(frame.PacketType):
		if state.SessionID == "" {
			sessionID, err := s.bootstrapTelephonySession(state)
			if err != nil {
				return fmt.Errorf("bootstrap pcm session: %w", err)
			}
			state.SessionID = sessionID
		}
		state.SampleRateHz = sampleRateForPacket(frame.PacketType)
		state.ChunkIndex++
		result, err := s.sendAudioChunkForTranscription(state, frame)
		if err != nil {
			return fmt.Errorf("transcribe audio chunk: %w", err)
		}
		if strings.TrimSpace(result.Transcript) == "" {
			return nil
		}
		_, err = s.forwardTranscript(TranscriptRequest{
			SessionID:         state.SessionID,
			ExternalCallID:    state.ExternalCallID,
			TelephonyProvider: "asterisk",
			Transport:         "audiosocket",
			Speaker:           "customer",
			Transcript:        result.Transcript,
			FinalSegment:      result.Final,
			Metadata: map[string]any{
				"audio_chunk_id":       result.ChunkID,
				"audio_bytes":          result.AudioBytes,
				"stt_engine":           result.Engine,
				"stt_engine_ready":     result.EngineReady,
				"stt_degraded":         result.DegradedMode,
				"stt_degraded_mode":    result.DegradedMode,
				"stt_degraded_reason":  strings.TrimSpace(result.DegradedReason),
				"stt_latency_ms":       result.LatencyMS,
			},
		})
					if err != nil {
				if isHTTPStatus(err, http.StatusConflict) {
					return errTerminalSessionConflict
				}
				return fmt.Errorf("forward transcript: %w", err)
			}

		return nil
	default:
		return nil
	}
}

func (s *GatewayService) bootstrapTelephonySession(state *AudioSocketStreamState) (string, error) {
	responseBody, _, err := s.forwardJSON(http.MethodPost, s.longcatCoreURL+"/api/internal/longcat/voice/bootstrap", BootstrapRequest{
		ExternalCallID:    state.ExternalCallID,
		TelephonyProvider: "asterisk",
		Transport:         "audiosocket",
		SampleRateHz:      state.SampleRateHz,
		VoiceChannel:      "phone_ordering",
		TriggerReason:     "audiosocket_ingress",
		IdempotencyKey:    fmt.Sprintf("audiosocket-%s", state.ExternalCallID),
		Metadata: map[string]string{
			"ingress": "audiosocket",
		},
	})
	if err != nil {
		return "", err
	}
	var payload map[string]any
	if err := json.Unmarshal(responseBody, &payload); err != nil {
		return "", err
	}
	sessionID := strings.TrimSpace(fmt.Sprintf("%v", payload["session_id"]))
	if sessionID == "" || sessionID == "<nil>" {
		return "", fmt.Errorf("missing session_id in bootstrap response")
	}
	return sessionID, nil
}

func (s *GatewayService) sendAudioChunkForTranscription(state *AudioSocketStreamState, frame AudioSocketFrame) (*SpeechChunkResponse, error) {
	chunkID := fmt.Sprintf("%s-%d", state.ExternalCallID, state.ChunkIndex)
	payload := map[string]any{
		"session_id":     state.SessionID,
		"chunk_id":       chunkID,
		"engine":         getEnv("LONGCAT_SPEECH_STT_ENGINE", "faster-whisper"),
		"audio_base64":   base64.StdEncoding.EncodeToString(frame.Payload),
		"sample_rate_hz": state.SampleRateHz,
		"final":          false,
	}
	responseBody, _, err := s.forwardJSON(http.MethodPost, s.speechServiceURL+"/stt/stream-chunk", payload)
	if err != nil {
		return nil, err
	}
	var result SpeechChunkResponse
	if err := json.Unmarshal(responseBody, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (s *GatewayService) forwardTranscript(req TranscriptRequest) (*GatewayTranscriptResponse, error) {
	responseBody, _, err := s.forwardJSON(http.MethodPost, s.longcatCoreURL+"/api/internal/longcat/voice/transcript", req)
	if err != nil {
		return nil, err
	}
	var result GatewayTranscriptResponse
	if err := json.Unmarshal(responseBody, &result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (s *GatewayService) closeTelephonySession(req CloseRequest) error {
	if strings.TrimSpace(req.SessionID) == "" || strings.TrimSpace(req.ExternalCallID) == "" {
		return nil
	}
	_, _, err := s.forwardJSON(http.MethodPost, s.longcatCoreURL+"/api/internal/longcat/voice/close", req)
	return err
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
	if resp.StatusCode >= http.StatusBadRequest {
		return responseBody, resp.StatusCode, &HTTPStatusError{Status: resp.StatusCode, Body: responseBody}
	}
	return responseBody, resp.StatusCode, nil
}

func isHTTPStatus(err error, status int) bool {
	var statusErr *HTTPStatusError
	if !errors.As(err, &statusErr) {
		return false
	}
	return statusErr.Status == status
}

func respondForwardingError(w http.ResponseWriter, fallbackStatus int, err error) {
	var statusErr *HTTPStatusError
	if errors.As(err, &statusErr) {
		if len(statusErr.Body) > 0 && json.Valid(statusErr.Body) {
			respondRawJSON(w, statusErr.Status, statusErr.Body)
			return
		}
		respondJSON(w, statusErr.Status, map[string]any{"error": strings.TrimSpace(string(statusErr.Body))})
		return
	}
	statusCode := fallbackStatus
	if statusCode < http.StatusBadRequest {
		statusCode = http.StatusBadGateway
	}
	respondJSON(w, statusCode, map[string]any{"error": err.Error()})
}

func readAudioSocketFrame(reader io.Reader) (AudioSocketFrame, error) {
	header := make([]byte, 3)
	if _, err := io.ReadFull(reader, header); err != nil {
		return AudioSocketFrame{}, err
	}
	payloadLength := binary.BigEndian.Uint16(header[1:3])
	payload := make([]byte, payloadLength)
	if _, err := io.ReadFull(reader, payload); err != nil {
		return AudioSocketFrame{}, err
	}
	return AudioSocketFrame{PacketType: header[0], Payload: payload}, nil
}

func isPCMFrameType(packetType byte) bool {
	switch packetType {
	case 0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18:
		return true
	default:
		return false
	}
}

func sampleRateForPacket(packetType byte) int {
	switch packetType {
	case 0x10:
		return 8000
	case 0x11:
		return 12000
	case 0x12:
		return 16000
	case 0x13:
		return 24000
	case 0x14:
		return 32000
	case 0x15:
		return 44100
	case 0x16:
		return 48000
	case 0x17:
		return 96000
	case 0x18:
		return 192000
	default:
		return 16000
	}
}

func sanitizeExternalCallID(value string) string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return fmt.Sprintf("audiosocket-%d", time.Now().UnixNano())
	}
	trimmed = strings.ReplaceAll(trimmed, " ", "-")
	trimmed = strings.ReplaceAll(trimmed, "/", "-")
	return trimmed
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
