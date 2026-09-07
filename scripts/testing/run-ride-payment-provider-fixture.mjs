import { createServer } from 'node:http';

const port = Number(process.env.PROVIDER_FIXTURE_PORT ?? '8123');
const expectedToken = process.env.PAYMENT_PROVIDER_API_KEY;
if (!expectedToken) throw new Error('PAYMENT_PROVIDER_API_KEY is required');

function send(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

const server = createServer((request, response) => {
  const authorization = request.headers.authorization;
  if (authorization !== `Bearer ${expectedToken}`) {
    send(response, 401, { status: false, message: 'unauthorized' });
    return;
  }
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`);
  const segments = url.pathname.split('/').filter(Boolean);
  if (request.method === 'GET' && segments.length === 3 && segments[0] === 'transaction' && segments[1] === 'verify') {
    const reference = decodeURIComponent(segments[2]);
    const suffix = Number(reference.replace('peak-payment-', ''));
    if (!Number.isInteger(suffix) || suffix < 1) {
      send(response, 404, { status: false, message: 'not found' });
      return;
    }
    send(response, 200, { status: true, data: { id: `fixture-collection-${suffix}`, reference, status: 'success', amount: 120000, currency: 'NGN', paid_at: '2026-09-03T19:00:00Z', split: { split_code: 'fixture-split' } } });
    return;
  }
  if (request.method === 'POST' && url.pathname === '/transfer') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      const payload = JSON.parse(body || '{}');
      send(response, 200, { status: true, data: { reference: payload.reference, status: 'success' } });
    });
    return;
  }
  if (request.method === 'GET' && segments.length === 3 && segments[0] === 'transfer' && segments[1] === 'verify') {
    const reference = decodeURIComponent(segments[2]);
    send(response, 200, { status: true, data: { id: `fixture-transfer-${reference}`, reference, status: 'success', amount: 80000, currency: 'NGN', completed_at: '2026-09-03T19:00:00Z' } });
    return;
  }
  send(response, 404, { status: false, message: 'not found' });
});

server.listen(port, '127.0.0.1', () => console.log(`payment fixture listening on ${port}`));
