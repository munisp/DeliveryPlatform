package main

import (
	"strings"
	"testing"
)

func TestNewMojaloopServiceRejectsMissingInternalServiceToken(t *testing.T) {
	t.Setenv("INTERNAL_SERVICE_TOKEN", "")

	_, err := NewMojaloopService(nil)
	if err == nil {
		t.Fatal("expected missing internal service token to be rejected")
	}
	if !strings.Contains(err.Error(), "INTERNAL_SERVICE_TOKEN must be explicitly configured") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestNewMojaloopServiceRejectsPlaceholderInternalServiceToken(t *testing.T) {
	t.Setenv("INTERNAL_SERVICE_TOKEN", insecureInternalServiceToken)

	_, err := NewMojaloopService(nil)
	if err == nil {
		t.Fatal("expected placeholder internal service token to be rejected")
	}
	if !strings.Contains(err.Error(), "INTERNAL_SERVICE_TOKEN must be explicitly configured") {
		t.Fatalf("unexpected error: %v", err)
	}
}
