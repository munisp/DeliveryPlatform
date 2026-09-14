package main

import (
	"fmt"
	"os"
	"strings"
)

// requiredEnvironmentVariables enumerates every environment variable the
// receiver cannot operate correctly without. The static manifest contract
// check (scripts/testing/check-config-contract.py) reads this table to
// cross-check the Kubernetes manifests against the code.
var requiredEnvironmentVariables = []string{
	"ALERTMANAGER_WEBHOOK_TOKEN",
}

// validateBootConfiguration fails fast at startup, naming every missing or
// invalid required environment variable, instead of rejecting the process
// with an opaque "invalid configuration" error.
func validateBootConfiguration() error {
	problems := []string{}
	for _, name := range requiredEnvironmentVariables {
		if strings.TrimSpace(os.Getenv(name)) == "" {
			problems = append(problems, fmt.Sprintf("%s is required", name))
		}
	}
	if token := strings.TrimSpace(os.Getenv("ALERTMANAGER_WEBHOOK_TOKEN")); token != "" && len(token) < 32 {
		problems = append(problems, "ALERTMANAGER_WEBHOOK_TOKEN must be at least 32 characters")
	}
	if len(problems) > 0 {
		return fmt.Errorf("invalid boot configuration: %s", strings.Join(problems, "; "))
	}
	return nil
}
