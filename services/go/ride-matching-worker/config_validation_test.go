package main

import (
	"strings"
	"testing"
)

func TestValidateBootConfigurationNamesEveryMissingVariable(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	t.Setenv("REDIS_URL", "")
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

func TestLoadConfigAggregatesMissingVariables(t *testing.T) {
	t.Setenv("DATABASE_URL", "")
	t.Setenv("REDIS_URL", "")
	t.Setenv("INTERNAL_SERVICE_TOKEN", "")
	_, err := loadConfig()
	if err == nil {
		t.Fatal("expected loadConfig to fail on missing configuration")
	}
	for _, name := range requiredEnvironmentVariables {
		if !strings.Contains(err.Error(), name) {
			t.Fatalf("expected loadConfig error to name %s, got %v", name, err)
		}
	}
}

func TestValidateBootConfigurationAcceptsCompleteEnvironment(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example.invalid/switchos")
	t.Setenv("REDIS_URL", "redis://example.invalid/0")
	t.Setenv("INTERNAL_SERVICE_TOKEN", strings.Repeat("a", 32))
	if err := validateBootConfiguration(); err != nil {
		t.Fatalf("expected complete environment to pass, got %v", err)
	}
}
