import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

// Consumer catalog read load script (P5-SCALE).
//
// Exercises the LIVE consumerCatalog tRPC read surface (mounted in
// server/routers.ts under `consumerCatalog:`; procedures in
// server/_core/consumerCatalog.ts):
//   consumerCatalog.consumerVerticals  (no input)
//   consumerCatalog.consumerProviders  { verticalId, limit, offset }
//   consumerCatalog.consumerCatalog    { providerId, limit, offset }
// plus the /api/health liveness probe (server/_core/index.ts:747).
// Queries go over GET /api/trpc/<path>?input=<superjson envelope>; every
// procedure is an authenticatedProcedure, so a bearer session token is sent.
//
// SLO budget (validation/consumer_scale_baseline_20261112.md):
//   read p95 < 150ms, p99 < 300ms, error rate < 0.1%;
//   /api/health p95 < 10ms (meaningful only from an in-cluster runner — the
//   health probe measures in-memory liveness, not WAN RTT).

const targetEnvironment = requireEnv("TARGET_ENV");
const consumerBaseUrl = requireEnv("CONSUMER_BASE_URL").replace(/\/$/, "");
const consumerSessionToken = requireEnv("CONSUMER_SESSION_TOKEN");
const runId = requireCorrelationId("RUN_ID");
const verticalId = positiveIntegerEnv("VERTICAL_ID", 1);
const providerId = positiveIntegerEnv("PROVIDER_ID", 1);

assertNonProductionTarget(targetEnvironment, consumerBaseUrl);

const verticalsLatency = new Trend("consumer_verticals_latency_ms", true);
const providersLatency = new Trend("consumer_providers_latency_ms", true);
const catalogLatency = new Trend("consumer_catalog_latency_ms", true);
const healthLatency = new Trend("consumer_health_latency_ms", true);
const readSuccess = new Rate("consumer_catalog_read_success_rate");
const readResponses = new Counter("consumer_catalog_read_responses_total");

const readRate = positiveIntegerEnv("READ_RATE_PER_SECOND", 60);
const readDuration = durationEnv("READ_DURATION", "15m");
const preAllocatedVUs = positiveIntegerEnv("PRE_ALLOCATED_VUS", 30);
const maxVUs = positiveIntegerEnv("MAX_VUS", 150);

export const options = {
  discardResponseBodies: false,
  scenarios: {
    catalog_reads: {
      executor: "constant-arrival-rate",
      exec: "catalogReadMix",
      rate: readRate,
      timeUnit: "1s",
      duration: readDuration,
      preAllocatedVUs,
      maxVUs,
      gracefulStop: "30s",
      tags: { scenario: "catalog_reads", run_id: runId },
    },
    health_probe: {
      executor: "constant-arrival-rate",
      exec: "healthProbe",
      rate: 1,
      timeUnit: "1s",
      duration: readDuration,
      preAllocatedVUs: 1,
      maxVUs: 2,
      gracefulStop: "30s",
      tags: { scenario: "health_probe", run_id: runId },
    },
  },
  thresholds: {
    "http_req_failed{operation:verticals}": ["rate<0.001"],
    "http_req_failed{operation:providers}": ["rate<0.001"],
    "http_req_failed{operation:catalog}": ["rate<0.001"],
    "consumer_verticals_latency_ms{operation:verticals}": [
      "p(95)<=150",
      "p(99)<=300",
    ],
    "consumer_providers_latency_ms{operation:providers}": [
      "p(95)<=150",
      "p(99)<=300",
    ],
    "consumer_catalog_latency_ms{operation:catalog}": [
      "p(95)<=150",
      "p(99)<=300",
    ],
    "consumer_health_latency_ms{operation:health}": ["p(95)<=10", "p(99)<=25"],
    "consumer_catalog_read_success_rate{operation:catalog}": ["rate>=0.999"],
  },
  noConnectionReuse: false,
  userAgent: `DeliveryPlatform-consumer-scale-k6/${runId}`,
};

export function setup() {
  const health = http.get(`${consumerBaseUrl}/api/health`, {
    tags: { operation: "health", run_id: runId },
    timeout: "5s",
  });
  if (health.status !== 200) {
    fail(`target health check failed: status=${health.status}`);
  }
  return { started_at: new Date().toISOString() };
}

// Deterministic per-iteration mix: verticals 50%, providers 25%, catalog 25%.
export function catalogReadMix() {
  const pick = __ITER % 4;
  if (pick === 0) {
    runRead("consumerCatalog.consumerProviders", {
      verticalId,
      limit: 20,
      offset: 0,
    }, "providers", providersLatency);
  } else if (pick === 1) {
    runRead("consumerCatalog.consumerCatalog", {
      providerId,
      limit: 50,
      offset: 0,
    }, "catalog", catalogLatency);
  } else {
    runRead("consumerCatalog.consumerVerticals", null, "verticals", verticalsLatency);
  }
  sleep(0.01);
}

export function healthProbe() {
  const response = http.get(`${consumerBaseUrl}/api/health`, {
    tags: { operation: "health", run_id: runId },
    timeout: "5s",
  });
  healthLatency.add(response.timings.duration, {
    operation: "health",
    run_id: runId,
  });
  check(response, {
    "health probe is HTTP 200": (result) => result.status === 200,
  });
}

export function teardown(data) {
  console.log(
    JSON.stringify({
      resilience_run_id: runId,
      target_environment: targetEnvironment,
      started_at: data.started_at,
      completed_at: new Date().toISOString(),
      next_step:
        "Record observed percentiles into validation/consumer_scale_baseline_20261112.md before treating the SLO budget as verified.",
    }),
  );
}

export function handleSummary(summary) {
  return {
    [`consumer-catalog-read-${runId}-summary.json`]: JSON.stringify(
      summary,
      null,
      2,
    ),
    stdout:
      JSON.stringify({
        resilience_run_id: runId,
        verticals_p95_ms: metricPercentile(
          summary,
          "consumer_verticals_latency_ms",
          "p(95)",
        ),
        providers_p95_ms: metricPercentile(
          summary,
          "consumer_providers_latency_ms",
          "p(95)",
        ),
        catalog_p95_ms: metricPercentile(
          summary,
          "consumer_catalog_latency_ms",
          "p(95)",
        ),
        health_p95_ms: metricPercentile(
          summary,
          "consumer_health_latency_ms",
          "p(95)",
        ),
        checks_passed: summary.root_group.checks,
      }) + "\n",
  };
}

function runRead(path, input, operation, latency) {
  const query =
    input === null
      ? ""
      : `?input=${encodeURIComponent(JSON.stringify({ json: input }))}`;
  const response = http.get(`${consumerBaseUrl}/api/trpc/${path}${query}`, {
    headers: {
      Authorization: `Bearer ${consumerSessionToken}`,
      "X-Resilience-Run-Id": runId,
    },
    tags: { operation, run_id: runId },
    timeout: "10s",
  });
  latency.add(response.timings.duration, { operation, run_id: runId });
  readResponses.add(1, {
    operation,
    status: String(response.status),
    run_id: runId,
  });
  const ok = check(response, {
    [`${operation} is HTTP 200`]: (result) => result.status === 200,
    [`${operation} returns a result payload`]: (result) =>
      trpcSucceeded(result),
  });
  readSuccess.add(ok, { operation: "catalog", run_id: runId });
}

function trpcSucceeded(response) {
  if (response.status !== 200) return false;
  try {
    const payload = response.json();
    return payload && payload.result && payload.result.data !== undefined;
  } catch (_) {
    return false;
  }
}

function requireEnv(name) {
  const value = __ENV[name];
  if (!value) fail(`${name} must be explicitly set`);
  return value;
}

function requireCorrelationId(name) {
  const value = requireEnv(name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/.test(value)) {
    fail(
      `${name} must use 3-81 letters, digits, dots, underscores, or hyphens`,
    );
  }
  return value;
}

function positiveIntegerEnv(name, fallback) {
  const value = Number(__ENV[name] || fallback);
  if (!Number.isInteger(value) || value < 1)
    fail(`${name} must be a positive integer`);
  return value;
}

function durationEnv(name, fallback) {
  const value = __ENV[name] || fallback;
  if (!/^\d+(s|m|h)$/.test(value))
    fail(`${name} must use a whole-number s, m, or h duration`);
  return value;
}

function assertNonProductionTarget(environment, ...urls) {
  if (!["test", "staging", "preproduction"].includes(environment)) {
    fail(
      "TARGET_ENV must be test, staging, or preproduction; this template refuses production targets",
    );
  }
  for (const value of urls) {
    const endpoint = new URL(value);
    if (endpoint.protocol !== "https:")
      fail(`endpoint must use HTTPS: ${value}`);
    if (/(^|[.-])(prod|production)([.-]|$)/i.test(endpoint.hostname)) {
      fail(
        `endpoint hostname appears production-like and is refused: ${endpoint.hostname}`,
      );
    }
  }
}

function metricPercentile(summary, metricName, percentile) {
  return summary.metrics[metricName]?.values?.[percentile] ?? null;
}
