package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestPublishWorkflowEventToDaprPublishesExpectedEnvelope(t *testing.T) {
	received := make(chan map[string]any, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer r.Body.Close()
		if r.Method != http.MethodPost {
			t.Fatalf("expected POST, got %s", r.Method)
		}
		if r.URL.Path != "/v1.0/publish/switchos-pubsub/funds-events" {
			t.Fatalf("unexpected dapr path: %s", r.URL.Path)
		}
		var payload map[string]any
		if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
			t.Fatalf("decode payload: %v", err)
		}
		received <- payload
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	hostPort := server.URL[len("http://127.0.0.1:"):]
	if hostPort == server.URL {
		t.Fatalf("expected loopback httptest URL, got %s", server.URL)
	}

	originalPort := os.Getenv("DAPR_HTTP_PORT")
	originalPubsub := os.Getenv("DAPR_PUBSUB_NAME")
	originalTopic := os.Getenv("DAPR_FUNDS_TOPIC")
	defer func() {
		_ = os.Setenv("DAPR_HTTP_PORT", originalPort)
		_ = os.Setenv("DAPR_PUBSUB_NAME", originalPubsub)
		_ = os.Setenv("DAPR_FUNDS_TOPIC", originalTopic)
	}()

	_ = os.Setenv("DAPR_HTTP_PORT", hostPort)
	_ = os.Setenv("DAPR_PUBSUB_NAME", "switchos-pubsub")
	_ = os.Setenv("DAPR_FUNDS_TOPIC", "funds-events")

	service := &MojaloopService{httpClient: server.Client()}
	err := service.publishWorkflowEventToDapr(FundsWorkflowEvent{
		WorkflowType: "refund",
		WorkflowID:   "refund-1",
		ResourceID:   "transfer-1",
		Step:         "completed",
		Status:       "COMPLETED",
		Payload: map[string]any{
			"amount":   15.25,
			"currency": "EUR",
		},
	})
	if err != nil {
		t.Fatalf("publish workflow event: %v", err)
	}

	payload := <-received
	if payload["workflowType"] != "refund" {
		t.Fatalf("expected workflowType refund, got %v", payload["workflowType"])
	}
	if payload["workflowId"] != "refund-1" {
		t.Fatalf("expected workflowId refund-1, got %v", payload["workflowId"])
	}
	if payload["resourceId"] != "transfer-1" {
		t.Fatalf("expected resourceId transfer-1, got %v", payload["resourceId"])
	}
}

func TestPublishWorkflowEventToDaprSkipsWhenUnconfigured(t *testing.T) {
	originalPort := os.Getenv("DAPR_HTTP_PORT")
	originalPubsub := os.Getenv("DAPR_PUBSUB_NAME")
	originalTopic := os.Getenv("DAPR_FUNDS_TOPIC")
	defer func() {
		_ = os.Setenv("DAPR_HTTP_PORT", originalPort)
		_ = os.Setenv("DAPR_PUBSUB_NAME", originalPubsub)
		_ = os.Setenv("DAPR_FUNDS_TOPIC", originalTopic)
	}()

	_ = os.Unsetenv("DAPR_HTTP_PORT")
	_ = os.Unsetenv("DAPR_PUBSUB_NAME")
	_ = os.Unsetenv("DAPR_FUNDS_TOPIC")

	service := &MojaloopService{httpClient: http.DefaultClient}
	if err := service.publishWorkflowEventToDapr(FundsWorkflowEvent{WorkflowType: "transfer", WorkflowID: "transfer-1"}); err != nil {
		t.Fatalf("expected nil error when Dapr is unconfigured, got %v", err)
	}
}

func TestPublishWorkflowEventToKafkaSkipsWhenUnconfigured(t *testing.T) {
	originalBrokers := os.Getenv("KAFKA_BROKERS")
	originalTopic := os.Getenv("KAFKA_FUNDS_TOPIC")
	defer func() {
		_ = os.Setenv("KAFKA_BROKERS", originalBrokers)
		_ = os.Setenv("KAFKA_FUNDS_TOPIC", originalTopic)
	}()

	_ = os.Unsetenv("KAFKA_BROKERS")
	_ = os.Unsetenv("KAFKA_FUNDS_TOPIC")

	service := &MojaloopService{httpClient: http.DefaultClient}
	if err := service.publishWorkflowEventToKafka(FundsWorkflowEvent{WorkflowType: "transfer", WorkflowID: "transfer-1"}); err != nil {
		t.Fatalf("expected nil error when Kafka is unconfigured, got %v", err)
	}
}

func TestFundsMiddlewareStatusReflectsConfiguration(t *testing.T) {
	originalPort := os.Getenv("DAPR_HTTP_PORT")
	originalPubsub := os.Getenv("DAPR_PUBSUB_NAME")
	originalDaprTopic := os.Getenv("DAPR_FUNDS_TOPIC")
	originalBrokers := os.Getenv("KAFKA_BROKERS")
	originalKafkaTopic := os.Getenv("KAFKA_FUNDS_TOPIC")
	originalFluvioBrokers := os.Getenv("FLUVIO_KAFKA_BROKERS")
	originalFluvioTopic := os.Getenv("FLUVIO_FUNDS_TOPIC")
	originalTemporalTaskQueue := os.Getenv("TEMPORAL_TASK_QUEUE")
	originalTemporalBridgeURL := os.Getenv("TEMPORAL_BRIDGE_URL")
	defer func() {
		_ = os.Setenv("DAPR_HTTP_PORT", originalPort)
		_ = os.Setenv("DAPR_PUBSUB_NAME", originalPubsub)
		_ = os.Setenv("DAPR_FUNDS_TOPIC", originalDaprTopic)
		_ = os.Setenv("KAFKA_BROKERS", originalBrokers)
		_ = os.Setenv("KAFKA_FUNDS_TOPIC", originalKafkaTopic)
		_ = os.Setenv("FLUVIO_KAFKA_BROKERS", originalFluvioBrokers)
		_ = os.Setenv("FLUVIO_FUNDS_TOPIC", originalFluvioTopic)
		_ = os.Setenv("TEMPORAL_TASK_QUEUE", originalTemporalTaskQueue)
		_ = os.Setenv("TEMPORAL_BRIDGE_URL", originalTemporalBridgeURL)
	}()

	_ = os.Setenv("DAPR_HTTP_PORT", "3500")
	_ = os.Setenv("DAPR_PUBSUB_NAME", "switchos-pubsub")
	_ = os.Setenv("DAPR_FUNDS_TOPIC", "funds-events")
	_ = os.Setenv("KAFKA_BROKERS", "broker-1:9092,broker-2:9092")
	_ = os.Setenv("KAFKA_FUNDS_TOPIC", "switchos.funds")
	_ = os.Setenv("FLUVIO_KAFKA_BROKERS", "fluvio-gateway:9093")
	_ = os.Setenv("FLUVIO_FUNDS_TOPIC", "switchos.funds.fluvio")
	_ = os.Setenv("TEMPORAL_TASK_QUEUE", "switchos-funds-workflows")
	_ = os.Setenv("TEMPORAL_BRIDGE_URL", "http://temporal-bridge:8080")

	service := &MojaloopService{httpClient: http.DefaultClient}
	status := service.fundsMiddlewareStatus()

	dapr, ok := status["dapr"].(map[string]any)
	if !ok || dapr["configured"] != true {
		t.Fatalf("expected dapr configured status, got %#v", status["dapr"])
	}
	kafkaStatus, ok := status["kafka"].(map[string]any)
	if !ok || kafkaStatus["configured"] != true {
		t.Fatalf("expected kafka configured status, got %#v", status["kafka"])
	}
	brokers, ok := kafkaStatus["brokers"].([]string)
	if !ok || len(brokers) != 2 {
		t.Fatalf("expected two kafka brokers, got %#v", kafkaStatus["brokers"])
	}
	if kafkaStatus["topic"] != "switchos.funds" {
		t.Fatalf("expected kafka topic switchos.funds, got %#v", kafkaStatus["topic"])
	}
	fluvioStatus, ok := status["fluvio"].(map[string]any)
	if !ok || fluvioStatus["configured"] != true {
		t.Fatalf("expected fluvio configured status, got %#v", status["fluvio"])
	}
	fluvioBrokers, ok := fluvioStatus["brokers"].([]string)
	if !ok || len(fluvioBrokers) != 1 || fluvioBrokers[0] != "fluvio-gateway:9093" {
		t.Fatalf("expected fluvio broker fluvio-gateway:9093, got %#v", fluvioStatus["brokers"])
	}
	if fluvioStatus["topic"] != "switchos.funds.fluvio" {
		t.Fatalf("expected fluvio topic switchos.funds.fluvio, got %#v", fluvioStatus["topic"])
	}
	temporalStatus, ok := status["temporal"].(map[string]any)
	if !ok || temporalStatus["configured"] != true {
		t.Fatalf("expected temporal configured status, got %#v", status["temporal"])
	}
	if temporalStatus["taskQueue"] != "switchos-funds-workflows" {
		t.Fatalf("expected temporal task queue switchos-funds-workflows, got %#v", temporalStatus["taskQueue"])
	}
	if temporalStatus["bridgeUrl"] != "http://temporal-bridge:8080" {
		t.Fatalf("expected temporal bridge URL http://temporal-bridge:8080, got %#v", temporalStatus["bridgeUrl"])
	}
}

func TestPublishWorkflowEventToFluvioSkipsWhenUnconfigured(t *testing.T) {
	originalBrokers := os.Getenv("FLUVIO_KAFKA_BROKERS")
	originalTopic := os.Getenv("FLUVIO_FUNDS_TOPIC")
	defer func() {
		_ = os.Setenv("FLUVIO_KAFKA_BROKERS", originalBrokers)
		_ = os.Setenv("FLUVIO_FUNDS_TOPIC", originalTopic)
	}()

	_ = os.Unsetenv("FLUVIO_KAFKA_BROKERS")
	_ = os.Unsetenv("FLUVIO_FUNDS_TOPIC")

	service := &MojaloopService{httpClient: http.DefaultClient}
	if err := service.publishWorkflowEventToFluvio(FundsWorkflowEvent{WorkflowType: "refund", WorkflowID: "refund-1"}); err != nil {
		t.Fatalf("expected nil error when Fluvio is unconfigured, got %v", err)
	}
}

func TestTemporalTargetPrefersQueueAndBridgeDescription(t *testing.T) {
	actual := temporalTarget("switchos-funds-workflows", "http://temporal-bridge:8080")
	if actual != "switchos-funds-workflows via http://temporal-bridge:8080" {
		t.Fatalf("unexpected temporal target %q", actual)
	}
}

func TestDispatchTemporalWorkflowIntentAuthenticatesBridge(t *testing.T) {
	requestCount := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestCount++
		if r.Method != http.MethodPost || r.URL.Path != "/funds/workflows" {
			t.Fatalf("unexpected Temporal bridge request %s %s", r.Method, r.URL.Path)
		}
		if r.Header.Get("X-Internal-Service-Token") != "bridge-token" {
			t.Fatalf("Temporal bridge did not receive the configured internal token")
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()

	service := &MojaloopService{httpClient: server.Client(), internalServiceToken: "bridge-token"}
	if err := service.dispatchTemporalWorkflowIntent(server.URL, []byte(`{"workflowId":"workflow-1"}`)); err != nil {
		t.Fatalf("dispatch authenticated Temporal workflow intent: %v", err)
	}
	if requestCount != 1 {
		t.Fatalf("expected one authenticated bridge request, got %d", requestCount)
	}

	service.internalServiceToken = ""
	if err := service.dispatchTemporalWorkflowIntent(server.URL, []byte(`{}`)); err == nil {
		t.Fatal("expected missing internal token to reject the Temporal dispatch")
	}
	if requestCount != 1 {
		t.Fatalf("missing token attempted bridge dispatch; request count=%d", requestCount)
	}
}

func TestDeriveTransferStateFromRefunds(t *testing.T) {
	tests := []struct {
		name           string
		originalAmount uint64
		refundedAmount uint64
		expected       string
	}{
		{name: "no refunds", originalAmount: 5000, refundedAmount: 0, expected: "SETTLED"},
		{name: "partial refund", originalAmount: 5000, refundedAmount: 1250, expected: "PARTIALLY_REFUNDED"},
		{name: "full refund", originalAmount: 5000, refundedAmount: 5000, expected: "REFUNDED"},
		{name: "over refund clamps to refunded state", originalAmount: 5000, refundedAmount: 6000, expected: "REFUNDED"},
	}

	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			actual := deriveTransferStateFromRefunds(testCase.originalAmount, testCase.refundedAmount)
			if actual != testCase.expected {
				t.Fatalf("expected %s, got %s", testCase.expected, actual)
			}
		})
	}
}

func TestIsRefundableTransferState(t *testing.T) {
	if !isRefundableTransferState("SETTLED") {
		t.Fatal("expected SETTLED to be refundable")
	}
	if !isRefundableTransferState("partially_refunded") {
		t.Fatal("expected PARTIALLY_REFUNDED to be refundable")
	}
	if isRefundableTransferState("RESERVED") {
		t.Fatal("expected RESERVED not to be refundable")
	}
}
