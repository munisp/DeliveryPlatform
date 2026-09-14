package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	enumspb "go.temporal.io/api/enums/v1"
	temporalclient "go.temporal.io/sdk/client"
	"go.temporal.io/sdk/temporal"

	"switchos-resilience"
	"go.temporal.io/sdk/workflow"
)

const defaultJourneyTaskQueue = "switchos-journey-workflows"

var journeyIDPattern = regexp.MustCompile(`^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+$`)
var journeyTenantPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$`)
var journeyReferencePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$`)

type JourneyStartRequest struct {
	JourneyID      string                     `json:"journeyId"`
	TenantID       string                     `json:"tenantId"`
	IdempotencyKey string                     `json:"idempotencyKey"`
	Inputs         map[string]json.RawMessage `json:"inputs"`
}

type TemporalJourneyWorkflowInput struct {
	WorkflowID string                     `json:"workflowId"`
	JourneyID  string                     `json:"journeyId"`
	TenantID   string                     `json:"tenantId"`
	Inputs     map[string]json.RawMessage `json:"inputs"`
}

type JourneyActionInvocation struct {
	WorkflowID string          `json:"workflowId"`
	JourneyID  string          `json:"journeyId"`
	TenantID   string          `json:"tenantId"`
	Action     JourneyAction   `json:"action"`
	Input      json.RawMessage `json:"input"`
}

type JourneyActionResult struct {
	Action     JourneyAction `json:"action"`
	StatusCode int           `json:"statusCode"`
	BodySHA256 string        `json:"bodySha256"`
}

type journeyActionSpec struct {
	ServiceEnv      string
	Method          string
	Path            string
	RequiresBody    bool
	PathParameter   string
	CommerceHMAC    bool
	ExpectedSuccess []int
}

func journeyActionSpecs() map[JourneyAction]journeyActionSpec {
	return map[JourneyAction]journeyActionSpec{
		JourneyActionRidePresence:             {ServiceEnv: "JOURNEY_RIDE_MATCHING_URL", Method: http.MethodPost, Path: "/events/driver-presence", RequiresBody: true, ExpectedSuccess: []int{http.StatusAccepted, http.StatusOK}},
		JourneyActionRideLocation:             {ServiceEnv: "JOURNEY_RIDE_MATCHING_URL", Method: http.MethodPost, Path: "/events/driver-location", RequiresBody: true, ExpectedSuccess: []int{http.StatusAccepted, http.StatusOK}},
		JourneyActionRideMatch:                {ServiceEnv: "JOURNEY_RIDE_MATCHING_URL", Method: http.MethodPost, Path: "/matches/attempts", RequiresBody: true, ExpectedSuccess: []int{http.StatusAccepted, http.StatusOK}},
		JourneyActionRideDecline:              {ServiceEnv: "JOURNEY_RIDE_MATCHING_URL", Method: http.MethodPost, Path: "/offers/decline", RequiresBody: true, ExpectedSuccess: []int{http.StatusAccepted, http.StatusOK}},
		JourneyActionRideDisclosure:           {ServiceEnv: "JOURNEY_RIDE_MATCHING_URL", Method: http.MethodPost, Path: "/offers/disclosures", RequiresBody: true, ExpectedSuccess: []int{http.StatusCreated, http.StatusAccepted, http.StatusOK}},
		JourneyActionPricingRideQuote:         {ServiceEnv: "JOURNEY_PRICING_URL", Method: http.MethodPost, Path: "/ride/surge-quote", RequiresBody: true, ExpectedSuccess: []int{http.StatusOK}},
		JourneyActionPricingDeliveryQuote:     {ServiceEnv: "JOURNEY_PRICING_URL", Method: http.MethodPost, Path: "/quote-courier-offer", RequiresBody: true, ExpectedSuccess: []int{http.StatusOK}},
		JourneyActionRouteOptimize:            {ServiceEnv: "JOURNEY_DISPATCH_OPTIMIZER_URL", Method: http.MethodPost, Path: "/optimize", RequiresBody: true, ExpectedSuccess: []int{http.StatusOK}},
		JourneyActionRoutePlan:                {ServiceEnv: "JOURNEY_DISPATCH_OPTIMIZER_URL", Method: http.MethodPost, Path: "/operations/route-plans", RequiresBody: true, ExpectedSuccess: []int{http.StatusCreated, http.StatusAccepted, http.StatusOK}},
		JourneyActionInventoryPosition:        {ServiceEnv: "JOURNEY_INVENTORY_URL", Method: http.MethodGet, Path: "/inventory/position", RequiresBody: false, ExpectedSuccess: []int{http.StatusOK}},
		JourneyActionInventoryReplenish:       {ServiceEnv: "JOURNEY_INVENTORY_URL", Method: http.MethodPost, Path: "/inventory/replenishment-request", RequiresBody: true, ExpectedSuccess: []int{http.StatusCreated, http.StatusAccepted, http.StatusOK}},
		JourneyActionInventoryReplenishCancel: {ServiceEnv: "JOURNEY_INVENTORY_URL", Method: http.MethodPost, Path: "/inventory/replenishment-cancel", RequiresBody: true, ExpectedSuccess: []int{http.StatusOK}},
		JourneyActionVerificationCheck:        {ServiceEnv: "JOURNEY_COMPLIANCE_URL", Method: http.MethodGet, Path: "/drivers/{driver_user_id}/eligibility", RequiresBody: false, PathParameter: "driver_user_id", ExpectedSuccess: []int{http.StatusOK}},
		JourneyActionVerificationPolicy:       {ServiceEnv: "JOURNEY_VERIFICATION_POLICY_URL", Method: http.MethodPost, Path: "/v1/evaluate", RequiresBody: true, ExpectedSuccess: []int{http.StatusOK}},
		JourneyActionPaymentReconcile:         {ServiceEnv: "JOURNEY_PAYMENT_URL", Method: http.MethodPost, Path: "/internal/payments/{reference}/reconcile", RequiresBody: false, PathParameter: "reference", ExpectedSuccess: []int{http.StatusAccepted, http.StatusOK}},
		JourneyActionPayoutRelease:            {ServiceEnv: "JOURNEY_PAYMENT_URL", Method: http.MethodPost, Path: "/internal/payouts/release", RequiresBody: true, ExpectedSuccess: []int{http.StatusAccepted, http.StatusOK}},
		JourneyActionPayoutReconcile:          {ServiceEnv: "JOURNEY_PAYMENT_URL", Method: http.MethodPost, Path: "/internal/payouts/{reference}/reconcile", RequiresBody: false, PathParameter: "reference", ExpectedSuccess: []int{http.StatusAccepted, http.StatusOK}},
		JourneyActionCommerceIngress:          {ServiceEnv: "JOURNEY_CENTRAL_API_URL", Method: http.MethodPost, Path: "/api/internal/commerce/medusa-events", RequiresBody: true, CommerceHMAC: true, ExpectedSuccess: []int{http.StatusAccepted}},
	}
}

func effectiveJourneyTaskQueue() string {
	if value := strings.TrimSpace(os.Getenv("JOURNEY_TEMPORAL_TASK_QUEUE")); value != "" {
		return value
	}
	return defaultJourneyTaskQueue
}

func (r JourneyStartRequest) workflowInput() (TemporalJourneyWorkflowInput, JourneyDefinition, error) {
	journeyID := strings.TrimSpace(r.JourneyID)
	tenantID := strings.TrimSpace(r.TenantID)
	idempotencyKey := strings.TrimSpace(r.IdempotencyKey)
	if !journeyIDPattern.MatchString(journeyID) || !journeyTenantPattern.MatchString(tenantID) || !journeyReferencePattern.MatchString(idempotencyKey) {
		return TemporalJourneyWorkflowInput{}, JourneyDefinition{}, fmt.Errorf("journeyId, tenantId, and idempotencyKey must be bounded identifiers")
	}
	definition, found := JourneyByID(journeyID)
	if !found {
		return TemporalJourneyWorkflowInput{}, JourneyDefinition{}, fmt.Errorf("journeyId is not in the registered catalog")
	}
	if len(r.Inputs) > 32 {
		return TemporalJourneyWorkflowInput{}, JourneyDefinition{}, fmt.Errorf("journey has too many action inputs")
	}
	inputs := make(map[string]json.RawMessage, len(r.Inputs))
	for key, raw := range r.Inputs {
		if _, known := journeyActionSpecs()[JourneyAction(key)]; !known || len(raw) == 0 || len(raw) > 65536 || !json.Valid(raw) {
			return TemporalJourneyWorkflowInput{}, JourneyDefinition{}, fmt.Errorf("invalid action input %q", key)
		}
		inputs[key] = append(json.RawMessage(nil), raw...)
	}
	for _, step := range definition.Steps {
		if step.Required && len(inputs[step.InputKey]) == 0 {
			return TemporalJourneyWorkflowInput{}, JourneyDefinition{}, fmt.Errorf("journey %q requires input for %s", journeyID, step.InputKey)
		}
	}
	return TemporalJourneyWorkflowInput{
		WorkflowID: "journey:" + tenantID + ":" + journeyID + ":" + idempotencyKey,
		JourneyID:  journeyID,
		TenantID:   tenantID,
		Inputs:     inputs,
	}, definition, nil
}

func journeyWorkflowStartOptions(input TemporalJourneyWorkflowInput) temporalclient.StartWorkflowOptions {
	return temporalclient.StartWorkflowOptions{
		ID:                                       input.WorkflowID,
		TaskQueue:                                effectiveJourneyTaskQueue(),
		WorkflowIDReusePolicy:                    enumspb.WORKFLOW_ID_REUSE_POLICY_REJECT_DUPLICATE,
		WorkflowExecutionErrorWhenAlreadyStarted: true,
	}
}

type completedJourneyStep struct {
	Step   JourneyStep
	Result JourneyActionResult
}

func JourneyOrchestration(ctx workflow.Context, input TemporalJourneyWorkflowInput) ([]JourneyActionResult, error) {
	definition, found := JourneyByID(input.JourneyID)
	if !found {
		return nil, temporal.NewNonRetryableApplicationError("journey is not registered", "JourneyDefinitionInvalid", nil)
	}
	activityOptions := workflow.ActivityOptions{
		StartToCloseTimeout: 15 * time.Second,
		RetryPolicy:         &temporal.RetryPolicy{InitialInterval: time.Second, BackoffCoefficient: 2, MaximumInterval: 10 * time.Second, MaximumAttempts: 3},
	}
	ctx = workflow.WithActivityOptions(ctx, activityOptions)
	results := make([]JourneyActionResult, 0, len(definition.Steps))
	completed := make([]completedJourneyStep, 0, len(definition.Steps))
	for _, step := range definition.Steps {
		raw := input.Inputs[step.InputKey]
		if len(raw) == 0 && !step.Required {
			continue
		}
		var result JourneyActionResult
		err := workflow.ExecuteActivity(ctx, "ExecuteJourneyAction", JourneyActionInvocation{
			WorkflowID: input.WorkflowID,
			JourneyID:  input.JourneyID,
			TenantID:   input.TenantID,
			Action:     step.Action,
			Input:      raw,
		}).Get(ctx, &result)
		if err != nil {
			if compensationErr := compensateJourney(ctx, input, completed, err); compensationErr != nil {
				return results, temporal.NewNonRetryableApplicationError("journey step failed and compensation did not complete", "JourneyCompensationFailed", compensationErr)
			}
			return results, temporal.NewNonRetryableApplicationError("journey step failed after completed compensations", "JourneyStepFailed", err)
		}
		results = append(results, result)
		completed = append(completed, completedJourneyStep{Step: step, Result: result})
	}
	return results, nil
}

func compensateJourney(ctx workflow.Context, input TemporalJourneyWorkflowInput, completed []completedJourneyStep, originalFailure error) error {
	for index := len(completed) - 1; index >= 0; index-- {
		completedStep := completed[index]
		if completedStep.Step.Compensation == "" {
			continue
		}
		if !isAuthorizedCompensation(completedStep.Step.Action, completedStep.Step.Compensation) {
			return fmt.Errorf("compensation %q is not authorized for action %q", completedStep.Step.Compensation, completedStep.Step.Action)
		}
		compensationInput, err := buildCompensationInput(input.WorkflowID, completedStep.Step.Action, completedStep.Step.Compensation, originalFailure.Error())
		if err != nil {
			return err
		}
		var ignored JourneyActionResult
		if err := workflow.ExecuteActivity(ctx, "ExecuteJourneyAction", JourneyActionInvocation{
			WorkflowID: input.WorkflowID,
			JourneyID:  input.JourneyID,
			TenantID:   input.TenantID,
			Action:     completedStep.Step.Compensation,
			Input:      compensationInput,
		}).Get(ctx, &ignored); err != nil {
			return err
		}
	}
	return nil
}

func buildCompensationInput(workflowID string, completedAction JourneyAction, compensation JourneyAction, originalFailure string) (json.RawMessage, error) {
	switch {
	case completedAction == JourneyActionInventoryReplenish && compensation == JourneyActionInventoryReplenishCancel:
		digest := sha256.Sum256([]byte(workflowID + ":" + string(completedAction) + ":" + string(compensation)))
		payload, err := json.Marshal(map[string]string{
			"workflow_id":      workflowID,
			"compensation_id":  "cmp-" + hex.EncodeToString(digest[:])[:48],
			"reason":           "journey compensation after a later action failed",
			"original_failure": truncateJourneyFailure(originalFailure, 1024),
		})
		return json.RawMessage(payload), err
	case completedAction == JourneyActionPayoutRelease && compensation == JourneyActionPayoutReconcile:
		return nil, fmt.Errorf("payout release compensation requires a per-payout reconciliation reference and cannot be generated automatically")
	default:
		return nil, fmt.Errorf("compensation %q is not authorized for action %q", compensation, completedAction)
	}
}

func truncateJourneyFailure(value string, limit int) string {
	if len(value) <= limit {
		return value
	}
	return value[:limit]
}

type JourneyActivities struct {
	HTTPClient *http.Client
}

func parseJourneyInput(raw json.RawMessage) (map[string]any, error) {
	var input map[string]any
	if len(raw) == 0 {
		return map[string]any{}, nil
	}
	if err := json.Unmarshal(raw, &input); err != nil || input == nil {
		return nil, fmt.Errorf("action input must be a JSON object")
	}
	return input, nil
}

func serviceBaseURL(environmentKey string) (string, error) {
	value := strings.TrimRight(strings.TrimSpace(os.Getenv(environmentKey)), "/")
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", fmt.Errorf("%s must be an absolute HTTP service URL without userinfo, query, or fragment", environmentKey)
	}
	return value, nil
}

func actionPath(spec journeyActionSpec, input map[string]any) (string, error) {
	if spec.Path == "/inventory/position" {
		warehouseID, warehouseOK := input["warehouse_id"].(float64)
		sku, skuOK := input["sku"].(string)
		if !warehouseOK || warehouseID <= 0 || warehouseID != float64(int64(warehouseID)) || !skuOK || !journeyReferencePattern.MatchString(sku) {
			return "", fmt.Errorf("inventory position requires a positive warehouse_id and bounded sku")
		}
		query := url.Values{}
		query.Set("warehouse_id", strconv.FormatInt(int64(warehouseID), 10))
		query.Set("sku", sku)
		return spec.Path + "?" + query.Encode(), nil
	}
	if spec.PathParameter == "" {
		return spec.Path, nil
	}
	switch spec.PathParameter {
	case "driver_user_id":
		value, ok := input[spec.PathParameter].(float64)
		if !ok || value <= 0 || value != float64(int64(value)) {
			return "", fmt.Errorf("driver_user_id must be a positive integer")
		}
		return strings.Replace(spec.Path, "{driver_user_id}", strconv.FormatInt(int64(value), 10), 1), nil
	case "reference":
		value, ok := input[spec.PathParameter].(string)
		if !ok || !journeyReferencePattern.MatchString(value) {
			return "", fmt.Errorf("reference must be a bounded identifier")
		}
		return strings.Replace(spec.Path, "{reference}", url.PathEscape(value), 1), nil
	default:
		return "", fmt.Errorf("unregistered action path parameter")
	}
}

func isAuthorizedCompensation(primary JourneyAction, compensation JourneyAction) bool {
	return (primary == JourneyActionInventoryReplenish && compensation == JourneyActionInventoryReplenishCancel) ||
		(primary == JourneyActionPayoutRelease && compensation == JourneyActionPayoutReconcile)
}

func journeyRequestBody(spec journeyActionSpec, invocation JourneyActionInvocation, input map[string]any) ([]byte, error) {
	if !spec.RequiresBody {
		return nil, nil
	}
	if invocation.Action != JourneyActionInventoryReplenish {
		return append([]byte(nil), invocation.Input...), nil
	}
	if provided, exists := input["workflow_id"]; exists && provided != invocation.WorkflowID {
		return nil, fmt.Errorf("inventory replenishment workflow_id is assigned by the journey and cannot be overridden")
	}
	bound := make(map[string]any, len(input)+1)
	for key, value := range input {
		bound[key] = value
	}
	bound["workflow_id"] = invocation.WorkflowID
	return json.Marshal(bound)
}

func statusExpected(status int, expected []int) bool {
	for _, allowed := range expected {
		if status == allowed {
			return true
		}
	}
	return false
}

func journeyHMACHeaders(input map[string]any, body []byte, invocation JourneyActionInvocation) (http.Header, error) {
	eventType, ok := input["event_type"].(string)
	if eventType != "commerce.inventory.level.snapshot" && eventType != "commerce.inventory.reservation.snapshot" {
		return nil, fmt.Errorf("commerce ingress requires an inventory snapshot event_type")
	}
	payload, ok := input["payload"].(map[string]any)
	if !ok || payload == nil {
		return nil, fmt.Errorf("commerce ingress requires a payload object")
	}
	payloadType, typeOK := payload["type"].(string)
	payloadData, dataOK := payload["data"].(map[string]any)
	if !typeOK || payloadType != eventType || !dataOK || payloadData == nil {
		return nil, fmt.Errorf("commerce ingress payload must contain matching type and data object")
	}
	canonicalBody, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal commerce payload: %w", err)
	}
	secret := strings.TrimSpace(os.Getenv("JOURNEY_MEDUSA_WEBHOOK_SECRET"))
	storeID := strings.TrimSpace(os.Getenv("JOURNEY_MEDUSA_STORE_ID"))
	if len(secret) < 32 || !journeyTenantPattern.MatchString(storeID) {
		return nil, fmt.Errorf("commerce ingress HMAC secret and store ID must be configured")
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(canonicalBody)
	headers := make(http.Header)
	headers.Set("Content-Type", "application/json")
	headers.Set("X-Medusa-Store-Id", storeID)
	eventIDHash := sha256.Sum256([]byte(invocation.WorkflowID + ":" + string(invocation.Action)))
	headers.Set("X-Medusa-Event-Id", "journey-"+hex.EncodeToString(eventIDHash[:])[:48])
	headers.Set("X-Medusa-Event-Type", eventType)
	headers.Set("X-Medusa-Signature", "sha256="+hex.EncodeToString(mac.Sum(nil)))
	_ = body
	return headers, nil
}

func (a *JourneyActivities) ExecuteJourneyAction(ctx context.Context, invocation JourneyActionInvocation) (JourneyActionResult, error) {
	spec, registered := journeyActionSpecs()[invocation.Action]
	if !registered {
		return JourneyActionResult{}, temporal.NewNonRetryableApplicationError("journey action is not registered", "JourneyActionInvalid", nil)
	}
	input, err := parseJourneyInput(invocation.Input)
	if err != nil {
		return JourneyActionResult{}, temporal.NewNonRetryableApplicationError(err.Error(), "JourneyInputInvalid", nil)
	}
	path, err := actionPath(spec, input)
	if err != nil {
		return JourneyActionResult{}, temporal.NewNonRetryableApplicationError(err.Error(), "JourneyInputInvalid", nil)
	}
	baseURL, err := serviceBaseURL(spec.ServiceEnv)
	if err != nil {
		return JourneyActionResult{}, temporal.NewNonRetryableApplicationError(err.Error(), "JourneyServiceUnavailable", nil)
	}

	body := []byte(nil)
	headers := make(http.Header)
	if spec.CommerceHMAC {
		payload, ok := input["payload"].(map[string]any)
		if !ok || payload == nil {
			return JourneyActionResult{}, temporal.NewNonRetryableApplicationError("commerce ingress requires a payload object", "JourneyInputInvalid", nil)
		}
		body, err = json.Marshal(payload)
		if err != nil {
			return JourneyActionResult{}, temporal.NewNonRetryableApplicationError("commerce ingress payload is not serializable", "JourneyInputInvalid", nil)
		}
		headers, err = journeyHMACHeaders(input, body, invocation)
		if err != nil {
			return JourneyActionResult{}, temporal.NewNonRetryableApplicationError(err.Error(), "JourneyCommerceConfigInvalid", nil)
		}
	} else if spec.RequiresBody {
		body, err = journeyRequestBody(spec, invocation, input)
		if err != nil {
			return JourneyActionResult{}, temporal.NewNonRetryableApplicationError(err.Error(), "JourneyInputInvalid", nil)
		}
		headers.Set("Content-Type", "application/json")
	}
	request, err := http.NewRequestWithContext(ctx, spec.Method, baseURL+path, bytes.NewReader(body))
	if err != nil {
		return JourneyActionResult{}, temporal.NewNonRetryableApplicationError("unable to construct registered action request", "JourneyRequestInvalid", nil)
	}
	for key, values := range headers {
		request.Header[key] = append([]string(nil), values...)
	}
	if !spec.CommerceHMAC {
		token := strings.TrimSpace(os.Getenv("INTERNAL_SERVICE_TOKEN"))
		if len(token) < 32 {
			return JourneyActionResult{}, temporal.NewNonRetryableApplicationError("INTERNAL_SERVICE_TOKEN must be configured", "JourneyServiceConfigInvalid", nil)
		}
		request.Header.Set("X-Internal-Service-Token", token)
	}
	request.Header.Set("X-Journey-Workflow-Id", invocation.WorkflowID)
	request.Header.Set("X-Resilience-Run-Id", invocation.WorkflowID)
	client := a.HTTPClient
	if client == nil {
		client = resilience.NewClient(10*time.Second,
			resilience.RetryPolicy{MaxAttempts: 3, BackoffBase: 100 * time.Millisecond, BackoffMax: 2 * time.Second},
			resilience.BreakerConfig{FailureThreshold: 5, ResetTimeout: 30 * time.Second, HalfOpenMaxProbes: 1})
	}
	response, err := client.Do(request)
	if err != nil {
		return JourneyActionResult{}, fmt.Errorf("execute %s: %w", invocation.Action, err)
	}
	defer response.Body.Close()
	responseBody, readErr := io.ReadAll(io.LimitReader(response.Body, 8192))
	if readErr != nil {
		return JourneyActionResult{}, fmt.Errorf("read %s response: %w", invocation.Action, readErr)
	}
	if !statusExpected(response.StatusCode, spec.ExpectedSuccess) {
		return JourneyActionResult{}, fmt.Errorf("%s returned HTTP %d: %s", invocation.Action, response.StatusCode, strings.TrimSpace(string(responseBody)))
	}
	digest := sha256.Sum256(responseBody)
	return JourneyActionResult{Action: invocation.Action, StatusCode: response.StatusCode, BodySHA256: hex.EncodeToString(digest[:])}, nil
}
