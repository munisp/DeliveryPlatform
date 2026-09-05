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
