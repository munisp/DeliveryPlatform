package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"
)

type FundsWorkflowEvent struct {
	WorkflowType string
	WorkflowID   string
	ResourceID   string
	Step         string
	Status       string
	Payload      map[string]any
}

func (s *MojaloopService) ensureWorkflowPersistence() error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS mojaloop_workflows (
			workflow_id TEXT PRIMARY KEY,
			workflow_type TEXT NOT NULL,
			resource_id TEXT NOT NULL,
			current_step TEXT NOT NULL,
			status TEXT NOT NULL,
			last_error TEXT,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS mojaloop_workflow_events (
			id BIGSERIAL PRIMARY KEY,
			workflow_id TEXT NOT NULL,
			workflow_type TEXT NOT NULL,
			resource_id TEXT NOT NULL,
			step TEXT NOT NULL,
			status TEXT NOT NULL,
			payload JSONB NOT NULL DEFAULT '{}'::jsonb,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_mojaloop_workflow_events_workflow_id ON mojaloop_workflow_events (workflow_id, created_at DESC)`,
	}
	for _, statement := range statements {
		if _, err := s.db.Exec(statement); err != nil {
			return fmt.Errorf("ensure mojaloop workflow persistence: %w", err)
		}
	}
	return nil
}

func (s *MojaloopService) recordFundsWorkflowEvent(event FundsWorkflowEvent) error {
	payloadBytes, err := json.Marshal(event.Payload)
	if err != nil {
		return fmt.Errorf("marshal workflow event payload: %w", err)
	}

	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin workflow event transaction: %w", err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	_, err = tx.Exec(
		`INSERT INTO mojaloop_workflows (workflow_id, workflow_type, resource_id, current_step, status, created_at, updated_at)
		 VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
		 ON CONFLICT (workflow_id) DO UPDATE SET
			workflow_type = EXCLUDED.workflow_type,
			resource_id = EXCLUDED.resource_id,
			current_step = EXCLUDED.current_step,
			status = EXCLUDED.status,
			updated_at = NOW()`,
		event.WorkflowID,
		event.WorkflowType,
		event.ResourceID,
		event.Step,
		event.Status,
	)
	if err != nil {
		return fmt.Errorf("upsert workflow state: %w", err)
	}

	_, err = tx.Exec(
		`INSERT INTO mojaloop_workflow_events (workflow_id, workflow_type, resource_id, step, status, payload, created_at)
		 VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())`,
		event.WorkflowID,
		event.WorkflowType,
		event.ResourceID,
		event.Step,
		event.Status,
		string(payloadBytes),
	)
	if err != nil {
		return fmt.Errorf("insert workflow event: %w", err)
	}

	if err = tx.Commit(); err != nil {
		return fmt.Errorf("commit workflow event: %w", err)
	}

	if publishErr := s.publishWorkflowEventToDapr(event); publishErr != nil {
		return publishErr
	}
	return nil
}

func (s *MojaloopService) publishWorkflowEventToDapr(event FundsWorkflowEvent) error {
	daprPort := os.Getenv("DAPR_HTTP_PORT")
	pubsubName := os.Getenv("DAPR_PUBSUB_NAME")
	topicName := os.Getenv("DAPR_FUNDS_TOPIC")
	if daprPort == "" || pubsubName == "" || topicName == "" {
		return nil
	}

	payload := map[string]any{
		"source":       "switchos-mojaloop-service",
		"timestamp":    time.Now().UTC().Format(time.RFC3339),
		"workflowType": event.WorkflowType,
		"workflowId":   event.WorkflowID,
		"resourceId":   event.ResourceID,
		"step":         event.Step,
		"status":       event.Status,
		"payload":      event.Payload,
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal dapr workflow event: %w", err)
	}

	request, err := http.NewRequest(
		http.MethodPost,
		fmt.Sprintf("http://127.0.0.1:%s/v1.0/publish/%s/%s", daprPort, pubsubName, topicName),
		bytes.NewReader(body),
	)
	if err != nil {
		return fmt.Errorf("create dapr workflow event request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")

	response, err := s.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("publish workflow event to dapr: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode >= 400 {
		return fmt.Errorf("publish workflow event to dapr returned status %d", response.StatusCode)
	}
	return nil
}

func (s *MojaloopService) getWorkflowStatus(workflowID string) (map[string]any, bool, error) {
	row := s.db.QueryRow(`SELECT workflow_type, resource_id, current_step, status, last_error, created_at, updated_at FROM mojaloop_workflows WHERE workflow_id = $1`, workflowID)
	var workflowType string
	var resourceID string
	var currentStep string
	var status string
	var lastError sql.NullString
	var createdAt time.Time
	var updatedAt time.Time
	if err := row.Scan(&workflowType, &resourceID, &currentStep, &status, &lastError, &createdAt, &updatedAt); err != nil {
		if err == sql.ErrNoRows {
			return nil, false, nil
		}
		return nil, false, fmt.Errorf("load workflow status: %w", err)
	}
	return map[string]any{
		"workflowId":   workflowID,
		"workflowType": workflowType,
		"resourceId":   resourceID,
		"currentStep":  currentStep,
		"status":       status,
		"lastError":    nullableStringValue(lastError),
		"createdAt":    createdAt,
		"updatedAt":    updatedAt,
	}, true, nil
}

func nullableStringValue(value sql.NullString) any {
	if !value.Valid || value.String == "" {
		return nil
	}
	return value.String
}
