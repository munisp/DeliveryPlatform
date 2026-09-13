package main

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestParseObjectLocation(t *testing.T) {
	tests := []struct {
		name       string
		reference  string
		bucket     string
		wantErr    bool
		wantScheme string
		wantBucket string
		wantKey    string
	}{
		{name: "plain key uses default bucket", reference: "verification/a.jpg", bucket: "evidence", wantScheme: "s3", wantBucket: "evidence", wantKey: "verification/a.jpg"},
		{name: "s3 uri carries its own bucket", reference: "s3://other/path/to/obj.pdf", bucket: "evidence", wantScheme: "s3", wantBucket: "other", wantKey: "path/to/obj.pdf"},
		{name: "https uri", reference: "https://objects.example.com/e/1.png", wantScheme: "https"},
		{name: "http uri allowed for explicit urls", reference: "http://127.0.0.1:9000/e/1.png", wantScheme: "http"},
		{name: "empty reference rejected", reference: "  ", bucket: "evidence", wantErr: true},
		{name: "plain key without bucket fails closed", reference: "verification/a.jpg", wantErr: true},
		{name: "unsupported scheme rejected", reference: "ftp://example.com/obj", bucket: "evidence", wantErr: true},
		{name: "s3 uri missing key rejected", reference: "s3://bucket-only", wantErr: true},
		{name: "s3 uri missing bucket rejected", reference: "s3:///key", wantErr: true},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			location, err := parseObjectLocation(tc.reference, tc.bucket)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("expected error for %q", tc.reference)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if location.scheme != tc.wantScheme {
				t.Fatalf("scheme=%q want %q", location.scheme, tc.wantScheme)
			}
			if tc.wantScheme == "s3" && (location.bucket != tc.wantBucket || location.key != tc.wantKey) {
				t.Fatalf("bucket/key=%q/%q want %q/%q", location.bucket, location.key, tc.wantBucket, tc.wantKey)
			}
		})
	}
}

func TestVerifyDigest(t *testing.T) {
	body := []byte("evidence-bytes")
	sum := sha256.Sum256(body)
	if err := verifyDigest(body, hex.EncodeToString(sum[:])); err != nil {
		t.Fatalf("expected digest match, got %v", err)
	}
	if err := verifyDigest(body, strings.ToUpper(hex.EncodeToString(sum[:]))); err != nil {
		t.Fatalf("expected case-insensitive digest match, got %v", err)
	}
	if err := verifyDigest(body, ""); err != nil {
		t.Fatalf("empty expected digest must be accepted, got %v", err)
	}
	other := sha256.Sum256([]byte("other"))
	if err := verifyDigest(body, hex.EncodeToString(other[:])); !errors.Is(err, errDigestMismatch) {
		t.Fatalf("expected errDigestMismatch, got %v", err)
	}
}

func TestReadBounded(t *testing.T) {
	body, err := readBounded(strings.NewReader("12345"), 5)
	if err != nil || string(body) != "12345" {
		t.Fatalf("unexpected bounded read body=%q err=%v", body, err)
	}
	if _, err := readBounded(strings.NewReader("123456"), 5); err == nil {
		t.Fatal("expected size bound violation")
	}
}

func TestFetchHTTPObject(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/missing" {
			http.NotFound(w, r)
			return
		}
		_, _ = w.Write([]byte("real-evidence"))
	}))
	defer server.Close()

	// The httptest server listens on loopback, so the SSRF guard only permits
	// the fetch when the host is explicitly allowlisted.
	allowed := map[string]bool{"127.0.0.1": true}
	cfg := config{maxObjectBytes: 64, retrievalAllowedHosts: allowed}
	body, err := fetchEvidenceObject(context.Background(), cfg, server.Client(), server.URL+"/obj")
	if err != nil || string(body) != "real-evidence" {
		t.Fatalf("unexpected fetch body=%q err=%v", body, err)
	}
	if _, err := fetchEvidenceObject(context.Background(), cfg, server.Client(), server.URL+"/missing"); err == nil {
		t.Fatal("expected non-200 status to fail")
	}
	if _, err := fetchEvidenceObject(context.Background(), config{maxObjectBytes: 4, retrievalAllowedHosts: allowed}, server.Client(), server.URL+"/obj"); err == nil {
		t.Fatal("expected size bound to be enforced")
	}
}

func TestFetchHTTPObjectRejectsPrivateIP(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("should-never-be-read"))
	}))
	defer server.Close()

	// Loopback (httptest) target must be rejected without the allowlist.
	if _, err := fetchEvidenceObject(context.Background(), config{maxObjectBytes: 64}, server.Client(), server.URL+"/obj"); err == nil {
		t.Fatal("expected loopback evidence URL to be rejected by the SSRF guard")
	} else if !errors.Is(err, errBlockedFetchTarget) {
		t.Fatalf("expected errBlockedFetchTarget, got %v", err)
	}
}

func TestValidateFetchTarget(t *testing.T) {
	blocked := []string{
		"http://127.0.0.1:9000/obj",
		"http://10.0.0.5/obj",
		"http://172.16.1.1/obj",
		"http://192.168.1.1/obj",
		"http://169.254.169.254/latest/meta-data",
		"http://100.64.0.1/obj",
		"http://0.0.0.0/obj",
		"http://[::1]/obj",
		"http://[fe80::1]/obj",
		"http://[::ffff:127.0.0.1]/obj",
		"file:///etc/passwd",
		"ftp://example.com/obj",
		"gopher://127.0.0.1:6379/_INFO",
	}
	for _, raw := range blocked {
		if err := validateFetchTarget(context.Background(), raw, nil); err == nil {
			t.Fatalf("expected %q to be rejected", raw)
		}
	}

	// Allowlisted hosts bypass the non-public-address rejection.
	if err := validateFetchTarget(context.Background(), "http://minio.internal:9000/obj", map[string]bool{"minio.internal": true}); err != nil {
		t.Fatalf("allowlisted host should pass, got %v", err)
	}
	// Scheme is enforced even for allowlisted hosts.
	if err := validateFetchTarget(context.Background(), "file:///etc/passwd", map[string]bool{"": true}); err == nil {
		t.Fatal("non-http scheme must be rejected even with an allowlist")
	}
}

func TestFetchHTTPObjectRechecksRedirects(t *testing.T) {
	// The redirector runs on (allowlisted) loopback but 302s to a link-local
	// metadata address. The redirect target must be re-validated and the
	// fetch rejected before any connection to it is attempted.
	redirector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://169.254.169.254/latest/meta-data", http.StatusFound)
	}))
	defer redirector.Close()

	cfg := config{maxObjectBytes: 64, retrievalAllowedHosts: map[string]bool{"127.0.0.1": true}}
	if _, err := fetchEvidenceObject(context.Background(), cfg, redirector.Client(), redirector.URL+"/go"); err == nil {
		t.Fatal("expected redirect to link-local target to be rejected")
	} else if !strings.Contains(err.Error(), errBlockedFetchTarget.Error()) {
		t.Fatalf("expected SSRF guard error, got %v", err)
	}
}

func TestFetchS3ObjectAgainstPathStyleEndpoint(t *testing.T) {
	var sawAuth, sawPath string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawAuth = r.Header.Get("Authorization")
		sawPath = r.URL.Path
		_, _ = w.Write([]byte("s3-evidence"))
	}))
	defer server.Close()

	cfg := config{
		s3Endpoint:     server.URL, // http://127.0.0.1 local endpoint
		s3Bucket:       "evidence",
		s3Region:       "us-east-1",
		s3AccessKey:    "AKIDEXAMPLE",
		s3SecretKey:    "secret",
		maxObjectBytes: 1024,
	}
	body, err := fetchEvidenceObject(context.Background(), cfg, server.Client(), "verification/doc.pdf")
	if err != nil || string(body) != "s3-evidence" {
		t.Fatalf("unexpected s3 fetch body=%q err=%v", body, err)
	}
	if sawPath != "/evidence/verification/doc.pdf" {
		t.Fatalf("unexpected path-style request path %q", sawPath)
	}
	if !strings.HasPrefix(sawAuth, "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/") || !strings.Contains(sawAuth, "/us-east-1/s3/aws4_request") || !strings.Contains(sawAuth, "SignedHeaders=host;x-amz-content-sha256;x-amz-date") {
		t.Fatalf("unexpected SigV4 authorization header %q", sawAuth)
	}
}

func TestFetchS3ObjectFailsClosedWithoutCredentials(t *testing.T) {
	cfg := config{s3Bucket: "evidence", s3Region: "us-east-1", maxObjectBytes: 1024}
	if _, err := fetchEvidenceObject(context.Background(), cfg, http.DefaultClient, "verification/doc.pdf"); err == nil {
		t.Fatal("expected missing S3 credentials to fail closed")
	}
	if _, err := fetchEvidenceObject(context.Background(), config{maxObjectBytes: 1024}, http.DefaultClient, "verification/doc.pdf"); err == nil {
		t.Fatal("expected missing S3_BUCKET to fail closed")
	}
}

func TestSignS3RequestIncludesSessionToken(t *testing.T) {
	cfg := config{s3Region: "eu-west-1", s3AccessKey: "AKID", s3SecretKey: "secret", s3SessionToken: "token-123"}
	request, err := http.NewRequest(http.MethodGet, "https://bucket.s3.eu-west-1.amazonaws.com/k", nil)
	if err != nil {
		t.Fatal(err)
	}
	signS3Request(request, cfg, time.Date(2024, 1, 2, 3, 4, 5, 0, time.UTC))
	if got := request.Header.Get("X-Amz-Security-Token"); got != "token-123" {
		t.Fatalf("session token header=%q", got)
	}
	if got := request.Header.Get("X-Amz-Date"); got != "20240102T030405Z" {
		t.Fatalf("amz date=%q", got)
	}
	auth := request.Header.Get("Authorization")
	if !strings.Contains(auth, "Credential=AKID/20240102/eu-west-1/s3/aws4_request") || !strings.Contains(auth, ";x-amz-security-token") {
		t.Fatalf("unexpected authorization header %q", auth)
	}
}

func TestRetrieveEvidenceSyntheticIsCountedAndDigestVerified(t *testing.T) {
	body := []byte("synthetic-evidence")
	sum := sha256.Sum256(body)
	cfg := config{
		allowSynthetic:   true,
		syntheticObjects: map[string]string{"verification/a.jpg": base64.StdEncoding.EncodeToString(body)},
		maxObjectBytes:   1024,
	}
	metrics := &orchestratorMetrics{}
	job := claimedJob{JobID: "job-1", EvidenceID: "ev-1", ObjectKey: "verification/a.jpg", SHA256Hex: hex.EncodeToString(sum[:])}
	got, err := retrieveEvidence(context.Background(), cfg, http.DefaultClient, metrics, job)
	if err != nil || string(got) != string(body) {
		t.Fatalf("unexpected synthetic retrieval body=%q err=%v", got, err)
	}
	if metrics.syntheticRetrievals != 1 {
		t.Fatalf("expected synthetic metric to be counted, got %d", metrics.syntheticRetrievals)
	}

	job.SHA256Hex = hex.EncodeToString(sha256.New().Sum(nil))
	if _, err := retrieveEvidence(context.Background(), cfg, http.DefaultClient, metrics, job); !errors.Is(err, errDigestMismatch) {
		t.Fatalf("expected digest mismatch on synthetic path, got %v", err)
	}
}

func TestRetrieveEvidenceFailsClosedWithoutSyntheticOrS3(t *testing.T) {
	cfg := config{maxObjectBytes: 1024}
	metrics := &orchestratorMetrics{}
	job := claimedJob{ObjectKey: "verification/a.jpg"}
	if _, err := retrieveEvidence(context.Background(), cfg, http.DefaultClient, metrics, job); err == nil {
		t.Fatal("expected retrieval to fail closed without object-store config")
	}
	if metrics.syntheticRetrievals != 0 {
		t.Fatal("synthetic metric must not increment when synthetic mode is not used")
	}
}

func TestMetricsExposition(t *testing.T) {
	metrics := &orchestratorMetrics{}
	metrics.incSynthetic()
	metrics.incSynthetic()
	recorder := httptest.NewRecorder()
	metrics.serveHTTP(recorder, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	body, err := io.ReadAll(recorder.Result().Body)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(body), "# TYPE verification_synthetic_retrievals_total counter") ||
		!strings.Contains(string(body), fmt.Sprintf("verification_synthetic_retrievals_total %d", 2)) {
		t.Fatalf("unexpected metrics exposition:\n%s", body)
	}
}
