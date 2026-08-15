package main

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	enumspb "go.temporal.io/api/enums/v1"
)

func TestTemporalBridgeRequestRequiresConfiguredQueueAndIdentity(t *testing.T) {
	request := temporalBridgeRequest{
		WorkflowID:   "refund-1",
		WorkflowType: "refund",
		ResourceID:   "transfer-1",
		Step:         "queued",
		Status:       "PENDING_LEDGER",
		TaskQueue:    "funds-queue",
	}
	input, err := request.workflowInput("funds-queue")
	if err != nil {
		t.Fatalf("validate matching bridge request: %v", err)
	}
	if input.WorkflowID != request.WorkflowID {
		t.Fatalf("unexpected workflow ID %q", input.WorkflowID)
	}
	request.TaskQueue = "untrusted-queue"
	if _, err := request.workflowInput("funds-queue"); err == nil {
		t.Fatal("expected task queue mismatch to be rejected")
	}
}

func TestTemporalFundsWorkflowStartOptionsRejectDuplicateRuns(t *testing.T) {
	options := temporalFundsWorkflowStartOptions(TemporalFundsWorkflowInput{WorkflowID: "workflow-1"}, "funds-queue")
	if options.ID != "workflow-1" || options.TaskQueue != "funds-queue" {
		t.Fatalf("unexpected workflow start identity: %#v", options)
	}
	if options.WorkflowIDReusePolicy != enumspb.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE {
		t.Fatalf("workflow reuse policy must reject duplicates, got %s", options.WorkflowIDReusePolicy)
	}
	if !options.WorkflowExecutionErrorWhenAlreadyStarted {
		t.Fatal("duplicate in-flight workflow starts must return a typed error")
	}
}

func TestTemporalBridgeRejectsUnauthenticatedAndInvalidRequestsBeforeDialing(t *testing.T) {
	service := &MojaloopService{internalServiceToken: "test-internal-token"}
	validBody := `{"workflowId":"workflow-1","workflowType":"transfer","resourceId":"transfer-1","step":"queued","status":"COMMITTED","taskQueue":"funds-queue"}`

	unauthenticated := httptest.NewRequest(http.MethodPost, "/funds/workflows", strings.NewReader(validBody))
	unauthenticatedRecorder := httptest.NewRecorder()
	service.handleTemporalWorkflowBridgeHTTP(unauthenticatedRecorder, unauthenticated)
	if unauthenticatedRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected unauthenticated bridge request to be rejected before dialing Temporal, got %d", unauthenticatedRecorder.Code)
	}

	t.Setenv("TEMPORAL_TASK_QUEUE", "funds-queue")
	invalid := httptest.NewRequest(http.MethodPost, "/funds/workflows", strings.NewReader(`{"workflowId":"workflow-1","taskQueue":"funds-queue","unexpected":true}`))
	invalid.Header.Set("X-Internal-Service-Token", "test-internal-token")
	invalidRecorder := httptest.NewRecorder()
	service.handleTemporalWorkflowBridgeHTTP(invalidRecorder, invalid)
	if invalidRecorder.Code != http.StatusBadRequest {
		t.Fatalf("expected malformed bridge request to be rejected before dialing Temporal, got %d", invalidRecorder.Code)
	}
}
