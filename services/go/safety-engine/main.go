// Command safety-engine is the R3 driver safety kit backend: SOS event
// ingest, trip risk scoring, and the passenger manifest verification hook.
//
// DATABASE DEPENDENCY (parallel workstream): the tables below are created by
// migration drizzle/0083 (built in parallel with this service). This service
// intentionally does NOT create them; every statement is written against the
// agreed contract and fails cleanly at runtime until the migration lands:
//
//	public.sos_events(id, trip_id, user_id, role, lat, lng, status,
//	    resolved_by, resolved_at, created_at)
//	public.passenger_manifests(trip_id, booked_by, passengers jsonb
//	    [{name, nin_hash}], manifest_verified, verified_via)
//	public.rider_verifications(user_id, status)
//	public.trip_safety_signals(trip_id, severity, created_at)
//
// Privacy invariant: nin_hash values never leave the database — the manifest
// verify hook extracts passenger names server-side in SQL.
package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	_ "github.com/lib/pq"

	sharedmetrics "switchos-metrics"
	"switchos-resilience"
)

const (
	serviceName      = "safety-engine"
	requestIDHeader  = "X-Request-Id"
	maxRequestBytes  = 64 << 10
	manifestMaxNames = 50
)

type config struct {
	DatabaseURL              string
	InternalServiceToken     string
	VerificationIntelligence string
	BindHost                 string
	Port                     string
}

type service struct {
	db     *sql.DB
	cfg    config
	client *http.Client
}

type correlationContextKey struct{}

type sosRequest struct {
	TripID *string  `json:"trip_id"`
	UserID string   `json:"user_id"`
	Role   string   `json:"role"`
	Lat    *float64 `json:"lat"`
	Lng    *float64 `json:"lng"`
}

type sosResolveRequest struct {
	ResolvedBy string `json:"resolved_by"`
}

type manifestVerifyHookRequest struct {
	TripID string `json:"trip_id"`
}

type manifestPassenger struct {
	Name string `json:"name"`
}

type manifestPassengerResult struct {
	Name        string   `json:"name"`
	NameOK      bool     `json:"name_ok"`
	NINFormatOK *bool    `json:"nin_format_ok"`
	Flags       []string `json:"flags"`
}

type manifestVerifyResponse struct {
	Results []manifestPassengerResult `json:"results"`
}

type riskResponse struct {
	Score   int          `json:"score"`
	Factors []riskFactor `json:"factors"`
}

func main() {
	if err := validateBootConfiguration(); err != nil {
		log.Fatal(err)
	}
	cfg := loadConfig()
	db, err := sql.Open("postgres", cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("open database: %v", err)
	}
	defer db.Close()
	db.SetMaxOpenConns(16)
	db.SetMaxIdleConns(4)
	db.SetConnMaxLifetime(15 * time.Minute)
	db.SetConnMaxIdleTime(3 * time.Minute)
	if err := db.Ping(); err != nil {
		log.Fatalf("ping database: %v", err)
	}

	svc := &service{
		db:  db,
		cfg: cfg,
		client: resilience.NewClient(15*time.Second,
			resilience.RetryPolicy{MaxAttempts: 3, BackoffBase: 100 * time.Millisecond, BackoffMax: 2 * time.Second},
			resilience.BreakerConfig{FailureThreshold: 5, ResetTimeout: 30 * time.Second, HalfOpenMaxProbes: 1}),
	}

	httpMetrics := sharedmetrics.New(serviceName, getenv("SERVICE_VERSION", ""))
	mux := http.NewServeMux()
	mux.Handle("/metrics", httpMetrics.Handler())
	mux.HandleFunc("/health", svc.healthHandler)
	mux.HandleFunc("/sos", svc.sosHandler)
	mux.HandleFunc("/sos/", svc.sosResolveHandler)
	mux.HandleFunc("/trip/", svc.tripRiskHandler)
	mux.HandleFunc("/manifest/verify-hook", svc.manifestVerifyHookHandler)

	server := &http.Server{
		Addr:              cfg.BindHost + ":" + cfg.Port,
		Handler:           svc.securityHeaders(svc.requestID(httpMetrics.Middleware(mux))),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	serverErrors := make(chan error, 1)
	go func() {
		log.Printf("%s listening on %s", serviceName, server.Addr)
		serverErrors <- server.ListenAndServe()
	}()

	select {
	case err := <-serverErrors:
		if err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	case <-ctx.Done():
		log.Printf("shutdown signal received; draining in-flight requests")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdownCtx); err != nil {
			log.Printf("graceful shutdown failed: %v", err)
		}
		if err := <-serverErrors; err != nil && err != http.ErrServerClosed {
			log.Fatal(err)
		}
	}
}

func loadConfig() config {
	return config{
		DatabaseURL:              strings.TrimSpace(os.Getenv("DATABASE_URL")),
		InternalServiceToken:     strings.TrimSpace(os.Getenv("INTERNAL_SERVICE_TOKEN")),
		VerificationIntelligence: getenv("VERIFICATION_INTELLIGENCE_URL", "http://127.0.0.1:8106"),
		BindHost:                 getenv("BIND_HOST", "127.0.0.1"),
		Port:                     getenv("PORT", "8107"),
	}
}

func (s *service) requestID(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := normalizeCorrelationID(r.Header.Get(requestIDHeader))
		if requestID == "" {
			generated, err := newRequestID()
			if err != nil {
				writeError(w, http.StatusServiceUnavailable, "request_id_unavailable")
				return
			}
			requestID = generated
		}
		w.Header().Set(requestIDHeader, requestID)
		ctx := context.WithValue(r.Context(), correlationContextKey{}, requestID)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (s *service) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, r)
	})
}

func (s *service) requireInternalAccess(w http.ResponseWriter, r *http.Request) bool {
	provided := strings.TrimSpace(r.Header.Get("X-Internal-Service-Token"))
	if provided == "" || subtle.ConstantTimeCompare([]byte(provided), []byte(s.cfg.InternalServiceToken)) != 1 {
		writeError(w, http.StatusUnauthorized, "invalid_internal_service_token")
		return false
	}
	return true
}

func (s *service) healthHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
	defer cancel()
	if err := s.db.PingContext(ctx); err != nil {
		writeError(w, http.StatusServiceUnavailable, "database_unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "ok", "service": serviceName})
}

// sosHandler records an SOS event in public.sos_events (drizzle/0083). It
// performs no scoring or dispatching; downstream consumers read the table.
func (s *service) sosHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	var request sosRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	request.UserID = strings.TrimSpace(request.UserID)
	request.Role = strings.ToLower(strings.TrimSpace(request.Role))
	if request.UserID == "" || len(request.UserID) > 128 {
		writeError(w, http.StatusBadRequest, "user_id_is_required")
		return
	}
	if request.Role != "driver" && request.Role != "rider" && request.Role != "passenger" {
		writeError(w, http.StatusBadRequest, "role_must_be_driver_rider_or_passenger")
		return
	}
	if (request.Lat == nil) != (request.Lng == nil) {
		writeError(w, http.StatusBadRequest, "lat_and_lng_must_be_provided_together")
		return
	}
	if request.Lat != nil && (*request.Lat < -90 || *request.Lat > 90 || *request.Lng < -180 || *request.Lng > 180) {
		writeError(w, http.StatusBadRequest, "lat_lng_out_of_range")
		return
	}
	var tripID any
	if request.TripID != nil && strings.TrimSpace(*request.TripID) != "" {
		tripID = strings.TrimSpace(*request.TripID)
	}
	var id, status string
	err := s.db.QueryRowContext(r.Context(),
		`INSERT INTO public.sos_events (trip_id, user_id, role, lat, lng) VALUES ($1, $2, $3, $4, $5) RETURNING id, status`,
		tripID, request.UserID, request.Role, request.Lat, request.Lng).Scan(&id, &status)
	if err != nil {
		log.Printf(`{"service":"%s","event":"sos_insert_failed","error_class":"%T"}`, serviceName, err)
		writeError(w, http.StatusServiceUnavailable, "sos_unavailable")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]string{"id": id, "status": status})
}

// sosResolveHandler marks an SOS event resolved: POST /sos/{id}/resolve.
func (s *service) sosResolveHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	id, ok := strings.CutSuffix(strings.TrimPrefix(r.URL.Path, "/sos/"), "/resolve")
	if !ok || id == "" || strings.Contains(id, "/") {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	var request sosResolveRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	request.ResolvedBy = strings.TrimSpace(request.ResolvedBy)
	if request.ResolvedBy == "" || len(request.ResolvedBy) > 128 {
		writeError(w, http.StatusBadRequest, "resolved_by_is_required")
		return
	}
	var status string
	err := s.db.QueryRowContext(r.Context(),
		`UPDATE public.sos_events SET status = 'resolved', resolved_by = $2, resolved_at = now() WHERE id = $1 AND status <> 'resolved' RETURNING status`,
		id, request.ResolvedBy).Scan(&status)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "sos_event_not_found")
		return
	}
	if err != nil {
		log.Printf(`{"service":"%s","event":"sos_resolve_failed","error_class":"%T"}`, serviceName, err)
		writeError(w, http.StatusServiceUnavailable, "sos_unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"id": id, "status": status})
}

// tripRiskHandler computes the 0-100 trip risk score: GET /trip/{trip_id}/risk.
func (s *service) tripRiskHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	tripID, ok := strings.CutSuffix(strings.TrimPrefix(r.URL.Path, "/trip/"), "/risk")
	if !ok || tripID == "" || strings.Contains(tripID, "/") {
		writeError(w, http.StatusNotFound, "not_found")
		return
	}
	input, err := s.loadRiskInput(r.Context(), tripID)
	if err != nil {
		log.Printf(`{"service":"%s","event":"risk_input_failed","error_class":"%T"}`, serviceName, err)
		writeError(w, http.StatusServiceUnavailable, "risk_unavailable")
		return
	}
	score, factors := computeTripRiskScore(input)
	writeJSON(w, http.StatusOK, riskResponse{Score: score, Factors: factors})
}

// loadRiskInput fetches the scoring signals for a trip. Missing optional
// signals degrade to zero values instead of failing the request; only hard
// database errors propagate.
func (s *service) loadRiskInput(ctx context.Context, tripID string) (riskInput, error) {
	var input riskInput
	var bookedBy sql.NullString
	err := s.db.QueryRowContext(ctx,
		`SELECT booked_by, manifest_verified FROM public.passenger_manifests WHERE trip_id = $1 LIMIT 1`, tripID).
		Scan(&bookedBy, &input.ManifestVerified)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		input.ManifestPresent = false
	case err != nil:
		return riskInput{}, err
	default:
		input.ManifestPresent = true
	}

	if bookedBy.Valid {
		var status string
		err := s.db.QueryRowContext(ctx,
			`SELECT status FROM public.rider_verifications WHERE user_id = $1 LIMIT 1`, bookedBy.String).Scan(&status)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return riskInput{}, err
		}
		input.RiderVerified = err == nil && status == "verified"
	}

	err = s.db.QueryRowContext(ctx,
		`SELECT count(*), count(*) FILTER (WHERE severity IN ('high', 'critical'))
		 FROM public.trip_safety_signals
		 WHERE trip_id = $1 AND created_at >= now() - interval '24 hours'`, tripID).
		Scan(&input.RecentSignalCount, &input.HighSeveritySignalCount)
	if err != nil {
		return riskInput{}, err
	}

	err = s.db.QueryRowContext(ctx,
		`SELECT count(*) FROM public.sos_events WHERE trip_id = $1`, tripID).Scan(&input.SOSCount)
	if err != nil {
		return riskInput{}, err
	}
	return input, nil
}

// manifestVerifyHookHandler verifies a trip's passenger manifest through the
// verification-intelligence service. Passenger names are extracted from the
// passengers jsonb column server-side so nin_hash values never leave the
// database. The outbound call runs behind the shared circuit breaker; an
// open breaker yields 503 verification_unavailable.
func (s *service) manifestVerifyHookHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	var request manifestVerifyHookRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	request.TripID = strings.TrimSpace(request.TripID)
	if request.TripID == "" {
		writeError(w, http.StatusBadRequest, "trip_id_is_required")
		return
	}

	var names []string
	rows, err := s.db.QueryContext(r.Context(),
		`SELECT elem ->> 'name'
		 FROM public.passenger_manifests pm
		 CROSS JOIN LATERAL jsonb_array_elements(pm.passengers) AS elem
		 WHERE pm.trip_id = $1`, request.TripID)
	if err != nil {
		log.Printf(`{"service":"%s","event":"manifest_read_failed","error_class":"%T"}`, serviceName, err)
		writeError(w, http.StatusServiceUnavailable, "manifest_unavailable")
		return
	}
	defer rows.Close()
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			writeError(w, http.StatusServiceUnavailable, "manifest_unavailable")
			return
		}
		if trimmed := strings.TrimSpace(name); trimmed != "" {
			names = append(names, trimmed)
		}
	}
	if err := rows.Err(); err != nil {
		writeError(w, http.StatusServiceUnavailable, "manifest_unavailable")
		return
	}
	if len(names) == 0 {
		writeError(w, http.StatusNotFound, "manifest_not_found")
		return
	}
	if len(names) > manifestMaxNames {
		writeError(w, http.StatusUnprocessableEntity, "manifest_too_large")
		return
	}

	passengers := make([]manifestPassenger, 0, len(names))
	for _, name := range names {
		passengers = append(passengers, manifestPassenger{Name: name})
	}
	var verified manifestVerifyResponse
	endpoint := strings.TrimRight(s.cfg.VerificationIntelligence, "/") + "/manifest/verify"
	err = s.postInternalJSON(r.Context(), endpoint, map[string]any{"passengers": passengers}, &verified)
	if err != nil {
		if errors.Is(err, resilience.ErrCircuitOpen) {
			writeError(w, http.StatusServiceUnavailable, "verification_unavailable")
			return
		}
		log.Printf(`{"service":"%s","event":"manifest_verify_call_failed","error_class":"%T"}`, serviceName, err)
		writeError(w, http.StatusServiceUnavailable, "verification_unavailable")
		return
	}

	allOK := len(verified.Results) > 0
	for _, result := range verified.Results {
		if !result.NameOK {
			allOK = false
			break
		}
	}
	if _, err := s.db.ExecContext(r.Context(),
		`UPDATE public.passenger_manifests SET manifest_verified = $2, verified_via = 'safety-engine' WHERE trip_id = $1`,
		request.TripID, allOK); err != nil {
		log.Printf(`{"service":"%s","event":"manifest_update_failed","error_class":"%T"}`, serviceName, err)
		writeError(w, http.StatusServiceUnavailable, "manifest_unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"trip_id":           request.TripID,
		"manifest_verified": allOK,
		"verified_via":      serviceName,
		"results":           verified.Results,
	})
}

// postInternalJSON posts a JSON body to an internal service with the shared
// internal-service-token header through the resilient client.
func (s *service) postInternalJSON(ctx context.Context, url string, in any, out any) error {
	body, err := json.Marshal(in)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, strings.NewReader(string(body)))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Internal-Service-Token", s.cfg.InternalServiceToken)
	response, err := s.client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return errors.New("internal service returned " + response.Status)
	}
	return json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(out)
}

func decodeJSON(w http.ResponseWriter, r *http.Request, destination any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, maxRequestBytes)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		writeError(w, http.StatusBadRequest, "invalid_json_request")
		return false
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		writeError(w, http.StatusBadRequest, "multiple_json_values_not_allowed")
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, status int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}

func writeError(w http.ResponseWriter, status int, code string) {
	writeJSON(w, status, map[string]string{"error": code})
}

func normalizeCorrelationID(value string) string {
	value = strings.TrimSpace(value)
	if len(value) < 3 || len(value) > 81 {
		return ""
	}
	for _, character := range value {
		if !((character >= 'a' && character <= 'z') || (character >= 'A' && character <= 'Z') || (character >= '0' && character <= '9') || character == '.' || character == '_' || character == '-') {
			return ""
		}
	}
	return value
}

func newRequestID() (string, error) {
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return "", err
	}
	return hex.EncodeToString(buf), nil
}

func getenv(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}
