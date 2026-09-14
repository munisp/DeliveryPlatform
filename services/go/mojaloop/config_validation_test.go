package main

import (
	"strings"
	"testing"
)

func TestValidateMojaloopBootConfigurationNamesEveryMissingVariable(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	t.Setenv("INTERNAL_SERVICE_TOKEN", "")
	err := validateMojaloopBootConfiguration()
	if err == nil {
		t.Fatal("expected missing configuration to fail")
	}
	for _, name := range requiredEnvironmentVariables {
		if !strings.Contains(err.Error(), name) {
			t.Fatalf("expected error to name %s, got %v", name, err)
		}
	}
}

func TestValidateMojaloopBootConfigurationAcceptsCompleteEnvironment(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example.invalid/switchos")
	t.Setenv("INTERNAL_SERVICE_TOKEN", strings.Repeat("a", 32))
	if err := validateMojaloopBootConfiguration(); err != nil {
		t.Fatalf("expected complete environment to pass, got %v", err)
	}
}
