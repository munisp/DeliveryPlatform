import { createHmac } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';

const outputDir = process.env.LOAD_OUTPUT_DIR;
const matchUrl = process.env.MATCH_URL;
const paymentUrl = process.env.PAYMENT_URL;
const internalToken = process.env.INTERNAL_TOKEN;
const webhookSecret = process.env.WEBHOOK_SECRET;
const activeTrips = Number(process.env.ACTIVE_TRIPS ?? '5000');
const paymentEvents = Number(process.env.PAYMENT_EVENTS ?? '500');
const matchConcurrency = Number(process.env.MATCH_CONCURRENCY ?? '128');
const paymentConcurrency = Number(process.env.PAYMENT_CONCURRENCY ?? '64');

if (!outputDir || !matchUrl || !paymentUrl || !internalToken || !webhookSecret) {
  throw new Error('LOAD_OUTPUT_DIR, MATCH_URL, PAYMENT_URL, INTERNAL_TOKEN, and WEBHOOK_SECRET are required');
}
if (!Number.isInteger(activeTrips) || activeTrips < 1 || !Number.isInteger(paymentEvents) || paymentEvents < 1) {
  throw new Error('ACTIVE_TRIPS and PAYMENT_EVENTS must be positive integers');
}

await mkdir(outputDir, { recursive: true });

function tripId(index) {
  return `30000000-0000-0000-0000-${String(index).padStart(12, '0')}`;
}

async function runBounded(label, total, concurrency, requestFactory) {
  let nextIndex = 1;
  const samples = [];
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index > total) return;
      const started = performance.now();
      let status = 0;
      let state = '';
      let error = '';
      try {
        const response = await requestFactory(index);
        status = response.status;
        const body = await response.json().catch(() => ({}));
        state = String(body.state ?? body.error ?? '');
      } catch (caught) {
        error = String(caught?.message ?? caught);
      }
      samples.push({ index, status, latency_ms: Number((performance.now() - started).toFixed(3)), state, error });
    }
  };
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  const elapsedMs = performance.now() - started;
  await writeFile(join(outputDir, `${label}.json`), `${JSON.stringify(samples)}\n`, 'utf8');
  return { samples, elapsed_ms: elapsedMs, requested: total, concurrency };
}

const dispatch = await runBounded('dispatch', activeTrips, matchConcurrency, async (index) => fetch(matchUrl, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-internal-service-token': internalToken },
  body: JSON.stringify({ trip_id: tripId(index), idempotency_key: `peak-dispatch-${index}` }),
}));

const payments = await runBounded('payment', paymentEvents, paymentConcurrency, async (index) => {
  const body = JSON.stringify({ event: 'charge.success', data: { id: `peak-payment-event-${index}`, reference: `peak-payment-${index}` } });
  const signature = createHmac('sha512', webhookSecret).update(body).digest('hex');
  return fetch(paymentUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-paystack-signature': signature },
    body,
  });
});

function summarize(result) {
  const sorted = result.samples.map((sample) => sample.latency_ms).sort((a, b) => a - b);
  const quantile = (q) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? null;
  const status = Object.groupBy(result.samples, (sample) => String(sample.status));
  const states = Object.groupBy(result.samples, (sample) => sample.state || 'none');
  return {
    requested: result.requested,
    concurrency: result.concurrency,
    elapsed_ms: Number(result.elapsed_ms.toFixed(3)),
    throughput_per_second: Number((result.requested / (result.elapsed_ms / 1000)).toFixed(3)),
    min_ms: sorted[0] ?? null,
    p50_ms: quantile(0.50),
    p95_ms: quantile(0.95),
    p99_ms: quantile(0.99),
    max_ms: sorted.at(-1) ?? null,
    status_counts: Object.fromEntries(Object.entries(status).map(([key, value]) => [key, value.length])),
    state_counts: Object.fromEntries(Object.entries(states).map(([key, value]) => [key, value.length])),
    transport_errors: result.samples.filter((sample) => sample.error).length,
  };
}

const summary = { dispatch: summarize(dispatch), payment: summarize(payments) };
await writeFile(join(outputDir, 'http_summary.json'), `${JSON.stringify(summary, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(summary));
