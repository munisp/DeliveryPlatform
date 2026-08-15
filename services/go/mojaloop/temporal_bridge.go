package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"

	enumspb "go.temporal.io/api/enums/v1"
	temporalclient "go.temporal.io/sdk/client"
	"go.temporal.io/sdk/temporal"
)

// temporalBridgeRequest is the authenticated delivery contract between the
// transactional outbox and Temporal. The bridge intentionally only starts the
// already-registered FundsWorkflowOrchestration workflow; it cannot invoke an
// arbitrary workflow or task queue supplied by a caller.
type temporalBridgeRequest struct {
	WorkflowID   string         `json:"workflowId"`
	WorkflowType string         `json:"workflowType"`
	ResourceID   string         `json:"resourceId"`
	Step         string         `json:"step"`
	Status       string         `json:"status"`
	Payload      map[string]any `json:"payload"`
	TaskQueue    string         `json:"taskQueue"`
}

func (r temporalBridgeRequest) workflowInput(expectedTaskQueue string) (TemporalFundsWorkflowInput, error) {
	input := TemporalFundsWorkflowInput{
		WorkflowID:   strings.TrimSpace(r.WorkflowID),
		WorkflowType: strings.TrimSpace(r.WorkflowType),
		ResourceID:   strings.TrimSpace(r.ResourceID),
		Step:         strings.TrimSpace(r.Step),
		Status:       strings.TrimSpace(r.Status),
		Payload:      r.Payload,
	}
	if input.WorkflowID == "" || input.WorkflowType == "" || input.ResourceID == "" || input.Step == "" {
		return TemporalFundsWorkflowInput{}, fmt.Errorf("workflowId, workflowType, resourceId, and step are required")
	}
	if strings.TrimSpace(r.TaskQueue) == "" {
		return TemporalFundsWorkflowInput{}, fmt.Errorf("taskQueue is required")
	}
	if strings.TrimSpace(r.TaskQueue) != expectedTaskQueue {
		return TemporalFundsWorkflowInput{}, fmt.Errorf("taskQueue does not match the bridge configuration")
	}
	if input.Payload == nil {
		input.Payload = map[string]any{}
	}
	return input, nil
}

func temporalFundsWorkflowStartOptions(input TemporalFundsWorkflowInput, taskQueue string) temporalclient.StartWorkflowOptions {
	return temporalclient.StartWorkflowOptions{
		ID:        input.WorkflowID,
		TaskQueue: taskQueue,
		// A completed workflow ID is never reused, and an in-flight ID must
		// return a typed duplicate error. The caller treats that outcome as a
		// successful idempotent replay rather than submitting new work.
		WorkflowIDReusePolicy:                    enumspb.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
		WorkflowExecutionErrorWhenAlreadyStarted: true,
	}
}

func (s *MojaloopService) handleTemporalWorkflowBridgeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		w.Header().Set("Allow", http.MethodPost)
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}

	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	var request temporalBridgeRequest
	if err := decoder.Decode(&request); err != nil {
		http.Error(w, "invalid temporal workflow request", http.StatusBadRequest)
		return
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		http.Error(w, "invalid temporal workflow request", http.StatusBadRequest)
		return
	}

	taskQueue := effectiveTemporalTaskQueue()
	input, err := request.workflowInput(taskQueue)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadRequest)
		return
	}

	client, err := temporalclient.Dial(temporalclient.Options{
		HostPort:  effectiveTemporalHostPort(),
		Namespace: effectiveTemporalNamespace(),
	})
	if err != nil {
		http.Error(w, "temporal is unavailable", http.StatusServiceUnavailable)
		return
	}
	defer client.Close()

	run, err := client.ExecuteWorkflow(r.Context(), temporalFundsWorkflowStartOptions(input, taskQueue), FundsWorkflowOrchestration, input)
	if err != nil {
		if temporal.IsWorkflowExecutionAlreadyStartedError(err) {
			writeJSON(w, http.StatusOK, map[string]any{
				"workflowId": input.WorkflowID,
				"accepted":   true,
				"duplicate":  true,
			})
			return
		}
		http.Error(w, "unable to start temporal workflow", http.StatusServiceUnavailable)
		return
	}

	writeJSON(w, http.StatusAccepted, map[string]any{
		"workflowId": input.WorkflowID,
		"runId":      run.GetRunID(),
		"accepted":   true,
		"duplicate":  false,
	})
}
