package main

import (
	"strings"
	"testing"
)

func TestValidateBootConfigurationNamesEveryMissingVariable(t *testing.T) {
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
	if err == nil || !strings.Contains(err.Error(), "INTERNAL_SERVICE_TOKEN must be at least 32 characters") {
		t.Fatalf("expected short-token error, got %v", err)
	}
}

func TestValidateBootConfigurationAcceptsCompleteEnvironment(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example.invalid/switchos")
	t.Setenv("INTERNAL_SERVICE_TOKEN", strings.Repeat("a", 32))
	if err := validateBootConfiguration(); err != nil {
		t.Fatalf("expected complete environment to pass, got %v", err)
	}
}

func TestLoadConfigAppliesDefaults(t *testing.T) {
	t.Setenv("DATABASE_URL", "postgres://example.invalid/switchos")
	t.Setenv("INTERNAL_SERVICE_TOKEN", strings.Repeat("a", 32))
	t.Setenv("VERIFICATION_INTELLIGENCE_URL", "")
	t.Setenv("PORT", "")
	t.Setenv("BIND_HOST", "")
	cfg := loadConfig()
	if cfg.VerificationIntelligence != "http://127.0.0.1:8106" {
		t.Fatalf("expected default verification intelligence URL, got %q", cfg.VerificationIntelligence)
	}
	if cfg.Port != "8107" {
		t.Fatalf("expected default port 8107, got %q", cfg.Port)
	}
	if cfg.BindHost != "127.0.0.1" {
		t.Fatalf("expected default bind host, got %q", cfg.BindHost)
	}
}
