package main

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func newTestGateway(coreURL string, speechURL string) *GatewayService {
	return &GatewayService{
		httpClient:           &http.Client{},
		internalServiceToken: "test-token",
		longcatCoreURL:       coreURL,
		speechServiceURL:     speechURL,
		telephonyMode:        "asterisk-audiosocket",
		audioSocketAddr:      "127.0.0.1:0",
		}
}

func TestForwardJSONReturnsHTTPStatusErrorAndBody(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		_, _ = w.Write([]byte(`{"error":"terminal session"}`))
	}))
	defer server.Close()

	gateway := newTestGateway(server.URL, server.URL)
	payload, statusCode, err := gateway.forwardJSON(http.MethodPost, server.URL, map[string]any{"sessionId": "voice-123"})
	if statusCode != http.StatusConflict {
		t.Fatalf("expected status %d, got %d", http.StatusConflict, statusCode)
	}
	if string(payload) != `{"error":"terminal session"}` {
		t.Fatalf("expected upstream body to be preserved, got %s", string(payload))
	}
	if err == nil {
		t.Fatal("expected HTTP status error, got nil")
	}
	if !isHTTPStatus(err, http.StatusConflict) {
		t.Fatalf("expected conflict status helper to match, got %v", err)
	}
	var statusErr *HTTPStatusError
	if !errors.As(err, &statusErr) {
		t.Fatalf("expected *HTTPStatusError, got %T", err)
	}
	if statusErr.Status != http.StatusConflict {
		t.Fatalf("expected conflict status on error, got %d", statusErr.Status)
	}
}

func TestRespondForwardingErrorWritesUpstreamJSONBody(t *testing.T) {
	recorder := httptest.NewRecorder()
	respondForwardingError(recorder, http.StatusBadGateway, &HTTPStatusError{
		Status: http.StatusUnauthorized,
		Body:   []byte(`{"error":"invalid internal token"}`),
	})

	result := recorder.Result()
	defer result.Body.Close()
	if result.StatusCode != http.StatusUnauthorized {
		t.Fatalf("expected upstream status to be preserved, got %d", result.StatusCode)
	}
	if !strings.Contains(recorder.Body.String(), "invalid internal token") {
		t.Fatalf("expected upstream body to be forwarded, got %s", recorder.Body.String())
	}
}

func TestHandleAudioSocketFrameReturnsTerminalConflictOnTranscript409(t *testing.T) {
	coreServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/api/internal/longcat/voice/transcript":
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusConflict)
			_, _ = w.Write([]byte(`{"error":"LongCat voice session is terminal"}`))
		default:
			w.Header().Set("Content-Type", "application/json")
			_, _ = w.Write([]byte(`{"ok":true}`))
		}
	}))
	defer coreServer.Close()

	speechServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"transcript":"customer wants noodles","final":true,"engine":"faster-whisper","degraded_mode":false,"engine_ready":true}`))
	}))
	defer speechServer.Close()

	gateway := newTestGateway(coreServer.URL, speechServer.URL)
	state := &AudioSocketStreamState{SessionID: "voice-123", ExternalCallID: "call-123", SampleRateHz: 8000}
	frame := AudioSocketFrame{PacketType: 0x10, Payload: []byte{0x01, 0x02, 0x03, 0x04}}

	if err := gateway.handleAudioSocketFrame(state, frame); err != nil {
		t.Fatalf("expected frame buffering to succeed, got %v", err)
	}
	if !errors.Is(gateway.flushBufferedAudio(state), errTerminalSessionConflict) {
		t.Fatalf("expected terminal session conflict on final flush, got %v", gateway.flushBufferedAudio(state))
	}
}

func TestHandleAudioSocketFrameForwardsSpeechReadinessMetadata(t *testing.T) {
	var forwarded TranscriptRequest
	coreServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/api/internal/longcat/voice/transcript" {
			body, err := io.ReadAll(r.Body)
			if err != nil {
				t.Fatalf("failed to read transcript body: %v", err)
			}
			if err := json.Unmarshal(body, &forwarded); err != nil {
				t.Fatalf("failed to decode transcript body: %v", err)
			}
		}
		_, _ = w.Write([]byte(`{"session_id":"voice-123","assistant_message":"ok","detected_intent":"place_order","callback_requested":false,"speech":{"requested":true,"synthesized":false,"engine":"piper","playback_text":"ok","degraded_mode":true}}`))
	}))
	defer coreServer.Close()

	speechServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"transcript":"customer wants dumplings","final":true,"engine":"whisper.cpp","engine_ready":false,"degraded_mode":true,"degraded_reason":"whisper_cpp_binary_or_model_missing","latency_ms":17,"chunk_id":"call-123-1","session_id":"voice-123","audio_bytes":4}`))
	}))
	defer speechServer.Close()

	gateway := newTestGateway(coreServer.URL, speechServer.URL)
	state := &AudioSocketStreamState{SessionID: "voice-123", ExternalCallID: "call-123", SampleRateHz: 8000}
	frame := AudioSocketFrame{PacketType: 0x10, Payload: []byte{0x01, 0x02, 0x03, 0x04}}

	if err := gateway.handleAudioSocketFrame(state, frame); err != nil {
		t.Fatalf("expected successful frame buffering, got %v", err)
	}
	if err := gateway.flushBufferedAudio(state); err != nil {
		t.Fatalf("expected successful final flush, got %v", err)
	}
	if forwarded.Metadata["stt_engine"] != "whisper.cpp" {
		t.Fatalf("expected stt_engine metadata, got %+v", forwarded.Metadata)
	}
	if forwarded.Metadata["stt_engine_ready"] != false {
		t.Fatalf("expected false stt_engine_ready metadata, got %+v", forwarded.Metadata)
	}
	if forwarded.Metadata["stt_degraded_reason"] != "whisper_cpp_binary_or_model_missing" {
		t.Fatalf("expected degraded reason metadata, got %+v", forwarded.Metadata)
	}
	if forwarded.Metadata["stt_latency_ms"] != float64(17) {
		t.Fatalf("expected latency metadata, got %+v", forwarded.Metadata)
	}
}

func TestForwardTranscriptPreservesStructuredResponse(t *testing.T) {
	coreServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(GatewayTranscriptResponse{
			SessionID:        "voice-123",
			AssistantMessage: "Confirmed order.",
			DetectedIntent:   "place_order",
			NextActions:      []string{"confirm_order"},
			CallbackRequested: false,
			Speech: GatewaySpeechResult{
				Requested:    true,
				Synthesized:  false,
				Engine:       "piper",
				PlaybackText: "Confirmed order.",
				DegradedMode: true,
			},
			Telephony: map[string]string{"transport": "audiosocket"},
		})
	}))
	defer coreServer.Close()

	gateway := newTestGateway(coreServer.URL, coreServer.URL)
	response, err := gateway.forwardTranscript(TranscriptRequest{SessionID: "voice-123", Transcript: "hello", FinalSegment: true})
	if err != nil {
		t.Fatalf("expected successful transcript forwarding, got %v", err)
	}
	if response.SessionID != "voice-123" {
		t.Fatalf("expected session id to round-trip, got %+v", response)
	}
	if response.AssistantMessage != "Confirmed order." {
		t.Fatalf("expected structured assistant reply, got %+v", response)
	}
}
