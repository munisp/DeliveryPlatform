import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

// Consumer ride request load script (P5-SCALE).
//
// Exercises the LIVE consumerRide tRPC surface (mounted in server/routers.ts
// under `consumerRide:`; procedures in server/_core/consumerRide.ts):
//   consumerRide.requestRide  (mutation — creates the rider trip AND its
//     integer-kobo fare quote in one transaction; quote id rq-{tripId},
//     fare_quote CHECK total = base+distance+time+demand+taxes)
//   consumerRide.myRideTrips  (read — trip + embedded quote read-back)
// Every procedure is an authenticatedProcedure; auth is via
// Authorization: Bearer <session token>. Idempotency keys are unique per
// iteration so each requestRide is a genuinely new trip+quote (the
// consumer_processed_events ledger would otherwise collapse duplicates).
//
// SLO budget (validation/consumer_scale_baseline_20261112.md):
//   mutation p95 < 300ms, p99 < 600ms; read p95 < 150ms; error rate < 0.1%.

const targetEnvironment = requireEnv("TARGET_ENV");
const consumerBaseUrl = requireEnv("CONSUMER_BASE_URL").replace(/\/$/, "");
const consumerSessionToken = requireEnv("CONSUMER_SESSION_TOKEN");
const runId = requireCorrelationId("RUN_ID");

assertNonProductionTarget(targetEnvironment, consumerBaseUrl);

const requestLatency = new Trend("consumer_ride_request_latency_ms", true);
const tripsReadLatency = new Trend("consumer_ride_trips_read_latency_ms", true);
const requestSuccess = new Rate("consumer_ride_request_success_rate");
const requestResponses = new Counter("consumer_ride_request_responses_total");

const requestRate = positiveIntegerEnv("RIDE_REQUEST_RATE_PER_SECOND", 15);
const readRate = positiveIntegerEnv("RIDE_READ_RATE_PER_SECOND", 30);
const rideDuration = durationEnv("RIDE_DURATION", "15m");
const preAllocatedVUs = positiveIntegerEnv("PRE_ALLOCATED_VUS", 30);
const maxVUs = positiveIntegerEnv("MAX_VUS", 150);

// Lagos (Yaba <-> Victoria Island) bounding box used for synthetic trips.
const PICKUP = { lat: 6.5095, lng: 3.3711, address: "1 K6 Resilience Close, Yaba, Lagos" };
const DESTINATION = { lat: 6.4281, lng: 3.4219, address: "100 K6 Boulevard, Victoria Island, Lagos" };

export const options = {
  discardResponseBodies: false,
  scenarios: {
    ride_request: {
      executor: "constant-arrival-rate",
      exec: "requestRide",
      rate: requestRate,
      timeUnit: "1s",
      duration: rideDuration,
      preAllocatedVUs,
      maxVUs,
      gracefulStop: "30s",
      tags: { scenario: "ride_request", run_id: runId },
    },
    ride_trips_read: {
      executor: "constant-arrival-rate",
      exec: "listMyRideTrips",
      rate: readRate,
      timeUnit: "1s",
      duration: rideDuration,
      preAllocatedVUs: Math.max(10, Math.ceil(preAllocatedVUs / 2)),
      maxVUs: Math.max(50, Math.ceil(maxVUs / 2)),
      gracefulStop: "30s",
      tags: { scenario: "ride_trips_read", run_id: runId },
    },
  },
  thresholds: {
    "http_req_failed{operation:ride_request}": ["rate<0.001"],
    "http_req_failed{operation:ride_trips_read}": ["rate<0.001"],
    "consumer_ride_request_latency_ms{operation:ride_request}": [
      "p(95)<=300",
      "p(99)<=600",
    ],
    "consumer_ride_trips_read_latency_ms{operation:ride_trips_read}": [
      "p(95)<=150",
      "p(99)<=300",
    ],
    "consumer_ride_request_success_rate{operation:ride_request}": [
      "rate>=0.999",
    ],
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

export function requestRide() {
  // Small deterministic jitter spreads trips across the zone so the quote
  // path (haversine distance/duration) is exercised with varying inputs.
  const jitter = ((__VU + __ITER) % 100) / 100000;
  const response = http.post(
    `${consumerBaseUrl}/api/trpc/consumerRide.requestRide`,
    JSON.stringify({
      json: {
        pickupLat: PICKUP.lat + jitter,
        pickupLng: PICKUP.lng + jitter,
        pickupAddress: PICKUP.address,
        destinationLat: DESTINATION.lat + jitter,
        destinationLng: DESTINATION.lng + jitter,
        destinationAddress: DESTINATION.address,
        idempotencyKey: `k6-ride-${runId}-${__VU}-${__ITER}`,
      },
    }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${consumerSessionToken}`,
        "X-Resilience-Run-Id": runId,
      },
      tags: { operation: "ride_request", run_id: runId },
      timeout: "10s",
    },
  );
  requestLatency.add(response.timings.duration, {
    operation: "ride_request",
    run_id: runId,
  });
  requestResponses.add(1, {
    operation: "ride_request",
    status: String(response.status),
    run_id: runId,
  });
  const ok = check(response, {
    "requestRide is HTTP 200": (result) => result.status === 200,
    "requestRide returns a result payload": (result) => trpcSucceeded(result),
  });
  requestSuccess.add(ok, { operation: "ride_request", run_id: runId });
  sleep(0.01);
}

export function listMyRideTrips() {
  const query = `?input=${encodeURIComponent(
    JSON.stringify({ json: { limit: 10 } }),
  )}`;
  const response = http.get(
    `${consumerBaseUrl}/api/trpc/consumerRide.myRideTrips${query}`,
    {
      headers: {
        Authorization: `Bearer ${consumerSessionToken}`,
        "X-Resilience-Run-Id": runId,
      },
      tags: { operation: "ride_trips_read", run_id: runId },
      timeout: "10s",
    },
  );
  tripsReadLatency.add(response.timings.duration, {
    operation: "ride_trips_read",
    run_id: runId,
  });
  requestResponses.add(1, {
    operation: "ride_trips_read",
    status: String(response.status),
    run_id: runId,
  });
  check(response, {
    "myRideTrips is HTTP 200": (result) => result.status === 200,
    "myRideTrips returns a result payload": (result) => trpcSucceeded(result),
  });
  sleep(0.01);
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
    [`consumer-ride-request-${runId}-summary.json`]: JSON.stringify(
      summary,
      null,
      2,
    ),
    stdout:
      JSON.stringify({
        resilience_run_id: runId,
        ride_request_p95_ms: metricPercentile(
          summary,
          "consumer_ride_request_latency_ms",
          "p(95)",
        ),
        ride_trips_read_p95_ms: metricPercentile(
          summary,
          "consumer_ride_trips_read_latency_ms",
          "p(95)",
        ),
        checks_passed: summary.root_group.checks,
      }) + "\n",
  };
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
