package metrics

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestMiddlewareAndHandlerExposition(t *testing.T) {
	r := New("test-service", "1.2.3")
	mux := http.NewServeMux()
	mux.Handle("/ok", r.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusOK)
	})))
	mux.Handle("/fail", r.Middleware(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	})))

	for i := 0; i < 2; i++ {
		rec := httptest.NewRecorder()
		mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/ok", nil))
		if rec.Code != http.StatusOK {
			t.Fatalf("unexpected status %d", rec.Code)
		}
	}
	rec := httptest.NewRecorder()
	mux.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/fail", nil))

	out := httptest.NewRecorder()
	r.Handler().ServeHTTP(out, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	body := out.Body.String()

	for _, want := range []string{
		`service_info{service="test-service",version="1.2.3"} 1`,
		`service_uptime_seconds{service="test-service"}`,
		`http_requests_total{method="GET",path="/ok",service="test-service",status="200"} 2`,
		`http_errors_total{method="GET",path="/fail",service="test-service",status="500"} 1`,
		`http_request_duration_seconds_bucket{`,
		`http_request_duration_seconds_count{`,
		`le="+Inf"`,
	} {
		if !strings.Contains(body, want) {
			t.Errorf("exposition missing %q\n---\n%s", want, body)
		}
	}
	if ct := out.Header().Get("Content-Type"); !strings.HasPrefix(ct, "text/plain") {
		t.Errorf("unexpected content type %q", ct)
	}
}

func TestHandlerAppendsExtraHandlers(t *testing.T) {
	r := New("svc", "")
	extra := http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte("custom_total 7\n"))
	})
	out := httptest.NewRecorder()
	r.Handler(extra).ServeHTTP(out, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if !strings.Contains(out.Body.String(), "custom_total 7") {
		t.Fatalf("extra handler output missing:\n%s", out.Body.String())
	}
}

func TestCustomCounterWithoutLabels(t *testing.T) {
	r := New("svc", "0")
	inc := r.Counter("jobs_processed_total", "Jobs processed.", nil)
	inc()
	inc()
	out := httptest.NewRecorder()
	r.Handler().ServeHTTP(out, httptest.NewRequest(http.MethodGet, "/metrics", nil))
	if !strings.Contains(out.Body.String(), "jobs_processed_total 2") {
		t.Fatalf("counter missing:\n%s", out.Body.String())
	}
}
