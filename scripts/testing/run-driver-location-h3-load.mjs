import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const outputDir = process.env.LOAD_OUTPUT_DIR;
const locationUrl = process.env.LOCATION_URL;
const queryUrl = process.env.QUERY_URL;
const internalToken = process.env.INTERNAL_TOKEN;
const driverCount = Number(process.env.DRIVER_COUNT ?? '10000');
const sequence = Number(process.env.LOCATION_SEQUENCE ?? '2');
const locationConcurrency = Number(process.env.LOCATION_CONCURRENCY ?? '10000');
const queryConcurrency = Number(process.env.QUERY_CONCURRENCY ?? '10000');
const maxSockets = Number(process.env.HTTP_MAX_SOCKETS ?? '512');
const requestTimeoutMs = Number(process.env.REQUEST_TIMEOUT_MS ?? '120000');
const zoneId = process.env.ZONE_ID;

if (!outputDir || !locationUrl || !queryUrl || !internalToken || !zoneId) {
  throw new Error('LOAD_OUTPUT_DIR, LOCATION_URL, QUERY_URL, INTERNAL_TOKEN, and ZONE_ID are required');
}
for (const [name, value, limit] of [['DRIVER_COUNT', driverCount, 100000], ['LOCATION_CONCURRENCY', locationConcurrency, driverCount], ['QUERY_CONCURRENCY', queryConcurrency, driverCount], ['HTTP_MAX_SOCKETS', maxSockets, 2048], ['REQUEST_TIMEOUT_MS', requestTimeoutMs, 300000]]) {
  if (!Number.isInteger(value) || value < 1 || value > limit) throw new Error(`${name} must be an integer from 1 to ${limit}`);
}
if (!Number.isInteger(sequence) || sequence < 1) throw new Error('LOCATION_SEQUENCE must be a positive integer');

await mkdir(outputDir, { recursive: true });
const locationEndpoint = new URL(locationUrl);
const queryEndpoint = new URL(queryUrl);
const locationAgent = new http.Agent({ keepAlive: true, maxSockets, maxFreeSockets: Math.min(maxSockets, 128), scheduling: 'lifo' });
const queryAgent = new http.Agent({ keepAlive: true, maxSockets, maxFreeSockets: Math.min(maxSockets, 128), scheduling: 'lifo' });

const pad = (value) => String(value).padStart(12, '0');
const driverId = (index) => 500000 + index;
const sessionId = (index) => `50000000-0000-4000-8000-${pad(index)}`;
const pointFor = (index, drift = 0) => ({
  longitude: Number((3.3300 + ((index - 1) % 125) * 0.0011 + drift).toFixed(6)),
  latitude: Number((6.4700 + (Math.floor((index - 1) / 125) % 80) * 0.0011 + drift).toFixed(6)),
});

function postJson(endpoint, agent, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const request = http.request({
      protocol: endpoint.protocol,
      hostname: endpoint.hostname,
      port: endpoint.port,
      path: `${endpoint.pathname}${endpoint.search}`,
      method: 'POST',
      agent,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'x-internal-service-token': internalToken },
      timeout: requestTimeoutMs,
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        try { resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }); }
        catch { resolve({ status: response.statusCode ?? 0, body: {} }); }
      });
    });
    request.once('timeout', () => request.destroy(new Error('request_timeout')));
    request.once('error', reject);
    request.end(body);
  });
}

async function runBounded(label, total, concurrency, buildRequest) {
  let next = 1;
  const samples = new Array(total);
  const started = performance.now();
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index > total) return;
      const requestStarted = performance.now();
      let status = 0;
      let state = '';
      let error = '';
      try {
        const response = await buildRequest(index);
        status = response.status;
        state = String(response.body.error ?? (response.body.accepted === false ? 'stale' : response.body.projected === true ? 'projected' : response.body.candidate_count ?? 'ok'));
      } catch (caught) {
        error = String(caught?.message ?? caught);
      }
      samples[index - 1] = { index, status, latency_ms: Number((performance.now() - requestStarted).toFixed(3)), state, error };
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsedMs = performance.now() - started;
  await writeFile(join(outputDir, `${label}.json`), `${JSON.stringify(samples)}\n`, 'utf8');
  return { requested: total, concurrency, elapsed_ms: elapsedMs, samples };
}

function summarize(result) {
  const latencies = result.samples.map((sample) => sample.latency_ms).sort((a, b) => a - b);
  const quantile = (q) => latencies[Math.min(latencies.length - 1, Math.max(0, Math.ceil(q * latencies.length) - 1))] ?? null;
  const histogram = (selector) => Object.fromEntries(Object.entries(Object.groupBy(result.samples, selector)).map(([key, value]) => [key, value.length]));
  return {
    requested: result.requested,
    logical_concurrency: result.concurrency,
    transport_socket_cap: maxSockets,
    elapsed_ms: Number(result.elapsed_ms.toFixed(3)),
    throughput_per_second: Number((result.requested / (result.elapsed_ms / 1000)).toFixed(3)),
    min_ms: latencies[0] ?? null,
    p50_ms: quantile(0.5),
    p90_ms: quantile(0.9),
    p95_ms: quantile(0.95),
    p99_ms: quantile(0.99),
    max_ms: latencies.at(-1) ?? null,
    status_counts: histogram((sample) => String(sample.status)),
    outcome_counts: histogram((sample) => sample.state || 'none'),
    transport_errors: result.samples.filter((sample) => sample.error).length,
  };
}

try {
  const [location, query] = await Promise.all([
    runBounded('location_updates', driverCount, locationConcurrency, async (index) => {
      const point = pointFor(index, sequence * 0.00001);
      return postJson(locationEndpoint, locationAgent, {
        driver_user_id: driverId(index), device_session_id: sessionId(index), source_sequence: sequence,
        occurred_at: new Date().toISOString(), latitude: point.latitude, longitude: point.longitude, accuracy_m: 5, integrity_score: 96,
      });
    }),
    runBounded('h3_spatial_queries', driverCount, queryConcurrency, async (index) => {
      const point = pointFor(index, sequence * 0.00001);
      return postJson(queryEndpoint, queryAgent, { zone_id: zoneId, latitude: point.latitude, longitude: point.longitude });
    }),
  ]);
  const summary = { generated_at: new Date().toISOString(), location_updates: summarize(location), h3_spatial_queries: summarize(query) };
  await writeFile(join(outputDir, 'http_summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify(summary)}\n`);
} finally {
  locationAgent.destroy();
  queryAgent.destroy();
}
