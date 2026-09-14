package main

import (
	"strings"
	"testing"
)

func TestValidateBootConfigurationNamesMissingToken(t *testing.T) {
	t.Setenv("ALERTMANAGER_WEBHOOK_TOKEN", "")
	err := validateBootConfiguration()
	if err == nil || !strings.Contains(err.Error(), "ALERTMANAGER_WEBHOOK_TOKEN") {
		t.Fatalf("expected error to name ALERTMANAGER_WEBHOOK_TOKEN, got %v", err)
	}
}

func TestLoadConfigNamesMissingToken(t *testing.T) {
	t.Setenv("ALERTMANAGER_WEBHOOK_TOKEN", "")
	if _, err := loadConfig(); err == nil || !strings.Contains(err.Error(), "ALERTMANAGER_WEBHOOK_TOKEN") {
		t.Fatalf("expected loadConfig to name ALERTMANAGER_WEBHOOK_TOKEN, got %v", err)
	}
}

func TestLoadConfigAcceptsCompleteEnvironment(t *testing.T) {
	t.Setenv("ALERTMANAGER_WEBHOOK_TOKEN", strings.Repeat("b", 32))
	t.Setenv("LOCAL_RESILIENCE_TEST", "true")
	t.Setenv("KUBERNETES_API_SCHEME", "http")
	if _, err := loadConfig(); err != nil {
		t.Fatalf("expected complete environment to pass, got %v", err)
	}
}
