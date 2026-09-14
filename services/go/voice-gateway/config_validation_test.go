package main

import (
	"strings"
	"testing"
)

func TestValidateBootConfigurationNamesEveryMissingVariable(t *testing.T) {
	// t.Setenv cannot unset, so point the process at an empty environment by
	// clearing the two required variables explicitly.
	t.Setenv("DATABASE_URL", "")
	t.Setenv("INTERNAL_SERVICE_TOKEN", "")
	err := validateBootConfiguration()
	if err == nil {
		t.Fatal("expected missing configuration to fail")
	}
	for _, name := range requiredEnvironmentVariables {
		if !strings.Contains(err.Error(), name) {
			t.Fatalf("expected error to name %s, got %v", name, err)
		}
	}
}

func TestValidateBootConfigurationRejectsShortToken(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example.invalid/switchos")
	t.Setenv("INTERNAL_SERVICE_TOKEN", "too-short")
	err := validateBootConfiguration()
	if err == nil || !strings.Contains(err.Error(), "INTERNAL_SERVICE_TOKEN") {
		t.Fatalf("expected short token to be rejected, got %v", err)
	}
}

func TestValidateBootConfigurationAcceptsCompleteEnvironment(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example.invalid/switchos")
	t.Setenv("INTERNAL_SERVICE_TOKEN", strings.Repeat("a", 32))
	if err := validateBootConfiguration(); err != nil {
		t.Fatalf("expected complete environment to pass, got %v", err)
	}
}
