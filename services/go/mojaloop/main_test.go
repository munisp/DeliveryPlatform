package main

import (
	"strings"
	"testing"
)

func TestNewMojaloopServiceRejectsMissingInternalServiceToken(t *testing.T) {
	t.Setenv("INTERNAL_SERVICE_TOKEN", "")

	_, err := NewMojaloopService(&TigerBeetleClient{})
	if err == nil {
		t.Fatal("expected missing internal service token to be rejected")
	}
	if !strings.Contains(err.Error(), "INTERNAL_SERVICE_TOKEN must be explicitly configured") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestNewMojaloopServiceRejectsPlaceholderInternalServiceToken(t *testing.T) {
	t.Setenv("INTERNAL_SERVICE_TOKEN", insecureInternalServiceToken)

	_, err := NewMojaloopService(&TigerBeetleClient{})
	if err == nil {
		t.Fatal("expected placeholder internal service token to be rejected")
	}
	if !strings.Contains(err.Error(), "INTERNAL_SERVICE_TOKEN must be explicitly configured") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestNewMojaloopServiceRejectsNilLedger(t *testing.T) {
	t.Setenv("INTERNAL_SERVICE_TOKEN", "a-non-placeholder-test-token")

	_, err := NewMojaloopService(nil)
	if err == nil {
		t.Fatal("expected nil TigerBeetle ledger to be rejected")
	}
	if !strings.Contains(err.Error(), "TigerBeetle ledger client is required") {
		t.Fatalf("unexpected error: %v", err)
	}
}

func TestNewTigerBeetleClientRejectsMissingRequiredConfiguration(t *testing.T) {
	t.Setenv("TIGERBEETLE_ADDRESSES", "")
	t.Setenv("TIGERBEETLE_CLUSTER_ID", "")
	t.Setenv("TIGERBEETLE_LEDGER", "")
	t.Setenv("TIGERBEETLE_ACCOUNT_MAP_JSON", "")

	_, err := NewTigerBeetleClient()
	if err == nil {
		t.Fatal("expected missing TigerBeetle configuration to be rejected")
	}
	if !strings.Contains(err.Error(), "TIGERBEETLE_ADDRESSES is required") {
		t.Fatalf("unexpected error: %v", err)
	}
}
