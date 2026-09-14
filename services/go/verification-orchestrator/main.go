package main

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	_ "github.com/lib/pq"

	sharedmetrics "switchos-metrics"
	"switchos-resilience"
)

type config struct {
	databaseURL      string
	internalToken    string
	intelligenceURL  string
	policyURL        string
	syntheticObjects map[string]string
	allowSynthetic   bool
	providerSecrets  map[string]string
	providerActorID  int
	s3Endpoint       string
	s3Bucket         string
	s3Region         string
	s3AccessKey      string
	s3SecretKey      string
	s3SessionToken   string
	maxObjectBytes   int64
	// retrievalAllowedHosts lists hostnames (lowercase, no port) that may be
	// fetched even when they resolve to non-public addresses. Operator-set via
	// RETRIEVAL_ALLOWED_HOSTS; empty by default (fail closed).
	retrievalAllowedHosts map[string]bool
}

type claimedJob struct {
	JobID           string          `json:"job_id"`
	CaseID          string          `json:"case_id"`
	EvidenceID      string          `json:"evidence_id"`
	Processor       string          `json:"processor"`
	EvidenceKind    string          `json:"evidence_kind"`
	ObjectKey       string          `json:"object_key"`
	ContentType     string          `json:"content_type"`
	SHA256Hex       string          `json:"sha256_hex"`
	CaptureMetadata json.RawMessage `json:"capture_metadata"`
	AttemptCount    int             `json:"attempt_count"`
	ClaimToken      string          `json:"claim_token"`
}

type processorResponse struct {
	State           string  `json:"state"`
	OutcomeCode     string  `json:"outcome_code"`
	OutputDigestHex *string `json:"output_digest_hex"`
}

type policyResponse struct {
	OutcomeCode          string `json:"outcome_code"`
	ManualReviewRequired bool   `json:"manual_review_required"`
}

func required(name string) string {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		log.Fatalf("%s is required", name)
	}
	return value
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if trimmed := strings.TrimSpace(value); trimmed != "" {
			return trimmed
		}
	}
	return ""
}

// validateS3Endpoint enforces TLS for object-store endpoints: http:// is only
// permitted for explicitly local endpoints (localhost / 127.0.0.1 / ::1) used
// with a development MinIO.
func validateS3Endpoint(raw string) string {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return ""
	}
	endpoint, err := url.Parse(raw)
	if err != nil || endpoint.Scheme == "" || endpoint.Host == "" {
		log.Fatalf("S3_ENDPOINT must be a valid URL, got %q", raw)
	}
	switch endpoint.Scheme {
	case "https":
	case "http":
		if host := endpoint.Hostname(); host != "localhost" && host != "127.0.0.1" && host != "::1" {
			log.Fatalf("S3_ENDPOINT must use https unless it targets localhost/127.0.0.1, got %q", raw)
		}
	default:
		log.Fatalf("S3_ENDPOINT must use http or https scheme, got %q", raw)
	}
	return raw
}

func loadMaxObjectBytes() int64 {
	raw := strings.TrimSpace(os.Getenv("VERIFICATION_MAX_OBJECT_BYTES"))
	if raw == "" {
		return 64 << 20
	}
	parsed, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || parsed <= 0 {
		log.Fatal("VERIFICATION_MAX_OBJECT_BYTES must be a positive integer")
	}
	return parsed
}

func loadConfig() config {
	raw := os.Getenv("VERIFICATION_SYNTHETIC_OBJECTS_JSON")
	objects := map[string]string{}
	if raw != "" && json.Unmarshal([]byte(raw), &objects) != nil {
		log.Fatal("VERIFICATION_SYNTHETIC_OBJECTS_JSON must be an object map")
	}
	providerSecrets := map[string]string{}
	if raw := os.Getenv("VERIFICATION_PROVIDER_WEBHOOK_SECRETS_JSON"); raw != "" && json.Unmarshal([]byte(raw), &providerSecrets) != nil {
		log.Fatal("VERIFICATION_PROVIDER_WEBHOOK_SECRETS_JSON must be an object map")
	}
	providerActorID, _ := strconv.Atoi(os.Getenv("VERIFICATION_PROVIDER_ACTOR_ID"))
	return config{
		databaseURL:      required("DATABASE_URL"),
		internalToken:    required("INTERNAL_SERVICE_TOKEN"),
		intelligenceURL:  required("VERIFICATION_INTELLIGENCE_URL"),
		policyURL:        required("VERIFICATION_POLICY_URL"),
		syntheticObjects: objects,
		allowSynthetic:   os.Getenv("VERIFICATION_ALLOW_SYNTHETIC_OBJECTS") == "true",
		providerSecrets:  providerSecrets,
		providerActorID:  providerActorID,
		s3Endpoint:       validateS3Endpoint(os.Getenv("S3_ENDPOINT")),
		s3Bucket:         strings.TrimSpace(os.Getenv("S3_BUCKET")),
		s3Region:         firstNonEmpty(os.Getenv("S3_REGION"), os.Getenv("AWS_REGION"), os.Getenv("AWS_DEFAULT_REGION"), "us-east-1"),
		s3AccessKey:      strings.TrimSpace(os.Getenv("AWS_ACCESS_KEY_ID")),
		s3SecretKey:      strings.TrimSpace(os.Getenv("AWS_SECRET_ACCESS_KEY")),
		s3SessionToken:   strings.TrimSpace(os.Getenv("AWS_SESSION_TOKEN")),
		maxObjectBytes:   loadMaxObjectBytes(),
		retrievalAllowedHosts: parseAllowedHosts(os.Getenv("RETRIEVAL_ALLOWED_HOSTS")),
	}
}

// parseAllowedHosts parses a comma-separated hostname allowlist. Entries are
// lowercased and stripped of any port so they match URL.Hostname().
func parseAllowedHosts(raw string) map[string]bool {
	hosts := map[string]bool{}
	for _, entry := range strings.Split(raw, ",") {
		entry = strings.ToLower(strings.TrimSpace(entry))
		if entry == "" {
			continue
		}
		if host, _, err := net.SplitHostPort(entry); err == nil {
			entry = host
		}
		entry = strings.Trim(entry, "[]")
		if entry != "" {
			hosts[entry] = true
		}
	}
	return hosts
}

func requireInternal(r *http.Request, token string) bool {
	provided := strings.TrimSpace(r.Header.Get("X-Internal-Service-Token"))
	return len(provided) == len(token) && subtle.ConstantTimeCompare([]byte(provided), []byte(token)) == 1
}

func postJSON(ctx context.Context, client *http.Client, url, token string, in any, out any) error {
	body, err := json.Marshal(in)
	if err != nil {
		return err
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("X-Internal-Service-Token", token)
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return fmt.Errorf("internal service returned %d", response.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(out)
}

func syntheticObject(cfg config, objectKey string) ([]byte, error) {
	if !cfg.allowSynthetic {
		return nil, errors.New("synthetic object retrieval disabled")
	}
	encoded, found := cfg.syntheticObjects[objectKey]
	if !found {
		return nil, fmt.Errorf("synthetic object not allowlisted: %s", objectKey)
	}
	return base64.StdEncoding.DecodeString(encoded)
}

// orchestratorMetrics exposes Prometheus-style counters on /metrics.
type orchestratorMetrics struct {
	mu                  sync.Mutex
	syntheticRetrievals uint64
}

func (m *orchestratorMetrics) incSynthetic() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.syntheticRetrievals++
}

func (m *orchestratorMetrics) serveHTTP(w http.ResponseWriter, _ *http.Request) {
	m.mu.Lock()
	defer m.mu.Unlock()
	w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
	_, _ = io.WriteString(w, "# HELP verification_synthetic_retrievals_total Evidence retrievals served from the explicitly opted-in synthetic object store (tests/dev only).\n")
	_, _ = io.WriteString(w, "# TYPE verification_synthetic_retrievals_total counter\n")
	_, _ = fmt.Fprintf(w, "verification_synthetic_retrievals_total %d\n", m.syntheticRetrievals)
}

// retrieveEvidence fetches the evidence bytes for a claimed job and enforces
// the SHA-256 digest recorded on the evidence row. Synthetic objects are used
// only when the mode is explicitly enabled and the key is allowlisted; every
// synthetic retrieval is logged with a distinct marker and counted.
func retrieveEvidence(ctx context.Context, cfg config, client *http.Client, metrics *orchestratorMetrics, job claimedJob) ([]byte, error) {
	var body []byte
	if _, synthetic := cfg.syntheticObjects[job.ObjectKey]; synthetic && cfg.allowSynthetic {
		metrics.incSynthetic()
		log.Printf(`{"service":"verification-orchestrator","event":"synthetic_retrieval","job_id":"%s","evidence_id":"%s","object_key":"%s"}`, job.JobID, job.EvidenceID, job.ObjectKey)
		syntheticBody, err := syntheticObject(cfg, job.ObjectKey)
		if err != nil {
			return nil, err
		}
		body = syntheticBody
	} else {
		fetched, err := fetchEvidenceObject(ctx, cfg, client, job.ObjectKey)
		if err != nil {
			return nil, err
		}
		body = fetched
	}
	if err := verifyDigest(body, job.SHA256Hex); err != nil {
		return nil, err
	}
	return body, nil
}

func runOnce(ctx context.Context, db *sql.DB, cfg config, client *http.Client, metrics *orchestratorMetrics) (int, error) {
	rows, err := db.QueryContext(ctx, `SELECT job_id,case_id,evidence_id,processor,evidence_kind,object_key,content_type,sha256_hex,capture_metadata,attempt_count,claim_token FROM verification.claim_processing_jobs($1)`, 20)
	if err != nil {
		return 0, err
	}
	defer rows.Close()
	jobs := []claimedJob{}
	for rows.Next() {
		var item claimedJob
		if err := rows.Scan(&item.JobID, &item.CaseID, &item.EvidenceID, &item.Processor, &item.EvidenceKind, &item.ObjectKey, &item.ContentType, &item.SHA256Hex, &item.CaptureMetadata, &item.AttemptCount, &item.ClaimToken); err != nil {
			return 0, err
		}
		jobs = append(jobs, item)
	}
	if err := rows.Err(); err != nil {
		return 0, err
	}
	for _, job := range jobs {
		body, retrievalErr := retrieveEvidence(ctx, cfg, client, metrics, job)
		state, outcome, outputDigest, detail := "failed", "object_retrieval_unavailable", (*string)(nil), ""
		if retrievalErr != nil {
			detail = retrievalErr.Error()
			if errors.Is(retrievalErr, errDigestMismatch) {
				outcome = "digest_mismatch"
			}
		} else {
			request := map[string]any{"processor": job.Processor, "evidence_kind": job.EvidenceKind, "content_type": job.ContentType, "sha256_hex": job.SHA256Hex, "object_body_base64": base64.StdEncoding.EncodeToString(body), "capture_metadata": job.CaptureMetadata}
			if job.Processor == "liveness" {
				request = map[string]any{"processor": "liveness", "challenge_id": "local-challenge-0001", "challenge_nonce": "synthetic-liveness-nonce-value", "expected_nonce_sha256": "", "capture_sha256": job.SHA256Hex, "frame_sha256": []string{job.SHA256Hex, job.SHA256Hex, job.SHA256Hex}, "captured_at_ms": 0, "expires_at_ms": 1, "device_attestation_ref": "synthetic-attestation-0001"}
			}
			var processed processorResponse
			endpoint := cfg.intelligenceURL + "/v1/documents/process"
			if job.Processor == "liveness" {
				endpoint = cfg.intelligenceURL + "/v1/liveness/process"
			}
			err := postJSON(ctx, client, endpoint, cfg.internalToken, request, &processed)
			if err == nil {
				state, outcome, outputDigest, detail = processed.State, processed.OutcomeCode, processed.OutputDigestHex, ""
			}
			if state != "failed" {
				var policy policyResponse
				policyErr := postJSON(ctx, client, cfg.policyURL+"/v1/evaluate", cfg.internalToken, map[string]any{"subject_type": "driver", "completed_processors": []string{job.Processor}, "provider_checks": []any{}}, &policy)
				if policyErr != nil {
					state, outcome, outputDigest, detail = "failed", "policy_unavailable", nil, policyErr.Error()
				} else if policy.ManualReviewRequired {
					state = "manual_review"
					outcome = policy.OutcomeCode
				}
			}
		}
		_, completeErr := db.ExecContext(ctx, `SELECT verification.complete_processing_job($1::uuid,$2::uuid,$3::verification.job_state,$4,$5,$6)`, job.JobID, job.ClaimToken, state, outputDigest, outcome, nullable(detail))
		if completeErr != nil {
			return len(jobs), fmt.Errorf("complete job %s: %w", job.JobID, completeErr)
		}
	}
	return len(jobs), nil
}

var errProviderCallbackAuth = errors.New("invalid provider callback authentication")

type providerCallback struct {
	CaseID            string  `json:"case_id"`
	CheckType         string  `json:"check_type"`
	State             string  `json:"state"`
	ProviderReference *string `json:"provider_reference"`
	ResponseDigestHex *string `json:"response_digest_hex"`
	ExpiresAt         *string `json:"expires_at"`
	DetailCode        *string `json:"detail_code"`
	IdempotencyKey    string  `json:"idempotency_key"`
}

func verifyProviderSignature(body []byte, signature, secret string) bool {
	if !strings.HasPrefix(signature, "sha256=") || len(secret) < 32 || len(secret) > 4096 {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	_, _ = mac.Write(body)
	expected := "sha256=" + fmt.Sprintf("%x", mac.Sum(nil))
	return hmac.Equal([]byte(signature), []byte(expected))
}

func recordProviderCallback(ctx context.Context, db *sql.DB, cfg config, provider string, body []byte, signature string) error {
	secret, found := cfg.providerSecrets[provider]
	if !found || cfg.providerActorID <= 0 || !verifyProviderSignature(body, signature, secret) {
		return errProviderCallbackAuth
	}
	var callback providerCallback
	if err := json.Unmarshal(body, &callback); err != nil {
		return errors.New("invalid provider callback payload")
	}
	_, err := db.ExecContext(ctx, `SELECT verification.record_provider_check($1,$2::uuid,$3::verification.check_type,$4,$5::verification.check_state,$6,$7,$8::timestamptz,$9,$10)`, cfg.providerActorID, callback.CaseID, callback.CheckType, provider, callback.State, callback.ProviderReference, callback.ResponseDigestHex, callback.ExpiresAt, callback.DetailCode, callback.IdempotencyKey)
	return err
}

func nullable(value string) any {
	if value == "" {
		return nil
	}
	return value
}

func main() {
	cfg := loadConfig()
	db, err := sql.Open("postgres", cfg.databaseURL)
	if err != nil {
		log.Fatal(err)
	}
	defer db.Close()
	client := resilience.NewClient(25*time.Second,
		resilience.RetryPolicy{MaxAttempts: 3, BackoffBase: 100 * time.Millisecond, BackoffMax: 2 * time.Second},
		resilience.BreakerConfig{FailureThreshold: 5, ResetTimeout: 30 * time.Second, HalfOpenMaxProbes: 1})
	metrics := &orchestratorMetrics{}
	httpMetrics := sharedmetrics.New("verification-orchestrator", os.Getenv("SERVICE_VERSION"))
	mux := http.NewServeMux()
	mux.Handle("/metrics", httpMetrics.Handler(http.HandlerFunc(metrics.serveHTTP)))
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"status":"ok","service":"verification-orchestrator"}`))
	})
	mux.HandleFunc("/v1/providers/callback", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 1<<20))
		if err != nil {
			http.Error(w, "invalid callback body", http.StatusBadRequest)
			return
		}
		if err := recordProviderCallback(r.Context(), db, cfg, r.Header.Get("X-Verification-Provider"), body, r.Header.Get("X-Verification-Signature-256")); err != nil {
			if errors.Is(err, errProviderCallbackAuth) {
				http.Error(w, "provider callback rejected", http.StatusUnauthorized)
			} else {
				log.Printf("provider callback persistence error: %v", err)
				http.Error(w, "provider callback unavailable", http.StatusServiceUnavailable)
			}
			return
		}
		w.WriteHeader(http.StatusNoContent)
	})
	mux.HandleFunc("/v1/jobs/run-once", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			http.NotFound(w, r)
			return
		}
		if !requireInternal(r, cfg.internalToken) {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		count, err := runOnce(r.Context(), db, cfg, client, metrics)
		if err != nil {
			log.Printf("verification run error: %v", err)
			http.Error(w, "verification processing unavailable", http.StatusServiceUnavailable)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"claimed": count})
	})
	address := os.Getenv("BIND_ADDR")
	if address == "" {
		address = "127.0.0.1:8121"
	}
	server := &http.Server{Addr: address, Handler: httpMetrics.Middleware(mux), ReadHeaderTimeout: 5 * time.Second}

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	serverErrors := make(chan error, 1)
	go func() {
		log.Printf("verification orchestrator listening on %s", address)
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
