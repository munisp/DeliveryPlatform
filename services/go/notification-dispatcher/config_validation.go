package main

import (
	"fmt"
	"log"
	"os"
	"strings"
)

// requiredEnvironmentVariables enumerates every environment variable the
// service cannot operate correctly without. The static manifest contract
// check (scripts/testing/check-config-contract.py) reads this table to
// cross-check the Kubernetes manifests against the code.
var requiredEnvironmentVariables = []string{
	"DATABASE_URL",
	"INTERNAL_SERVICE_TOKEN",
}

// channelProviderEnvVars maps each dispatch channel to the provider webhook
// URL that enables it. Channels are optional: the dispatcher degrades to the
// configured subset, but the degradation must be loud at boot instead of
// surfacing as silent per-channel dispatch failures.
var channelProviderEnvVars = map[string]string{
	"sms":   "SMS_PROVIDER_URL",
	"email": "EMAIL_PROVIDER_URL",
	"push":  "PUSH_PROVIDER_URL",
	"voice": "VOICE_PROVIDER_URL",
}

// validateBootConfiguration fails fast at startup, naming every missing or
// invalid required environment variable, instead of crash-looping on the
// first use of a half-configured process.
func validateBootConfiguration() error {
	problems := []string{}
	for _, name := range requiredEnvironmentVariables {
		if strings.TrimSpace(os.Getenv(name)) == "" {
			problems = append(problems, fmt.Sprintf("%s is required", name))
		}
	}
	if token := strings.TrimSpace(os.Getenv("INTERNAL_SERVICE_TOKEN")); token != "" && len(token) < 32 {
		problems = append(problems, "INTERNAL_SERVICE_TOKEN must be at least 32 characters")
	}
	if len(problems) > 0 {
		return fmt.Errorf("invalid boot configuration: %s", strings.Join(problems, "; "))
	}
	return nil
}

// disabledChannels returns the dispatch channels whose provider URL is not
// configured, in deterministic order.
func disabledChannels() []string {
	channels := []string{}
	for _, channel := range []string{"sms", "email", "push", "voice"} {
		if strings.TrimSpace(os.Getenv(channelProviderEnvVars[channel])) == "" {
			channels = append(channels, channel)
		}
	}
	return channels
}

// logOptionalDegradations loudly reports every channel disabled by missing
// optional configuration so operators see the degraded surface at boot.
func logOptionalDegradations() {
	for _, channel := range disabledChannels() {
		log.Printf("WARNING: %s is not configured; the %s notification channel is DISABLED and dispatches for it will fail closed", channelProviderEnvVars[channel], channel)
	}
}
