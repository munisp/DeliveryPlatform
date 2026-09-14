package main

import (
	"fmt"
	"os"
	"strings"
)

// requiredEnvironmentVariables enumerates the environment variables every
// mojaloop service mode (http, worker, outbox-worker) cannot operate
// correctly without. Mode-specific requirements are layered on top by
// validateFundsOutboxConfiguration. The static manifest contract check
// (scripts/testing/check-config-contract.py) reads this table to
// cross-check the Kubernetes manifests against the code.
var requiredEnvironmentVariables = []string{
	"DATABASE_URL",
	"INTERNAL_SERVICE_TOKEN",
}

// validateMojaloopBootConfiguration fails fast at startup, naming every
// missing or invalid required environment variable in a single error,
// instead of surfacing one missing variable per crash-loop iteration.
func validateMojaloopBootConfiguration() error {
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
