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

func TestDisabledChannelsReflectProviderConfiguration(t *testing.T) {
	t.Setenv("SMS_PROVIDER_URL", "")
	t.Setenv("EMAIL_PROVIDER_URL", "https://provider.example/email")
	t.Setenv("PUSH_PROVIDER_URL", "")
	t.Setenv("VOICE_PROVIDER_URL", "https://provider.example/voice")
	disabled := disabledChannels()
	if len(disabled) != 2 || disabled[0] != "sms" || disabled[1] != "push" {
		t.Fatalf("expected sms and push to be disabled, got %v", disabled)
	}
}
