import assert from "node:assert/strict";
import { createHmac } from "node:crypto";

const databaseUrl = process.env.TEST_DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL_REQUIRED");
process.env.DATABASE_URL = databaseUrl;
process.env.NODE_ENV = "production";
process.env.INTERNAL_SERVICE_TOKEN = "partner-integration-test-token-0123456789";
process.env.SESSION_SECRET = "partner-integration-session-secret-0123456789";
process.env.JWT_SECRET = "partner-integration-jwt-secret-0123456789";
process.env.OAUTH_SERVER_URL = "https://identity.test";
process.env.PUBLIC_APP_ORIGIN = "https://operator.test";
process.env.BOOTSTRAP_OPERATOR_PASSWORD = "partner-integration-bootstrap-password-0123456789";
process.env.PERMIFY_ENDPOINT = "https://permify.test";
process.env.PERMIFY_AUTH_TOKEN = "partner-integration-permify-token-0123456789";
process.env.OPA_ENDPOINT = "https://opa.test";
process.env.OPA_AUTH_TOKEN = "partner-integration-opa-token-0123456789";
process.env.ALLOWED_ORIGINS = "https://operator.test";
process.env.API_BODY_LIMIT = "1mb";

const { getPool } = await import("../../server/db");
const { ingestPartnerEvent, listPartnerClients, registerPartnerClient, revokePartnerCredential } = await import("../../server/_core/partnerIntegrationStore");

const actor = { id: 9001, tenantId: "tenant-partner-test" };
const issued = await registerPartnerClient(actor, {
  displayName: "Independent routing partner",
  scopes: ["operations.tracking.write", "operations.events.write"],
});
assert.match(issued.apiKey, /^ops_[A-Za-z0-9]{12}\.[A-Za-z0-9_-]{32,}$/);
assert.equal(issued.client.display_name, "Independent routing partner");
assert.deepEqual(issued.credential.scopes, ["operations.tracking.write", "operations.events.write"]);

const rawBody = Buffer.from(JSON.stringify({ latitude: 6.455, longitude: 3.395, source_time: "2026-09-03T12:00:00Z" }));
const secret = issued.apiKey.split(".")[1]!;
const signature = `hmac-sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
const accepted = await ingestPartnerEvent({
  apiKey: issued.apiKey,
  eventType: "operations.tracking.position",
  externalEventId: "position-9f4b2170-0001",
  signature,
  rawBody,
  parsedBody: JSON.parse(rawBody.toString("utf8")),
});
assert.equal(accepted.state, "accepted");
assert.equal(accepted.idempotent, false);
const replay = await ingestPartnerEvent({
  apiKey: issued.apiKey,
  eventType: "operations.tracking.position",
  externalEventId: "position-9f4b2170-0001",
  signature,
  rawBody,
  parsedBody: JSON.parse(rawBody.toString("utf8")),
});
assert.equal(replay.idempotent, true);

await assert.rejects(() => ingestPartnerEvent({
  apiKey: issued.apiKey,
  eventType: "operations.tracking.position",
  externalEventId: "position-9f4b2170-0002",
  signature: "hmac-sha256=00",
  rawBody,
  parsedBody: JSON.parse(rawBody.toString("utf8")),
}), /partner_signature_rejected/);

await assert.rejects(() => ingestPartnerEvent({
  apiKey: issued.apiKey,
  eventType: "operations.work_order.created",
  externalEventId: "order-9f4b2170-0001",
  signature,
  rawBody,
  parsedBody: JSON.parse(rawBody.toString("utf8")),
}), /partner_scope_forbidden/);

const beforeRevocation = await listPartnerClients(actor);
assert.equal(beforeRevocation.length, 1);
assert.equal(beforeRevocation[0]?.credential_prefix, issued.credential.credential_prefix);
await revokePartnerCredential(actor, issued.credential.id);
await assert.rejects(() => ingestPartnerEvent({
  apiKey: issued.apiKey,
  eventType: "operations.tracking.position",
  externalEventId: "position-9f4b2170-0003",
  signature,
  rawBody,
  parsedBody: JSON.parse(rawBody.toString("utf8")),
}), /partner_credential_rejected/);

const pool = await getPool();
const rows = await pool.query("SELECT state::text, count(*)::int AS count FROM integration.inbound_event GROUP BY state");
assert.deepEqual(rows.rows, [{ state: "accepted", count: 1 }]);
await pool.end();
process.stdout.write("Partner integration control test passed.\n");
