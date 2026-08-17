package main

import (
	"strings"
	"testing"
)

func TestRequiredFundsOutboxDestinationsRejectIncompleteDestinationConfiguration(t *testing.T) {
	cases := []struct {
		name        string
		destination string
		configure   func(*testing.T)
		message     string
	}{
		{
			name:        "Dapr",
			destination: "tigerbeetle,dapr",
			configure: func(t *testing.T) {
				t.Setenv("DAPR_HTTP_PORT", "")
				t.Setenv("DAPR_PUBSUB_NAME", "switchos")
				t.Setenv("DAPR_FUNDS_TOPIC", "funds")
			},
			message: "required dapr outbox destination",
		},
		{
			name:        "Kafka",
			destination: "tigerbeetle,kafka",
			configure: func(t *testing.T) {
				t.Setenv("KAFKA_BROKERS", "")
				t.Setenv("KAFKA_FUNDS_TOPIC", "funds")
			},
			message: "required kafka outbox destination",
		},
		{
			name:        "Fluvio",
			destination: "tigerbeetle,fluvio",
			configure: func(t *testing.T) {
				t.Setenv("FLUVIO_KAFKA_BROKERS", "")
				t.Setenv("FLUVIO_FUNDS_TOPIC", "funds")
			},
			message: "required fluvio outbox destination",
		},
		{
			name:        "Temporal",
			destination: "tigerbeetle,temporal",
			configure: func(t *testing.T) {
				t.Setenv("TEMPORAL_BRIDGE_URL", "")
				t.Setenv("TEMPORAL_TASK_QUEUE", "funds")
			},
			message: "required temporal outbox destination",
		},
	}

	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			t.Setenv("FUNDS_OUTBOX_DESTINATIONS", testCase.destination)
			testCase.configure(t)
			_, err := destinationsForFundsEvent(FundsWorkflowEvent{WorkflowType: "transfer"})
			if err == nil || !strings.Contains(err.Error(), testCase.message) {
				t.Fatalf("expected %q configuration error, got %v", testCase.message, err)
			}
		})
	}
}

func TestRequiredFundsOutboxDestinationsAcceptCompleteDestinationConfiguration(t *testing.T) {
	t.Setenv("FUNDS_OUTBOX_DESTINATIONS", "tigerbeetle,dapr,kafka,fluvio,temporal")
	t.Setenv("DAPR_HTTP_PORT", "3500")
	t.Setenv("DAPR_PUBSUB_NAME", "switchos")
	t.Setenv("DAPR_FUNDS_TOPIC", "funds")
	t.Setenv("KAFKA_BROKERS", "broker:9092")
	t.Setenv("KAFKA_FUNDS_TOPIC", "funds")
	t.Setenv("FLUVIO_KAFKA_BROKERS", "fluvio:9092")
	t.Setenv("FLUVIO_FUNDS_TOPIC", "funds")
	t.Setenv("TEMPORAL_BRIDGE_URL", "http://temporal-bridge:8080")
	t.Setenv("TEMPORAL_TASK_QUEUE", "funds")

	destinations, err := destinationsForFundsEvent(FundsWorkflowEvent{WorkflowType: "transfer"})
	if err != nil {
		t.Fatalf("accept complete required destinations: %v", err)
	}
	if len(destinations) != 5 {
		t.Fatalf("expected five destinations, got %#v", destinations)
	}
}
