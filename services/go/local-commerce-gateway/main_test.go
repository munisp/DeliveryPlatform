package main

import (
	"testing"
)

func TestIdempotentEventIDIsDeterministicAndBounded(t *testing.T) {
	first := idempotentEventID("order-events:evt-123")
	second := idempotentEventID("order-events:evt-123")
	if first != second {
		t.Fatalf("event id must be deterministic: %q vs %q", first, second)
	}
	other := idempotentEventID("order-events:evt-124")
	if other == first {
		t.Fatal("distinct idempotency keys must yield distinct event ids")
	}
	if len(first) > 64 {
		t.Fatalf("event id is too long: %d", len(first))
	}
}

func TestDecodeStoredPlanRoundTrip(t *testing.T) {
	request := planRequest{Categories: []string{"retail"}, Request: "restock", CustomerSegment: "member"}
	plan := buildPlan(request)
	decoded := decodeStoredPlan(map[string]any{
		"action_plan": plan,
	}["action_plan"])
	if len(decoded) != len(plan) {
		t.Fatalf("decoded %d steps, want %d", len(decoded), len(plan))
	}
	for i := range plan {
		if decoded[i] != plan[i] {
			t.Fatalf("step %d mismatch: %+v vs %+v", i, decoded[i], plan[i])
		}
	}
	if decoded := decodeStoredPlan("not-a-plan"); decoded != nil {
		t.Fatalf("expected nil for undecodable payload, got %+v", decoded)
	}
}
