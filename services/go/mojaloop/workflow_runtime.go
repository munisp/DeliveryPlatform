package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/segmentio/kafka-go"
)

type FundsWorkflowEvent struct {
	WorkflowType string
	WorkflowID   string
	ResourceID   string
	Step         string
	Status       string
	Payload      map[string]any
}

type ReconciliationOverview struct {
	TransferCount         int        `json:"transferCount"`
	RefundCount           int        `json:"refundCount"`
	SettledTransfers      int        `json:"settledTransfers"`
	PartiallyRefunded     int        `json:"partiallyRefundedTransfers"`
	FullyRefunded         int        `json:"fullyRefundedTransfers"`
	InconsistentAudits    int        `json:"inconsistentAudits"`
	GrossTransferredMinor uint64     `json:"grossTransferredMinor"`
	RefundedMinor         uint64     `json:"refundedMinor"`
	NetSettledMinor       uint64     `json:"netSettledMinor"`
	LastReconciledAt      *time.Time `json:"lastReconciledAt,omitempty"`
	Recommendation        string     `json:"recommendation"`
}

func (s *MojaloopService) recordFundsWorkflowEvent(event FundsWorkflowEvent) error {
	tx, err := s.db.Begin()
	if err != nil {
		return fmt.Errorf("begin workflow event transaction: %w", err)
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()

	if err = s.persistFundsWorkflowEvent(tx, event); err != nil {
		return err
	}

	if err = tx.Commit(); err != nil {
		return fmt.Errorf("commit workflow event: %w", err)
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

	body, err := json.Marshal(s.workflowEnvelope(event))
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

func (s *MojaloopService) publishWorkflowEventToKafka(event FundsWorkflowEvent) error {
	brokers := strings.TrimSpace(os.Getenv("KAFKA_BROKERS"))
	topic := strings.TrimSpace(os.Getenv("KAFKA_FUNDS_TOPIC"))
	if brokers == "" || topic == "" {
		return nil
	}
	return s.publishWorkflowEventToKafkaCompatible(splitAndTrim(brokers), topic, event, "kafka")
}

func (s *MojaloopService) publishWorkflowEventToFluvio(event FundsWorkflowEvent) error {
	brokers := strings.TrimSpace(os.Getenv("FLUVIO_KAFKA_BROKERS"))
	topic := strings.TrimSpace(os.Getenv("FLUVIO_FUNDS_TOPIC"))
	if brokers == "" || topic == "" {
		return nil
	}
	return s.publishWorkflowEventToKafkaCompatible(splitAndTrim(brokers), topic, event, "fluvio")
}

func (s *MojaloopService) publishWorkflowEventToKafkaCompatible(brokers []string, topic string, event FundsWorkflowEvent, brokerName string) error {
	if len(brokers) == 0 || strings.TrimSpace(topic) == "" {
		return nil
	}

	body, err := json.Marshal(s.workflowEnvelope(event))
	if err != nil {
		return fmt.Errorf("marshal %s workflow event: %w", brokerName, err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	writer := &kafka.Writer{
		Addr:         kafka.TCP(brokers...),
		Topic:        topic,
		RequiredAcks: kafka.RequireAll,
		Async:        false,
		Balancer:     &kafka.LeastBytes{},
	}
	defer writer.Close()

	messageKey := event.WorkflowID
	if strings.TrimSpace(messageKey) == "" {
		messageKey = event.ResourceID
	}

	if err := writer.WriteMessages(ctx, kafka.Message{
		Key:   []byte(messageKey),
		Value: body,
		Time:  time.Now().UTC(),
		Headers: []kafka.Header{
			{Key: "workflow-type", Value: []byte(event.WorkflowType)},
			{Key: "workflow-step", Value: []byte(event.Step)},
			{Key: "workflow-status", Value: []byte(event.Status)},
			{Key: "workflow-broker", Value: []byte(brokerName)},
		},
	}); err != nil {
		return fmt.Errorf("publish workflow event to %s: %w", brokerName, err)
	}
	return nil
}

func (s *MojaloopService) enqueueTemporalWorkflowTask(event FundsWorkflowEvent) error {
	temporalBridgeURL := strings.TrimSpace(os.Getenv("TEMPORAL_BRIDGE_URL"))
	taskQueue := strings.TrimSpace(os.Getenv("TEMPORAL_TASK_QUEUE"))
	if temporalBridgeURL == "" && taskQueue == "" {
		return nil
	}

	payload := s.workflowEnvelope(event)
	payload["taskQueue"] = taskQueue
	payloadBytes, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal temporal workflow task: %w", err)
	}

	status := "queued"
	lastError := ""
	if temporalBridgeURL != "" {
		if dispatchErr := s.dispatchTemporalWorkflowIntent(temporalBridgeURL, payloadBytes); dispatchErr != nil {
			status = "failed"
			lastError = dispatchErr.Error()
		} else {
			status = "submitted"
		}
	}

	_, dbErr := s.db.Exec(
		`INSERT INTO mojaloop_workflow_orchestration (
			workflow_id, workflow_type, resource_id, orchestrator, target, status, payload, last_error, created_at, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW(), NOW())`,
		event.WorkflowID,
		event.WorkflowType,
		event.ResourceID,
		"temporal",
		temporalTarget(taskQueue, temporalBridgeURL),
		status,
		string(payloadBytes),
		nullableDBString(lastError),
	)
	if dbErr != nil {
		return fmt.Errorf("store temporal workflow task: %w", dbErr)
	}

	if lastError != "" {
		return fmt.Errorf("enqueue temporal workflow task: %s", lastError)
	}
	return nil
}

func (s *MojaloopService) dispatchTemporalWorkflowIntent(temporalBridgeURL string, payload []byte) error {
	internalToken := strings.TrimSpace(s.internalServiceToken)
	if internalToken == "" {
		return fmt.Errorf("Temporal bridge dispatch requires an internal service token")
	}
	request, err := http.NewRequest(
		http.MethodPost,
		strings.TrimRight(temporalBridgeURL, "/")+"/funds/workflows",
		bytes.NewReader(payload),
	)
	if err != nil {
		return fmt.Errorf("create temporal workflow request: %w", err)
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Internal-Service-Token", internalToken)

	response, err := s.httpClient.Do(request)
	if err != nil {
		return fmt.Errorf("dispatch temporal workflow request: %w", err)
	}
	defer response.Body.Close()
	if response.StatusCode >= http.StatusBadRequest {
		return fmt.Errorf("temporal bridge returned status %d", response.StatusCode)
	}
	return nil
}

func temporalTarget(taskQueue, temporalBridgeURL string) string {
	if strings.TrimSpace(taskQueue) != "" && strings.TrimSpace(temporalBridgeURL) != "" {
		return fmt.Sprintf("%s via %s", taskQueue, strings.TrimRight(temporalBridgeURL, "/"))
	}
	if strings.TrimSpace(taskQueue) != "" {
		return taskQueue
	}
	return strings.TrimRight(temporalBridgeURL, "/")
}

func nullableDBString(value string) any {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return trimmed
}

func (s *MojaloopService) workflowEnvelope(event FundsWorkflowEvent) map[string]any {
	return map[string]any{
		"source":       "switchos-mojaloop-service",
		"timestamp":    time.Now().UTC().Format(time.RFC3339),
		"workflowType": event.WorkflowType,
		"workflowId":   event.WorkflowID,
		"resourceId":   event.ResourceID,
		"step":         event.Step,
		"status":       event.Status,
		"payload":      event.Payload,
	}
}

func splitAndTrim(value string) []string {
	parts := strings.Split(value, ",")
	result := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			result = append(result, trimmed)
		}
	}
	return result
}

func (s *MojaloopService) fundsMiddlewareStatus() map[string]any {
	status := map[string]any{
		"dapr": map[string]any{
			"configured": strings.TrimSpace(os.Getenv("DAPR_HTTP_PORT")) != "" && strings.TrimSpace(os.Getenv("DAPR_PUBSUB_NAME")) != "" && strings.TrimSpace(os.Getenv("DAPR_FUNDS_TOPIC")) != "",
		},
		"kafka": map[string]any{
			"configured": strings.TrimSpace(os.Getenv("KAFKA_BROKERS")) != "" && strings.TrimSpace(os.Getenv("KAFKA_FUNDS_TOPIC")) != "",
		},
		"fluvio": map[string]any{
			"configured": strings.TrimSpace(os.Getenv("FLUVIO_KAFKA_BROKERS")) != "" && strings.TrimSpace(os.Getenv("FLUVIO_FUNDS_TOPIC")) != "",
		},
		"temporal": map[string]any{
			"configured": strings.TrimSpace(os.Getenv("TEMPORAL_TASK_QUEUE")) != "" || strings.TrimSpace(os.Getenv("TEMPORAL_BRIDGE_URL")) != "",
		},
	}

	if kafkaConfigured, ok := status["kafka"].(map[string]any)["configured"].(bool); ok && kafkaConfigured {
		status["kafka"].(map[string]any)["brokers"] = splitAndTrim(os.Getenv("KAFKA_BROKERS"))
		status["kafka"].(map[string]any)["topic"] = strings.TrimSpace(os.Getenv("KAFKA_FUNDS_TOPIC"))
	}
	if fluvioConfigured, ok := status["fluvio"].(map[string]any)["configured"].(bool); ok && fluvioConfigured {
		status["fluvio"].(map[string]any)["brokers"] = splitAndTrim(os.Getenv("FLUVIO_KAFKA_BROKERS"))
		status["fluvio"].(map[string]any)["topic"] = strings.TrimSpace(os.Getenv("FLUVIO_FUNDS_TOPIC"))
	}
	if temporalConfigured, ok := status["temporal"].(map[string]any)["configured"].(bool); ok && temporalConfigured {
		status["temporal"].(map[string]any)["taskQueue"] = strings.TrimSpace(os.Getenv("TEMPORAL_TASK_QUEUE"))
		status["temporal"].(map[string]any)["bridgeUrl"] = strings.TrimSpace(os.Getenv("TEMPORAL_BRIDGE_URL"))
	}
	return status
}

func (s *MojaloopService) buildReconciliationOverview() (ReconciliationOverview, error) {
	var overview ReconciliationOverview
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM mojaloop_transfers`).Scan(&overview.TransferCount); err != nil {
		return ReconciliationOverview{}, fmt.Errorf("count transfers: %w", err)
	}
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM mojaloop_refunds`).Scan(&overview.RefundCount); err != nil {
		return ReconciliationOverview{}, fmt.Errorf("count refunds: %w", err)
	}
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM mojaloop_transfers WHERE state = 'SETTLED'`).Scan(&overview.SettledTransfers); err != nil {
		return ReconciliationOverview{}, fmt.Errorf("count settled transfers: %w", err)
	}
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM mojaloop_transfers WHERE state = 'PARTIALLY_REFUNDED'`).Scan(&overview.PartiallyRefunded); err != nil {
		return ReconciliationOverview{}, fmt.Errorf("count partially refunded transfers: %w", err)
	}
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM mojaloop_transfers WHERE state = 'REFUNDED'`).Scan(&overview.FullyRefunded); err != nil {
		return ReconciliationOverview{}, fmt.Errorf("count refunded transfers: %w", err)
	}
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM mojaloop_reconciliation_audits WHERE ledger_consistent = FALSE`).Scan(&overview.InconsistentAudits); err != nil {
		return ReconciliationOverview{}, fmt.Errorf("count inconsistent audits: %w", err)
	}
	var grossMinor sql.NullInt64
	if err := s.db.QueryRow(`SELECT COALESCE(SUM(amount_minor), 0) FROM mojaloop_transfers`).Scan(&grossMinor); err != nil {
		return ReconciliationOverview{}, fmt.Errorf("sum transferred amount: %w", err)
	}
	var refundedMinor sql.NullInt64
	if err := s.db.QueryRow(`SELECT COALESCE(SUM(amount_minor), 0) FROM mojaloop_refunds WHERE state IN ('PENDING_LEDGER','PENDING','COMPLETED')`).Scan(&refundedMinor); err != nil {
		return ReconciliationOverview{}, fmt.Errorf("sum refunded amount: %w", err)
	}
	if grossMinor.Valid && grossMinor.Int64 > 0 {
		overview.GrossTransferredMinor = uint64(grossMinor.Int64)
	}
	if refundedMinor.Valid && refundedMinor.Int64 > 0 {
		overview.RefundedMinor = uint64(refundedMinor.Int64)
	}
	if overview.RefundedMinor <= overview.GrossTransferredMinor {
		overview.NetSettledMinor = overview.GrossTransferredMinor - overview.RefundedMinor
	}

	var lastRecorded sql.NullTime
	if err := s.db.QueryRow(`SELECT MAX(created_at) FROM mojaloop_reconciliation_audits`).Scan(&lastRecorded); err != nil {
		return ReconciliationOverview{}, fmt.Errorf("load last reconciliation audit time: %w", err)
	}
	if lastRecorded.Valid {
		timestamp := lastRecorded.Time.UTC()
		overview.LastReconciledAt = &timestamp
	}

	overview.Recommendation = "No immediate reconciliation action required."
	if overview.InconsistentAudits > 0 {
		overview.Recommendation = "At least one reconciliation audit is inconsistent; investigate ledger and platform divergence before settlement finalization."
	} else if overview.PartiallyRefunded > 0 {
		overview.Recommendation = "Partially refunded transfers exist; verify merchant payout offsets and customer statement adjustments."
	} else if overview.FullyRefunded > 0 {
		overview.Recommendation = "Fully refunded transfers exist; confirm treasury and downstream payout reversals are reflected."
	}
	return overview, nil
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

func canDialTCPAddress(address string) bool {
	conn, err := net.DialTimeout("tcp", address, 750*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}
