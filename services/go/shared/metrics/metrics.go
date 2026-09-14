// Package metrics provides a dependency-free Prometheus text-exposition
// registry plus HTTP middleware for SwitchOS Go services. It records request
// counts, latency histograms, error counts, an uptime gauge and a version
// info gauge, and renders them on a /metrics handler. Standard library only.
package metrics

import (
	"fmt"
	"io"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// DefaultBuckets are the default histogram buckets in seconds.
var DefaultBuckets = []float64{0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10}

type counterVec struct {
	name   string
	help   string
	values map[string]*float64 // key: encoded labels
}

type histogram struct {
	name    string
	help    string
	buckets []float64
	// counts[i] counts observations <= buckets[i]; counts[len] is +Inf.
	series map[string]*histogramSeries
}

type histogramSeries struct {
	counts []uint64
	sum    float64
}

// Registry is a goroutine-safe Prometheus metrics registry.
type Registry struct {
	service string
	version string
	start   time.Time

	mu         sync.Mutex
	counters   map[string]*counterVec
	histograms map[string]*histogram
}

// New creates a Registry for a service.
func New(service, version string) *Registry {
	if version == "" {
		version = "unknown"
	}
	return &Registry{
		service:    service,
		version:    version,
		start:      time.Now(),
		counters:   make(map[string]*counterVec),
		histograms: make(map[string]*histogram),
	}
}

// Counter returns an increment function for the named counter with the given
// label set, creating the counter on first use.
func (r *Registry) Counter(name, help string, labels map[string]string) func() {
	r.mu.Lock()
	defer r.mu.Unlock()
	cv, ok := r.counters[name]
	if !ok {
		cv = &counterVec{name: name, help: help, values: make(map[string]*float64)}
		r.counters[name] = cv
	}
	key := encodeLabels(labels)
	v, ok := cv.values[key]
	if !ok {
		var zero float64
		v = &zero
		cv.values[key] = v
	}
	return func() {
		r.mu.Lock()
		defer r.mu.Unlock()
		*v++
	}
}

// Observe records a duration (seconds) in the named histogram.
func (r *Registry) Observe(name, help string, seconds float64, labels map[string]string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	h, ok := r.histograms[name]
	if !ok {
		h = &histogram{name: name, help: help, buckets: DefaultBuckets, series: make(map[string]*histogramSeries)}
		r.histograms[name] = h
	}
	key := encodeLabels(labels)
	s, ok := h.series[key]
	if !ok {
		s = &histogramSeries{counts: make([]uint64, len(h.buckets)+1)}
		h.series[key] = s
	}
	s.sum += seconds
	placed := false
	for i, b := range h.buckets {
		if seconds <= b {
			s.counts[i]++
			placed = true
			break
		}
	}
	if !placed {
		s.counts[len(h.buckets)]++
	}
}

func encodeLabels(labels map[string]string) string {
	if len(labels) == 0 {
		return ""
	}
	keys := make([]string, 0, len(labels))
	for k := range labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var sb strings.Builder
	for i, k := range keys {
		if i > 0 {
			sb.WriteByte(',')
		}
		sb.WriteString(k)
		sb.WriteByte('=')
		sb.WriteString(strconv.Quote(labels[k]))
	}
	return sb.String()
}

func mergeLabels(base map[string]string, kv ...string) map[string]string {
	out := make(map[string]string, len(base)+len(kv)/2)
	for k, v := range base {
		out[k] = v
	}
	for i := 0; i+1 < len(kv); i += 2 {
		out[kv[i]] = kv[i+1]
	}
	return out
}

// statusRecorder captures the response status code.
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

// Unwrap supports http.ResponseController.
func (s *statusRecorder) Unwrap() http.ResponseWriter { return s.ResponseWriter }

// routeLabel returns the request path as the route label.
func routeLabel(r *http.Request) string {
	if r.URL != nil && r.URL.Path != "" {
		return r.URL.Path
	}
	return "unknown"
}

// Middleware instruments an http.Handler with request count, latency
// histogram and error count metrics.
func (r *Registry) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		start := time.Now()
		recorder := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(recorder, req)
		elapsed := time.Since(start).Seconds()
		path := routeLabel(req)
		labels := map[string]string{"service": r.service, "method": req.Method, "path": path}
		r.Counter("http_requests_total", "Total HTTP requests handled.", mergeLabels(labels, "status", strconv.Itoa(recorder.status)))()
		r.Observe("http_request_duration_seconds", "HTTP request latency in seconds.", elapsed, labels)
		if recorder.status >= 500 {
			r.Counter("http_errors_total", "Total HTTP 5xx responses.", mergeLabels(labels, "status", strconv.Itoa(recorder.status)))()
		}
	})
}

// Handler renders the registry in Prometheus text exposition format. Any
// extra handlers (e.g. pre-existing service-specific metrics) are appended.
func (r *Registry) Handler(extra ...http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, req *http.Request) {
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		r.render(w)
		for _, h := range extra {
			h.ServeHTTP(w, req)
		}
	})
}

func (r *Registry) render(w io.Writer) {
	r.mu.Lock()
	defer r.mu.Unlock()

	_, _ = io.WriteString(w, "# HELP service_info Static service metadata gauge (always 1).\n")
	_, _ = io.WriteString(w, "# TYPE service_info gauge\n")
	_, _ = fmt.Fprintf(w, "service_info{service=%s,version=%s} 1\n", strconv.Quote(r.service), strconv.Quote(r.version))
	_, _ = io.WriteString(w, "# HELP service_uptime_seconds Seconds since the service process started.\n")
	_, _ = io.WriteString(w, "# TYPE service_uptime_seconds gauge\n")
	_, _ = fmt.Fprintf(w, "service_uptime_seconds{service=%s} %.3f\n", strconv.Quote(r.service), time.Since(r.start).Seconds())

	names := make([]string, 0, len(r.counters))
	for name := range r.counters {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		cv := r.counters[name]
		_, _ = fmt.Fprintf(w, "# HELP %s %s\n", cv.name, cv.help)
		_, _ = fmt.Fprintf(w, "# TYPE %s counter\n", cv.name)
		keys := make([]string, 0, len(cv.values))
		for k := range cv.values {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			if k == "" {
				_, _ = fmt.Fprintf(w, "%s %g\n", cv.name, *cv.values[k])
			} else {
				_, _ = fmt.Fprintf(w, "%s{%s} %g\n", cv.name, k, *cv.values[k])
			}
		}
	}

	hNames := make([]string, 0, len(r.histograms))
	for name := range r.histograms {
		hNames = append(hNames, name)
	}
	sort.Strings(hNames)
	for _, name := range hNames {
		h := r.histograms[name]
		_, _ = fmt.Fprintf(w, "# HELP %s %s\n", h.name, h.help)
		_, _ = fmt.Fprintf(w, "# TYPE %s histogram\n", h.name)
		keys := make([]string, 0, len(h.series))
		for k := range h.series {
			keys = append(keys, k)
		}
		sort.Strings(keys)
		for _, k := range keys {
			s := h.series[k]
			var cumulative uint64
			var total uint64
			for _, c := range s.counts {
				total += c
			}
			bucketLabels := func(le string) string {
				if k == "" {
					return "le=" + strconv.Quote(le)
				}
				return k + ",le=" + strconv.Quote(le)
			}
			seriesLabels := k
			for i, b := range h.buckets {
				cumulative += s.counts[i]
				_, _ = fmt.Fprintf(w, "%s_bucket{%s} %d\n", h.name, bucketLabels(strconv.FormatFloat(b, 'g', -1, 64)), cumulative)
			}
			_, _ = fmt.Fprintf(w, "%s_bucket{%s} %d\n", h.name, bucketLabels("+Inf"), total)
			if seriesLabels == "" {
				_, _ = fmt.Fprintf(w, "%s_sum %g\n", h.name, s.sum)
				_, _ = fmt.Fprintf(w, "%s_count %d\n", h.name, total)
			} else {
				_, _ = fmt.Fprintf(w, "%s_sum{%s} %g\n", h.name, seriesLabels, s.sum)
				_, _ = fmt.Fprintf(w, "%s_count{%s} %d\n", h.name, seriesLabels, total)
			}
		}
	}
}
