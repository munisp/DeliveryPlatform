package main

import (
	"encoding/json"
	"errors"
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

	err := gateway.handleAudioSocketFrame(state, frame)
	if !errors.Is(err, errTerminalSessionConflict) {
		t.Fatalf("expected terminal session conflict, got %v", err)
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
