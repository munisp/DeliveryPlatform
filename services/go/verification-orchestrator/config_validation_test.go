package main

import (
	"strings"
	"testing"
)

func TestValidateBootConfigurationNamesEveryMissingVariable(t *testing.T) {
	for _, name := range requiredEnvironmentVariables {
		t.Setenv(name, "")
	}
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

func TestValidateBootConfigurationAcceptsCompleteEnvironment(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example.invalid/switchos")
	t.Setenv("INTERNAL_SERVICE_TOKEN", strings.Repeat("a", 32))
	t.Setenv("VERIFICATION_INTELLIGENCE_URL", "https://intelligence.example.internal")
	t.Setenv("VERIFICATION_POLICY_URL", "https://policy.example.internal")
	if err := validateBootConfiguration(); err != nil {
		t.Fatalf("expected complete environment to pass, got %v", err)
	}
}
