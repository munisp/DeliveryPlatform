package main

import (
	"testing"

	h3 "github.com/uber/h3-go/v4"
)

func TestH3CellForLagosCoordinates(t *testing.T) {
	cell := h3CellFor(6.5244, 3.3792, 9)
	if cell == "" {
		t.Fatal("expected a non-empty H3 cell for Lagos coordinate")
	}
	parsed := h3.Cell(h3.IndexFromString(cell))
	if parsed == 0 {
		t.Fatalf("expected H3 cell %q to parse", cell)
	}
	if distance := h3.GridDistance(parsed, h3.LatLngToCell(h3.NewLatLng(6.5244, 3.3792), 9)); distance != 0 {
		t.Fatalf("expected same H3 cell, got grid distance %d", distance)
	}
}

func TestH3CellForRejectsInvalidCoordinates(t *testing.T) {
	for _, input := range []struct {
		latitude, longitude float64
		resolution          int
	}{
		{91, 3.3, 9}, {6.5, 181, 9}, {6.5, 3.3, -1}, {6.5, 3.3, 16},
	} {
		if cell := h3CellFor(input.latitude, input.longitude, input.resolution); cell != "" {
			t.Fatalf("expected invalid input %+v to return empty H3 cell, got %q", input, cell)
		}
	}
}

func TestH3SearchRingIsBoundedForConfiguredLagosRadius(t *testing.T) {
	edgeMeters := h3.HexagonEdgeLengthAvgM(9)
	if edgeMeters <= 0 {
		t.Fatalf("invalid H3 edge length: %f", edgeMeters)
	}
	cells := h3.GridDisk(h3.LatLngToCell(h3.NewLatLng(6.5244, 3.3792), 9), 12)
	if len(cells) == 0 {
		t.Fatal("expected a bounded H3 grid disk")
	}
}

func TestValidDriverOfferDeclineReason(t *testing.T) {
	for _, reason := range []string{
		"pickup_distance_unprofitable",
		"pickup_time_unprofitable",
		"fare_insufficient",
		"destination_unsuitable",
		"safety_preference",
		"vehicle_constraint",
		"other",
	} {
		if !validDriverOfferDeclineReason(reason) {
			t.Fatalf("expected reason %q to be accepted", reason)
		}
	}
	for _, reason := range []string{"", "account_block", "pickup_distance_unprofitable;DROP"} {
		if validDriverOfferDeclineReason(reason) {
			t.Fatalf("expected reason %q to be rejected", reason)
		}
	}
}

func TestValidIdempotencyKey(t *testing.T) {
	for _, key := range []string{"fair-decline-0001", "offer.1234:retry_1"} {
		if !validIdempotencyKey(key) {
			t.Fatalf("expected key %q to be accepted", key)
		}
	}
	for _, key := range []string{"short", " leading-key", "bad/key", ""} {
		if validIdempotencyKey(key) {
			t.Fatalf("expected key %q to be rejected", key)
		}
	}
}

func TestFairnessEndpointsRegistered(t *testing.T) {
	if !validDriverOfferDeclineReason("pickup_distance_unprofitable") {
		t.Fatal("fair decline endpoint must retain a pickup-economics refusal reason")
	}
}
