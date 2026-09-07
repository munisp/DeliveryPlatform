import http from 'k6/http';
import { check, sleep } from 'k6';

const target = __ENV.RECEIVER_URL || '';
const token = __ENV.ALERTMANAGER_WEBHOOK_TOKEN || '';
if (!/^https:\/\/(127\.0\.0\.1|localhost|[a-z0-9.-]+\.resilience-test\.svc)(?::\d+)?\//.test(target) || token.length < 32 || __ENV.CONFIRM_NON_PRODUCTION !== 'true') {
  throw new Error('requires confirmed non-production receiver URL and test-only credential');
}
export const options = { scenarios: { alert_storm: { executor: 'ramping-arrival-rate', startRate: 10, timeUnit: '1s', preAllocatedVUs: 25, maxVUs: 100, stages: [{ target: 100, duration: '30s' }, { target: 250, duration: '60s' }, { target: 0, duration: '10s' }] } }, thresholds: { http_req_failed: ['rate<0.01'], http_req_duration: ['p(95)<500'], 'checks{check:accepted_or_idempotent}': ['rate==1'] } };
export default function () {
  const id = `${__VU}-${__ITER}`;
  const payload = JSON.stringify({ status: 'firing', alerts: [{ status: 'firing', fingerprint: `k6-invariant-${id}`, labels: { alertname: 'ResilienceInvariantProbeFailed', severity: 'critical', namespace: 'resilience-test', circuit_breaker: 'open', 'resilience.delivery-platform.io/environment': 'non-production' } }] });
  const response = http.post(`${target.replace(/\/$/, '')}/v1/alertmanager/open`, payload, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, tags: { operation: 'circuit_breaker_alert' } });
  check(response, { accepted_or_idempotent: (r) => r.status === 202 });
  sleep(0.01);
}
