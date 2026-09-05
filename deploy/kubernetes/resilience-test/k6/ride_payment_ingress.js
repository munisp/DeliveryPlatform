import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";
import { hmac } from "k6/crypto";

const targetEnvironment = requireEnv("TARGET_ENV");
const matchingBaseUrl = requireEnv("MATCHING_BASE_URL").replace(/\/$/, "");
const paymentBaseUrl = requireEnv("PAYMENT_BASE_URL").replace(/\/$/, "");
const internalServiceToken = requireEnv("INTERNAL_SERVICE_TOKEN");
const webhookSecret = requireEnv("WEBHOOK_SECRET");
const runId = requireCorrelationId("RUN_ID");
const tripIdPrefix = __ENV.TRIP_ID_PREFIX || "30000000-0000-0000-0000-";
const paymentReferencePrefix =
  __ENV.PAYMENT_REFERENCE_PREFIX || "peak-payment-";
const paymentEventPrefix = __ENV.PAYMENT_EVENT_PREFIX || "k6-payment-event-";
const tripOffset = positiveIntegerEnv("TRIP_OFFSET", 1);
const paymentOffset = positiveIntegerEnv("PAYMENT_OFFSET", 1);

assertNonProductionTarget(targetEnvironment, matchingBaseUrl, paymentBaseUrl);

const matchLatency = new Trend("match_ingress_latency_ms", true);
const webhookLatency = new Trend("payment_webhook_accept_latency_ms", true);
const matchSuccess = new Rate("match_success_rate");
const webhookAccepted = new Rate("payment_webhook_accept_rate");
const matchingResponses = new Counter("match_responses_total");
const webhookResponses = new Counter("payment_webhook_responses_total");

const matchRate = positiveIntegerEnv("MATCH_RATE_PER_SECOND", 80);
const matchDuration = durationEnv("MATCH_DURATION", "15m");
const paymentRate = positiveIntegerEnv("PAYMENT_RATE_PER_SECOND", 10);
const paymentDuration = durationEnv("PAYMENT_DURATION", "15m");
const preAllocatedVUs = positiveIntegerEnv("PRE_ALLOCATED_VUS", 50);
const maxVUs = positiveIntegerEnv("MAX_VUS", 250);

export const options = {
  discardResponseBodies: false,
  scenarios: {
    match_ingress: {
      executor: "constant-arrival-rate",
      exec: "matchTrip",
      rate: matchRate,
      timeUnit: "1s",
      duration: matchDuration,
      preAllocatedVUs,
      maxVUs,
      gracefulStop: "30s",
      tags: { scenario: "match_ingress", run_id: runId },
    },
    payment_webhook_ingress: {
      executor: "constant-arrival-rate",
      exec: "acceptPaymentWebhook",
      rate: paymentRate,
      timeUnit: "1s",
      duration: paymentDuration,
      preAllocatedVUs: Math.max(10, Math.ceil(preAllocatedVUs / 2)),
      maxVUs: Math.max(50, Math.ceil(maxVUs / 2)),
      gracefulStop: "30s",
      tags: { scenario: "payment_webhook_ingress", run_id: runId },
    },
  },
  thresholds: {
    "http_req_failed{operation:match}": ["rate<0.001"],
    "http_req_failed{operation:webhook_accept}": ["rate<0.001"],
    "match_ingress_latency_ms{operation:match}": ["p(95)<=200", "p(99)<=400"],
    "payment_webhook_accept_latency_ms{operation:webhook_accept}": [
      "p(95)<=200",
      "p(99)<=400",
    ],
    "match_success_rate{operation:match}": ["rate>=0.999"],
    "payment_webhook_accept_rate{operation:webhook_accept}": ["rate>=0.999"],
  },
  noConnectionReuse: false,
  userAgent: `DeliveryPlatform-resilience-k6/${runId}`,
};

export function setup() {
  const matchingHealth = http.get(`${matchingBaseUrl}/health`, {
    tags: { operation: "match_health", run_id: runId },
    timeout: "5s",
  });
  const paymentHealth = http.get(`${paymentBaseUrl}/health`, {
    tags: { operation: "payment_health", run_id: runId },
    timeout: "5s",
  });
  if (matchingHealth.status !== 200 || paymentHealth.status !== 200) {
    fail(
      `target health checks failed: matching=${matchingHealth.status} payment=${paymentHealth.status}`,
    );
  }
  return { started_at: new Date().toISOString() };
}

export function matchTrip() {
  const sequence = tripOffset + (__VU - 1) * 1_000_000 + __ITER;
  const tripId = `${tripIdPrefix}${String(sequence).padStart(12, "0")}`;
  const idempotencyKey = `k6-match-${runId}-${__VU}-${__ITER}`;
  const requestId = buildRequestId("match");
  const response = http.post(
    `${matchingBaseUrl}/matches/attempts`,
    JSON.stringify({ trip_id: tripId, idempotency_key: idempotencyKey }),
    {
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Service-Token": internalServiceToken,
        "X-Request-Id": requestId,
        "X-Resilience-Run-Id": runId,
      },
      tags: { operation: "match", run_id: runId },
      timeout: "5s",
    },
  );
  matchLatency.add(response.timings.duration, {
    operation: "match",
    run_id: runId,
  });
  matchingResponses.add(1, {
    operation: "match",
    status: String(response.status),
    run_id: runId,
  });
  const ok = check(response, {
    "match response is HTTP 200": (result) => result.status === 200,
    "match response contains durable state": (result) =>
      hasExpectedMatchState(result),
    "match response echoes correlation headers": (result) =>
      hasExpectedCorrelationHeaders(result, requestId),
  });
  matchSuccess.add(ok, { operation: "match", run_id: runId });
  sleep(0.01);
}

export function acceptPaymentWebhook() {
  const sequence = paymentOffset + (__VU - 1) * 1_000_000 + __ITER;
  const requestId = buildRequestId("payment");
  const body = JSON.stringify({
    event: "charge.success",
    data: {
      id: `${paymentEventPrefix}${runId}-${sequence}`,
      reference: `${paymentReferencePrefix}${sequence}`,
    },
  });
  const signature = hmac("sha512", webhookSecret, body, "hex");
  const response = http.post(`${paymentBaseUrl}/webhooks/payments`, body, {
    headers: {
      "Content-Type": "application/json",
      "X-Paystack-Signature": signature,
      "X-Request-Id": requestId,
      "X-Resilience-Run-Id": runId,
    },
    tags: { operation: "webhook_accept", run_id: runId },
    timeout: "5s",
  });
  webhookLatency.add(response.timings.duration, {
    operation: "webhook_accept",
    run_id: runId,
  });
  webhookResponses.add(1, {
    operation: "webhook_accept",
    status: String(response.status),
    run_id: runId,
  });
  const ok = check(response, {
    "webhook acceptance is HTTP 202": (result) => result.status === 202,
    "webhook reports durable acceptance": (result) =>
      hasAcceptedWebhookBody(result),
    "webhook response echoes correlation headers": (result) =>
      hasExpectedCorrelationHeaders(result, requestId),
  });
  webhookAccepted.add(ok, { operation: "webhook_accept", run_id: runId });
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
        "Run the protected PostgreSQL invariant probe and queue-drain probe before treating the test as passed.",
    }),
  );
}

export function handleSummary(summary) {
  return {
    [`ride-payment-ingress-${runId}-summary.json`]: JSON.stringify(
      summary,
      null,
      2,
    ),
    stdout:
      JSON.stringify({
        resilience_run_id: runId,
        match_p95_ms: metricPercentile(
          summary,
          "match_ingress_latency_ms",
          "p(95)",
        ),
        webhook_accept_p95_ms: metricPercentile(
          summary,
          "payment_webhook_accept_latency_ms",
          "p(95)",
        ),
        checks_passed: summary.root_group.checks,
      }) + "\n",
  };
}

function hasExpectedMatchState(response) {
  if (response.status !== 200) return false;
  try {
    const payload = response.json();
    return (
      payload.trip_id && ["driver_offered", "matching"].includes(payload.state)
    );
  } catch (_) {
    return false;
  }
}

function hasAcceptedWebhookBody(response) {
  if (response.status !== 202) return false;
  try {
    const payload = response.json();
    return payload.accepted === true && payload.queued === true;
  } catch (_) {
    return false;
  }
}

function buildRequestId(workload) {
  const suffix = `${__VU}-${__ITER}`;
  const maximumRunLength = 81 - `k6-${workload}--${suffix}`.length;
  return `k6-${workload}-${runId.slice(0, Math.max(3, maximumRunLength))}-${suffix}`;
}

function hasExpectedCorrelationHeaders(response, requestId) {
  return (
    responseHeader(response, "X-Request-Id") === requestId &&
    responseHeader(response, "X-Resilience-Run-Id") === runId
  );
}

function responseHeader(response, expectedName) {
  const target = expectedName.toLowerCase();
  for (const [name, value] of Object.entries(response.headers || {})) {
    if (name.toLowerCase() === target) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return "";
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
