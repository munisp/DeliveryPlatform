import http from "k6/http";
import { check, fail, sleep } from "k6";
import { Counter, Rate, Trend } from "k6/metrics";

// Consumer checkout ingress load script (P5-SCALE).
//
// Exercises the LIVE consumer tRPC mutation chain end to end:
//   consumer.createCart -> consumer.addCartItem -> consumer.checkout
// (mounted in server/routers.ts under `consumer:`; procedure input schemas in
// server/_core/consumerCommerce.ts). Every step is an authenticatedProcedure;
// auth is via Authorization: Bearer <session token> (server/_core/auth.ts
// accepts the session token as a bearer credential).
//
// SLO budget (validation/consumer_scale_baseline_20261112.md):
//   mutation p95 < 300ms, p99 < 600ms, error rate < 0.1%.

const targetEnvironment = requireEnv("TARGET_ENV");
const consumerBaseUrl = requireEnv("CONSUMER_BASE_URL").replace(/\/$/, "");
const consumerSessionToken = requireEnv("CONSUMER_SESSION_TOKEN");
const runId = requireCorrelationId("RUN_ID");
const verticalId = positiveIntegerEnv("VERTICAL_ID", 1);

assertNonProductionTarget(targetEnvironment, consumerBaseUrl);

const createCartLatency = new Trend("consumer_create_cart_latency_ms", true);
const addItemLatency = new Trend("consumer_add_cart_item_latency_ms", true);
const checkoutLatency = new Trend("consumer_checkout_latency_ms", true);
const flowSuccess = new Rate("consumer_checkout_flow_success_rate");
const flowResponses = new Counter("consumer_checkout_flow_responses_total");

const checkoutRate = positiveIntegerEnv("CHECKOUT_RATE_PER_SECOND", 20);
const checkoutDuration = durationEnv("CHECKOUT_DURATION", "15m");
const preAllocatedVUs = positiveIntegerEnv("PRE_ALLOCATED_VUS", 30);
const maxVUs = positiveIntegerEnv("MAX_VUS", 150);

export const options = {
  discardResponseBodies: false,
  scenarios: {
    checkout_flow: {
      executor: "constant-arrival-rate",
      exec: "checkoutFlow",
      rate: checkoutRate,
      timeUnit: "1s",
      duration: checkoutDuration,
      preAllocatedVUs,
      maxVUs,
      gracefulStop: "30s",
      tags: { scenario: "checkout_flow", run_id: runId },
    },
  },
  thresholds: {
    "http_req_failed{operation:create_cart}": ["rate<0.001"],
    "http_req_failed{operation:add_cart_item}": ["rate<0.001"],
    "http_req_failed{operation:checkout}": ["rate<0.001"],
    "consumer_create_cart_latency_ms{operation:create_cart}": [
      "p(95)<=300",
      "p(99)<=600",
    ],
    "consumer_add_cart_item_latency_ms{operation:add_cart_item}": [
      "p(95)<=300",
      "p(99)<=600",
    ],
    "consumer_checkout_latency_ms{operation:checkout}": [
      "p(95)<=300",
      "p(99)<=600",
    ],
    "consumer_checkout_flow_success_rate{operation:checkout}": ["rate>=0.999"],
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

export function checkoutFlow() {
  const flowId = `${__VU}-${__ITER}`;

  const cart = trpcMutation(
    "consumer.createCart",
    {
      verticalId,
      idempotencyKey: `k6-cart-${runId}-${flowId}`,
    },
    "create_cart",
    createCartLatency,
  );
  const cartId = trpcResultField(cart, "id");
  const cartOk = check(cart, {
    "createCart is HTTP 200": (result) => result.status === 200,
    "createCart returns a cart id": () => cartId !== null,
  });
  flowResponses.add(1, {
    operation: "create_cart",
    status: String(cart.status),
    run_id: runId,
  });
  if (!cartOk || cartId === null) {
    flowSuccess.add(false, { operation: "checkout", run_id: runId });
    sleep(0.01);
    return;
  }

  const item = trpcMutation(
    "consumer.addCartItem",
    {
      cartId,
      name: "k6 resilience item",
      unitPriceMinor: 25000,
      quantity: 1,
      modifiers: [],
    },
    "add_cart_item",
    addItemLatency,
  );
  const itemOk = check(item, {
    "addCartItem is HTTP 200": (result) => result.status === 200,
  });
  flowResponses.add(1, {
    operation: "add_cart_item",
    status: String(item.status),
    run_id: runId,
  });
  if (!itemOk) {
    flowSuccess.add(false, { operation: "checkout", run_id: runId });
    sleep(0.01);
    return;
  }

  const checkout = trpcMutation(
    "consumer.checkout",
    {
      cartId,
      idempotencyKey: `k6-checkout-${runId}-${flowId}`,
      deliveryAddress: "1 K6 Resilience Close, Yaba, Lagos",
      deliveryLat: 6.5095,
      deliveryLng: 3.3711,
    },
    "checkout",
    checkoutLatency,
  );
  const checkoutOk = check(checkout, {
    "checkout is HTTP 200": (result) => result.status === 200,
    "checkout returns a result payload": (result) =>
      trpcSucceeded(result),
  });
  flowResponses.add(1, {
    operation: "checkout",
    status: String(checkout.status),
    run_id: runId,
  });
  flowSuccess.add(checkoutOk, { operation: "checkout", run_id: runId });
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
    [`consumer-checkout-ingress-${runId}-summary.json`]: JSON.stringify(
      summary,
      null,
      2,
    ),
    stdout:
      JSON.stringify({
        resilience_run_id: runId,
        create_cart_p95_ms: metricPercentile(
          summary,
          "consumer_create_cart_latency_ms",
          "p(95)",
        ),
        add_cart_item_p95_ms: metricPercentile(
          summary,
          "consumer_add_cart_item_latency_ms",
          "p(95)",
        ),
        checkout_p95_ms: metricPercentile(
          summary,
          "consumer_checkout_latency_ms",
          "p(95)",
        ),
        checks_passed: summary.root_group.checks,
      }) + "\n",
  };
}

function trpcMutation(path, input, operation, latency) {
  const startedAt = Date.now();
  const response = http.post(
    `${consumerBaseUrl}/api/trpc/${path}`,
    JSON.stringify({ json: input }),
    {
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${consumerSessionToken}`,
        "X-Resilience-Run-Id": runId,
      },
      tags: { operation, run_id: runId },
      timeout: "10s",
    },
  );
  latency.add(response.timings.duration, { operation, run_id: runId });
  if (Date.now() - startedAt > 10000) {
    console.log(`slow ${operation}: run_id=${runId}`);
  }
  return response;
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

function trpcResultField(response, field) {
  if (!trpcSucceeded(response)) return null;
  try {
    const data = response.json().result.data.json;
    if (data && data[field] !== undefined && data[field] !== null) {
      return String(data[field]);
    }
    return null;
  } catch (_) {
    return null;
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
