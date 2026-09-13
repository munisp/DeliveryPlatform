package main

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/segmentio/kafka-go"
)

// TestFundsWorkflowEventLiveKafkaRehearsal is an infrastructure-gated rehearsal
// that exercises the real production publish path
// (publishWorkflowEventToKafkaCompatible, RequireAll acks, synchronous writer)
// against a live Kafka-compatible broker and consumes the message back to
// verify key, headers, and envelope integrity. It is skipped unless
// LIVE_KAFKA_BROKERS (comma-separated broker list) and LIVE_KAFKA_TOPIC are
// set, so default unit/CI runs remain hermetic. It proves broker-visible
// durability of the funds workflow event stream; it does not replace the
// PostgreSQL outbox claim/fence suite, which runs in every non-short test run.
func TestFundsWorkflowEventLiveKafkaRehearsal(t *testing.T) {
	brokersValue := strings.TrimSpace(os.Getenv("LIVE_KAFKA_BROKERS"))
	topic := strings.TrimSpace(os.Getenv("LIVE_KAFKA_TOPIC"))
	if brokersValue == "" || topic == "" {
		t.Skip("LIVE_KAFKA_BROKERS and LIVE_KAFKA_TOPIC must target a live Kafka-compatible broker")
	}
	brokers := splitAndTrim(brokersValue)

	// Ensure the rehearsal topic exists on the live broker.
	dialCtx, dialCancel := context.WithTimeout(context.Background(), 10*time.Second)
	conn, err := kafka.DialContext(dialCtx, "tcp", brokers[0])
	dialCancel()
	if err != nil {
		t.Fatalf("dial live broker %s: %v", brokers[0], err)
	}
	defer conn.Close()
	_ = conn.SetDeadline(time.Now().Add(10 * time.Second))
	err = conn.CreateTopics(kafka.TopicConfig{Topic: topic, NumPartitions: 1, ReplicationFactor: 1})
	if err != nil && !strings.Contains(err.Error(), "Topic with this name already exists") &&
		!strings.Contains(err.Error(), "topic already exists") {
		t.Fatalf("create rehearsal topic %s: %v", topic, err)
	}

	event := FundsWorkflowEvent{
		WorkflowType: "funds-transfer",
		WorkflowID:   "live-kafka-rehearsal-" + time.Now().UTC().Format("20060102150405"),
		ResourceID:   "transfer-live-rehearsal-1",
		Step:         "ledger-commit",
		Status:       "committed",
		Payload: map[string]any{
			"amount":   "1250",
			"currency": "USD",
			"payerFsp": "payer-live-rehearsal",
			"payeeFsp": "payee-live-rehearsal",
		},
	}

	service := &MojaloopService{}
	if err := service.publishWorkflowEventToKafkaCompatible(brokers, topic, event, "kafka"); err != nil {
		t.Fatalf("publish via production code path to live broker: %v", err)
	}

	reader := kafka.NewReader(kafka.ReaderConfig{
		Brokers:   brokers,
		Topic:     topic,
		Partition: 0,
		MinBytes:  1,
		MaxBytes:  1 << 20,
		MaxWait:   2 * time.Second,
	})
	defer reader.Close()

	readCtx, readCancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer readCancel()
	for {
		message, err := reader.FetchMessage(readCtx)
		if err != nil {
			t.Fatalf("consume rehearsal message from live broker: %v", err)
		}
		if string(message.Key) != event.WorkflowID {
			// Rehearsal topics may hold prior runs; scan until our message.
			continue
		}

		headers := map[string]string{}
		for _, header := range message.Headers {
			headers[header.Key] = string(header.Value)
		}
		if headers["workflow-type"] != event.WorkflowType ||
			headers["workflow-step"] != event.Step ||
			headers["workflow-status"] != event.Status ||
			headers["workflow-broker"] != "kafka" {
			t.Fatalf("unexpected rehearsal headers: %+v", headers)
		}

		var envelope map[string]any
		if err := json.Unmarshal(message.Value, &envelope); err != nil {
			t.Fatalf("unmarshal rehearsal envelope: %v", err)
		}
		if envelope["workflowId"] != event.WorkflowID ||
			envelope["resourceId"] != event.ResourceID ||
			envelope["status"] != event.Status ||
			envelope["source"] != "switchos-mojaloop-service" {
			t.Fatalf("unexpected rehearsal envelope: %+v", envelope)
		}
		payload, ok := envelope["payload"].(map[string]any)
		if !ok || payload["amount"] != "1250" || payload["currency"] != "USD" {
			t.Fatalf("unexpected rehearsal payload: %+v", envelope["payload"])
		}
		t.Logf("live broker round-trip verified: topic=%s partition=%d offset=%d key=%s",
			topic, message.Partition, message.Offset, message.Key)
		return
	}
}
