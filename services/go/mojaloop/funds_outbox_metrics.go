package main

import (
	"context"
	"crypto/subtle"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type fundsOutboxMetric struct {
	WorkClass          string
	ReadyUnits         int64
	OldestReadySeconds int64
}

func (s *MojaloopService) listFundsOutboxMetrics(ctx context.Context) ([]fundsOutboxMetric, error) {
	if s == nil || s.db == nil {
		return nil, fmt.Errorf("funds outbox metrics database is unavailable")
	}
	queryCtx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	rows, err := s.db.QueryContext(queryCtx, `
		SELECT work_class, ready_units, oldest_ready_seconds
		FROM public.mojaloop_outbox_autoscaling_metrics(clock_timestamp())
	`)
	if err != nil {
		return nil, fmt.Errorf("read funds outbox autoscaling metrics: %w", err)
	}
	defer rows.Close()

	metrics := make([]fundsOutboxMetric, 0, 3)
	for rows.Next() {
		metric := fundsOutboxMetric{}
		if err := rows.Scan(&metric.WorkClass, &metric.ReadyUnits, &metric.OldestReadySeconds); err != nil {
			return nil, fmt.Errorf("scan funds outbox autoscaling metric: %w", err)
		}
		if !validFundsOutboxWorkClass(metric.WorkClass) || metric.ReadyUnits < 0 || metric.OldestReadySeconds < 0 {
			return nil, fmt.Errorf("invalid funds outbox autoscaling metric row")
		}
		metrics = append(metrics, metric)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate funds outbox autoscaling metrics: %w", err)
	}
	if len(metrics) != 3 {
		return nil, fmt.Errorf("funds outbox autoscaling metrics must return exactly three work classes")
	}
	return metrics, nil
}

func validFundsOutboxWorkClass(value string) bool {
	switch value {
	case "general_workflow", "ledger_transfer_lane", "ledger_refund":
		return true
	default:
		return false
	}
}

func (s *MojaloopService) requireMetricsAccess(w http.ResponseWriter, r *http.Request) bool {
	provided := strings.TrimSpace(r.Header.Get("X-Internal-Service-Token"))
	if provided == "" {
		const bearerPrefix = "Bearer "
		authorization := strings.TrimSpace(r.Header.Get("Authorization"))
		if strings.HasPrefix(authorization, bearerPrefix) {
			provided = strings.TrimSpace(strings.TrimPrefix(authorization, bearerPrefix))
		}
	}
	if provided == "" || subtle.ConstantTimeCompare([]byte(provided), []byte(s.internalServiceToken)) != 1 {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return false
	}
	return true
}

func renderFundsOutboxMetrics(metrics []fundsOutboxMetric) string {
	var builder strings.Builder
	builder.WriteString("# HELP deliveryplatform_funds_outbox_ready_units Eligible due financial outbox work units by bounded work class.\n")
	builder.WriteString("# TYPE deliveryplatform_funds_outbox_ready_units gauge\n")
	builder.WriteString("# HELP deliveryplatform_funds_outbox_oldest_ready_seconds Age in seconds of the oldest eligible due financial outbox work unit by bounded work class.\n")
	builder.WriteString("# TYPE deliveryplatform_funds_outbox_oldest_ready_seconds gauge\n")
	for _, metric := range metrics {
		if !validFundsOutboxWorkClass(metric.WorkClass) {
			continue
		}
		fmt.Fprintf(&builder, "deliveryplatform_funds_outbox_ready_units{work_class=%q} %d\n", metric.WorkClass, metric.ReadyUnits)
		fmt.Fprintf(&builder, "deliveryplatform_funds_outbox_oldest_ready_seconds{work_class=%q} %d\n", metric.WorkClass, metric.OldestReadySeconds)
	}
	return builder.String()
}

func (s *MojaloopService) handleFundsOutboxMetricsHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	if !s.requireMetricsAccess(w, r) {
		return
	}
	metrics, err := s.listFundsOutboxMetrics(r.Context())
	if err != nil {
		http.Error(w, "funds outbox metrics unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	_, _ = w.Write([]byte(renderFundsOutboxMetrics(metrics)))
}
