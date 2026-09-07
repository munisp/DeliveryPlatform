/**
 * LongCat Sustained Load Test — Real Ollama Instance
 *
 * Exercises all three LongCat workspaces against a live local Ollama model
 * under sustained concurrent load, measuring latency percentiles and SLO compliance.
 *
 * Run with: npx tsx tests/longcat.loadtest.ts
 */

const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";
const MODEL = process.env.OLLAMA_MODEL || "qwen2.5:0.5b";
const CONCURRENCY = 5;
const TOTAL_REQUESTS = 30; // 10 per workspace type
const SLO_P95_MS = 30_000; // 30s P95 target for CPU-only inference
const SLO_P99_MS = 60_000; // 60s P99 target
const TIMEOUT_MS = 90_000;

type RequestResult = {
  workspace: string;
  latencyMs: number;
  success: boolean;
  executionMode: string;
  error?: string;
};

async function generateStructured(prompt: string): Promise<{ data: any; latencyMs: number; error?: string }> {
  const start = Date.now();
  try {
    const response = await fetch(`${OLLAMA_URL}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: MODEL, prompt, stream: false, format: "json" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const latencyMs = Date.now() - start;
    if (!response.ok) {
      return { data: null, latencyMs, error: `HTTP ${response.status}` };
    }
    const payload = await response.json() as { response?: string };
    try {
      const parsed = JSON.parse(payload.response || "{}");
      return { data: parsed, latencyMs };
    } catch {
      return { data: null, latencyMs, error: "JSON parse failure" };
    }
  } catch (err: any) {
    return { data: null, latencyMs: Date.now() - start, error: err.message };
  }
}

const CONSUMER_PROMPT = [
  "You are LongCat Concierge for a food delivery platform.",
  "Return JSON only with keys conversation_goal, personalized_recommendations, operator_script, accessibility_note, next_actions, memory_grounding, channel_actions.",
  "Each list must contain 3 concise items.",
  "Workspace snapshot: staffed_lines=4, active_calls=6, substitution_cases=2.",
  "Call flows: inbound-order | callback-request.",
  "Current recommended action: Route overflow to assisted ordering queue.",
].join("\n");

const MERCHANT_PROMPT = [
  "You are LongCat Merchant Copilot for a restaurant and merchant growth workspace.",
  "Return JSON only with keys market_brief, demand_forecast, menu_actions, channel_actions, financial_watchouts, benchmark_summary, benchmark_actions.",
  "Each list must contain 3 concise items.",
  "Workspace snapshot: activated_channels=3, branded_storefronts=1, partner_channels=2.",
  "Channel mix: owned-storefront | marketplace-A | marketplace-B.",
  "Current recommended action: Increase owned-channel conversion before adding surfaces.",
].join("\n");

const DISPATCH_PROMPT = [
  "You are LongCat Dispatch Intelligence for a high-volume delivery marketplace.",
  "Return JSON only with keys dispatch_brief, batching_strategy, rider_guidance, risk_flags, telemetry_summary, recommended_reallocations.",
  "Each list must contain 3 concise items.",
  "Workspace snapshot: online_drivers=12, trip_radar_candidates=8, airport_ready_drivers=3.",
  "Supply queue: Alice/zone-A/online/dispatch | Bob/zone-B/online/hold | Charlie/airport/online/reserve.",
  "Current recommended action: Rebalance airport reserve after peak.",
].join("\n");

async function runLoadTest(): Promise<void> {
  console.log("=== LongCat Sustained Load Test ===");
  console.log(`Ollama: ${OLLAMA_URL} | Model: ${MODEL}`);
  console.log(`Concurrency: ${CONCURRENCY} | Total requests: ${TOTAL_REQUESTS}`);
  console.log(`SLO targets: P95 < ${SLO_P95_MS}ms, P99 < ${SLO_P99_MS}ms`);
  console.log("");

  // Warm up the model
  console.log("Warming up model...");
  await generateStructured("Return JSON: {\"status\":\"ready\"}");
  console.log("Warm-up complete.\n");

  const prompts = [
    ...Array(10).fill(null).map(() => ({ workspace: "consumer", prompt: CONSUMER_PROMPT })),
    ...Array(10).fill(null).map(() => ({ workspace: "merchant", prompt: MERCHANT_PROMPT })),
    ...Array(10).fill(null).map(() => ({ workspace: "dispatch", prompt: DISPATCH_PROMPT })),
  ];

  // Shuffle for realistic mixed load
  for (let i = prompts.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [prompts[i], prompts[j]] = [prompts[j], prompts[i]];
  }

  const results: RequestResult[] = [];
  let completed = 0;

  // Process with bounded concurrency
  const queue = [...prompts];
  const workers = Array.from({ length: CONCURRENCY }, async () => {
    while (queue.length > 0) {
      const item = queue.shift()!;
      const { data, latencyMs, error } = await generateStructured(item.prompt);
      completed++;
      const success = data !== null && !error;
      const executionMode = success ? "llm" : "timeout_or_error";
      results.push({ workspace: item.workspace, latencyMs, success, executionMode, error });
      process.stdout.write(`\r  Progress: ${completed}/${TOTAL_REQUESTS} (${item.workspace} ${latencyMs}ms ${success ? "OK" : "FAIL"})`);
    }
  });

  const loadStart = Date.now();
  await Promise.all(workers);
  const totalDuration = Date.now() - loadStart;
  console.log("\n");

  // Calculate metrics
  const latencies = results.map((r) => r.latencyMs).sort((a, b) => a - b);
  const successCount = results.filter((r) => r.success).length;
  const failCount = results.filter((r) => !r.success).length;

  const p50 = latencies[Math.floor(latencies.length * 0.5)];
  const p75 = latencies[Math.floor(latencies.length * 0.75)];
  const p90 = latencies[Math.floor(latencies.length * 0.9)];
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  const p99 = latencies[Math.floor(latencies.length * 0.99)];
  const avg = Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  const min = latencies[0];
  const max = latencies[latencies.length - 1];

  // Per-workspace breakdown
  const byWorkspace: Record<string, { latencies: number[]; success: number; fail: number }> = {};
  for (const r of results) {
    if (!byWorkspace[r.workspace]) byWorkspace[r.workspace] = { latencies: [], success: 0, fail: 0 };
    byWorkspace[r.workspace].latencies.push(r.latencyMs);
    if (r.success) byWorkspace[r.workspace].success++;
    else byWorkspace[r.workspace].fail++;
  }

  // SLO assessment
  const p95Pass = p95 <= SLO_P95_MS;
  const p99Pass = p99 <= SLO_P99_MS;
  const availabilityPct = ((successCount / TOTAL_REQUESTS) * 100).toFixed(1);

  // Report
  console.log("=== LOAD TEST RESULTS ===\n");
  console.log(`Total duration: ${(totalDuration / 1000).toFixed(1)}s`);
  console.log(`Requests: ${TOTAL_REQUESTS} (${successCount} success, ${failCount} failed)`);
  console.log(`Availability: ${availabilityPct}%`);
  console.log(`Throughput: ${(TOTAL_REQUESTS / (totalDuration / 1000)).toFixed(2)} req/s\n`);

  console.log("--- Latency Percentiles ---");
  console.log(`  Min:  ${min}ms`);
  console.log(`  P50:  ${p50}ms`);
  console.log(`  P75:  ${p75}ms`);
  console.log(`  P90:  ${p90}ms`);
  console.log(`  P95:  ${p95}ms  ${p95Pass ? "✓ PASS" : "✗ FAIL"} (target: <${SLO_P95_MS}ms)`);
  console.log(`  P99:  ${p99}ms  ${p99Pass ? "✓ PASS" : "✗ FAIL"} (target: <${SLO_P99_MS}ms)`);
  console.log(`  Max:  ${max}ms`);
  console.log(`  Avg:  ${avg}ms\n`);

  console.log("--- Per-Workspace Breakdown ---");
  for (const [ws, data] of Object.entries(byWorkspace)) {
    const sorted = data.latencies.sort((a, b) => a - b);
    const wsAvg = Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length);
    const wsP95 = sorted[Math.floor(sorted.length * 0.95)];
    console.log(`  ${ws}: avg=${wsAvg}ms p95=${wsP95}ms success=${data.success}/${data.success + data.fail}`);
  }

  console.log("\n--- SLO Compliance ---");
  console.log(`  P95 < ${SLO_P95_MS}ms: ${p95Pass ? "PASS ✓" : "FAIL ✗"} (actual: ${p95}ms)`);
  console.log(`  P99 < ${SLO_P99_MS}ms: ${p99Pass ? "PASS ✓" : "FAIL ✗"} (actual: ${p99}ms)`);
  console.log(`  Availability > 95%: ${Number(availabilityPct) >= 95 ? "PASS ✓" : "FAIL ✗"} (actual: ${availabilityPct}%)`);

  // Write results to file for reporting
  const report = {
    timestamp: new Date().toISOString(),
    config: { ollamaUrl: OLLAMA_URL, model: MODEL, concurrency: CONCURRENCY, totalRequests: TOTAL_REQUESTS },
    summary: { totalDurationMs: totalDuration, successCount, failCount, availabilityPct: Number(availabilityPct), throughputReqPerSec: Number((TOTAL_REQUESTS / (totalDuration / 1000)).toFixed(2)) },
    latency: { min, p50, p75, p90, p95, p99, max, avg },
    slo: { p95Target: SLO_P95_MS, p95Actual: p95, p95Pass, p99Target: SLO_P99_MS, p99Actual: p99, p99Pass, availabilityTarget: 95, availabilityActual: Number(availabilityPct) },
    perWorkspace: byWorkspace,
    rawResults: results,
  };

  const fs = await import("fs");
  fs.writeFileSync(new URL("./loadtest-results.json", import.meta.url), JSON.stringify(report, null, 2));
  console.log("\n✓ Results saved to tests/loadtest-results.json");
}

runLoadTest().catch(console.error);
