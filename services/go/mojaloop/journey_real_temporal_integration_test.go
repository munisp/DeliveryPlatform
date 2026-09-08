package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/worker"
)

type realJourneyFixtureCall struct {
	Method string
	Path   string
	Header http.Header
	Body   map[string]any
}

func TestRealTemporalJourneyRehearsal(t *testing.T) {
	if os.Getenv("REAL_JOURNEY_TEMPORAL_REHEARSAL") != "1" {
		t.Skip("REAL_JOURNEY_TEMPORAL_REHEARSAL=1 is required for the disposable real Temporal rehearsal")
	}
	address := strings.TrimSpace(os.Getenv("TEMPORAL_ADDRESS"))
	if address == "" {
		t.Fatal("TEMPORAL_ADDRESS is required")
	}
	namespace := strings.TrimSpace(os.Getenv("TEMPORAL_NAMESPACE"))
	if namespace == "" {
		namespace = "default"
	}
	internalToken := "journey-real-temporal-fixture-token-20260908"
	var callsMu sync.Mutex
	calls := make([]realJourneyFixtureCall, 0, 4)
	routeFirstAttempt := make(chan struct{}, 1)
	var routeFirstOnce sync.Once
	fixture := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("X-Internal-Service-Token") != internalToken {
			writer.WriteHeader(http.StatusUnauthorized)
			return
		}
		if request.Header.Get("X-Journey-Workflow-Id") == "" {
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		body := map[string]any{}
		if request.Body != nil {
			_ = json.NewDecoder(request.Body).Decode(&body)
		}
		callsMu.Lock()
		calls = append(calls, realJourneyFixtureCall{Method: request.Method, Path: request.URL.Path, Header: request.Header.Clone(), Body: body})
		callsMu.Unlock()
		switch request.URL.Path {
		case "/inventory/replenishment-request", "/inventory/replenishment-cancel", "/internal/payments/ride-payment-001/reconcile":
			writer.Header().Set("Content-Type", "application/json")
			writer.WriteHeader(http.StatusOK)
			_, _ = writer.Write([]byte(`{"status":"accepted"}`))
		case "/operations/route-plans":
			routeFirstOnce.Do(func() { routeFirstAttempt <- struct{}{} })
			writer.Header().Set("Content-Type", "application/json")
			writer.WriteHeader(http.StatusConflict)
			_, _ = writer.Write([]byte(`{"error":"fixture route plan conflict"}`))
		default:
			writer.WriteHeader(http.StatusNotFound)
		}
	}))
	defer fixture.Close()

	t.Setenv("JOURNEY_INVENTORY_URL", fixture.URL)
	t.Setenv("JOURNEY_DISPATCH_OPTIMIZER_URL", fixture.URL)
	t.Setenv("JOURNEY_PAYMENT_URL", fixture.URL)
	t.Setenv("INTERNAL_SERVICE_TOKEN", internalToken)
	taskQueue := fmt.Sprintf("switchos-real-journey-rehearsal-%d", time.Now().UnixNano())
	t.Setenv("JOURNEY_TEMPORAL_TASK_QUEUE", taskQueue)

	temporalClient, err := client.Dial(client.Options{HostPort: address, Namespace: namespace})
	if err != nil {
		t.Fatalf("dial real Temporal at %s: %v", address, err)
	}
	defer temporalClient.Close()
	startWorker := func() worker.Worker {
		journeyWorker := worker.New(temporalClient, taskQueue, worker.Options{})
		journeyWorker.RegisterWorkflow(JourneyOrchestration)
		journeyWorker.RegisterActivityWithOptions((&JourneyActivities{HTTPClient: fixture.Client()}).ExecuteJourneyAction, activity.RegisterOptions{Name: "ExecuteJourneyAction"})
		if err := journeyWorker.Start(); err != nil {
			t.Fatalf("start real Temporal journey worker: %v", err)
		}
		return journeyWorker
	}
	journeyWorker := startWorker()
	defer journeyWorker.Stop()

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	deliveryWorkflowID := "journey:tenant-real:delivery.warehouse_replenishment:rehearsal"
	deliveryRun, err := temporalClient.ExecuteWorkflow(ctx, client.StartWorkflowOptions{ID: deliveryWorkflowID, TaskQueue: taskQueue}, JourneyOrchestration, TemporalJourneyWorkflowInput{
		WorkflowID: deliveryWorkflowID,
		JourneyID:  "delivery.warehouse_replenishment",
		TenantID:   "tenant-real",
		Inputs: map[string]json.RawMessage{
			string(JourneyActionInventoryReplenish): json.RawMessage(`{"city":"Lagos","skus":[{"sku":"SKU-001","warehouse_id":701,"recommended_units":12}]}`),
			string(JourneyActionRoutePlan):          json.RawMessage(`{"plan":"fixture-conflict"}`),
		},
	})
	if err != nil {
		t.Fatalf("start delivery workflow: %v", err)
	}
	if os.Getenv("REAL_JOURNEY_TEMPORAL_WORKER_RECOVERY") == "1" {
		select {
		case <-routeFirstAttempt:
			journeyWorker.Stop()
			time.Sleep(1500 * time.Millisecond)
			journeyWorker = startWorker()
			defer journeyWorker.Stop()
		case <-ctx.Done():
			t.Fatalf("wait for first route failure before worker recovery: %v", ctx.Err())
		}
	}
	var ignored []JourneyActionResult
	if err := deliveryRun.Get(ctx, &ignored); err == nil {
		t.Fatal("delivery workflow should fail after its compensation completes")
	}

	rideWorkflowID := "journey:tenant-real:ride.driver_payout_release:rehearsal"
	rideRun, err := temporalClient.ExecuteWorkflow(ctx, client.StartWorkflowOptions{ID: rideWorkflowID, TaskQueue: taskQueue}, JourneyOrchestration, TemporalJourneyWorkflowInput{
		WorkflowID: rideWorkflowID,
		JourneyID:  "ride.driver_payout_release",
		TenantID:   "tenant-real",
		Inputs: map[string]json.RawMessage{
			string(JourneyActionPaymentReconcile): json.RawMessage(`{"reference":"ride-payment-001"}`),
		},
	})
	if err != nil {
		t.Fatalf("start ride workflow: %v", err)
	}
	var rideResults []JourneyActionResult
	if err := rideRun.Get(ctx, &rideResults); err != nil {
		t.Fatalf("ride reconciliation workflow: %v", err)
	}
	if len(rideResults) != 1 || rideResults[0].Action != JourneyActionPaymentReconcile || rideResults[0].StatusCode != http.StatusOK {
		t.Fatalf("unexpected ride workflow result: %#v", rideResults)
	}

	callsMu.Lock()
	captured := append([]realJourneyFixtureCall(nil), calls...)
	callsMu.Unlock()
	if len(captured) != 6 {
		t.Fatalf("expected one replenishment, three route retries, one compensation, and one ride reconciliation call, got %#v", captured)
	}
	if captured[0].Path != "/inventory/replenishment-request" || captured[0].Body["workflow_id"] != deliveryWorkflowID {
		t.Fatalf("replenishment request was not bound to delivery workflow: %#v", captured[0])
	}
	if captured[1].Path != "/operations/route-plans" || captured[2].Path != "/operations/route-plans" || captured[3].Path != "/operations/route-plans" {
		t.Fatalf("route-plan retry sequence was not observed: %#v", captured)
	}
	if captured[4].Path != "/inventory/replenishment-cancel" || captured[4].Body["workflow_id"] != deliveryWorkflowID || !strings.HasPrefix(captured[4].Body["compensation_id"].(string), "cmp-") {
		t.Fatalf("delivery compensation was not sent to the exact inventory workflow: %#v", captured[4])
	}
	if captured[4].Header.Get("X-Journey-Workflow-Id") != deliveryWorkflowID {
		t.Fatalf("compensation correlation header is incorrect: %#v", captured[4].Header)
	}
	if captured[5].Path != "/internal/payments/ride-payment-001/reconcile" || captured[5].Header.Get("X-Journey-Workflow-Id") != rideWorkflowID {
		t.Fatalf("ride reconciliation was not separately correlated: %#v", captured[5])
	}
	t.Logf("real Temporal rehearsal passed: namespace=%s, delivery activity retries=%d, compensation=%s, ride reconciliation=%s, workerRecovery=%t", namespace, 3, captured[4].Path, rideResults[0].Action, os.Getenv("REAL_JOURNEY_TEMPORAL_WORKER_RECOVERY") == "1")
}
