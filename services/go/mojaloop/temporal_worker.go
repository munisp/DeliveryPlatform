package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"go.temporal.io/sdk/activity"
	temporalclient "go.temporal.io/sdk/client"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

const defaultTemporalFundsTaskQueue = "switchos-funds-workflows"

// TemporalFundsWorkflowInput mirrors the existing workflow event envelope persisted by the
// Mojaloop workflow runtime so that queued orchestration records can be replayed by a native
// Temporal worker when the Temporal stack is available.
type TemporalFundsWorkflowInput struct {
	WorkflowID   string         `json:"workflowId"`
	WorkflowType string         `json:"workflowType"`
	ResourceID   string         `json:"resourceId"`
	Step         string         `json:"step"`
	Status       string         `json:"status"`
	Payload      map[string]any `json:"payload"`
}

type TemporalFundsWorkflowActivities struct {
	Service *MojaloopService
}

func (a *TemporalFundsWorkflowActivities) PersistOrchestrationStatus(ctx context.Context, input TemporalFundsWorkflowInput, status string, lastError string) error {
	if a == nil || a.Service == nil || a.Service.db == nil {
		return fmt.Errorf("temporal activity service database is not configured")
	}

	payloadBytes, err := json.Marshal(map[string]any{
		"workflowId":   input.WorkflowID,
		"workflowType": input.WorkflowType,
		"resourceId":   input.ResourceID,
		"step":         input.Step,
		"status":       input.Status,
		"payload":      input.Payload,
	})
	if err != nil {
		return fmt.Errorf("marshal orchestration payload: %w", err)
	}

	updateResult, err := a.Service.db.ExecContext(
		ctx,
		`UPDATE mojaloop_workflow_orchestration
		 SET status = $1,
		     payload = $2::jsonb,
		     last_error = $3,
		     updated_at = NOW()
		 WHERE workflow_id = $4
		   AND orchestrator = 'temporal'`,
		status,
		string(payloadBytes),
		nullableDBString(lastError),
		input.WorkflowID,
	)
	if err != nil {
		return fmt.Errorf("update temporal orchestration state: %w", err)
	}

	if rowsAffected, _ := updateResult.RowsAffected(); rowsAffected == 0 {
		if _, err := a.Service.db.ExecContext(
			ctx,
			`INSERT INTO mojaloop_workflow_orchestration (
				workflow_id, workflow_type, resource_id, orchestrator, target, status, payload, last_error, created_at, updated_at
			) VALUES ($1, $2, $3, 'temporal', $4, $5, $6::jsonb, $7, NOW(), NOW())`,
			input.WorkflowID,
			input.WorkflowType,
			input.ResourceID,
			effectiveTemporalTaskQueue(),
			status,
			string(payloadBytes),
			nullableDBString(lastError),
		); err != nil {
			return fmt.Errorf("insert temporal orchestration state: %w", err)
		}
	}

	return nil
}

func (a *TemporalFundsWorkflowActivities) PersistWorkflowHistory(ctx context.Context, input TemporalFundsWorkflowInput, status string, lastError string) error {
	if a == nil || a.Service == nil || a.Service.db == nil {
		return fmt.Errorf("temporal activity service database is not configured")
	}

	if _, err := a.Service.db.ExecContext(
		ctx,
		`INSERT INTO mojaloop_workflows (
			workflow_id, workflow_type, resource_id, current_step, status, last_error, created_at, updated_at
		 ) VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())
		 ON CONFLICT (workflow_id) DO UPDATE
		 SET current_step = EXCLUDED.current_step,
		     status = EXCLUDED.status,
		     last_error = EXCLUDED.last_error,
		     updated_at = NOW()`,
		input.WorkflowID,
		input.WorkflowType,
		input.ResourceID,
		input.Step,
		status,
		nullableDBString(lastError),
	); err != nil {
		return fmt.Errorf("persist workflow history: %w", err)
	}

	return nil
}

func FundsWorkflowOrchestration(ctx workflow.Context, input TemporalFundsWorkflowInput) error {
	activityOptions := workflow.ActivityOptions{
		StartToCloseTimeout: 30 * time.Second,
		RetryPolicy: &temporal.RetryPolicy{
			InitialInterval:    time.Second,
			BackoffCoefficient: 2,
			MaximumInterval:    10 * time.Second,
			MaximumAttempts:    5,
		},
	}
	ctx = workflow.WithActivityOptions(ctx, activityOptions)

	if err := workflow.ExecuteActivity(ctx, "PersistOrchestrationStatus", input, "running", "").Get(ctx, nil); err != nil {
		return err
	}
	if err := workflow.ExecuteActivity(ctx, "PersistWorkflowHistory", input, "running", "").Get(ctx, nil); err != nil {
		return err
	}

	terminalStatus := strings.TrimSpace(strings.ToLower(input.Status))
	if terminalStatus == "" {
		terminalStatus = "submitted"
	}

	if terminalStatus == "failed" {
		workflowErr := "workflow event was marked failed before Temporal execution"
		if err := workflow.ExecuteActivity(ctx, "PersistOrchestrationStatus", input, "failed", workflowErr).Get(ctx, nil); err != nil {
			return err
		}
		if err := workflow.ExecuteActivity(ctx, "PersistWorkflowHistory", input, "failed", workflowErr).Get(ctx, nil); err != nil {
			return err
		}
		return temporal.NewApplicationError(workflowErr, "FundsWorkflowFailed")
	}

	if err := workflow.ExecuteActivity(ctx, "PersistOrchestrationStatus", input, "completed", "").Get(ctx, nil); err != nil {
		return err
	}
	if err := workflow.ExecuteActivity(ctx, "PersistWorkflowHistory", input, "completed", "").Get(ctx, nil); err != nil {
		return err
	}
	return nil
}

func effectiveTemporalTaskQueue() string {
	taskQueue := strings.TrimSpace(os.Getenv("TEMPORAL_TASK_QUEUE"))
	if taskQueue == "" {
		return defaultTemporalFundsTaskQueue
	}
	return taskQueue
}

func effectiveTemporalHostPort() string {
	hostPort := strings.TrimSpace(os.Getenv("TEMPORAL_ADDRESS"))
	if hostPort == "" {
		return "127.0.0.1:7233"
	}
	return hostPort
}

func effectiveTemporalNamespace() string {
	namespace := strings.TrimSpace(os.Getenv("TEMPORAL_NAMESPACE"))
	if namespace == "" {
		return temporalclient.DefaultNamespace
	}
	return namespace
}

func RunTemporalWorker(ctx context.Context, service *MojaloopService) error {
	if service == nil || service.db == nil {
		return fmt.Errorf("temporal worker requires an initialized mojaloop service")
	}

	client, err := temporalclient.Dial(temporalclient.Options{
		HostPort:  effectiveTemporalHostPort(),
		Namespace: effectiveTemporalNamespace(),
	})
	if err != nil {
		return fmt.Errorf("dial temporal client: %w", err)
	}
	defer client.Close()

	fundsWorker := worker.New(client, effectiveTemporalTaskQueue(), worker.Options{})
	fundsActivities := &TemporalFundsWorkflowActivities{Service: service}
	fundsWorker.RegisterWorkflowWithOptions(FundsWorkflowOrchestration, workflow.RegisterOptions{Name: "FundsWorkflowOrchestration"})
	fundsWorker.RegisterActivityWithOptions(fundsActivities.PersistOrchestrationStatus, activity.RegisterOptions{Name: "PersistOrchestrationStatus"})
	fundsWorker.RegisterActivityWithOptions(fundsActivities.PersistWorkflowHistory, activity.RegisterOptions{Name: "PersistWorkflowHistory"})
	if err := fundsWorker.Start(); err != nil {
		return fmt.Errorf("start funds temporal worker: %w", err)
	}
	defer fundsWorker.Stop()

	journeyWorker := worker.New(client, effectiveJourneyTaskQueue(), worker.Options{})
	journeyActivities := &JourneyActivities{}
	journeyWorker.RegisterWorkflowWithOptions(JourneyOrchestration, workflow.RegisterOptions{Name: "JourneyOrchestration"})
	journeyWorker.RegisterActivityWithOptions(journeyActivities.ExecuteJourneyAction, activity.RegisterOptions{Name: "ExecuteJourneyAction"})
	if err := journeyWorker.Start(); err != nil {
		return fmt.Errorf("start journey temporal worker: %w", err)
	}
	defer journeyWorker.Stop()

	<-ctx.Done()
	return nil
}

func LoadPendingTemporalWorkflowTasks(ctx context.Context, db *sql.DB, limit int) ([]TemporalFundsWorkflowInput, error) {
	if db == nil {
		return nil, fmt.Errorf("temporal workflow loader requires a database connection")
	}
	if limit <= 0 {
		limit = 50
	}

	rows, err := db.QueryContext(
		ctx,
		`SELECT workflow_id, workflow_type, resource_id, payload
		 FROM mojaloop_workflow_orchestration
		 WHERE orchestrator = 'temporal'
		   AND status IN ('queued', 'submitted')
		 ORDER BY updated_at ASC
		 LIMIT $1`,
		limit,
	)
	if err != nil {
		return nil, fmt.Errorf("query pending temporal tasks: %w", err)
	}
	defer rows.Close()

	pending := make([]TemporalFundsWorkflowInput, 0, limit)
	for rows.Next() {
		var workflowID, workflowType, resourceID string
		var payloadBytes []byte
		if err := rows.Scan(&workflowID, &workflowType, &resourceID, &payloadBytes); err != nil {
			return nil, fmt.Errorf("scan pending temporal task: %w", err)
		}

		payload := TemporalFundsWorkflowInput{
			WorkflowID:   workflowID,
			WorkflowType: workflowType,
			ResourceID:   resourceID,
		}
		if len(payloadBytes) > 0 {
			var stored map[string]any
			if err := json.Unmarshal(payloadBytes, &stored); err != nil {
				return nil, fmt.Errorf("decode pending temporal payload: %w", err)
			}
			if step, ok := stored["step"].(string); ok {
				payload.Step = step
			}
			if status, ok := stored["status"].(string); ok {
				payload.Status = status
			}
			if workflowTypeValue, ok := stored["workflowType"].(string); ok && strings.TrimSpace(workflowTypeValue) != "" {
				payload.WorkflowType = workflowTypeValue
			}
			if resourceIDValue, ok := stored["resourceId"].(string); ok && strings.TrimSpace(resourceIDValue) != "" {
				payload.ResourceID = resourceIDValue
			}
			if workflowIDValue, ok := stored["workflowId"].(string); ok && strings.TrimSpace(workflowIDValue) != "" {
				payload.WorkflowID = workflowIDValue
			}
			if payloadMap, ok := stored["payload"].(map[string]any); ok {
				payload.Payload = payloadMap
			}
		}
		pending = append(pending, payload)
	}

	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate pending temporal tasks: %w", err)
	}
	return pending, nil
}
