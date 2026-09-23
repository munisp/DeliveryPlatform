#!/usr/bin/env node
/**
 * bench.mjs — perf-harness benchmark runner (baseline + after runs).
 *
 * Measures p50/p95/p99 latency (>=200 iterations after a warmup) for:
 *   (a) GET /api/health
 *   (b) hot read paths (perf-audit P0/P1): funds reconciliation snapshot,
 *       analytics dashboard procedures (6 mounts), fare floor / take rate,
 *       driver protection getPolicy, contract defaults, rider verification
 *       status, an OPA-gated protected procedure, campaign send trigger,
 *       council consultations list, and a session-protected request
 *       (auth.me — exercises session UPDATE + resolvePublicUser overhead)
 *   (c) fail-open path with a dependency DOWN (economics.generateMarketReport
 *       against MARKET_ECONOMICS_URL pointing at a dead port)
 *   (d) service-to-service: Go health endpoints, Rust signer /sign
 *       (sequential + 4 parallel), Python lakehouse /health
 *
 * The runner spawns a stub OPA server on 127.0.0.1:8190 (the server under
 * test is booted with OPA_ENDPOINT=http://127.0.0.1:8190, so OPA-gated
 * procedures make a real HTTP policy call per request).
 *
 * Prereqs: server on :3005 (see README), seed loaded, satellites up.
 *
 * Usage:
 *   node scripts/perf/bench.mjs [--out scripts/perf/baseline.json]
 * Env: PERF_BASE_URL (default http://127.0.0.1:3005), PERF_ITERS (200),
 *      PERF_WARMUP (20), PERF_LABEL (baseline|after), PERF_COMMIT.
 */
import { createServer } from "node:http";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const BASE = process.env.PERF_BASE_URL ?? "http://127.0.0.1:3005";
const ITERS = parseInt(process.env.PERF_ITERS ?? "200", 10);
const WARMUP = parseInt(process.env.PERF_WARMUP ?? "20", 10);
const LABEL = process.env.PERF_LABEL ?? "baseline";
const COMMIT = process.env.PERF_COMMIT ?? "604d431";
const INTERNAL_TOKEN = process.env.PERF_INTERNAL_TOKEN ?? "perf-internal-token-0123456789abcdef00";
const OPA_PORT = 8190;
const MARKET = "NG-LAGOS";

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function summarize(samples, errors) {
  const sorted = [...samples].sort((a, b) => a - b);
  const sum = samples.reduce((a, b) => a + b, 0);
  return {
    unit: "ms",
    n: samples.length,
    errors,
    min: sorted.length ? +sorted[0].toFixed(2) : null,
    p50: percentile(sorted, 50) !== null ? +percentile(sorted, 50).toFixed(2) : null,
    p95: percentile(sorted, 95) !== null ? +percentile(sorted, 95).toFixed(2) : null,
    p99: percentile(sorted, 99) !== null ? +percentile(sorted, 99).toFixed(2) : null,
    max: sorted.length ? +sorted[sorted.length - 1].toFixed(2) : null,
    mean: samples.length ? +(sum / samples.length).toFixed(2) : null,
  };
}

let cookie = "";

async function rawFetch(url, opts = {}) {
  const t0 = performance.now();
  const res = await fetch(url, opts);
  await res.arrayBuffer(); // drain
  return { ms: performance.now() - t0, status: res.status, res };
}

async function trpc(path, { input, mutation = false } = {}) {
  const headers = { cookie };
  let url = `${BASE}/api/trpc/${path}?batch=1`;
  let body;
  // When no input is given, OMIT the input field entirely: an explicit
  // JSON null fails `.input(z.object(...).optional())` validators ("expected
  // object, received null"), while an absent input deserializes as
  // undefined and satisfies both no-input and optional-input procedures.
  if (mutation) {
    headers["content-type"] = "application/json";
    body = JSON.stringify({ "0": { json: input ?? null } });
  } else if (input !== undefined) {
    url += `&input=${encodeURIComponent(JSON.stringify({ "0": { json: input } }))}`;
  }
  const t0 = performance.now();
  const res = await fetch(url, {
    method: mutation ? "POST" : "GET",
    headers,
    body,
  });
  const ms = performance.now() - t0;
  const status = res.status;
  let payload = null;
  try {
    payload = await res.json();
  } catch {
    /* counted via status */
  }
  const ok =
    status === 200 &&
    Array.isArray(payload) &&
    payload[0] &&
    payload[0].result &&
    !payload[0].error;
  return { ms, ok, status };
}

async function measure(results, name, fn, { iters = ITERS, warmup = WARMUP, note, countErrorsAsSamples = false } = {}) {
  for (let i = 0; i < warmup; i++) {
    try {
      await fn(i);
    } catch {
      /* warmup errors ignored */
    }
  }
  const samples = [];
  let errors = 0;
  let firstError = null;
  for (let i = 0; i < iters; i++) {
    try {
      const r = await fn(i);
      if (r && r.ok === false) {
        errors++;
        if (!firstError) firstError = `status=${r.status}`;
        if (countErrorsAsSamples) samples.push(r.ms);
      } else {
        samples.push(r.ms);
      }
    } catch (err) {
      errors++;
      if (!firstError) firstError = String(err && err.message ? err.message : err);
    }
  }
  const stats = summarize(samples, errors);
  if (note) stats.note = note;
  if (firstError) stats.firstError = firstError;
  if (errors === iters) stats.allIterationsErrored = true;
  results[name] = stats;
  console.log(
    `[bench] ${name}: p50=${stats.p50}ms p95=${stats.p95}ms p99=${stats.p99}ms n=${stats.n} errors=${errors}${firstError ? ` firstError=${firstError}` : ""}`,
  );
}

async function login() {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: "admin@switchos.local", password: "ChangeMe123!" }),
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  const match = setCookie.match(/([^=;]+=[^;]*)/);
  if (!res.ok || !match) {
    throw new Error(`login failed: ${res.status} ${await res.text()}`);
  }
  cookie = match[1];
  console.log(`[bench] logged in (cookie ${cookie.split("=")[0]})`);
}

function startOpaStub() {
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ result: true }));
    });
  });
  return new Promise((resolvePromise) =>
    server.listen(OPA_PORT, "127.0.0.1", () => {
      console.log(`[bench] OPA stub on 127.0.0.1:${OPA_PORT}`);
      resolvePromise(server);
    }),
  );
}

async function main() {
  const outIdx = process.argv.indexOf("--out");
  const outPath = resolve(
    outIdx !== -1 ? process.argv[outIdx + 1] : `scripts/perf/${LABEL}.json`,
  );

  const opa = await startOpaStub();
  const results = {};

  try {
    await login();

    // ---- (a) health probe ----
    await measure(results, "http.health", () => rawFetch(`${BASE}/api/health`), {
      note: "SLO p95<10ms",
    });

    // ---- (b) hot read paths ----
    const trpcGet = (path, input) => () => trpc(path, { input });

    // analytics dashboard mounts (6 client queries) + funds reconciliation
    await measure(results, "trpc.analytics.summary", trpcGet("analytics.summary"));
    await measure(results, "trpc.analytics.orderStats", trpcGet("analytics.orderStats"));
    await measure(results, "trpc.analytics.driverStats", trpcGet("analytics.driverStats"));
    await measure(results, "trpc.analytics.marketplaceOverview", trpcGet("analytics.marketplaceOverview"));
    await measure(results, "trpc.analytics.revenueTrend", trpcGet("analytics.revenueTrend"));
    await measure(results, "trpc.analytics.ordersByVertical", trpcGet("analytics.ordersByVertical"));
    await measure(results, "trpc.analytics.fundsReconciliation", trpcGet("analytics.fundsReconciliation"), {
      note: "8 parallel full scans + mojaloop leg; SLO p95<150ms. At 604d431 the endpoint 500s: invalid SQL (FILTER after COALESCE, server/db.ts:3779+) — baseline records the defect (latency = time-to-500).",
      countErrorsAsSamples: true,
    });

    // config/policy hot reads
    await measure(results, "trpc.economics.getFareFloor", trpcGet("economics.getFareFloor", { marketId: MARKET }));
    await measure(results, "trpc.economics.getTakeRate", trpcGet("economics.getTakeRate", { marketId: MARKET }));
    await measure(results, "trpc.protection.getPolicy", trpcGet("protection.getPolicy", { marketId: MARKET }));
    await measure(results, "trpc.contractDefaults.get", trpcGet("contractDefaults.getContractDefaults", { marketId: MARKET }));
    await measure(results, "trpc.riderVerification.getMyVerificationStatus", trpcGet("riderVerification.getMyVerificationStatus"));
    await measure(results, "trpc.council.listConsultations", trpcGet("council.listConsultations", {}));

    // OPA-gated protected procedure (analyticsReadProcedure -> requirePolicy -> OPA HTTP call)
    await measure(results, "trpc.opaGated.analyticsSummary", trpcGet("analytics.summary"), {
      note: "explicit OPA-gated sample; every call hits the OPA stub over HTTP at 604d431",
    });

    // session-protected request: session UPDATE + resolvePublicUser overhead
    await measure(results, "trpc.session.authMe", trpcGet("auth.me"), {
      note: "measures session middleware (last_seen UPDATE + resolvePublicUser) on every authed call",
    });

    // campaign send trigger
    await measure(
      results,
      "trpc.campaign.sendSingleUser",
      (i) =>
        trpc("localCommerceSuperGateway.merchantGrowthCampaign", {
          mutation: true,
          input: {
            campaignId: 1,
            activate: true,
            audienceMode: "single_user",
            userId: 5000 + (i % 100),
            channel: "email",
            idempotencyKey: `bench-${LABEL}-single-${i}-${Date.now()}`,
          },
        }),
      { iters: 50, warmup: 5 },
    );
    await measure(
      results,
      "trpc.campaign.sendFullAudience",
      (i) =>
        trpc("localCommerceSuperGateway.merchantGrowthCampaign", {
          mutation: true,
          input: {
            campaignId: 1,
            activate: true,
            audienceMode: "full_audience",
            idempotencyKey: `bench-${LABEL}-full-${i}-${Date.now()}`,
          },
        }),
      { iters: 3, warmup: 0, note: "unbounded N+1: 10k sequential per-user sends; few iterations by design" },
    );

    // ---- (c) fail-open with dependency DOWN (MARKET_ECONOMICS_URL dead) ----
    await measure(
      results,
      "failopen.economics.generateMarketReport",
      () =>
        trpc("economics.generateMarketReport", {
          mutation: true,
          input: { marketId: MARKET, periodStart: "2026-08-01", periodEnd: "2026-09-01" },
        }),
      {
        note: "market-economics dep DOWN (conn refused on :8110); breaker opens after 5 failures then ~0ms; SLO ~0 added latency",
      },
    );

    // ---- (d) service-to-service ----
    await measure(results, "svc.go.notificationDispatcher.health", () =>
      rawFetch("http://127.0.0.1:8099/health"),
    );
    await measure(results, "svc.go.safetyEngine.health", () =>
      rawFetch("http://127.0.0.1:8107/health"),
    );
    await measure(results, "svc.rust.signer.healthz", () =>
      rawFetch("http://127.0.0.1:8109/healthz"),
    );
    const signBody = JSON.stringify({ payload: `perf-bench-payload-${"x".repeat(256)}` });
    const signInit = {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-internal-service-token": INTERNAL_TOKEN,
      },
      body: signBody,
    };
    await measure(results, "svc.rust.signer.signSequential", () =>
      rawFetch("http://127.0.0.1:8109/sign", signInit),
    );
    await measure(
      results,
      "svc.rust.signer.signParallel4",
      async () => {
        const t0 = performance.now();
        await Promise.all(
          [0, 1, 2, 3].map(() => rawFetch("http://127.0.0.1:8109/sign", signInit)),
        );
        return { ms: performance.now() - t0, ok: true };
      },
      { iters: 50, warmup: 5, note: "wall time per batch of 4 parallel /sign; tiny_http is single-threaded at 604d431" },
    );
    await measure(results, "svc.python.lakehouse.health", () =>
      rawFetch("http://127.0.0.1:8007/health"),
    );
  } finally {
    opa.close();
  }

  const doc = {
    meta: {
      label: LABEL,
      commit: COMMIT,
      generatedAt: new Date().toISOString(),
      baseUrl: BASE,
      iterations: ITERS,
      warmup: WARMUP,
      node: process.version,
      platform: `${process.platform}/${process.arch}`,
      seedVolumes: {
        users: 10000, drivers: 1000, rider_verifications: 2000,
        verification_case: 5000, fare_quote: 50000, ride_trip: 50000,
        match_attempt: 20000, driver_offer: 20000, orders: 20000,
        transactions: 20000, rider_trips: 20000,
        offer_economics_breakdowns: 10000, sos_events: 2500,
        passenger_manifests: 2500, trip_safety_signals: 5000,
        council_members: 15, consultation_objects: 50,
        consultation_responses: 150, deactivation_cases: 1000,
        deactivation_appeals: 200, markets: 5, driver_applications: 501,
        work_record_exports: 500,
      },
      slo: {
        readP95Ms: 150, hotCachedP95Ms: 20, mutationP95Ms: 300,
        serviceToServiceP95Ms: 50, healthP95Ms: 10, failOpenAddedMs: 0,
      },
    },
    benchmarks: results,
  };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(doc, null, 2));
  console.log(`[bench] wrote ${outPath}`);
}

main().catch((err) => {
  console.error("[bench] FAILED:", err);
  process.exit(1);
});
