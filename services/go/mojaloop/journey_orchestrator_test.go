package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/testsuite"
)

func TestJourneyCatalogHasTwentyScenariosPerVertical(t *testing.T) {
	catalog := JourneyCatalog()
	if len(catalog) != 60 {
		t.Fatalf("expected 60 reusable journeys, got %d", len(catalog))
	}
	if err := ValidateJourneyCatalog(catalog); err != nil {
		t.Fatalf("journey catalog validation failed: %v", err)
	}
	actions := journeyActionSpecs()
	for _, journey := range catalog {
		for _, journeyStep := range journey.Steps {
			if _, found := actions[journeyStep.Action]; !found {
				t.Fatalf("journey %q references unregistered action %q", journey.ID, journeyStep.Action)
			}
		}
	}
}

func TestJourneyStartInputRejectsUnregisteredActionAndCreatesStableWorkflowIdentity(t *testing.T) {
	request := JourneyStartRequest{
		JourneyID:      "delivery.merchant_stockout",
		TenantID:       "tenant-001",
		IdempotencyKey: "order-1001",
		Inputs: map[string]json.RawMessage{
			"inventory_position":  json.RawMessage(`{"warehouse_id":11,"sku":"sku-1001"}`),
			"inventory_replenish": json.RawMessage(`{"city":"Lagos","skus":[{"sku":"sku-1001"}]}`),
		},
	}
	input, definition, err := request.workflowInput()
	if err != nil {
		t.Fatalf("validate registered journey: %v", err)
	}
	if definition.ID != request.JourneyID || input.WorkflowID != "journey:tenant-001:delivery.merchant_stockout:order-1001" {
		t.Fatalf("unexpected journey identity: %#v %#v", definition, input)
	}
	options := journeyWorkflowStartOptions(input)
	if options.TaskQueue != defaultJourneyTaskQueue || options.WorkflowIDReusePolicy != enumspb.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE || !options.WorkflowExecutionErrorWhenAlreadyStarted {
		t.Fatalf("journey start options must use a fixed duplicate-safe queue: %#v", options)
	}
	request.Inputs["unregistered_action"] = json.RawMessage(`{}`)
	if _, _, err := request.workflowInput(); err == nil {
		t.Fatal("unregistered action input must be rejected")
	}
}

func TestJourneyInventoryActionUsesFixedEndpointAndValidatedQuery(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet || r.URL.Path != "/inventory/position" || r.URL.RawQuery != "sku=sku-1001&warehouse_id=9" {
			t.Fatalf("unexpected inventory request %s %s", r.Method, r.URL.String())
		}
		if r.Header.Get("X-Internal-Service-Token") != "a-journey-internal-token-with-at-least-32-bytes" {
			t.Fatal("inventory action omitted internal service token")
		}
		if r.Header.Get("X-Journey-Workflow-Id") != "journey:tenant-001:delivery.merchant_order_intake:key-100" {
			t.Fatal("inventory action omitted workflow correlation ID")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"inventory":{"available_units":4}}`)
	}))
	defer server.Close()
	t.Setenv("JOURNEY_INVENTORY_URL", server.URL)
	t.Setenv("INTERNAL_SERVICE_TOKEN", "a-journey-internal-token-with-at-least-32-bytes")
	activity := JourneyActivities{HTTPClient: server.Client()}
	result, err := activity.ExecuteJourneyAction(context.Background(), JourneyActionInvocation{
		WorkflowID: "journey:tenant-001:delivery.merchant_order_intake:key-100",
		JourneyID:  "delivery.merchant_order_intake",
		TenantID:   "tenant-001",
		Action:     JourneyActionInventoryPosition,
		Input:      json.RawMessage(`{"warehouse_id":9,"sku":"sku-1001"}`),
	})
	if err != nil {
		t.Fatalf("execute inventory action: %v", err)
	}
	if result.Action != JourneyActionInventoryPosition || result.StatusCode != http.StatusOK || len(result.BodySHA256) != 64 {
		t.Fatalf("unexpected inventory action result: %#v", result)
	}
}

func TestJourneyCommerceActionSignsCanonicalPayloadAndRejectsArbitraryHost(t *testing.T) {
	secret := "journey-commerce-secret-with-at-least-32-bytes"
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Fatalf("read commerce body: %v", err)
		}
		if r.URL.Path != "/api/internal/commerce/medusa-events" || r.Method != http.MethodPost || r.Header.Get("X-Medusa-Store-Id") != "store-001" || r.Header.Get("X-Medusa-Event-Type") != "commerce.inventory.level.snapshot" {
			t.Fatalf("unexpected commerce request: %s %s %#v", r.Method, r.URL.Path, r.Header)
		}
		mac := hmac.New(sha256.New, []byte(secret))
		_, _ = mac.Write(body)
		expectedSignature := "sha256=" + hex.EncodeToString(mac.Sum(nil))
		if !hmac.Equal([]byte(r.Header.Get("X-Medusa-Signature")), []byte(expectedSignature)) {
			t.Fatalf("commerce signature mismatch: got %q expected %q", r.Header.Get("X-Medusa-Signature"), expectedSignature)
		}
		if !strings.HasPrefix(r.Header.Get("X-Medusa-Event-Id"), "journey-") || len(r.Header.Get("X-Medusa-Event-Id")) != 56 {
			t.Fatalf("unexpected deterministic event ID %q", r.Header.Get("X-Medusa-Event-Id"))
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()
	t.Setenv("JOURNEY_CENTRAL_API_URL", server.URL)
	t.Setenv("JOURNEY_MEDUSA_STORE_ID", "store-001")
	t.Setenv("JOURNEY_MEDUSA_WEBHOOK_SECRET", secret)
	activity := JourneyActivities{HTTPClient: server.Client()}
	_, err := activity.ExecuteJourneyAction(context.Background(), JourneyActionInvocation{
		WorkflowID: "journey:tenant-001:delivery.merchant_inventory_reservation:key-100",
		JourneyID:  "delivery.merchant_inventory_reservation",
		TenantID:   "tenant-001",
		Action:     JourneyActionCommerceIngress,
		Input: json.RawMessage(`{
			"event_type":"commerce.inventory.level.snapshot",
			"payload":{"type":"commerce.inventory.level.snapshot","data":{"inventory_level_id":"ilev_001","inventory_item_id":"iitem_001","stock_location_id":"sloc_001","stocked_quantity":10,"reserved_quantity":2,"incoming_quantity":0,"source_updated_at":"2026-09-08T00:00:00Z"}}
		}`),
	})
	if err != nil {
		t.Fatalf("execute signed commerce action: %v", err)
	}
	t.Setenv("JOURNEY_CENTRAL_API_URL", "https://user:password@example.invalid")
	_, err = activity.ExecuteJourneyAction(context.Background(), JourneyActionInvocation{
		WorkflowID: "journey:tenant-001:delivery.merchant_inventory_reservation:key-101",
		JourneyID:  "delivery.merchant_inventory_reservation",
		TenantID:   "tenant-001",
		Action:     JourneyActionCommerceIngress,
		Input:      json.RawMessage(`{"event_type":"commerce.inventory.level.snapshot","payload":{"type":"commerce.inventory.level.snapshot","data":{}}}`),
	})
	if err == nil {
		t.Fatal("journey activity must reject a configured URL containing userinfo")
	}
}

func TestJourneyWorkflowExecutesRegisteredStepsInOrder(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	environment := suite.NewTestWorkflowEnvironment()
	var lock sync.Mutex
	executed := make([]JourneyAction, 0, 2)
	environment.RegisterActivityWithOptions(func(_ context.Context, invocation JourneyActionInvocation) (JourneyActionResult, error) {
		lock.Lock()
		executed = append(executed, invocation.Action)
		lock.Unlock()
		return JourneyActionResult{Action: invocation.Action, StatusCode: http.StatusOK, BodySHA256: strings.Repeat("0", 64)}, nil
	}, activity.RegisterOptions{Name: "ExecuteJourneyAction"})
	environment.ExecuteWorkflow(JourneyOrchestration, TemporalJourneyWorkflowInput{
		WorkflowID: "journey:tenant-001:delivery.consumer_quote:key-001",
		JourneyID:  "delivery.consumer_quote",
		TenantID:   "tenant-001",
		Inputs: map[string]json.RawMessage{
			"pricing_delivery_quote": json.RawMessage(`{"order_id":"order-1001"}`),
			"route_optimize":         json.RawMessage(`{"route_id":"route-1001"}`),
		},
	})
	if !environment.IsWorkflowCompleted() || environment.GetWorkflowError() != nil {
		t.Fatalf("registered journey did not complete: %v", environment.GetWorkflowError())
	}
	var results []JourneyActionResult
	if err := environment.GetWorkflowResult(&results); err != nil {
		t.Fatalf("read journey workflow result: %v", err)
	}
	if len(results) != 2 || len(executed) != 2 || executed[0] != JourneyActionPricingDeliveryQuote || executed[1] != JourneyActionRouteOptimize {
		t.Fatalf("unexpected action order: results=%#v executed=%#v", results, executed)
	}
}

func TestInventoryCompensationActionBindsWorkflowAndUsesFixedEndpoint(t *testing.T) {
	workflowID := "journey:tenant-001:delivery.warehouse_replenishment:binding-001"
	requests := make([]struct {
		Path string
		Body map[string]any
	}, 0, 2)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-Internal-Service-Token") != "a-journey-internal-token-with-at-least-32-bytes" || request.Header.Get("X-Journey-Workflow-Id") != workflowID {
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		var body map[string]any
		if err := json.NewDecoder(request.Body).Decode(&body); err != nil {
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		requests = append(requests, struct {
			Path string
			Body map[string]any
		}{Path: request.URL.Path, Body: body})
		writer.Header().Set("Content-Type", "application/json")
		writer.WriteHeader(http.StatusOK)
		_, _ = writer.Write([]byte(`{"status":"ok"}`))
	}))
	defer server.Close()
	t.Setenv("JOURNEY_INVENTORY_URL", server.URL)
	t.Setenv("INTERNAL_SERVICE_TOKEN", "a-journey-internal-token-with-at-least-32-bytes")
	activities := &JourneyActivities{HTTPClient: server.Client()}
	_, err := activities.ExecuteJourneyAction(context.Background(), JourneyActionInvocation{
		WorkflowID: workflowID,
		JourneyID:  "delivery.warehouse_replenishment",
		TenantID:   "tenant-001",
		Action:     JourneyActionInventoryReplenish,
		Input:      json.RawMessage(`{"city":"Lagos","skus":[{"sku":"SKU-001","warehouse_id":7,"recommended_units":10}]}`),
	})
	if err != nil {
		t.Fatalf("execute replenishment action: %v", err)
	}
	compensation, err := buildCompensationInput(workflowID, JourneyActionInventoryReplenish, JourneyActionInventoryReplenishCancel, "route plan failed")
	if err != nil {
		t.Fatalf("build compensation: %v", err)
	}
	_, err = activities.ExecuteJourneyAction(context.Background(), JourneyActionInvocation{
		WorkflowID: workflowID,
		JourneyID:  "delivery.warehouse_replenishment",
		TenantID:   "tenant-001",
		Action:     JourneyActionInventoryReplenishCancel,
		Input:      compensation,
	})
	if err != nil {
		t.Fatalf("execute replenishment compensation: %v", err)
	}
	if len(requests) != 2 || requests[0].Path != "/inventory/replenishment-request" || requests[1].Path != "/inventory/replenishment-cancel" {
		t.Fatalf("unexpected fixed inventory endpoints: %#v", requests)
	}
	if requests[0].Body["workflow_id"] != workflowID || requests[1].Body["workflow_id"] != workflowID || !strings.HasPrefix(requests[1].Body["compensation_id"].(string), "cmp-") {
		t.Fatalf("inventory compensation was not bound to the originating workflow: %#v", requests)
	}
}

func TestJourneyFailureRunsReverseInventoryCompensation(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	environment := suite.NewTestWorkflowEnvironment()
	invocations := make([]JourneyActionInvocation, 0, 3)
	environment.RegisterActivityWithOptions(func(_ context.Context, invocation JourneyActionInvocation) (JourneyActionResult, error) {
		invocations = append(invocations, invocation)
		if invocation.Action == JourneyActionRoutePlan {
			return JourneyActionResult{}, temporal.NewNonRetryableApplicationError("route planner rejected fixture", "RoutePlanRejected", nil)
		}
		return JourneyActionResult{Action: invocation.Action, StatusCode: http.StatusOK, BodySHA256: strings.Repeat("0", 64)}, nil
	}, activity.RegisterOptions{Name: "ExecuteJourneyAction"})
	workflowID := "journey:tenant-001:delivery.warehouse_replenishment:rollback-001"
	environment.ExecuteWorkflow(JourneyOrchestration, TemporalJourneyWorkflowInput{
		WorkflowID: workflowID,
		JourneyID:  "delivery.warehouse_replenishment",
		TenantID:   "tenant-001",
		Inputs: map[string]json.RawMessage{
			string(JourneyActionInventoryReplenish): json.RawMessage(`{"city":"Lagos","skus":[{"sku":"SKU-001","warehouse_id":7,"recommended_units":10}]}`),
			string(JourneyActionRoutePlan):          json.RawMessage(`{"plan":"will-fail"}`),
		},
	})
	if !environment.IsWorkflowCompleted() {
		t.Fatal("workflow did not complete")
	}
	if environment.GetWorkflowError() == nil {
		t.Fatal("workflow should report the original route-plan failure after compensation")
	}
	if len(invocations) != 3 || invocations[0].Action != JourneyActionInventoryReplenish || invocations[1].Action != JourneyActionRoutePlan || invocations[2].Action != JourneyActionInventoryReplenishCancel {
		t.Fatalf("unexpected saga action order: %#v", invocations)
	}
	var compensation map[string]string
	if err := json.Unmarshal(invocations[2].Input, &compensation); err != nil {
		t.Fatalf("read compensation input: %v", err)
	}
	if compensation["workflow_id"] != workflowID || !strings.HasPrefix(compensation["compensation_id"], "cmp-") || compensation["reason"] == "" || compensation["original_failure"] == "" {
		t.Fatalf("compensation input is not safely bound to failed workflow: %#v", compensation)
	}
}

func TestJourneyCompensationFailureIsTerminal(t *testing.T) {
	var suite testsuite.WorkflowTestSuite
	environment := suite.NewTestWorkflowEnvironment()
	environment.RegisterActivityWithOptions(func(_ context.Context, invocation JourneyActionInvocation) (JourneyActionResult, error) {
		switch invocation.Action {
		case JourneyActionRoutePlan:
			return JourneyActionResult{}, temporal.NewNonRetryableApplicationError("route planner rejected fixture", "RoutePlanRejected", nil)
		case JourneyActionInventoryReplenishCancel:
			return JourneyActionResult{}, temporal.NewNonRetryableApplicationError("inventory cancellation conflict", "InventoryCancellationConflict", nil)
		default:
			return JourneyActionResult{Action: invocation.Action, StatusCode: http.StatusOK, BodySHA256: strings.Repeat("0", 64)}, nil
		}
	}, activity.RegisterOptions{Name: "ExecuteJourneyAction"})
	environment.ExecuteWorkflow(JourneyOrchestration, TemporalJourneyWorkflowInput{
		WorkflowID: "journey:tenant-001:delivery.warehouse_replenishment:rollback-002",
		JourneyID:  "delivery.warehouse_replenishment",
		TenantID:   "tenant-001",
		Inputs: map[string]json.RawMessage{
			string(JourneyActionInventoryReplenish): json.RawMessage(`{"city":"Lagos","skus":[{"sku":"SKU-001","warehouse_id":7,"recommended_units":10}]}`),
			string(JourneyActionRoutePlan):          json.RawMessage(`{"plan":"will-fail"}`),
		},
	})
	var applicationError *temporal.ApplicationError
	if !errors.As(environment.GetWorkflowError(), &applicationError) || applicationError.Type() != "JourneyCompensationFailed" {
		t.Fatalf("expected terminal compensation failure, got %v", environment.GetWorkflowError())
	}
}

func TestFinancialRollbackIsNeverGeneratedAutomatically(t *testing.T) {
	if _, err := buildCompensationInput("journey:tenant:ride.driver_payout_release:key", JourneyActionPayoutRelease, JourneyActionPayoutReconcile, "subsequent failure"); err == nil {
		t.Fatal("payout release must not generate an automatic reversal or hold request")
	}
	for _, definition := range JourneyCatalog() {
		for _, item := range definition.Steps {
			if item.Action == JourneyActionPayoutRelease || item.Compensation == JourneyActionPayoutReconcile {
				t.Fatalf("catalog must not use automatic payout release or reversal: %+v", definition)
			}
		}
	}
}

func TestEveryRegisteredJourneyExecutesItsActionSequence(t *testing.T) {
	for _, definition := range JourneyCatalog() {
		definition := definition
		t.Run(definition.ID, func(t *testing.T) {
			var suite testsuite.WorkflowTestSuite
			environment := suite.NewTestWorkflowEnvironment()
			executed := make([]JourneyAction, 0, len(definition.Steps))
			environment.RegisterActivityWithOptions(func(_ context.Context, invocation JourneyActionInvocation) (JourneyActionResult, error) {
				executed = append(executed, invocation.Action)
				return JourneyActionResult{Action: invocation.Action, StatusCode: http.StatusOK, BodySHA256: strings.Repeat("0", 64)}, nil
			}, activity.RegisterOptions{Name: "ExecuteJourneyAction"})
			inputs := make(map[string]json.RawMessage, len(definition.Steps))
			for _, item := range definition.Steps {
				inputs[item.InputKey] = json.RawMessage(`{"fixture":true}`)
			}
			environment.ExecuteWorkflow(JourneyOrchestration, TemporalJourneyWorkflowInput{
				WorkflowID: "journey:tenant-001:" + definition.ID + ":coverage-001",
				JourneyID:  definition.ID,
				TenantID:   "tenant-001",
				Inputs:     inputs,
			})
			if !environment.IsWorkflowCompleted() || environment.GetWorkflowError() != nil {
				t.Fatalf("journey workflow did not complete: %v", environment.GetWorkflowError())
			}
			if len(executed) != len(definition.Steps) {
				t.Fatalf("journey executed %d of %d registered steps", len(executed), len(definition.Steps))
			}
			for index, item := range definition.Steps {
				if executed[index] != item.Action {
					t.Fatalf("step %d action mismatch: got %q want %q", index, executed[index], item.Action)
				}
			}
		})
	}
}

func TestJourneyCatalogEndpointRequiresInternalAccessAndReturnsCatalog(t *testing.T) {
	service := &MojaloopService{internalServiceToken: "a-journey-internal-token-with-at-least-32-bytes"}
	unauthorized := httptest.NewRequest(http.MethodGet, "/journeys/catalog", nil)
	unauthorizedRecorder := httptest.NewRecorder()
	service.handleJourneyCatalogHTTP(unauthorizedRecorder, unauthorized)
	if unauthorizedRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected catalog to require internal access, got %d", unauthorizedRecorder.Code)
	}
	authorized := httptest.NewRequest(http.MethodGet, "/journeys/catalog", nil)
	authorized.Header.Set("X-Internal-Service-Token", "a-journey-internal-token-with-at-least-32-bytes")
	authorizedRecorder := httptest.NewRecorder()
	service.handleJourneyCatalogHTTP(authorizedRecorder, authorized)
	if authorizedRecorder.Code != http.StatusOK {
		t.Fatalf("expected authorized catalog request to succeed, got %d", authorizedRecorder.Code)
	}
	var response struct {
		Journeys []JourneyDefinition `json:"journeys"`
	}
	if err := json.Unmarshal(authorizedRecorder.Body.Bytes(), &response); err != nil || len(response.Journeys) != 60 {
		t.Fatalf("unexpected catalog response: err=%v journeys=%d", err, len(response.Journeys))
	}
}

func TestJourneyBridgeRejectsUnauthorizedAndMalformedInputBeforeTemporalDial(t *testing.T) {
	service := &MojaloopService{internalServiceToken: "a-journey-internal-token-with-at-least-32-bytes"}
	unauthorized := httptest.NewRequest(http.MethodPost, "/journeys/start", strings.NewReader(`{}`))
	unauthorizedRecorder := httptest.NewRecorder()
	service.handleJourneyStartHTTP(unauthorizedRecorder, unauthorized)
	if unauthorizedRecorder.Code != http.StatusUnauthorized {
		t.Fatalf("expected unauthorized journey start to be rejected before temporal dial, got %d", unauthorizedRecorder.Code)
	}
	invalid := httptest.NewRequest(http.MethodPost, "/journeys/start", strings.NewReader(`{"journeyId":"delivery.merchant_stockout","tenantId":"tenant-001","idempotencyKey":"key-001","unexpected":true}`))
	invalid.Header.Set("X-Internal-Service-Token", "a-journey-internal-token-with-at-least-32-bytes")
	invalidRecorder := httptest.NewRecorder()
	service.handleJourneyStartHTTP(invalidRecorder, invalid)
	if invalidRecorder.Code != http.StatusBadRequest {
		t.Fatalf("expected malformed journey start to be rejected before temporal dial, got %d", invalidRecorder.Code)
	}
}
