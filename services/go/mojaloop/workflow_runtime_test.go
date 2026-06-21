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
	defer func() {
		_ = os.Setenv("DAPR_HTTP_PORT", originalPort)
		_ = os.Setenv("DAPR_PUBSUB_NAME", originalPubsub)
		_ = os.Setenv("DAPR_FUNDS_TOPIC", originalDaprTopic)
		_ = os.Setenv("KAFKA_BROKERS", originalBrokers)
		_ = os.Setenv("KAFKA_FUNDS_TOPIC", originalKafkaTopic)
	}()

	_ = os.Setenv("DAPR_HTTP_PORT", "3500")
	_ = os.Setenv("DAPR_PUBSUB_NAME", "switchos-pubsub")
	_ = os.Setenv("DAPR_FUNDS_TOPIC", "funds-events")
	_ = os.Setenv("KAFKA_BROKERS", "broker-1:9092,broker-2:9092")
	_ = os.Setenv("KAFKA_FUNDS_TOPIC", "switchos.funds")

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
}

func TestDeriveTransferStateFromRefunds(t *testing.T) {
	tests := []struct {
		name           string
		originalAmount float64
		refundedAmount float64
		expected       string
	}{
		{name: "no refunds", originalAmount: 50, refundedAmount: 0, expected: "SETTLED"},
		{name: "partial refund", originalAmount: 50, refundedAmount: 12.5, expected: "PARTIALLY_REFUNDED"},
		{name: "full refund", originalAmount: 50, refundedAmount: 50, expected: "REFUNDED"},
		{name: "over refund clamps to refunded state", originalAmount: 50, refundedAmount: 60, expected: "REFUNDED"},
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
