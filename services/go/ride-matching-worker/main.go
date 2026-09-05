package main

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/lib/pq"
	"github.com/redis/go-redis/v9"
	h3 "github.com/uber/h3-go/v4"
)

const (
	serviceName         = "ride-matching-worker"
	resilienceRunHeader = "X-Resilience-Run-Id"
	requestIDHeader     = "X-Request-Id"
	maxRequestBytes     = 64 << 10
	maxOfferWaveSize    = 5
	defaultOfferTTL     = 20 * time.Second
	defaultMatchRange   = 1500.0
	defaultSpeedMPS     = 8.0
	defaultH3Resolution = 9
)

type config struct {
	DatabaseURL            string
	RedisURL               string
	InternalServiceToken   string
	BindHost               string
	Port                   string
	MatchRadiusM           float64
	CandidateLimit         int
	OfferWaveSize          int
	OfferTTL               time.Duration
	LocationMinIntegrity   int
	AverageSpeedMPS        float64
	ReaperInterval         time.Duration
	H3Resolution           int
	DatabaseMaxOpenConns   int
	DatabaseMaxIdleConns   int
	RedisPoolSize          int
	RequireDeviceIntegrity bool
}

type service struct {
	db  *sql.DB
	rdb *redis.Client
	cfg config
	mu  sync.Mutex
}

type correlationContextKey struct{}

type requestCorrelation struct {
	RequestID       string
	ResilienceRunID string
}

type statusCapturingResponseWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusCapturingResponseWriter) WriteHeader(status int) {
	w.status = status
	w.ResponseWriter.WriteHeader(status)
}

func (w *statusCapturingResponseWriter) Write(payload []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(payload)
}

type matchRequest struct {
	TripID         string `json:"trip_id"`
	IdempotencyKey string `json:"idempotency_key"`
}

type presenceProjectionRequest struct {
	DriverUserID int64 `json:"driver_user_id"`
	PGVersion    int64 `json:"pg_version"`
}

type driverLocationEventRequest struct {
	DriverUserID    int64   `json:"driver_user_id"`
	DeviceSessionID string  `json:"device_session_id"`
	SourceSequence  int64   `json:"source_sequence"`
	OccurredAt      string  `json:"occurred_at"`
	Latitude        float64 `json:"latitude"`
	Longitude       float64 `json:"longitude"`
	AccuracyM       float64 `json:"accuracy_m"`
	IntegrityScore  int     `json:"integrity_score"`
	DevicePublicID  string  `json:"device_public_id"`
	AttestationID   string  `json:"attestation_id"`
}

type deviceRegistrationRequest struct {
	DriverUserID         int64  `json:"driver_user_id"`
	DevicePublicID       string `json:"device_public_id"`
	DeviceFingerprint    string `json:"device_fingerprint"`
	AttestationID        string `json:"attestation_id"`
	AttestationState     string `json:"attestation_state"`
	AttestationProvider  string `json:"attestation_provider"`
	AttestationExpiresAt string `json:"attestation_expires_at"`
}

type locationConsentRequest struct {
	DriverUserID   int64  `json:"driver_user_id"`
	DevicePublicID string `json:"device_public_id"`
	ConsentVersion string `json:"consent_version"`
	State          string `json:"state"`
	EvidenceRef    string `json:"evidence_ref"`
}

type driverLocationEventResponse struct {
	DriverUserID int64 `json:"driver_user_id"`
	PGVersion    int64 `json:"pg_version"`
	Accepted     bool  `json:"accepted"`
	Projected    bool  `json:"projected"`
}

type spatialCandidateQueryRequest struct {
	ZoneID    string  `json:"zone_id"`
	Latitude  float64 `json:"latitude"`
	Longitude float64 `json:"longitude"`
}

type spatialCandidateQueryResponse struct {
	ZoneID          string  `json:"zone_id"`
	H3Cell          string  `json:"h3_cell"`
	CandidateCount  int     `json:"candidate_count"`
	NearestDriverID []int64 `json:"nearest_driver_ids"`
}

type matchResponse struct {
	TripID           string   `json:"trip_id"`
	MatchAttemptID   string   `json:"match_attempt_id"`
	State            string   `json:"state"`
	CandidateCount   int      `json:"candidate_count"`
	OfferIDs         []string `json:"offer_ids"`
	AlgorithmVersion string   `json:"algorithm_version"`
}

type candidate struct {
	DriverUserID   int64
	Latitude       float64
	Longitude      float64
	DistanceM      float64
	IntegrityScore int
	ETASeconds     int
	Score          float64
}

type tripForMatch struct {
	ID        string
	State     string
	ZoneID    string
	PickupLat float64
	PickupLng float64
	H3Cell    string
}

type offerProjection struct {
	OfferID   string
	TripID    string
	ZoneID    string
	DriverID  int64
	ExpiresAt time.Time
}

func main() {
	cfg, err := loadConfig()
	if err != nil {
		log.Fatal(err)
	}
	db, err := sql.Open("postgres", cfg.DatabaseURL)
	if err != nil {
		log.Fatalf("open database: %v", err)
	}
	db.SetMaxOpenConns(cfg.DatabaseMaxOpenConns)
	db.SetMaxIdleConns(cfg.DatabaseMaxIdleConns)
	db.SetConnMaxLifetime(15 * time.Minute)
	db.SetConnMaxIdleTime(3 * time.Minute)
	if err := db.Ping(); err != nil {
		log.Fatalf("ping database: %v", err)
	}

	redisOptions, err := redis.ParseURL(cfg.RedisURL)
	if err != nil {
		log.Fatalf("parse REDIS_URL: %v", err)
	}
	redisOptions.PoolSize = cfg.RedisPoolSize
	rdb := redis.NewClient(redisOptions)
	if err := rdb.Ping(context.Background()).Err(); err != nil {
		log.Fatalf("ping redis: %v", err)
	}

	svc := &service{db: db, rdb: rdb, cfg: cfg}
	go svc.reapExpiredOffers(context.Background())

	mux := http.NewServeMux()
	mux.HandleFunc("/health", svc.healthHandler)
	mux.HandleFunc("/matches/attempts", svc.matchHandler)
	mux.HandleFunc("/events/driver-presence", svc.presenceProjectionHandler)
	mux.HandleFunc("/events/driver-location", svc.driverLocationEventHandler)
	mux.HandleFunc("/telematics/devices", svc.deviceRegistrationHandler)
	mux.HandleFunc("/telematics/location-consents", svc.locationConsentHandler)
	mux.HandleFunc("/queries/spatial-candidates", svc.spatialCandidateQueryHandler)
	mux.HandleFunc("/events/reconcile-cache", svc.cacheReconcileHandler)

	server := &http.Server{
		Addr:              cfg.BindHost + ":" + cfg.Port,
		Handler:           svc.securityHeaders(svc.correlationLogging(mux)),
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       10 * time.Second,
		WriteTimeout:      15 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	log.Printf("%s listening on %s", serviceName, server.Addr)
	log.Fatal(server.ListenAndServe())
}

func loadConfig() (config, error) {
	cfg := config{
		DatabaseURL:            strings.TrimSpace(os.Getenv("DATABASE_URL")),
		RedisURL:               strings.TrimSpace(os.Getenv("REDIS_URL")),
		InternalServiceToken:   strings.TrimSpace(os.Getenv("INTERNAL_SERVICE_TOKEN")),
		BindHost:               getenv("BIND_HOST", "127.0.0.1"),
		Port:                   getenv("PORT", "8121"),
		MatchRadiusM:           getenvFloat("MATCH_RADIUS_METERS", defaultMatchRange),
		CandidateLimit:         getenvInt("MATCH_CANDIDATE_LIMIT", 25),
		OfferWaveSize:          getenvInt("MATCH_OFFER_WAVE_SIZE", 1),
		OfferTTL:               time.Duration(getenvInt("MATCH_OFFER_TTL_SECONDS", int(defaultOfferTTL.Seconds()))) * time.Second,
		LocationMinIntegrity:   getenvInt("MATCH_MIN_LOCATION_INTEGRITY", 70),
		AverageSpeedMPS:        getenvFloat("MATCH_AVERAGE_SPEED_MPS", defaultSpeedMPS),
		ReaperInterval:         time.Duration(getenvInt("MATCH_REAPER_INTERVAL_SECONDS", 2)) * time.Second,
		H3Resolution:           getenvInt("MATCH_H3_RESOLUTION", defaultH3Resolution),
		DatabaseMaxOpenConns:   getenvInt("DB_MAX_OPEN_CONNS", 32),
		DatabaseMaxIdleConns:   getenvInt("DB_MAX_IDLE_CONNS", 8),
		RedisPoolSize:          getenvInt("REDIS_POOL_SIZE", 64),
		RequireDeviceIntegrity: getenvBool("MATCH_REQUIRE_DEVICE_INTEGRITY", false),
	}
	if cfg.DatabaseURL == "" {
		return config{}, errors.New("DATABASE_URL must be explicitly configured")
	}
	if cfg.RedisURL == "" {
		return config{}, errors.New("REDIS_URL must be explicitly configured")
	}
	if len(cfg.InternalServiceToken) < 32 {
		return config{}, errors.New("INTERNAL_SERVICE_TOKEN must be explicitly configured with at least 32 characters")
	}
	if cfg.MatchRadiusM <= 0 || cfg.CandidateLimit < 1 || cfg.CandidateLimit > 100 || cfg.OfferWaveSize < 1 || cfg.OfferWaveSize > maxOfferWaveSize || cfg.OfferTTL < 5*time.Second || cfg.OfferTTL > 90*time.Second || cfg.LocationMinIntegrity < 0 || cfg.LocationMinIntegrity > 100 || cfg.AverageSpeedMPS <= 0 || cfg.ReaperInterval < time.Second || cfg.H3Resolution < 0 || cfg.H3Resolution > 15 || cfg.DatabaseMaxOpenConns < 2 || cfg.DatabaseMaxOpenConns > 96 || cfg.DatabaseMaxIdleConns < 0 || cfg.DatabaseMaxIdleConns > cfg.DatabaseMaxOpenConns || cfg.RedisPoolSize < 4 || cfg.RedisPoolSize > 512 {
		return config{}, errors.New("matching worker configuration is outside allowed safe bounds")
	}
	return cfg, nil
}

func (s *service) correlationLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requestID := normalizeCorrelationID(r.Header.Get(requestIDHeader))
		if requestID == "" {
			generated, err := newUUID()
			if err != nil {
				writeError(w, http.StatusServiceUnavailable, "request_id_unavailable")
				return
			}
			requestID = generated
		}
		resilienceRunID := normalizeCorrelationID(r.Header.Get(resilienceRunHeader))
		correlation := requestCorrelation{RequestID: requestID, ResilienceRunID: resilienceRunID}
		ctx := context.WithValue(r.Context(), correlationContextKey{}, correlation)
		w.Header().Set(requestIDHeader, requestID)
		if resilienceRunID != "" {
			w.Header().Set(resilienceRunHeader, resilienceRunID)
		}
		capturing := &statusCapturingResponseWriter{ResponseWriter: w}
		started := time.Now()
		next.ServeHTTP(capturing, r.WithContext(ctx))
		if resilienceRunID != "" {
			status := capturing.status
			if status == 0 {
				status = http.StatusOK
			}
			logCorrelationEvent(ctx, "http.request.completed", "method", r.Method, "path", r.URL.Path, "status", status, "duration_ms", time.Since(started).Milliseconds())
		}
	})
}

func (s *service) securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		next.ServeHTTP(w, r)
	})
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
	if err := s.rdb.Ping(ctx).Err(); err != nil {
		writeError(w, http.StatusServiceUnavailable, "redis_unavailable")
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"status": "healthy", "service": serviceName})
}

func (s *service) matchHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	var request matchRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	request.TripID = strings.TrimSpace(request.TripID)
	request.IdempotencyKey = strings.TrimSpace(request.IdempotencyKey)
	if request.TripID == "" || len(request.TripID) > 64 || request.IdempotencyKey == "" || len(request.IdempotencyKey) > 128 {
		writeError(w, http.StatusBadRequest, "trip_id_and_idempotency_key_are_required")
		return
	}

	response, err := s.matchTrip(r.Context(), request)
	if err != nil {
		s.writeMatchError(r.Context(), w, request.TripID, err)
		return
	}
	logCorrelationEvent(r.Context(), "matching.trip.completed", "trip_id", request.TripID, "match_attempt_id", response.MatchAttemptID, "state", response.State, "candidate_count", response.CandidateCount, "offer_count", len(response.OfferIDs))
	writeJSON(w, http.StatusOK, response)
}

func (s *service) presenceProjectionHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	var request presenceProjectionRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	if request.DriverUserID <= 0 || request.PGVersion <= 0 {
		writeError(w, http.StatusBadRequest, "driver_user_id_and_pg_version_are_required")
		return
	}
	if err := s.projectDriverPresence(r.Context(), request.DriverUserID, request.PGVersion); err != nil {
		if errors.Is(err, errNotFound) {
			writeError(w, http.StatusNotFound, "durable_presence_not_found")
			return
		}
		log.Printf("project presence driver=%d version=%d: %v", request.DriverUserID, request.PGVersion, err)
		writeError(w, http.StatusServiceUnavailable, "presence_projection_failed")
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"driver_user_id": request.DriverUserID, "pg_version": request.PGVersion, "projected": true})
}

func (s *service) deviceRegistrationHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	var request deviceRegistrationRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	request.DevicePublicID = strings.TrimSpace(request.DevicePublicID)
	request.DeviceFingerprint = strings.TrimSpace(request.DeviceFingerprint)
	request.AttestationID = strings.TrimSpace(request.AttestationID)
	request.AttestationState = strings.TrimSpace(request.AttestationState)
	request.AttestationProvider = strings.TrimSpace(request.AttestationProvider)
	expiresAt, err := time.Parse(time.RFC3339Nano, strings.TrimSpace(request.AttestationExpiresAt))
	if err != nil || request.DriverUserID <= 0 || !isCanonicalUUID(request.DevicePublicID) || len(request.DeviceFingerprint) < 16 || len(request.DeviceFingerprint) > 256 || len(request.AttestationID) < 16 || len(request.AttestationID) > 256 || len(request.AttestationProvider) < 1 || len(request.AttestationProvider) > 80 || !map[string]bool{"verified": true, "failed": true, "expired": true}[request.AttestationState] || expiresAt.Before(time.Now()) {
		writeError(w, http.StatusBadRequest, "invalid_device_attestation")
		return
	}
	fingerprint := sha256.Sum256([]byte(request.DeviceFingerprint))
	claims := sha256.Sum256([]byte(request.AttestationProvider + "|" + request.AttestationID + "|" + request.DevicePublicID))
	state := "pending"
	if request.AttestationState == "verified" {
		state = "active"
	} else if request.AttestationState == "failed" {
		state = "suspended"
	}
	tx, err := s.db.BeginTx(r.Context(), &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "device_registration_unavailable")
		return
	}
	defer tx.Rollback()
	var deviceID string
	err = tx.QueryRowContext(r.Context(), `INSERT INTO telematics.driver_device (driver_user_id,device_public_id,device_fingerprint_hash,state,last_attestation_state,last_attested_at,attestation_expires_at,activated_at,updated_at) VALUES ($1,$2::uuid,$3,$4::telematics.device_state,$5::telematics.attestation_state,NOW(),$6,CASE WHEN $4='active' THEN NOW() ELSE NULL END,NOW()) ON CONFLICT (device_public_id) DO UPDATE SET device_fingerprint_hash=EXCLUDED.device_fingerprint_hash,state=EXCLUDED.state,last_attestation_state=EXCLUDED.last_attestation_state,last_attested_at=EXCLUDED.last_attested_at,attestation_expires_at=EXCLUDED.attestation_expires_at,activated_at=CASE WHEN EXCLUDED.state='active' THEN NOW() ELSE telematics.driver_device.activated_at END,updated_at=NOW() WHERE telematics.driver_device.driver_user_id=EXCLUDED.driver_user_id RETURNING id::text`, request.DriverUserID, request.DevicePublicID, fingerprint[:], state, request.AttestationState, expiresAt.UTC()).Scan(&deviceID)
	if err != nil {
		writeError(w, http.StatusConflict, "device_registration_rejected")
		return
	}
	if _, err = tx.ExecContext(r.Context(), `INSERT INTO telematics.device_attestation_event (device_id,attestation_id,attestation_state,verified_at,expires_at,provider,claims_digest) VALUES ($1::uuid,$2,$3::telematics.attestation_state,NOW(),$4,$5,$6) ON CONFLICT (device_id,attestation_id) DO NOTHING`, deviceID, request.AttestationID, request.AttestationState, expiresAt.UTC(), request.AttestationProvider, claims[:]); err != nil {
		writeError(w, http.StatusServiceUnavailable, "device_registration_unavailable")
		return
	}
	if err = tx.Commit(); err != nil {
		writeError(w, http.StatusServiceUnavailable, "device_registration_unavailable")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"driver_user_id": request.DriverUserID, "device_public_id": request.DevicePublicID, "state": state})
}

func (s *service) locationConsentHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	var request locationConsentRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	request.DevicePublicID = strings.TrimSpace(request.DevicePublicID)
	request.ConsentVersion = strings.TrimSpace(request.ConsentVersion)
	request.State = strings.TrimSpace(request.State)
	request.EvidenceRef = strings.TrimSpace(request.EvidenceRef)
	if request.DriverUserID <= 0 || !isCanonicalUUID(request.DevicePublicID) || len(request.ConsentVersion) == 0 || len(request.ConsentVersion) > 64 || !map[string]bool{"granted": true, "withdrawn": true}[request.State] || len(request.EvidenceRef) < 16 || len(request.EvidenceRef) > 256 {
		writeError(w, http.StatusBadRequest, "invalid_location_consent")
		return
	}
	var deviceID string
	err := s.db.QueryRowContext(r.Context(), "SELECT id::text FROM telematics.driver_device WHERE driver_user_id=$1 AND device_public_id=$2::uuid", request.DriverUserID, request.DevicePublicID).Scan(&deviceID)
	if errors.Is(err, sql.ErrNoRows) {
		writeError(w, http.StatusNotFound, "driver_device_not_found")
		return
	}
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "location_consent_unavailable")
		return
	}
	_, err = s.db.ExecContext(r.Context(), `INSERT INTO telematics.driver_location_consent (driver_user_id,device_id,consent_version,state,granted_at,withdrawn_at,evidence_ref) VALUES ($1,$2::uuid,$3,$4::telematics.consent_state,CASE WHEN $4='granted' THEN NOW() ELSE NULL END,CASE WHEN $4='withdrawn' THEN NOW() ELSE NULL END,$5)`, request.DriverUserID, deviceID, request.ConsentVersion, request.State, request.EvidenceRef)
	if err != nil {
		writeError(w, http.StatusServiceUnavailable, "location_consent_unavailable")
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"driver_user_id": request.DriverUserID, "state": request.State})
}

func (s *service) driverLocationEventHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	var request driverLocationEventRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	request.DeviceSessionID = strings.TrimSpace(request.DeviceSessionID)
	occurredAt, err := time.Parse(time.RFC3339Nano, request.OccurredAt)
	if err != nil || request.DriverUserID <= 0 || !isCanonicalUUID(request.DeviceSessionID) || request.SourceSequence <= 0 ||
		request.Latitude < -90 || request.Latitude > 90 || request.Longitude < -180 || request.Longitude > 180 ||
		request.AccuracyM < 0 || request.AccuracyM > 10000 || request.IntegrityScore < 0 || request.IntegrityScore > 100 {
		writeError(w, http.StatusBadRequest, "invalid_driver_location_event")
		return
	}
	if occurredAt.After(time.Now().Add(2*time.Minute)) || occurredAt.Before(time.Now().Add(-10*time.Minute)) {
		writeError(w, http.StatusBadRequest, "driver_location_event_time_outside_allowed_window")
		return
	}
	if s.cfg.RequireDeviceIntegrity && request.IntegrityScore < s.cfg.LocationMinIntegrity {
		writeError(w, http.StatusUnprocessableEntity, "driver_location_integrity_below_threshold")
		return
	}
	if err := s.assertDeviceIntegrity(r.Context(), request); err != nil {
		if errors.Is(err, errDeviceIntegrity) {
			writeError(w, http.StatusForbidden, "driver_device_integrity_required")
			return
		}
		log.Printf("verify driver device integrity driver=%d: %v", request.DriverUserID, err)
		writeError(w, http.StatusServiceUnavailable, "driver_device_integrity_unavailable")
		return
	}
	version, accepted, err := s.ingestDriverLocation(r.Context(), request, occurredAt.UTC())

	if err != nil {
		if errors.Is(err, errNotFound) {
			writeError(w, http.StatusNotFound, "durable_presence_not_found")
			return
		}
		log.Printf("ingest driver location driver=%d sequence=%d: %v", request.DriverUserID, request.SourceSequence, err)
		writeError(w, http.StatusServiceUnavailable, "driver_location_ingest_failed")
		return
	}
	projected := false
	if accepted {
		for attempt := 0; attempt < 3; attempt++ {
			if projectionErr := s.projectDriverPresence(r.Context(), request.DriverUserID, version); projectionErr == nil {
				projected = true
				break
			} else if !errors.Is(projectionErr, errConflict) {
				log.Printf("project driver location driver=%d version=%d: %v", request.DriverUserID, version, projectionErr)
				break
			}
			currentVersion, currentErr := s.currentPresenceVersion(r.Context(), request.DriverUserID)
			if currentErr != nil {
				log.Printf("load current location projection version driver=%d: %v", request.DriverUserID, currentErr)
				break
			}
			version = currentVersion
		}
	}
	writeJSON(w, http.StatusAccepted, driverLocationEventResponse{DriverUserID: request.DriverUserID, PGVersion: version, Accepted: accepted, Projected: projected})
}

func (s *service) spatialCandidateQueryHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	var request spatialCandidateQueryRequest
	if !decodeJSON(w, r, &request) {
		return
	}
	request.ZoneID = strings.TrimSpace(request.ZoneID)
	if !isCanonicalUUID(request.ZoneID) || request.Latitude < -90 || request.Latitude > 90 || request.Longitude < -180 || request.Longitude > 180 {
		writeError(w, http.StatusBadRequest, "invalid_spatial_candidate_query")
		return
	}
	candidates, err := s.querySpatialCandidates(r.Context(), request)
	if err != nil {
		log.Printf("spatial candidate query zone=%s: %v", request.ZoneID, err)
		writeError(w, http.StatusServiceUnavailable, "spatial_candidate_query_failed")
		return
	}
	ids := make([]int64, 0, len(candidates))
	for _, item := range candidates {
		ids = append(ids, item.DriverUserID)
	}
	writeJSON(w, http.StatusOK, spatialCandidateQueryResponse{ZoneID: request.ZoneID, H3Cell: h3CellFor(request.Latitude, request.Longitude, s.cfg.H3Resolution), CandidateCount: len(candidates), NearestDriverID: ids})
}

func (s *service) cacheReconcileHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeError(w, http.StatusMethodNotAllowed, "method_not_allowed")
		return
	}
	if !s.requireInternalAccess(w, r) {
		return
	}
	count, err := s.reconcileAvailableDrivers(r.Context())
	if err != nil {
		log.Printf("reconcile cache: %v", err)
		writeError(w, http.StatusServiceUnavailable, "cache_reconciliation_failed")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"projected_drivers": count})
}

func (s *service) requireInternalAccess(w http.ResponseWriter, r *http.Request) bool {
	provided := strings.TrimSpace(r.Header.Get("X-Internal-Service-Token"))
	if provided == "" || subtle.ConstantTimeCompare([]byte(provided), []byte(s.cfg.InternalServiceToken)) != 1 {
		writeError(w, http.StatusUnauthorized, "invalid_internal_service_token")
		return false
	}
	return true
}

func (s *service) matchTrip(ctx context.Context, request matchRequest) (matchResponse, error) {
	var lastErr error
	for attempt := 0; attempt < 3; attempt++ {
		response, err := s.matchTripOnce(ctx, request)
		if err == nil || !isSerializationFailure(err) {
			return response, err
		}
		lastErr = err
		select {
		case <-ctx.Done():
			return matchResponse{}, ctx.Err()
		case <-time.After(time.Duration(attempt+1) * 20 * time.Millisecond):
		}
	}
	return matchResponse{}, fmt.Errorf("matching transaction exhausted serialization retries: %w", lastErr)
}

func (s *service) matchTripOnce(ctx context.Context, request matchRequest) (matchResponse, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return matchResponse{}, fmt.Errorf("begin matching transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	if response, found, err := loadIdempotentMatch(ctx, tx, request); err != nil {
		return matchResponse{}, err
	} else if found {
		if err := tx.Commit(); err != nil {
			return matchResponse{}, fmt.Errorf("commit idempotent match response: %w", err)
		}
		return response, nil
	}

	trip, err := lockTripForMatching(ctx, tx, request.TripID)
	if err != nil {
		return matchResponse{}, err
	}
	if trip.State != "requested" && trip.State != "matching" {
		return matchResponse{}, fmt.Errorf("%w: trip state %s cannot start matching", errConflict, trip.State)
	}

	if _, err := tx.ExecContext(ctx, `
		UPDATE mobility.ride_trip
		SET state = 'matching', state_version = state_version + 1, updated_at = NOW()
		WHERE id = $1 AND state IN ('requested', 'matching')`, trip.ID); err != nil {
		return matchResponse{}, fmt.Errorf("move trip to matching: %w", err)
	}

	candidates, err := s.findCandidates(ctx, tx, trip)
	if err != nil {
		return matchResponse{}, err
	}
	waveNo, err := nextWave(ctx, tx, trip.ID)
	if err != nil {
		return matchResponse{}, err
	}
	attemptID, err := newUUID()
	if err != nil {
		return matchResponse{}, err
	}
	attemptState := "offering"
	if len(candidates) == 0 {
		attemptState = "exhausted"
	}
	snapshot, err := json.Marshal(map[string]any{
		"radius_m": s.cfg.MatchRadiusM, "candidate_limit": s.cfg.CandidateLimit,
		"offer_wave_size": s.cfg.OfferWaveSize, "scoring": "geodesic_eta_fairness_v1",
	})
	if err != nil {
		return matchResponse{}, fmt.Errorf("marshal candidate snapshot: %w", err)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO mobility.match_attempt (id, trip_id, wave_no, algorithm_version, candidate_query_snapshot, candidate_count, state)
		VALUES ($1,$2,$3,$4,$5::jsonb,$6,$7)`, attemptID, trip.ID, waveNo, "geodesic_eta_fairness_v1", string(snapshot), len(candidates), attemptState); err != nil {
		return matchResponse{}, fmt.Errorf("insert match attempt: %w", err)
	}

	response := matchResponse{TripID: trip.ID, MatchAttemptID: attemptID, CandidateCount: len(candidates), AlgorithmVersion: "geodesic_eta_fairness_v1"}
	if len(candidates) == 0 {
		if _, err := tx.ExecContext(ctx, `
			UPDATE mobility.ride_trip SET state = 'unfulfilled', state_version = state_version + 1, updated_at = NOW() WHERE id = $1`, trip.ID); err != nil {
			return matchResponse{}, fmt.Errorf("mark trip unfulfilled: %w", err)
		}
		if err := appendTripEvent(ctx, tx, trip.ID, "match_exhausted", "system", nil, request.IdempotencyKey, "matching", "unfulfilled", map[string]any{"match_attempt_id": attemptID}); err != nil {
			return matchResponse{}, err
		}
		if err := insertOutbox(ctx, tx, "ride_trip", trip.ID, "ride.match_exhausted", map[string]any{"trip_id": trip.ID, "match_attempt_id": attemptID}); err != nil {
			return matchResponse{}, err
		}
		response.State = "unfulfilled"
		if err := tx.Commit(); err != nil {
			return matchResponse{}, fmt.Errorf("commit unfulfilled match: %w", err)
		}
		return response, nil
	}

	offers := make([]offerProjection, 0, s.cfg.OfferWaveSize)
	expiresAt := time.Now().UTC().Add(s.cfg.OfferTTL)
	for index, item := range candidates {
		if len(offers) >= s.cfg.OfferWaveSize {
			break
		}
		offerID, err := newUUID()
		if err != nil {
			return matchResponse{}, err
		}
		explanation, err := json.Marshal(map[string]any{
			"distance_m": item.DistanceM, "eta_seconds": item.ETASeconds,
			"integrity_score": item.IntegrityScore, "score": item.Score,
		})
		if err != nil {
			return matchResponse{}, fmt.Errorf("marshal offer explanation: %w", err)
		}
		reservationResult, err := tx.ExecContext(ctx, `
			WITH reservable AS (
				SELECT p.driver_user_id
				FROM mobility.driver_presence p
				JOIN mobility.driver_eligibility e ON e.driver_user_id = p.driver_user_id
				JOIN mobility.driver_profile d ON d.user_id = p.driver_user_id
				WHERE p.driver_user_id = $1 AND p.state = 'available' AND p.location_valid_until > NOW()
				  AND p.integrity_score >= $9 AND e.eligible = true AND e.eligible_until > NOW()
				  AND d.account_state = 'active' AND d.safety_state = 'clear'
				FOR UPDATE OF p SKIP LOCKED
			), offer AS (
				INSERT INTO mobility.driver_offer (id, match_attempt_id, trip_id, driver_user_id, rank, score, score_explanation, expires_at)
				SELECT $2, $3, $4, reservable.driver_user_id, $5, $6, $7::jsonb, $8
				FROM reservable
				ON CONFLICT DO NOTHING
				RETURNING driver_user_id
			)
			UPDATE mobility.driver_presence p
			SET state = 'offer_pending', active_offer_id = $2, offer_expires_at = $8, version = version + 1, updated_at = NOW()
			FROM offer
			WHERE p.driver_user_id = offer.driver_user_id`,
			item.DriverUserID, offerID, attemptID, trip.ID, index+1, item.Score, string(explanation), expiresAt, s.cfg.LocationMinIntegrity)
		if err != nil {
			return matchResponse{}, fmt.Errorf("conditionally reserve and insert driver offer: %w", err)
		}
		rowsAffected, err := reservationResult.RowsAffected()
		if err != nil {
			return matchResponse{}, fmt.Errorf("verify driver offer reservation: %w", err)
		}
		if rowsAffected != 1 {
			continue
		}
		offers = append(offers, offerProjection{OfferID: offerID, TripID: trip.ID, ZoneID: trip.ZoneID, DriverID: item.DriverUserID, ExpiresAt: expiresAt})
		response.OfferIDs = append(response.OfferIDs, offerID)
	}

	if len(offers) == 0 {
		if _, err := tx.ExecContext(ctx, `UPDATE mobility.match_attempt SET state = 'exhausted', closed_at = NOW() WHERE id = $1`, attemptID); err != nil {
			return matchResponse{}, fmt.Errorf("close empty match attempt: %w", err)
		}
		if _, err := tx.ExecContext(ctx, `UPDATE mobility.ride_trip SET state = 'unfulfilled', state_version = state_version + 1, updated_at = NOW() WHERE id = $1`, trip.ID); err != nil {
			return matchResponse{}, fmt.Errorf("mark unique-conflict trip unfulfilled: %w", err)
		}
		if err := appendTripEvent(ctx, tx, trip.ID, "match_exhausted", "system", nil, request.IdempotencyKey, "matching", "unfulfilled", map[string]any{"match_attempt_id": attemptID, "reason": "candidate_offer_conflict"}); err != nil {
			return matchResponse{}, err
		}
		response.State = "unfulfilled"
	} else {
		if _, err := tx.ExecContext(ctx, `UPDATE mobility.ride_trip SET state = 'driver_offered', state_version = state_version + 1, updated_at = NOW() WHERE id = $1`, trip.ID); err != nil {
			return matchResponse{}, fmt.Errorf("mark trip driver offered: %w", err)
		}
		if err := appendTripEvent(ctx, tx, trip.ID, "driver_offers_created", "system", nil, request.IdempotencyKey, "matching", "driver_offered", map[string]any{"match_attempt_id": attemptID, "offer_ids": response.OfferIDs}); err != nil {
			return matchResponse{}, err
		}
		if err := insertOutbox(ctx, tx, "ride_trip", trip.ID, "ride.driver_offered", map[string]any{"trip_id": trip.ID, "match_attempt_id": attemptID, "offer_ids": response.OfferIDs}); err != nil {
			return matchResponse{}, err
		}
		response.State = "driver_offered"
	}
	if err := tx.Commit(); err != nil {
		return matchResponse{}, fmt.Errorf("commit match attempt: %w", err)
	}
	for _, offer := range offers {
		if err := s.projectOffer(ctx, offer); err != nil {
			logCorrelationEvent(ctx, "matching.offer_projection_failed", "trip_id", trip.ID, "offer_id", offer.OfferID, "driver_user_id", offer.DriverID, "error_class", fmt.Sprintf("%T", err))
		}
	}
	return response, nil
}

func loadIdempotentMatch(ctx context.Context, tx *sql.Tx, request matchRequest) (matchResponse, bool, error) {
	var nextState sql.NullString
	err := tx.QueryRowContext(ctx, `SELECT next_state::text FROM mobility.trip_event WHERE trip_id = $1 AND idempotency_key = $2`, request.TripID, request.IdempotencyKey).Scan(&nextState)
	if errors.Is(err, sql.ErrNoRows) {
		return matchResponse{}, false, nil
	}
	if err != nil {
		return matchResponse{}, false, fmt.Errorf("load idempotent match: %w", err)
	}
	var attemptID string
	_ = tx.QueryRowContext(ctx, `SELECT id::text FROM mobility.match_attempt WHERE trip_id = $1 ORDER BY created_at DESC LIMIT 1`, request.TripID).Scan(&attemptID)
	return matchResponse{TripID: request.TripID, MatchAttemptID: attemptID, State: nextState.String, AlgorithmVersion: "geodesic_eta_fairness_v1"}, true, nil
}

func lockTripForMatching(ctx context.Context, tx *sql.Tx, tripID string) (tripForMatch, error) {
	var trip tripForMatch
	err := tx.QueryRowContext(ctx, `
		SELECT id::text, state::text, zone_id::text,
			ST_Y(pickup::geometry), ST_X(pickup::geometry)
		FROM mobility.ride_trip WHERE id = $1 FOR UPDATE`, tripID).Scan(&trip.ID, &trip.State, &trip.ZoneID, &trip.PickupLat, &trip.PickupLng)
	if errors.Is(err, sql.ErrNoRows) {
		return tripForMatch{}, fmt.Errorf("%w: trip %s", errNotFound, tripID)
	}
	if err != nil {
		return tripForMatch{}, fmt.Errorf("lock trip: %w", err)
	}
	return trip, nil
}

func nextWave(ctx context.Context, tx *sql.Tx, tripID string) (int, error) {
	var wave int
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(wave_no), 0) + 1 FROM mobility.match_attempt WHERE trip_id = $1`, tripID).Scan(&wave); err != nil {
		return 0, fmt.Errorf("next match wave: %w", err)
	}
	return wave, nil
}

func (s *service) querySpatialCandidates(ctx context.Context, request spatialCandidateQueryRequest) ([]candidate, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true, Isolation: sql.LevelReadCommitted})
	if err != nil {
		return nil, fmt.Errorf("begin spatial candidate query: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	trip := tripForMatch{ZoneID: request.ZoneID, PickupLat: request.Latitude, PickupLng: request.Longitude}
	trip.H3Cell = h3CellFor(trip.PickupLat, trip.PickupLng, s.cfg.H3Resolution)
	if redisIDs, err := s.redisCandidateIDs(ctx, trip); err != nil {
		logCorrelationEvent(ctx, "matching.redis_geo_lookup_failed", "trip_id", trip.ID, "zone_id", trip.ZoneID, "fallback", "postgis", "error_class", fmt.Sprintf("%T", err))
	} else if len(redisIDs) > 0 {
		candidates, queryErr := s.queryRedisCandidates(ctx, tx, trip, redisIDs)
		if queryErr != nil {
			return nil, queryErr
		}
		if len(candidates) > 0 {
			if commitErr := tx.Commit(); commitErr != nil {
				return nil, fmt.Errorf("commit Redis GEO candidate query: %w", commitErr)
			}
			return candidates, nil
		}
	}
	candidates, err := s.queryPostGISCandidates(ctx, tx, trip)
	if err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, fmt.Errorf("commit PostGIS candidate query: %w", err)
	}
	return candidates, nil
}

func (s *service) findCandidates(ctx context.Context, tx *sql.Tx, trip tripForMatch) ([]candidate, error) {
	trip.H3Cell = h3CellFor(trip.PickupLat, trip.PickupLng, s.cfg.H3Resolution)
	if trip.H3Cell != "" {
		if _, err := tx.ExecContext(ctx, `SELECT mobility.set_trip_pickup_h3_cell($1::uuid, $2)`, trip.ID, trip.H3Cell); err != nil {
			return nil, fmt.Errorf("persist trip H3 cell: %w", err)
		}
	}
	redisIDs, redisErr := s.redisCandidateIDs(ctx, trip)
	if redisErr != nil {
		logCorrelationEvent(ctx, "matching.redis_candidate_lookup_failed", "trip_id", trip.ID, "zone_id", trip.ZoneID, "fallback", "postgis", "error_class", fmt.Sprintf("%T", redisErr))
	} else if len(redisIDs) > 0 {
		candidates, err := s.queryRedisCandidates(ctx, tx, trip, redisIDs)
		if err != nil {
			return nil, err
		}
		if len(candidates) > 0 {
			return candidates, nil
		}
		logCorrelationEvent(ctx, "matching.redis_candidate_set_stale", "trip_id", trip.ID, "zone_id", trip.ZoneID, "fallback", "postgis")
	}
	return s.queryPostGISCandidates(ctx, tx, trip)
}

func (s *service) queryRedisCandidates(ctx context.Context, tx *sql.Tx, trip tripForMatch, redisIDs []int64) ([]candidate, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT p.driver_user_id, ST_Y(p.last_point::geometry), ST_X(p.last_point::geometry),
			ST_Distance(p.last_point, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography), p.integrity_score
		FROM mobility.driver_presence p
		JOIN mobility.driver_eligibility e ON e.driver_user_id = p.driver_user_id
		JOIN mobility.driver_profile d ON d.user_id = p.driver_user_id
		WHERE p.driver_user_id = ANY($3::bigint[])
		  AND p.state = 'available' AND p.zone_id = $4::uuid
		  AND p.location_valid_until > NOW() AND p.integrity_score >= $5
		  AND e.eligible = true AND e.eligible_until > NOW()
		  AND d.account_state = 'active' AND d.safety_state = 'clear'
		ORDER BY ST_Distance(p.last_point, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography) ASC
		LIMIT $6`, trip.PickupLat, trip.PickupLng, pq.Array(redisIDs), trip.ZoneID, s.cfg.LocationMinIntegrity, s.cfg.CandidateLimit)
	if err != nil {
		return nil, fmt.Errorf("query Redis candidates: %w", err)
	}
	return s.scanCandidates(rows)
}

func (s *service) queryPostGISCandidates(ctx context.Context, tx *sql.Tx, trip tripForMatch) ([]candidate, error) {
	rows, err := tx.QueryContext(ctx, `
		SELECT p.driver_user_id, ST_Y(p.last_point::geometry), ST_X(p.last_point::geometry),
			ST_Distance(p.last_point, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography), p.integrity_score
		FROM mobility.driver_presence p
		JOIN mobility.driver_eligibility e ON e.driver_user_id = p.driver_user_id
		JOIN mobility.driver_profile d ON d.user_id = p.driver_user_id
		WHERE p.state = 'available' AND p.zone_id = $3::uuid
		  AND p.location_valid_until > NOW() AND p.integrity_score >= $4
		  AND e.eligible = true AND e.eligible_until > NOW()
		  AND d.account_state = 'active' AND d.safety_state = 'clear'
		  AND ST_DWithin(p.last_point, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, $5)
		ORDER BY p.last_point <-> ST_SetSRID(ST_MakePoint($2,$1),4326)::geography
		LIMIT $6`, trip.PickupLat, trip.PickupLng, trip.ZoneID, s.cfg.LocationMinIntegrity, s.cfg.MatchRadiusM, s.cfg.CandidateLimit)
	if err != nil {
		return nil, fmt.Errorf("query PostGIS candidates: %w", err)
	}
	return s.scanCandidates(rows)
}

func (s *service) scanCandidates(rows *sql.Rows) ([]candidate, error) {
	defer rows.Close()
	candidates := make([]candidate, 0, s.cfg.CandidateLimit)
	for rows.Next() {
		var item candidate
		if err := rows.Scan(&item.DriverUserID, &item.Latitude, &item.Longitude, &item.DistanceM, &item.IntegrityScore); err != nil {
			return nil, fmt.Errorf("scan candidate: %w", err)
		}
		item.ETASeconds = int(math.Ceil(item.DistanceM/s.cfg.AverageSpeedMPS)) + 20
		item.Score = candidateScore(item.DistanceM, item.ETASeconds, item.IntegrityScore)
		candidates = append(candidates, item)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("iterate candidates: %w", err)
	}
	return candidates, nil
}

func candidateScore(distanceM float64, etaSeconds, integrity int) float64 {
	etaComponent := 1.0 / (1.0 + float64(etaSeconds)/120.0)
	distanceComponent := 1.0 / (1.0 + distanceM/1000.0)
	integrityComponent := float64(integrity) / 100.0
	return 0.55*etaComponent + 0.30*distanceComponent + 0.15*integrityComponent
}

func (s *service) redisCandidateIDs(ctx context.Context, trip tripForMatch) ([]int64, error) {
	key := fmt.Sprintf("rh:zone:{%s}:available", trip.ZoneID)
	members, err := s.rdb.GeoSearch(ctx, key, &redis.GeoSearchQuery{
		Longitude: trip.PickupLng, Latitude: trip.PickupLat, Radius: s.cfg.MatchRadiusM, RadiusUnit: "m", Sort: "ASC", Count: s.cfg.CandidateLimit,
	}).Result()
	if err != nil && !errors.Is(err, redis.Nil) {
		return nil, err
	}
	ids := make([]int64, 0, len(members))
	for _, member := range members {
		id, err := strconv.ParseInt(member, 10, 64)
		if err == nil && id > 0 {
			ids = append(ids, id)
		}
	}
	return ids, nil
}

func appendTripEvent(ctx context.Context, tx *sql.Tx, tripID, eventType, actorKind string, actorUserID *int64, idempotencyKey, previousState, nextState string, payload map[string]any) error {
	var nextSequence int
	if err := tx.QueryRowContext(ctx, `SELECT COALESCE(MAX(sequence_no), 0) + 1 FROM mobility.trip_event WHERE trip_id = $1`, tripID).Scan(&nextSequence); err != nil {
		return fmt.Errorf("next trip event sequence: %w", err)
	}
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal trip event payload: %w", err)
	}
	correlationID, err := newUUID()
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, `
		INSERT INTO mobility.trip_event (trip_id, sequence_no, event_type, actor_kind, actor_user_id, correlation_id, idempotency_key, previous_state, next_state, payload)
		VALUES ($1,$2,$3,$4,$5,$6,$7,$8::mobility.trip_state,$9::mobility.trip_state,$10::jsonb)`,
		tripID, nextSequence, eventType, actorKind, nullableInt64(actorUserID), correlationID, idempotencyKey, nullableState(previousState), nullableState(nextState), string(body))
	if err != nil {
		return fmt.Errorf("append trip event: %w", err)
	}
	return nil
}

func insertOutbox(ctx context.Context, tx *sql.Tx, aggregateType, aggregateID, eventType string, payload map[string]any) error {
	body, err := json.Marshal(payload)
	if err != nil {
		return fmt.Errorf("marshal outbox payload: %w", err)
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO mobility.outbox_event (aggregate_type, aggregate_id, event_type, payload) VALUES ($1,$2::uuid,$3,$4::jsonb)`, aggregateType, aggregateID, eventType, string(body))
	if err != nil {
		return fmt.Errorf("insert outbox event: %w", err)
	}
	return nil
}

func (s *service) projectOffer(ctx context.Context, offer offerProjection) error {
	ttl := time.Until(offer.ExpiresAt).Round(time.Second)
	if ttl <= 0 {
		return nil
	}
	driverKey := fmt.Sprintf("rh:driver:{%d}:offer", offer.DriverID)
	tripKey := fmt.Sprintf("rh:trip:{%s}:offer_ids", offer.TripID)
	presenceKey := fmt.Sprintf("rh:driver:{%d}:presence", offer.DriverID)
	h3Cell, _ := s.rdb.HGet(ctx, presenceKey, "h3_cell").Result()
	pipe := s.rdb.TxPipeline()
	pipe.ZRem(ctx, fmt.Sprintf("rh:zone:{%s}:available", offer.ZoneID), strconv.FormatInt(offer.DriverID, 10))
	if h3Cell != "" {
		pipe.SRem(ctx, fmt.Sprintf("rh:zone:{%s}:h3:{%s}:available", offer.ZoneID, h3Cell), strconv.FormatInt(offer.DriverID, 10))
	}
	pipe.HSet(ctx, driverKey, map[string]any{"offer_id": offer.OfferID, "trip_id": offer.TripID, "expires_at_ms": offer.ExpiresAt.UnixMilli(), "state": "pending"})
	pipe.Expire(ctx, driverKey, ttl+30*time.Second)
	pipe.SAdd(ctx, tripKey, offer.OfferID)
	pipe.Expire(ctx, tripKey, ttl+5*time.Minute)
	_, err := pipe.Exec(ctx)
	return err
}

func (s *service) assertDeviceIntegrity(ctx context.Context, request driverLocationEventRequest) error {
	if !s.cfg.RequireDeviceIntegrity {
		return nil
	}
	request.DevicePublicID = strings.TrimSpace(request.DevicePublicID)
	request.AttestationID = strings.TrimSpace(request.AttestationID)
	if !isCanonicalUUID(request.DevicePublicID) || len(request.AttestationID) < 16 || len(request.AttestationID) > 256 {
		return errDeviceIntegrity
	}
	var valid bool
	err := s.db.QueryRowContext(ctx, `
		SELECT EXISTS (
			SELECT 1 FROM telematics.driver_device d
			JOIN LATERAL (
				SELECT state FROM telematics.driver_location_consent c
				WHERE c.driver_user_id=d.driver_user_id AND (c.device_id=d.id OR c.device_id IS NULL)
				ORDER BY c.created_at DESC LIMIT 1
			) consent ON consent.state='granted'
			JOIN telematics.device_attestation_event a ON a.device_id=d.id
			WHERE d.driver_user_id=$1 AND d.device_public_id=$2::uuid AND d.state='active'
			  AND a.attestation_id=$3 AND a.attestation_state='verified' AND (a.expires_at IS NULL OR a.expires_at>NOW())
		)`, request.DriverUserID, request.DevicePublicID, request.AttestationID).Scan(&valid)
	if err != nil {
		return err
	}
	if !valid {
		return errDeviceIntegrity
	}
	return nil
}

func (s *service) ingestDriverLocation(ctx context.Context, request driverLocationEventRequest, occurredAt time.Time) (int64, bool, error) {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return 0, false, fmt.Errorf("begin driver location transaction: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var existingAccepted bool
	var existingVersion int64
	err = tx.QueryRowContext(ctx, `
		SELECT accepted, COALESCE((payload->>'presence_version')::bigint, 0)
		FROM mobility.driver_location_event
		WHERE driver_user_id = $1 AND device_session_id = $2::uuid AND source_sequence = $3`,
		request.DriverUserID, request.DeviceSessionID, request.SourceSequence,
	).Scan(&existingAccepted, &existingVersion)
	if err == nil {
		if err := tx.Commit(); err != nil {
			return 0, false, fmt.Errorf("commit idempotent location event: %w", err)
		}
		return existingVersion, existingAccepted, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return 0, false, fmt.Errorf("load idempotent location event: %w", err)
	}

	var currentVersion int64
	var lastSourceAt sql.NullTime
	err = tx.QueryRowContext(ctx, `
		SELECT version, last_location_source_at
		FROM mobility.driver_presence WHERE driver_user_id = $1 FOR UPDATE`, request.DriverUserID,
	).Scan(&currentVersion, &lastSourceAt)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, errNotFound
	}
	if err != nil {
		return 0, false, fmt.Errorf("lock driver presence for location event: %w", err)
	}

	accepted := !lastSourceAt.Valid || !occurredAt.Before(lastSourceAt.Time)
	rejectionReason := ""
	if !accepted {
		rejectionReason = "stale_source_timestamp"
	}
	if accepted {
		result, updateErr := tx.ExecContext(ctx, `
			UPDATE mobility.driver_presence
			SET last_point = ST_SetSRID(ST_MakePoint($2,$3),4326)::geography,
				last_location_at = $4, last_location_source_at = $4,
				location_valid_until = NOW() + INTERVAL '2 minutes', accuracy_m = $5,
				integrity_score = $6, version = version + 1, updated_at = NOW()
			WHERE driver_user_id = $1 AND version = $7`,
			request.DriverUserID, request.Longitude, request.Latitude, occurredAt, request.AccuracyM, request.IntegrityScore, currentVersion,
		)
		if updateErr != nil {
			return 0, false, fmt.Errorf("update durable driver presence: %w", updateErr)
		}
		changed, rowsErr := result.RowsAffected()
		if rowsErr != nil {
			return 0, false, fmt.Errorf("verify durable driver presence update: %w", rowsErr)
		}
		if changed != 1 {
			return 0, false, fmt.Errorf("%w: presence version changed during update", errConflict)
		}
		currentVersion++
	}
	payload, marshalErr := json.Marshal(map[string]any{"presence_version": currentVersion})
	if marshalErr != nil {
		return 0, false, fmt.Errorf("marshal driver location event payload: %w", marshalErr)
	}
	if _, err := tx.ExecContext(ctx, `
		INSERT INTO mobility.driver_location_event (driver_user_id, device_session_id, source_sequence, occurred_at, point, accuracy_m, integrity_score, accepted, rejection_reason, payload)
		VALUES ($1,$2::uuid,$3,$4,ST_SetSRID(ST_MakePoint($5,$6),4326)::geography,$7,$8,$9,NULLIF($10,''),$11::jsonb)`,
		request.DriverUserID, request.DeviceSessionID, request.SourceSequence, occurredAt, request.Longitude, request.Latitude,
		request.AccuracyM, request.IntegrityScore, accepted, rejectionReason, string(payload),
	); err != nil {
		return 0, false, fmt.Errorf("persist driver location event: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return 0, false, fmt.Errorf("commit driver location event: %w", err)
	}
	return currentVersion, accepted, nil
}

func (s *service) currentPresenceVersion(ctx context.Context, driverID int64) (int64, error) {
	var version int64
	err := s.db.QueryRowContext(ctx, `SELECT version FROM mobility.driver_presence WHERE driver_user_id = $1`, driverID).Scan(&version)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, errNotFound
	}
	if err != nil {
		return 0, fmt.Errorf("load current driver presence version: %w", err)
	}
	return version, nil
}

func (s *service) projectDriverPresence(ctx context.Context, driverID, expectedVersion int64) error {
	var state, zoneID, priorH3Cell string
	var lat, lng sql.NullFloat64
	var validUntil sql.NullTime
	var integrity int
	var version int64
	err := s.db.QueryRowContext(ctx, `
		SELECT state::text, COALESCE(zone_id::text,''),
			CASE WHEN last_point IS NULL THEN NULL ELSE ST_Y(last_point::geometry) END,
			CASE WHEN last_point IS NULL THEN NULL ELSE ST_X(last_point::geometry) END,
		location_valid_until, integrity_score, version, COALESCE(h3_cell_r9, '')
			FROM mobility.driver_presence WHERE driver_user_id = $1`, driverID).Scan(&state, &zoneID, &lat, &lng, &validUntil, &integrity, &version, &priorH3Cell)
	if errors.Is(err, sql.ErrNoRows) {
		return errNotFound
	}
	if err != nil {
		return err
	}
	if version != expectedVersion {
		return fmt.Errorf("%w: durable presence version %d does not match event %d", errConflict, version, expectedVersion)
	}
	if zoneID == "" {
		return errors.New("durable presence has no service zone")
	}
	presenceKey := fmt.Sprintf("rh:driver:{%d}:presence", driverID)
	zoneKey := fmt.Sprintf("rh:zone:{%s}:available", zoneID)
	if state == "available" && lat.Valid && lng.Valid && validUntil.Valid && validUntil.Time.After(time.Now()) {
		h3Cell := h3CellFor(lat.Float64, lng.Float64, s.cfg.H3Resolution)
		if h3Cell == "" {
			return errors.New("unable to derive H3 driver cell")
		}
		result, err := s.db.ExecContext(ctx, `
			UPDATE mobility.driver_presence SET h3_cell_r9 = $2, updated_at = NOW()
			WHERE driver_user_id = $1 AND version = $3`, driverID, h3Cell, version)
		if err != nil {
			return fmt.Errorf("persist driver H3 cell: %w", err)
		}
		rowsAffected, err := result.RowsAffected()
		if err != nil {
			return fmt.Errorf("verify driver H3 cell persistence: %w", err)
		}
		if rowsAffected != 1 {
			return fmt.Errorf("%w: presence changed before H3 projection", errConflict)
		}
		if _, err := s.db.ExecContext(ctx, `
			INSERT INTO mobility.h3_cell_projection (driver_user_id, zone_id, h3_cell_r9, presence_version, expires_at)
			VALUES ($1,$2::uuid,$3,$4,$5)
			ON CONFLICT (driver_user_id) DO UPDATE SET zone_id = EXCLUDED.zone_id, h3_cell_r9 = EXCLUDED.h3_cell_r9,
			  presence_version = EXCLUDED.presence_version, projected_at = NOW(), expires_at = EXCLUDED.expires_at
			WHERE mobility.h3_cell_projection.presence_version <= EXCLUDED.presence_version`,
			driverID, zoneID, h3Cell, version, validUntil.Time); err != nil {
			return fmt.Errorf("upsert H3 projection: %w", err)
		}
		ttl := time.Until(validUntil.Time) + 30*time.Second
		if ttl < time.Second {
			ttl = time.Second
		}
		pipe := s.rdb.TxPipeline()
		pipe.HSet(ctx, presenceKey, map[string]any{"pg_version": version, "state": state, "zone_id": zoneID, "lat": lat.Float64, "lng": lng.Float64, "location_valid_until_ms": validUntil.Time.UnixMilli(), "integrity_score": integrity, "h3_cell": h3Cell})
		pipe.Expire(ctx, presenceKey, ttl)
		if priorH3Cell != "" && priorH3Cell != h3Cell {
			pipe.SRem(ctx, fmt.Sprintf("rh:zone:{%s}:h3:{%s}:available", zoneID, priorH3Cell), strconv.FormatInt(driverID, 10))
		}
		h3Key := fmt.Sprintf("rh:zone:{%s}:h3:{%s}:available", zoneID, h3Cell)
		pipe.SAdd(ctx, h3Key, strconv.FormatInt(driverID, 10))
		pipe.Expire(ctx, h3Key, ttl)
		pipe.GeoAdd(ctx, zoneKey, &redis.GeoLocation{Name: strconv.FormatInt(driverID, 10), Longitude: lng.Float64, Latitude: lat.Float64})
		_, err = pipe.Exec(ctx)
		return err
	}
	if _, err := s.db.ExecContext(ctx, `DELETE FROM mobility.h3_cell_projection WHERE driver_user_id = $1 AND presence_version <= $2`, driverID, version); err != nil {
		return fmt.Errorf("remove H3 projection: %w", err)
	}
	pipe := s.rdb.TxPipeline()
	pipe.ZRem(ctx, zoneKey, strconv.FormatInt(driverID, 10))
	if priorH3Cell != "" {
		pipe.SRem(ctx, fmt.Sprintf("rh:zone:{%s}:h3:{%s}:available", zoneID, priorH3Cell), strconv.FormatInt(driverID, 10))
	}
	pipe.HSet(ctx, presenceKey, map[string]any{"pg_version": version, "state": state, "zone_id": zoneID, "integrity_score": integrity, "h3_cell": priorH3Cell})
	pipe.Expire(ctx, presenceKey, 2*time.Minute)
	_, err = pipe.Exec(ctx)
	return err
}

func (s *service) reconcileAvailableDrivers(ctx context.Context) (int, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT driver_user_id, version FROM mobility.driver_presence WHERE state = 'available' AND location_valid_until > NOW()`)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var driverID, version int64
		if err := rows.Scan(&driverID, &version); err != nil {
			return count, err
		}
		if err := s.projectDriverPresence(ctx, driverID, version); err != nil {
			return count, err
		}
		count++
	}
	return count, rows.Err()
}

func (s *service) reapExpiredOffers(ctx context.Context) {
	ticker := time.NewTicker(s.cfg.ReaperInterval)
	defer ticker.Stop()
	for range ticker.C {
		if err := s.expireOffers(ctx); err != nil {
			log.Printf("expire offers: %v", err)
		}
	}
}

func (s *service) expireOffers(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{Isolation: sql.LevelReadCommitted})
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	rows, err := tx.QueryContext(ctx, `
		UPDATE mobility.driver_offer
		SET state = 'expired', responded_at = NOW()
		WHERE id IN (
			SELECT id FROM mobility.driver_offer
			WHERE state = 'pending' AND expires_at <= NOW()
			ORDER BY expires_at ASC FOR UPDATE SKIP LOCKED LIMIT 50
		)
		RETURNING id::text, trip_id::text, driver_user_id`)
	if err != nil {
		return err
	}
	defer rows.Close()
	type expiredOffer struct {
		id, tripID string
		driverID   int64
	}
	expired := make([]expiredOffer, 0)
	for rows.Next() {
		var item expiredOffer
		if err := rows.Scan(&item.id, &item.tripID, &item.driverID); err != nil {
			return err
		}
		expired = append(expired, item)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	for _, item := range expired {
		if _, err := tx.ExecContext(ctx, `
			UPDATE mobility.driver_presence
			SET state = 'available', active_offer_id = NULL, offer_expires_at = NULL, version = version + 1, updated_at = NOW()
			WHERE driver_user_id = $1 AND active_offer_id = $2::uuid AND state = 'offer_pending' AND location_valid_until > NOW()`, item.driverID, item.id); err != nil {
			return err
		}
		if err := insertOutbox(ctx, tx, "ride_trip", item.tripID, "ride.driver_offer_expired", map[string]any{"trip_id": item.tripID, "offer_id": item.id, "driver_user_id": item.driverID}); err != nil {
			return err
		}
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	for _, item := range expired {
		_ = s.rdb.Del(ctx, fmt.Sprintf("rh:driver:{%d}:offer", item.driverID)).Err()
	}
	return nil
}

func (s *service) writeMatchError(ctx context.Context, w http.ResponseWriter, tripID string, err error) {
	if errors.Is(err, errNotFound) {
		writeError(w, http.StatusNotFound, "trip_not_found")
		return
	}
	if errors.Is(err, errConflict) {
		writeError(w, http.StatusConflict, "trip_not_matchable")
		return
	}
	logCorrelationEvent(ctx, "matching.trip.failed", "trip_id", tripID, "error_class", fmt.Sprintf("%T", err))
	writeError(w, http.StatusServiceUnavailable, "matching_unavailable")
}

func correlationFromContext(ctx context.Context) requestCorrelation {
	value, ok := ctx.Value(correlationContextKey{}).(requestCorrelation)
	if !ok {
		return requestCorrelation{}
	}
	return value
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

func logCorrelationEvent(ctx context.Context, event string, fields ...any) {
	correlation := correlationFromContext(ctx)
	if correlation.ResilienceRunID == "" {
		return
	}
	entry := map[string]any{
		"service":           serviceName,
		"event":             event,
		"request_id":        correlation.RequestID,
		"resilience_run_id": correlation.ResilienceRunID,
	}
	for index := 0; index+1 < len(fields); index += 2 {
		key, ok := fields[index].(string)
		if !ok || normalizeCorrelationID(key) == "" {
			continue
		}
		switch value := fields[index+1].(type) {
		case string, int, int64, bool:
			entry[key] = value
		}
	}
	encoded, err := json.Marshal(entry)
	if err != nil {
		return
	}
	log.Print(string(encoded))
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

func getenv(key, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(key)); value != "" {
		return value
	}
	return fallback
}

func getenvBool(key string, fallback bool) bool {
	value := strings.TrimSpace(strings.ToLower(os.Getenv(key)))
	if value == "" {
		return fallback
	}
	if value == "true" || value == "1" || value == "yes" {
		return true
	}
	if value == "false" || value == "0" || value == "no" {
		return false
	}
	return fallback
}

func getenvInt(key string, fallback int) int {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.Atoi(value)
	if err != nil {
		return fallback
	}
	return parsed
}

func getenvFloat(key string, fallback float64) float64 {
	value := strings.TrimSpace(os.Getenv(key))
	if value == "" {
		return fallback
	}
	parsed, err := strconv.ParseFloat(value, 64)
	if err != nil {
		return fallback
	}
	return parsed
}

func isCanonicalUUID(value string) bool {
	if len(value) != 36 {
		return false
	}
	for index, character := range value {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if character != '-' {
				return false
			}
			continue
		}
		if !((character >= '0' && character <= '9') || (character >= 'a' && character <= 'f') || (character >= 'A' && character <= 'F')) {
			return false
		}
	}
	return true
}

func h3CellFor(latitude, longitude float64, resolution int) string {
	if latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 || resolution < 0 || resolution > 15 {
		return ""
	}
	cell := h3.LatLngToCell(h3.NewLatLng(latitude, longitude), resolution)
	if cell == 0 {
		return ""
	}
	return h3.IndexToString(uint64(cell))
}

func newUUID() (string, error) {
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("generate uuid: %w", err)
	}
	bytes[6] = (bytes[6] & 0x0f) | 0x40
	bytes[8] = (bytes[8] & 0x3f) | 0x80
	return fmt.Sprintf("%s-%s-%s-%s-%s", hex.EncodeToString(bytes[0:4]), hex.EncodeToString(bytes[4:6]), hex.EncodeToString(bytes[6:8]), hex.EncodeToString(bytes[8:10]), hex.EncodeToString(bytes[10:16])), nil
}

func isUniqueViolation(err error) bool {
	var pqErr *pq.Error
	return errors.As(err, &pqErr) && string(pqErr.Code) == "23505"
}

func isSerializationFailure(err error) bool {
	var pqErr *pq.Error
	return errors.As(err, &pqErr) && string(pqErr.Code) == "40001"
}

func nullableInt64(value *int64) any {
	if value == nil {
		return nil
	}
	return *value
}

func nullableState(value string) any {
	if value == "" {
		return nil
	}
	return value
}

var (
	errNotFound        = errors.New("not found")
	errConflict        = errors.New("conflict")
	errDeviceIntegrity = errors.New("device integrity rejected")
)
