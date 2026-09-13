package main

import (
	"bytes"
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	_ "github.com/lib/pq"
	"github.com/segmentio/kafka-go"
)

type inventoryService struct {
	db                   *sql.DB
	httpClient           *http.Client
	internalServiceToken string
	serviceName          string
}

type inventoryAdjustmentRequest struct {
	WarehouseID        int64    `json:"warehouse_id"`
	SKU                string   `json:"sku"`
	MerchantID         *int64   `json:"merchant_id,omitempty"`
	City               string   `json:"city"`
	ZoneKey            string   `json:"zone_key"`
	DeltaUnits         float64  `json:"delta_units"`
	ReservedDeltaUnits float64  `json:"reserved_delta_units"`
	InboundDeltaUnits  float64  `json:"inbound_delta_units"`
	StockAccuracy      float64  `json:"stock_accuracy"`
	FreshnessHours     *float64 `json:"freshness_hours,omitempty"`
	ColdChainReady     bool     `json:"cold_chain_ready"`
	Source             string   `json:"source"`
	Reason             string   `json:"reason"`
	OrderID            *int64   `json:"order_id,omitempty"`
	TraceID            string   `json:"trace_id,omitempty"`
}

type replenishmentSku struct {
	SKU                    string  `json:"sku"`
	Label                  string  `json:"label,omitempty"`
	WarehouseID            int64   `json:"warehouse_id"`
	WarehouseLabel         string  `json:"warehouse_label,omitempty"`
	SupplierID             string  `json:"supplier_id,omitempty"`
	SupplierName           string  `json:"supplier_name,omitempty"`
	RecommendedUnits       float64 `json:"recommended_units"`
	SafetyStockUnits       float64 `json:"safety_stock_units"`
	CurrentAvailableUnits  float64 `json:"current_available_units"`
	CurrentInboundUnits    float64 `json:"current_inbound_units"`
	LeadTimeHours          float64 `json:"lead_time_hours"`
	ServiceLevel           float64 `json:"service_level"`
	RiskBand               string  `json:"risk_band"`
	TargetTransferNodeID   *int64  `json:"target_transfer_node_id,omitempty"`
	TargetTransferNodeName string  `json:"target_transfer_node_name,omitempty"`
}

type replenishmentRequest struct {
	WorkflowID           string             `json:"workflow_id,omitempty"`
	City                 string             `json:"city"`
	PlanningHorizonHours int                `json:"planning_horizon_hours"`
	Trigger              string             `json:"trigger"`
	RequestedBy          string             `json:"requested_by"`
	WorkflowReason       string             `json:"workflow_reason"`
	Skus                 []replenishmentSku `json:"skus"`
	ApprovalMode         string             `json:"approval_mode"`
	TraceID              string             `json:"trace_id,omitempty"`
}

type inventoryPosition struct {
	WarehouseID    int64    `json:"warehouse_id"`
	SKU            string   `json:"sku"`
	MerchantID     *int64   `json:"merchant_id,omitempty"`
	City           string   `json:"city"`
	ZoneKey        string   `json:"zone_key"`
	OnHandUnits    float64  `json:"on_hand_units"`
	ReservedUnits  float64  `json:"reserved_units"`
	InboundUnits   float64  `json:"inbound_units"`
	AvailableUnits float64  `json:"available_units"`
	StockAccuracy  float64  `json:"stock_accuracy"`
	FreshnessHours *float64 `json:"freshness_hours,omitempty"`
	ColdChainReady bool     `json:"cold_chain_ready"`
	LastSource     string   `json:"last_source"`
	LastReason     string   `json:"last_reason"`
	UpdatedAt      string   `json:"updated_at"`
}

type inventoryWorkflowEvent struct {
	WorkflowID   string         `json:"workflow_id"`
	WorkflowType string         `json:"workflow_type"`
	ResourceID   string         `json:"resource_id"`
	Step         string         `json:"step"`
	Status       string         `json:"status"`
	Payload      map[string]any `json:"payload"`
}

type inventoryResponse struct {
	Service    string            `json:"service"`
	WorkflowID string            `json:"workflow_id"`
	ResourceID string            `json:"resource_id"`
	Inventory  inventoryPosition `json:"inventory"`
	Workflow   map[string]any    `json:"workflow"`
	Middleware map[string]any    `json:"middleware"`
	Metrics    map[string]any    `json:"metrics"`
}

type replenishmentResponse struct {
	Service    string         `json:"service"`
	WorkflowID string         `json:"workflow_id"`
	Status     string         `json:"status"`
	Summary    string         `json:"summary"`
	Approvals  []string       `json:"approvals"`
	Middleware map[string]any `json:"middleware"`
	Metrics    map[string]any `json:"metrics"`
}

type replenishmentCancelRequest struct {
	WorkflowID      string `json:"workflow_id"`
	CompensationID  string `json:"compensation_id"`
	Reason          string `json:"reason"`
	OriginalFailure string `json:"original_failure"`
}

type replenishmentCancelResponse struct {
	Service        string         `json:"service"`
	WorkflowID     string         `json:"workflow_id"`
	CompensationID string         `json:"compensation_id"`
	Status         string         `json:"status"`
	Idempotent     bool           `json:"idempotent"`
	Middleware     map[string]any `json:"middleware"`
	Metrics        map[string]any `json:"metrics"`
}

func main() {
	databaseURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if databaseURL == "" {
		log.Fatal("DATABASE_URL must be explicitly configured")
	}
	internalServiceToken := strings.TrimSpace(os.Getenv("INTERNAL_SERVICE_TOKEN"))
	if len(internalServiceToken) < 32 {
		log.Fatal("INTERNAL_SERVICE_TOKEN must be explicitly configured with at least 32 characters")
	}
	service := &inventoryService{
		db:                   openDB(databaseURL),
		httpClient:           &http.Client{Timeout: 5 * time.Second},
		internalServiceToken: internalServiceToken,
		serviceName:          "switchos-inventory-control",
	}
	if err := service.db.Ping(); err != nil {
		log.Fatalf("ping database: %v", err)
	}
	if err := service.ensureSchema(); err != nil {
		log.Fatalf("ensure schema: %v", err)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", service.healthHandler)
	mux.HandleFunc("/middleware-status", service.middlewareStatusHandler)
	mux.HandleFunc("/inventory/adjustment", service.adjustmentHandler)
	mux.HandleFunc("/inventory/replenishment-request", service.replenishmentHandler)
	mux.HandleFunc("/inventory/replenishment-cancel", service.replenishmentCancelHandler)
	mux.HandleFunc("/inventory/position", service.positionHandler)

	addr := fmt.Sprintf("%s:%s", getenv("BIND_HOST", "127.0.0.1"), getenv("PORT", "8117"))
	server := &http.Server{Addr: addr, Handler: mux, ReadHeaderTimeout: 5 * time.Second}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	serverErrors := make(chan error, 1)
	go func() {
		log.Printf("inventory control listening on %s", addr)
		serverErrors <- server.ListenAndServe()
	}()

	select {
	case err := <-serverErrors:
		if err != nil && err != http.ErrServerClosed {
			log.Fatalf("inventory control server failed: %v", err)
		}
	case <-ctx.Done():
		log.Printf("shutdown signal received; draining in-flight requests")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("graceful shutdown failed: %v", err)
		}
		if err := <-serverErrors; err != nil && err != http.ErrServerClosed {
			log.Fatalf("inventory control server failed: %v", err)
		}
	}
}

func openDB(databaseURL string) *sql.DB {
	db, err := sql.Open("postgres", databaseURL)
	if err != nil {
		log.Fatalf("open db: %v", err)
	}
	db.SetMaxOpenConns(6)
	db.SetConnMaxLifetime(15 * time.Minute)
	return db
}

func (s *inventoryService) ensureSchema() error {
	statements := []string{
		`CREATE TABLE IF NOT EXISTS inventory_positions (
			warehouse_id BIGINT NOT NULL,
			sku TEXT NOT NULL,
			merchant_id BIGINT,
			city TEXT NOT NULL DEFAULT '',
			zone_key TEXT NOT NULL DEFAULT '',
			on_hand_units DOUBLE PRECISION NOT NULL DEFAULT 0,
			reserved_units DOUBLE PRECISION NOT NULL DEFAULT 0,
			inbound_units DOUBLE PRECISION NOT NULL DEFAULT 0,
			stock_accuracy DOUBLE PRECISION NOT NULL DEFAULT 0.92,
			freshness_hours DOUBLE PRECISION,
			cold_chain_ready BOOLEAN NOT NULL DEFAULT FALSE,
			last_source TEXT NOT NULL DEFAULT 'unknown',
			last_reason TEXT NOT NULL DEFAULT '',
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY (warehouse_id, sku)
		)`,
		`CREATE TABLE IF NOT EXISTS inventory_workflows (
			workflow_id TEXT PRIMARY KEY,
			workflow_type TEXT NOT NULL,
			resource_id TEXT NOT NULL,
			current_step TEXT NOT NULL,
			status TEXT NOT NULL,
			last_error TEXT,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE TABLE IF NOT EXISTS inventory_workflow_events (
			id BIGSERIAL PRIMARY KEY,
			workflow_id TEXT NOT NULL,
			workflow_type TEXT NOT NULL,
			resource_id TEXT NOT NULL,
			step TEXT NOT NULL,
			status TEXT NOT NULL,
			payload JSONB NOT NULL DEFAULT '{}'::jsonb,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_inventory_workflow_events_workflow ON inventory_workflow_events (workflow_id, created_at DESC)`,
		`CREATE TABLE IF NOT EXISTS inventory_workflow_orchestration (
			id BIGSERIAL PRIMARY KEY,
			workflow_id TEXT NOT NULL,
			workflow_type TEXT NOT NULL,
			resource_id TEXT NOT NULL,
			orchestrator TEXT NOT NULL,
			target TEXT NOT NULL,
			status TEXT NOT NULL,
			payload JSONB NOT NULL DEFAULT '{}'::jsonb,
			last_error TEXT,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)`,
		`CREATE INDEX IF NOT EXISTS idx_inventory_workflow_orchestration_workflow ON inventory_workflow_orchestration (workflow_id, created_at DESC)`,
	}
	for _, statement := range statements {
		if _, err := s.db.Exec(statement); err != nil {
			return err
		}
	}
	return nil
}

func (s *inventoryService) healthHandler(w http.ResponseWriter, r *http.Request) {
	traceID := requestTraceID(r)
	writeJSON(w, http.StatusOK, map[string]any{
		"status":     "healthy",
		"service":    s.serviceName,
		"trace_id":   traceID,
		"middleware": s.middlewareStatus(),
	})
}

func (s *inventoryService) middlewareStatusHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.middlewareStatus())
}

func (s *inventoryService) adjustmentHandler(w http.ResponseWriter, r *http.Request) {
	startedAt := time.Now()
	traceID := requestTraceID(r)
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed", "trace_id": traceID})
		return
	}
	if err := s.requireInternalAccess(r); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": err.Error(), "trace_id": traceID})
		return
	}
	var request inventoryAdjustmentRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON payload", "trace_id": traceID})
		return
	}
	if request.WarehouseID <= 0 || strings.TrimSpace(request.SKU) == "" || strings.TrimSpace(request.City) == "" || strings.TrimSpace(request.Source) == "" || strings.TrimSpace(request.Reason) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "warehouse_id, sku, city, source, and reason are required", "trace_id": traceID})
		return
	}
	workflowID := fmt.Sprintf("inv-%d", time.Now().UnixNano())
	resourceID := fmt.Sprintf("warehouse:%d:sku:%s", request.WarehouseID, request.SKU)

	position, err := s.applyInventoryAdjustment(request)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error(), "trace_id": traceID})
		return
	}
	payload := map[string]any{
		"inventory": position,
		"reason":    request.Reason,
		"source":    request.Source,
		"trace_id":  traceID,
	}
	publishMetrics, workflowErr := s.recordWorkflowEvent(inventoryWorkflowEvent{
		WorkflowID:   workflowID,
		WorkflowType: "inventory_adjustment",
		ResourceID:   resourceID,
		Step:         "inventory_adjusted",
		Status:       "completed",
		Payload:      payload,
	})
	if workflowErr != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": workflowErr.Error(), "trace_id": traceID})
		return
	}
	responseMetrics := map[string]any{
		"trace_id": traceID,
		"timings_ms": map[string]any{
			"total": roundDurationMs(time.Since(startedAt)),
		},
		"middleware_publish": publishMetrics,
	}
	writeJSON(w, http.StatusOK, inventoryResponse{
		Service:    s.serviceName,
		WorkflowID: workflowID,
		ResourceID: resourceID,
		Inventory:  position,
		Workflow:   map[string]any{"type": "inventory_adjustment", "step": "inventory_adjusted", "status": "completed"},
		Middleware: s.middlewareStatus(),
		Metrics:    responseMetrics,
	})
}

func (s *inventoryService) replenishmentHandler(w http.ResponseWriter, r *http.Request) {
	startedAt := time.Now()
	traceID := requestTraceID(r)
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed", "trace_id": traceID})
		return
	}
	if err := s.requireInternalAccess(r); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": err.Error(), "trace_id": traceID})
		return
	}
	var request replenishmentRequest
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid JSON payload", "trace_id": traceID})
		return
	}
	if len(request.Skus) == 0 || strings.TrimSpace(request.City) == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "city and at least one sku are required", "trace_id": traceID})
		return
	}
	workflowID := strings.TrimSpace(request.WorkflowID)
	journeyWorkflowID := strings.TrimSpace(r.Header.Get("X-Journey-Workflow-Id"))
	if journeyWorkflowID != "" && workflowID != "" && workflowID != journeyWorkflowID {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "workflow_id must match the journey workflow identity", "trace_id": traceID})
		return
	}
	if journeyWorkflowID != "" {
		workflowID = journeyWorkflowID
	}
	if workflowID == "" {
		workflowID = fmt.Sprintf("repl-%d", time.Now().UnixNano())
	}
	if len(workflowID) > 160 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "workflow_id is too long", "trace_id": traceID})
		return
	}
	resourceID := fmt.Sprintf("city:%s:replenishment", strings.ToLower(strings.ReplaceAll(strings.TrimSpace(request.City), " ", "-")))
	approvals := make([]string, 0, len(request.Skus))
	criticalCount := 0
	for _, sku := range request.Skus {
		if strings.EqualFold(strings.TrimSpace(sku.RiskBand), "critical") || strings.EqualFold(strings.TrimSpace(sku.RiskBand), "fragile") {
			criticalCount++
		}
		approvalTarget := fmt.Sprintf("Approve %.0f units of %s into %s", sku.RecommendedUnits, sku.SKU, sku.WarehouseLabel)
		if sku.TargetTransferNodeID != nil {
			approvalTarget = fmt.Sprintf("Approve transfer %.0f units of %s from node %d to %s", sku.RecommendedUnits, sku.SKU, *sku.TargetTransferNodeID, sku.WarehouseLabel)
		}
		approvals = append(approvals, approvalTarget)
	}
	status := "queued"
	if criticalCount > 0 {
		status = "urgent"
	}
	payload := map[string]any{
		"city":                   request.City,
		"planning_horizon_hours": request.PlanningHorizonHours,
		"trigger":                request.Trigger,
		"requested_by":           request.RequestedBy,
		"workflow_reason":        request.WorkflowReason,
		"approval_mode":          firstNonEmpty(request.ApprovalMode, "operator_review"),
		"critical_sku_count":     criticalCount,
		"sku_count":              len(request.Skus),
		"skus":                   request.Skus,
		"trace_id":               traceID,
	}
	publishMetrics, workflowErr := s.recordWorkflowEvent(inventoryWorkflowEvent{
		WorkflowID:   workflowID,
		WorkflowType: "replenishment_request",
		ResourceID:   resourceID,
		Step:         "replenishment_requested",
		Status:       status,
		Payload:      payload,
	})
	if workflowErr != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": workflowErr.Error(), "trace_id": traceID})
		return
	}
	responseMetrics := map[string]any{
		"trace_id":           traceID,
		"sku_count":          len(request.Skus),
		"critical_sku_count": criticalCount,
		"timings_ms":         map[string]any{"total": roundDurationMs(time.Since(startedAt))},
		"middleware_publish": publishMetrics,
	}
	writeJSON(w, http.StatusOK, replenishmentResponse{
		Service:    s.serviceName,
		WorkflowID: workflowID,
		Status:     status,
		Summary:    fmt.Sprintf("Queued replenishment workflow for %d SKUs in %s with %d critical items.", len(request.Skus), request.City, criticalCount),
		Approvals:  approvals,
		Middleware: s.middlewareStatus(),
		Metrics:    responseMetrics,
	})
}

func (s *inventoryService) replenishmentCancelHandler(w http.ResponseWriter, r *http.Request) {
	startedAt := time.Now()
	traceID := requestTraceID(r)
	if r.Method != http.MethodPost {
		writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed", "trace_id": traceID})
		return
	}
	if err := s.requireInternalAccess(r); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": err.Error(), "trace_id": traceID})
		return
	}
	var request replenishmentCancelRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 16*1024)).Decode(&request); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid cancellation payload", "trace_id": traceID})
		return
	}
	request.WorkflowID = strings.TrimSpace(request.WorkflowID)
	request.CompensationID = strings.TrimSpace(request.CompensationID)
	request.Reason = strings.TrimSpace(request.Reason)
	request.OriginalFailure = strings.TrimSpace(request.OriginalFailure)
	if len(request.WorkflowID) < 3 || len(request.WorkflowID) > 160 || len(request.CompensationID) < 3 || len(request.CompensationID) > 160 || len(request.Reason) < 3 || len(request.Reason) > 256 || len(request.OriginalFailure) > 1024 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "invalid bounded cancellation fields", "trace_id": traceID})
		return
	}
	if headerWorkflowID := strings.TrimSpace(r.Header.Get("X-Journey-Workflow-Id")); headerWorkflowID == "" || headerWorkflowID != request.WorkflowID {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "journey workflow identity is required and must match the cancellation payload", "trace_id": traceID})
		return
	}
	status, idempotent, err := s.cancelReplenishment(request, traceID)
	if err != nil {
		writeJSON(w, http.StatusConflict, map[string]any{"error": err.Error(), "trace_id": traceID})
		return
	}
	writeJSON(w, http.StatusOK, replenishmentCancelResponse{
		Service:        s.serviceName,
		WorkflowID:     request.WorkflowID,
		CompensationID: request.CompensationID,
		Status:         status,
		Idempotent:     idempotent,
		Middleware:     s.middlewareStatus(),
		Metrics:        map[string]any{"trace_id": traceID, "timings_ms": map[string]any{"total": roundDurationMs(time.Since(startedAt))}},
	})
}

func (s *inventoryService) cancelReplenishment(request replenishmentCancelRequest, traceID string) (string, bool, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return "", false, err
	}
	defer func() { _ = tx.Rollback() }()
	var workflowType, status, resourceID string
	if err := tx.QueryRow(`
		SELECT workflow_type, status, resource_id
		FROM inventory_workflows
		WHERE workflow_id = $1
		FOR UPDATE
	`, request.WorkflowID).Scan(&workflowType, &status, &resourceID); err != nil {
		if err == sql.ErrNoRows {
			return "", false, fmt.Errorf("replenishment workflow was not found")
		}
		return "", false, err
	}
	if workflowType != "replenishment_request" {
		return "", false, fmt.Errorf("workflow is not a replenishment request")
	}
	if status == "cancelled" {
		var existingCompensationID string
		err := tx.QueryRow(`
			SELECT payload->>'compensation_id'
			FROM inventory_workflow_events
			WHERE workflow_id = $1 AND step = 'replenishment_cancelled'
			ORDER BY id DESC
			LIMIT 1
		`, request.WorkflowID).Scan(&existingCompensationID)
		if err != nil {
			return "", false, fmt.Errorf("cancelled replenishment lacks immutable compensation evidence: %w", err)
		}
		if existingCompensationID != request.CompensationID {
			return "", false, fmt.Errorf("replenishment workflow was already cancelled by a different compensation")
		}
		return status, true, nil
	}
	if status != "queued" && status != "urgent" {
		return "", false, fmt.Errorf("replenishment workflow cannot be cancelled from %s", status)
	}
	if _, err := tx.Exec(`
		UPDATE inventory_workflows
		SET current_step = 'replenishment_cancelled', status = 'cancelled', last_error = $2, updated_at = NOW()
		WHERE workflow_id = $1
	`, request.WorkflowID, request.Reason); err != nil {
		return "", false, err
	}
	payload, err := json.Marshal(map[string]any{
		"compensation_id":  request.CompensationID,
		"reason":           request.Reason,
		"original_failure": request.OriginalFailure,
		"trace_id":         traceID,
		"stock_mutated":    false,
	})
	if err != nil {
		return "", false, err
	}
	if _, err := tx.Exec(`
		INSERT INTO inventory_workflow_events (workflow_id, workflow_type, resource_id, step, status, payload, created_at)
		VALUES ($1, 'replenishment_request', $2, 'replenishment_cancelled', 'cancelled', $3::jsonb, NOW())
	`, request.WorkflowID, resourceID, string(payload)); err != nil {
		return "", false, err
	}
	if err := tx.Commit(); err != nil {
		return "", false, err
	}
	return "cancelled", false, nil
}

func (s *inventoryService) positionHandler(w http.ResponseWriter, r *http.Request) {
	traceID := requestTraceID(r)
	if err := s.requireInternalAccess(r); err != nil {
		writeJSON(w, http.StatusUnauthorized, map[string]any{"error": err.Error(), "trace_id": traceID})
		return
	}
	warehouseID, err := strconv.ParseInt(r.URL.Query().Get("warehouse_id"), 10, 64)
	if err != nil || warehouseID <= 0 {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "warehouse_id is required", "trace_id": traceID})
		return
	}
	sku := strings.TrimSpace(r.URL.Query().Get("sku"))
	if sku == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": "sku is required", "trace_id": traceID})
		return
	}
	position, err := s.loadInventoryPosition(warehouseID, sku)
	if err != nil {
		writeJSON(w, http.StatusNotFound, map[string]any{"error": err.Error(), "trace_id": traceID})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"service": s.serviceName, "inventory": position, "trace_id": traceID})
}

func (s *inventoryService) applyInventoryAdjustment(request inventoryAdjustmentRequest) (inventoryPosition, error) {
	var position inventoryPosition
	freshness := nullableFloatPtr(request.FreshnessHours)
	merchantID := nullableInt64(request.MerchantID)
	row := s.db.QueryRow(`
		INSERT INTO inventory_positions (
			warehouse_id, sku, merchant_id, city, zone_key, on_hand_units, reserved_units, inbound_units,
			stock_accuracy, freshness_hours, cold_chain_ready, last_source, last_reason, updated_at
		) VALUES ($1, $2, $3, $4, $5, GREATEST($6, 0), GREATEST($7, 0), GREATEST($8, 0), $9, $10, $11, $12, $13, NOW())
		ON CONFLICT (warehouse_id, sku) DO UPDATE SET
			merchant_id = COALESCE(EXCLUDED.merchant_id, inventory_positions.merchant_id),
			city = EXCLUDED.city,
			zone_key = EXCLUDED.zone_key,
			on_hand_units = GREATEST(inventory_positions.on_hand_units + $14, 0),
			reserved_units = GREATEST(inventory_positions.reserved_units + $15, 0),
			inbound_units = GREATEST(inventory_positions.inbound_units + $16, 0),
			stock_accuracy = CASE WHEN $17::DOUBLE PRECISION > 0 THEN $17::DOUBLE PRECISION ELSE inventory_positions.stock_accuracy END,
			freshness_hours = COALESCE($18, inventory_positions.freshness_hours),
			cold_chain_ready = EXCLUDED.cold_chain_ready,
			last_source = EXCLUDED.last_source,
			last_reason = EXCLUDED.last_reason,
			updated_at = NOW()
		RETURNING warehouse_id, sku, merchant_id, city, zone_key, on_hand_units, reserved_units, inbound_units,
			GREATEST(on_hand_units - reserved_units, 0) AS available_units,
			stock_accuracy, freshness_hours, cold_chain_ready, last_source, last_reason,
			TO_CHAR(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
	`,
		request.WarehouseID,
		request.SKU,
		merchantID,
		request.City,
		request.ZoneKey,
		request.DeltaUnits,
		request.ReservedDeltaUnits,
		request.InboundDeltaUnits,
		defaultFloat(request.StockAccuracy, 0.92),
		freshness,
		request.ColdChainReady,
		request.Source,
		request.Reason,
		request.DeltaUnits,
		request.ReservedDeltaUnits,
		request.InboundDeltaUnits,
		defaultFloat(request.StockAccuracy, 0.92),
		freshness,
	)
	var merchantIDValue sql.NullInt64
	var freshnessValue sql.NullFloat64
	if err := row.Scan(
		&position.WarehouseID,
		&position.SKU,
		&merchantIDValue,
		&position.City,
		&position.ZoneKey,
		&position.OnHandUnits,
		&position.ReservedUnits,
		&position.InboundUnits,
		&position.AvailableUnits,
		&position.StockAccuracy,
		&freshnessValue,
		&position.ColdChainReady,
		&position.LastSource,
		&position.LastReason,
		&position.UpdatedAt,
	); err != nil {
		return position, err
	}
	if merchantIDValue.Valid {
		value := merchantIDValue.Int64
		position.MerchantID = &value
	}
	if freshnessValue.Valid {
		value := freshnessValue.Float64
		position.FreshnessHours = &value
	}
	return position, nil
}

func (s *inventoryService) loadInventoryPosition(warehouseID int64, sku string) (inventoryPosition, error) {
	var position inventoryPosition
	var merchantIDValue sql.NullInt64
	var freshnessValue sql.NullFloat64
	err := s.db.QueryRow(`
		SELECT warehouse_id, sku, merchant_id, city, zone_key, on_hand_units, reserved_units, inbound_units,
			GREATEST(on_hand_units - reserved_units, 0) AS available_units,
			stock_accuracy, freshness_hours, cold_chain_ready, last_source, last_reason,
			TO_CHAR(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS updated_at
		FROM inventory_positions
		WHERE warehouse_id = $1 AND sku = $2
	`, warehouseID, sku).Scan(
		&position.WarehouseID,
		&position.SKU,
		&merchantIDValue,
		&position.City,
		&position.ZoneKey,
		&position.OnHandUnits,
		&position.ReservedUnits,
		&position.InboundUnits,
		&position.AvailableUnits,
		&position.StockAccuracy,
		&freshnessValue,
		&position.ColdChainReady,
		&position.LastSource,
		&position.LastReason,
		&position.UpdatedAt,
	)
	if err != nil {
		return position, err
	}
	if merchantIDValue.Valid {
		value := merchantIDValue.Int64
		position.MerchantID = &value
	}
	if freshnessValue.Valid {
		value := freshnessValue.Float64
		position.FreshnessHours = &value
	}
	return position, nil
}

func (s *inventoryService) recordWorkflowEvent(event inventoryWorkflowEvent) (map[string]any, error) {
	payloadBytes, err := json.Marshal(event.Payload)
	if err != nil {
		return nil, err
	}
	startedAt := time.Now()
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			_ = tx.Rollback()
		}
	}()
	_, err = tx.Exec(`
		INSERT INTO inventory_workflows (workflow_id, workflow_type, resource_id, current_step, status, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
		ON CONFLICT (workflow_id) DO UPDATE SET
			workflow_type = EXCLUDED.workflow_type,
			resource_id = EXCLUDED.resource_id,
			current_step = EXCLUDED.current_step,
			status = EXCLUDED.status,
			updated_at = NOW()
	`, event.WorkflowID, event.WorkflowType, event.ResourceID, event.Step, event.Status)
	if err != nil {
		return nil, err
	}
	_, err = tx.Exec(`
		INSERT INTO inventory_workflow_events (workflow_id, workflow_type, resource_id, step, status, payload, created_at)
		VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
	`, event.WorkflowID, event.WorkflowType, event.ResourceID, event.Step, event.Status, string(payloadBytes))
	if err != nil {
		return nil, err
	}
	if err = tx.Commit(); err != nil {
		return nil, err
	}
	publishMetrics, publishErr := s.publishWorkflowEvent(event)
	publishMetrics["persist_ms"] = roundDurationMs(time.Since(startedAt))
	return publishMetrics, publishErr
}

func (s *inventoryService) publishWorkflowEvent(event inventoryWorkflowEvent) (map[string]any, error) {
	metrics := map[string]any{}
	if duration, err := s.publishToDapr(event); err != nil {
		metrics["dapr"] = map[string]any{"ok": false, "duration_ms": duration, "error": err.Error()}
		return metrics, err
	} else {
		metrics["dapr"] = map[string]any{"ok": true, "duration_ms": duration}
	}
	if duration, err := s.publishToKafkaCompatible(splitAndTrim(getenv("KAFKA_BROKERS", "")), getenv("KAFKA_INVENTORY_TOPIC", ""), event, "kafka"); err != nil {
		metrics["kafka"] = map[string]any{"ok": false, "duration_ms": duration, "error": err.Error()}
		return metrics, err
	} else {
		metrics["kafka"] = map[string]any{"ok": true, "duration_ms": duration}
	}
	if duration, err := s.publishToKafkaCompatible(splitAndTrim(getenv("FLUVIO_KAFKA_BROKERS", "")), getenv("FLUVIO_INVENTORY_TOPIC", ""), event, "fluvio"); err != nil {
		metrics["fluvio"] = map[string]any{"ok": false, "duration_ms": duration, "error": err.Error()}
		return metrics, err
	} else {
		metrics["fluvio"] = map[string]any{"ok": true, "duration_ms": duration}
	}
	if duration, err := s.publishToTemporal(event); err != nil {
		metrics["temporal"] = map[string]any{"ok": false, "duration_ms": duration, "error": err.Error()}
		return metrics, err
	} else {
		metrics["temporal"] = map[string]any{"ok": true, "duration_ms": duration}
	}
	return metrics, nil
}

func (s *inventoryService) publishToDapr(event inventoryWorkflowEvent) (float64, error) {
	startedAt := time.Now()
	daprPort := strings.TrimSpace(getenv("DAPR_HTTP_PORT", ""))
	pubsubName := strings.TrimSpace(getenv("DAPR_PUBSUB_NAME", ""))
	topicName := strings.TrimSpace(getenv("DAPR_INVENTORY_TOPIC", ""))
	if daprPort == "" || pubsubName == "" || topicName == "" {
		return roundDurationMs(time.Since(startedAt)), nil
	}
	body, _ := json.Marshal(s.workflowEnvelope(event))
	request, err := http.NewRequest(http.MethodPost, fmt.Sprintf("http://127.0.0.1:%s/v1.0/publish/%s/%s", daprPort, pubsubName, topicName), bytes.NewReader(body))
	if err != nil {
		return roundDurationMs(time.Since(startedAt)), err
	}
	request.Header.Set("Content-Type", "application/json")
	response, err := s.httpClient.Do(request)
	if err != nil {
		return roundDurationMs(time.Since(startedAt)), err
	}
	defer response.Body.Close()
	if response.StatusCode >= 400 {
		return roundDurationMs(time.Since(startedAt)), fmt.Errorf("dapr publish returned status %d", response.StatusCode)
	}
	return roundDurationMs(time.Since(startedAt)), nil
}

func (s *inventoryService) publishToKafkaCompatible(brokers []string, topic string, event inventoryWorkflowEvent, brokerName string) (float64, error) {
	startedAt := time.Now()
	if len(brokers) == 0 || strings.TrimSpace(topic) == "" {
		return roundDurationMs(time.Since(startedAt)), nil
	}
	body, _ := json.Marshal(s.workflowEnvelope(event))
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	writer := &kafka.Writer{Addr: kafka.TCP(brokers...), Topic: topic, RequiredAcks: kafka.RequireAll, Async: false, Balancer: &kafka.LeastBytes{}}
	defer writer.Close()
	err := writer.WriteMessages(ctx, kafka.Message{
		Key:     []byte(event.WorkflowID),
		Value:   body,
		Time:    time.Now().UTC(),
		Headers: []kafka.Header{{Key: "workflow-type", Value: []byte(event.WorkflowType)}, {Key: "workflow-step", Value: []byte(event.Step)}, {Key: "workflow-status", Value: []byte(event.Status)}, {Key: "workflow-broker", Value: []byte(brokerName)}},
	})
	return roundDurationMs(time.Since(startedAt)), err
}

func (s *inventoryService) publishToTemporal(event inventoryWorkflowEvent) (float64, error) {
	startedAt := time.Now()
	temporalBridgeURL := strings.TrimSpace(getenv("TEMPORAL_BRIDGE_URL", ""))
	taskQueue := strings.TrimSpace(getenv("TEMPORAL_TASK_QUEUE", ""))
	if temporalBridgeURL == "" && taskQueue == "" {
		return roundDurationMs(time.Since(startedAt)), nil
	}
	payload := s.workflowEnvelope(event)
	payload["taskQueue"] = taskQueue
	payloadBytes, _ := json.Marshal(payload)
	status := "queued"
	lastError := ""
	if temporalBridgeURL != "" {
		request, requestErr := http.NewRequest(http.MethodPost, strings.TrimRight(temporalBridgeURL, "/")+"/inventory/workflows", bytes.NewReader(payloadBytes))
		if requestErr != nil {
			status = "failed"
			lastError = requestErr.Error()
		} else {
			request.Header.Set("Content-Type", "application/json")
			response, doErr := s.httpClient.Do(request)
			if doErr != nil {
				status = "failed"
				lastError = doErr.Error()
			} else {
				defer response.Body.Close()
				if response.StatusCode >= 400 {
					status = "failed"
					lastError = fmt.Sprintf("temporal bridge returned status %d", response.StatusCode)
				} else {
					status = "submitted"
				}
			}
		}
	}
	_, dbErr := s.db.Exec(`
		INSERT INTO inventory_workflow_orchestration (workflow_id, workflow_type, resource_id, orchestrator, target, status, payload, last_error, created_at, updated_at)
		VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, NOW(), NOW())
	`, event.WorkflowID, event.WorkflowType, event.ResourceID, "temporal", temporalTarget(taskQueue, temporalBridgeURL), status, string(payloadBytes), nullableString(lastError))
	if dbErr != nil {
		return roundDurationMs(time.Since(startedAt)), dbErr
	}
	if lastError != "" {
		return roundDurationMs(time.Since(startedAt)), fmt.Errorf(lastError)
	}
	return roundDurationMs(time.Since(startedAt)), nil
}

func (s *inventoryService) workflowEnvelope(event inventoryWorkflowEvent) map[string]any {
	return map[string]any{
		"source":        s.serviceName,
		"timestamp":     time.Now().UTC().Format(time.RFC3339),
		"workflow_id":   event.WorkflowID,
		"workflow_type": event.WorkflowType,
		"resource_id":   event.ResourceID,
		"step":          event.Step,
		"status":        event.Status,
		"payload":       event.Payload,
	}
}

func (s *inventoryService) middlewareStatus() map[string]any {
	return map[string]any{
		"dapr":     map[string]any{"configured": getenv("DAPR_HTTP_PORT", "") != "" && getenv("DAPR_PUBSUB_NAME", "") != "" && getenv("DAPR_INVENTORY_TOPIC", "") != ""},
		"kafka":    map[string]any{"configured": getenv("KAFKA_BROKERS", "") != "" && getenv("KAFKA_INVENTORY_TOPIC", "") != ""},
		"fluvio":   map[string]any{"configured": getenv("FLUVIO_KAFKA_BROKERS", "") != "" && getenv("FLUVIO_INVENTORY_TOPIC", "") != ""},
		"temporal": map[string]any{"configured": getenv("TEMPORAL_BRIDGE_URL", "") != "" || getenv("TEMPORAL_TASK_QUEUE", "") != ""},
	}
}

func (s *inventoryService) requireInternalAccess(r *http.Request) error {
	provided := strings.TrimSpace(r.Header.Get("x-internal-service-token"))
	if len(s.internalServiceToken) < 32 || len(provided) != len(s.internalServiceToken) || subtle.ConstantTimeCompare([]byte(provided), []byte(s.internalServiceToken)) != 1 {
		return fmt.Errorf("unauthorized internal access")
	}
	return nil
}

func writeJSON(w http.ResponseWriter, statusCode int, payload any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(payload)
}

func requestTraceID(r *http.Request) string {
	provided := strings.TrimSpace(r.Header.Get("x-trace-id"))
	if provided != "" {
		return provided
	}
	return fmt.Sprintf("inv-%d", time.Now().UnixNano())
}

func getenv(name string, fallback string) string {
	if value, ok := os.LookupEnv(name); ok && strings.TrimSpace(value) != "" {
		return value
	}
	return fallback
}

func splitAndTrim(raw string) []string {
	parts := strings.Split(raw, ",")
	clean := make([]string, 0, len(parts))
	for _, part := range parts {
		trimmed := strings.TrimSpace(part)
		if trimmed != "" {
			clean = append(clean, trimmed)
		}
	}
	return clean
}

func roundDurationMs(duration time.Duration) float64 {
	return float64(duration.Microseconds()) / 1000
}

func defaultFloat(value float64, fallback float64) float64 {
	if value <= 0 {
		return fallback
	}
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if strings.TrimSpace(value) != "" {
			return value
		}
	}
	return ""
}

func temporalTarget(taskQueue string, bridgeURL string) string {
	if strings.TrimSpace(bridgeURL) != "" {
		return strings.TrimRight(bridgeURL, "/") + "/inventory/workflows"
	}
	if strings.TrimSpace(taskQueue) != "" {
		return fmt.Sprintf("task-queue:%s", taskQueue)
	}
	return "temporal-unconfigured"
}

func nullableString(value string) any {
	if strings.TrimSpace(value) == "" {
		return nil
	}
	return value
}

func nullableInt64(value *int64) any {
	if value == nil || *value <= 0 {
		return nil
	}
	return *value
}

func nullableFloatPtr(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}
