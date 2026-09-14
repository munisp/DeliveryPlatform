//! Dependency-free Prometheus `/metrics` support: request counts, latency
//! histogram, error counts, uptime and version gauges rendered in the
//! Prometheus text exposition format. Standard library + axum only.

use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use axum::http::header;
use axum::http::HeaderValue;
use axum::response::{IntoResponse, Response};
use axum::{extract::Request, middleware::Next};

const BUCKETS: [f64; 11] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0];

struct HistogramSeries {
    /// buckets[i] counts observations <= BUCKETS[i]; buckets[BUCKETS.len()] is +Inf.
    buckets: [u64; 12],
    sum: f64,
}

pub struct ServiceMetrics {
    service: &'static str,
    version: String,
    started: Instant,
    /// (method, path, status) -> count
    requests: Mutex<HashMap<(String, String, u16), u64>>,
    /// (method, path, status) -> count (5xx only)
    errors: Mutex<HashMap<(String, String, u16), u64>>,
    /// (method, path) -> series
    histograms: Mutex<HashMap<(String, String), HistogramSeries>>,
}

static METRICS: OnceLock<ServiceMetrics> = OnceLock::new();

/// Initialize and return the process-wide metrics registry.
pub fn init(service: &'static str) -> &'static ServiceMetrics {
    METRICS.get_or_init(|| ServiceMetrics {
        service,
        version: std::env::var("SERVICE_VERSION")
            .ok()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| env!("CARGO_PKG_VERSION").to_string()),
        started: Instant::now(),
        requests: Mutex::new(HashMap::new()),
        errors: Mutex::new(HashMap::new()),
        histograms: Mutex::new(HashMap::new()),
    })
}

fn increment(map: &Mutex<HashMap<(String, String, u16), u64>>, key: (String, String, u16)) {
    let mut guard = map.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    *guard.entry(key).or_insert(0) += 1;
}

/// Axum middleware recording request count, latency and 5xx errors.
pub async fn track(request: Request, next: Next) -> Response {
    let started = Instant::now();
    let method = request.method().to_string();
    let path = request.uri().path().to_string();
    let response = next.run(request).await;
    let Some(metrics) = METRICS.get() else {
        return response;
    };
    let status = response.status().as_u16();
    increment(&metrics.requests, (method.clone(), path.clone(), status));
    if status >= 500 {
        increment(&metrics.errors, (method.clone(), path.clone(), status));
    }
    let elapsed = started.elapsed().as_secs_f64();
    let mut histograms = metrics
        .histograms
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    let series = histograms.entry((method, path)).or_insert(HistogramSeries {
        buckets: [0; 12],
        sum: 0.0,
    });
    series.sum += elapsed;
    let mut placed = false;
    for (index, bound) in BUCKETS.iter().enumerate() {
        if elapsed <= *bound {
            series.buckets[index] += 1;
            placed = true;
            break;
        }
    }
    if !placed {
        series.buckets[BUCKETS.len()] += 1;
    }
    response
}

fn format_bucket_bound(bound: f64) -> String {
    let mut text = format!("{bound}");
    if !text.contains('.') {
        text.push_str(".0");
    }
    text
}

impl ServiceMetrics {
    fn render(&self) -> String {
        let mut out = String::with_capacity(4096);
        let _ = writeln!(out, "# HELP service_info Static service metadata gauge (always 1).");
        let _ = writeln!(out, "# TYPE service_info gauge");
        let _ = writeln!(
            out,
            "service_info{{service=\"{}\",version=\"{}\"}} 1",
            self.service, self.version
        );
        let _ = writeln!(out, "# HELP service_uptime_seconds Seconds since the service process started.");
        let _ = writeln!(out, "# TYPE service_uptime_seconds gauge");
        let _ = writeln!(
            out,
            "service_uptime_seconds{{service=\"{}\"}} {:.3}",
            self.service,
            self.started.elapsed().as_secs_f64()
        );

        let _ = writeln!(out, "# HELP http_requests_total Total HTTP requests handled.");
        let _ = writeln!(out, "# TYPE http_requests_total counter");
        let requests = self.requests.lock().unwrap_or_else(|p| p.into_inner());
        let mut request_rows: Vec<_> = requests.iter().collect();
        request_rows.sort_by(|left, right| left.0.cmp(right.0));
        for ((method, path, status), count) in request_rows {
            let _ = writeln!(
                out,
                "http_requests_total{{service=\"{}\",method=\"{}\",path=\"{}\",status=\"{}\"}} {}",
                self.service, method, path, status, count
            );
        }
        drop(requests);

        let _ = writeln!(out, "# HELP http_errors_total Total HTTP 5xx responses.");
        let _ = writeln!(out, "# TYPE http_errors_total counter");
        let errors = self.errors.lock().unwrap_or_else(|p| p.into_inner());
        let mut error_rows: Vec<_> = errors.iter().collect();
        error_rows.sort_by(|left, right| left.0.cmp(right.0));
        for ((method, path, status), count) in error_rows {
            let _ = writeln!(
                out,
                "http_errors_total{{service=\"{}\",method=\"{}\",path=\"{}\",status=\"{}\"}} {}",
                self.service, method, path, status, count
            );
        }
        drop(errors);

        let _ = writeln!(out, "# HELP http_request_duration_seconds HTTP request latency in seconds.");
        let _ = writeln!(out, "# TYPE http_request_duration_seconds histogram");
        let histograms = self.histograms.lock().unwrap_or_else(|p| p.into_inner());
        let mut histogram_rows: Vec<_> = histograms.iter().collect();
        histogram_rows.sort_by(|left, right| left.0.cmp(right.0));
        for ((method, path), series) in histogram_rows {
            let total: u64 = series.buckets.iter().sum();
            let mut cumulative = 0u64;
            for (index, bound) in BUCKETS.iter().enumerate() {
                cumulative += series.buckets[index];
                let _ = writeln!(
                    out,
                    "http_request_duration_seconds_bucket{{service=\"{}\",method=\"{}\",path=\"{}\",le=\"{}\"}} {}",
                    self.service,
                    method,
                    path,
                    format_bucket_bound(*bound),
                    cumulative
                );
            }
            let _ = writeln!(
                out,
                "http_request_duration_seconds_bucket{{service=\"{}\",method=\"{}\",path=\"{}\",le=\"+Inf\"}} {}",
                self.service, method, path, total
            );
            let _ = writeln!(
                out,
                "http_request_duration_seconds_sum{{service=\"{}\",method=\"{}\",path=\"{}\"}} {}",
                self.service, method, path, series.sum
            );
            let _ = writeln!(
                out,
                "http_request_duration_seconds_count{{service=\"{}\",method=\"{}\",path=\"{}\"}} {}",
                self.service, method, path, total
            );
        }
        out
    }
}

/// GET /metrics handler rendering the Prometheus text exposition format.
pub async fn handler() -> Response {
    let body = match METRICS.get() {
        Some(metrics) => metrics.render(),
        None => String::new(),
    };
    (
        [(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/plain; version=0.0.4; charset=utf-8"),
        )],
        body,
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_contains_core_series_after_tracking() {
        let metrics = init("test-service");
        increment(
            &metrics.requests,
            ("GET".to_string(), "/health".to_string(), 200),
        );
        increment(
            &metrics.requests,
            ("GET".to_string(), "/health".to_string(), 200),
        );
        increment(
            &metrics.errors,
            ("POST".to_string(), "/boom".to_string(), 500),
        );
        {
            let mut histograms = metrics.histograms.lock().unwrap();
            let series = histograms
                .entry(("GET".to_string(), "/health".to_string()))
                .or_insert(HistogramSeries {
                    buckets: [0; 12],
                    sum: 0.0,
                });
            series.sum += 0.03;
            series.buckets[3] += 1; // <= 0.05
        }
        let body = metrics.render();
        assert!(body.contains("service_info{service=\"test-service\""));
        assert!(body.contains("service_uptime_seconds{service=\"test-service\"}"));
        assert!(body.contains(
            "http_requests_total{service=\"test-service\",method=\"GET\",path=\"/health\",status=\"200\"} 2"
        ));
        assert!(body.contains(
            "http_errors_total{service=\"test-service\",method=\"POST\",path=\"/boom\",status=\"500\"} 1"
        ));
        assert!(body.contains("le=\"0.05\"} 1"));
        assert!(body.contains("le=\"+Inf\"} 1"));
        assert!(body.contains("http_request_duration_seconds_count{"));
    }
}
