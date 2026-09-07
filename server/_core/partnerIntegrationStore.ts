import { createHmac, randomBytes, scryptSync, timingSafeEqual } from "crypto";
import { getPool } from "../db";
import type { OpsActor } from "./logisticsOperationsStore";

const allowedScopes = new Set(["operations.jobs.read", "operations.jobs.write", "operations.tracking.write", "operations.events.write"]);

type PartnerCredential = {
  credentialId: string;
  clientId: string;
  tenantId: string;
  clientState: string;
  scopes: string[];
  secret: string;
};

function text(value: unknown, field: string, max: number) {
  const normalized = `${value ?? ""}`.trim();
  if (!normalized || normalized.length > max) throw new Error(`invalid_${field}`);
  return normalized;
}

function uuid(value: unknown, field: string) {
  const normalized = text(value, field, 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) throw new Error(`invalid_${field}`);
  return normalized;
}

function tenant(actor: OpsActor) {
  const value = actor.tenantId.trim();
  if (!value || value.length > 128) throw new Error("tenant_context_required");
  return value;
}

function hexDigest(value: Buffer | string) { return createHmac("sha256", "partner-event-digest-v1").update(value).digest(); }

function keyParts(value: unknown) {
  const key = text(value, "api_key", 512);
  const [prefix, secret, ...extra] = key.split(".");
  if (extra.length || !/^ops_[A-Za-z0-9]{12}$/.test(prefix ?? "") || !secret || secret.length < 32) throw new Error("invalid_api_key");
  return { key, prefix: prefix!, secret };
}

function keyDigest(secret: string, salt: Buffer) { return scryptSync(secret, salt, 32, { N: 16_384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }); }

function subtleEqual(left: Buffer, right: Buffer) { return left.length === right.length && timingSafeEqual(left, right); }

function normalizedScopes(value: unknown) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 24) throw new Error("invalid_partner_scopes");
  const scopes = [...new Set(value.map((scope) => text(scope, "partner_scope", 96)))];
  if (scopes.some((scope) => !allowedScopes.has(scope))) throw new Error("unsupported_partner_scope");
  return scopes;
}

export async function registerPartnerClient(actor: OpsActor, input: { displayName: unknown; scopes: unknown; callbackSecretRef?: unknown; expiresAt?: unknown }) {
  const tenantId = tenant(actor);
  const displayName = text(input.displayName, "partner_display_name", 160);
  const scopes = normalizedScopes(input.scopes);
  const callbackSecretRef = input.callbackSecretRef === undefined || input.callbackSecretRef === null ? null : text(input.callbackSecretRef, "callback_secret_ref", 160);
  const expiresAt = input.expiresAt === undefined || input.expiresAt === null ? null : new Date(`${input.expiresAt}`);
  if (expiresAt && (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= Date.now())) throw new Error("invalid_credential_expiry");
  const prefix = `ops_${randomBytes(9).toString("base64url").replace(/[^A-Za-z0-9]/g, "A").slice(0, 12)}`;
  const secret = randomBytes(32).toString("base64url");
  const salt = randomBytes(16);
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const application = await client.query(`INSERT INTO integration.client_application (tenant_id, display_name, allowed_scopes, callback_secret_ref, created_by)
      VALUES ($1,$2,$3::text[],$4,$5) RETURNING id::text, display_name, client_state::text, allowed_scopes, created_at`, [tenantId, displayName, scopes, callbackSecretRef, actor.id]);
    const applicationId = application.rows[0].id as string;
    const credential = await client.query(`INSERT INTO integration.api_credential (client_application_id, credential_prefix, secret_salt, secret_digest, scopes, expires_at, created_by)
      VALUES ($1::uuid,$2,$3,$4,$5::text[],$6,$7) RETURNING id::text, credential_prefix, scopes, expires_at, created_at`, [applicationId, prefix, salt, keyDigest(secret, salt), scopes, expiresAt, actor.id]);
    await client.query("COMMIT");
    return { client: application.rows[0], credential: credential.rows[0], apiKey: `${prefix}.${secret}` };
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function listPartnerClients(actor: OpsActor) {
  const pool = await getPool();
  const result = await pool.query(`SELECT a.id::text, a.display_name, a.client_state::text, a.allowed_scopes, a.created_at,
      c.id::text AS credential_id, c.credential_prefix, c.scopes, c.expires_at, c.revoked_at, c.last_used_at
    FROM integration.client_application a LEFT JOIN integration.api_credential c ON c.client_application_id=a.id
    WHERE a.tenant_id=$1 ORDER BY a.created_at DESC, c.created_at DESC LIMIT 200`, [tenant(actor)]);
  return result.rows;
}

export async function revokePartnerCredential(actor: OpsActor, credentialId: unknown) {
  const id = uuid(credentialId, "credential_id");
  const pool = await getPool();
  const result = await pool.query(`UPDATE integration.api_credential c SET revoked_at=NOW()
    FROM integration.client_application a WHERE c.id=$1::uuid AND c.client_application_id=a.id AND a.tenant_id=$2 AND c.revoked_at IS NULL
    RETURNING c.id::text, c.revoked_at`, [id, tenant(actor)]);
  if (result.rowCount !== 1) throw new Error("partner_credential_not_found");
  return result.rows[0];
}

async function authenticateApiKey(value: unknown): Promise<PartnerCredential> {
  const parts = keyParts(value);
  const pool = await getPool();
  const result = await pool.query(`SELECT c.id::text AS credential_id, a.id::text AS client_id, a.tenant_id, a.client_state::text, c.scopes, c.secret_salt, c.secret_digest
    FROM integration.api_credential c JOIN integration.client_application a ON a.id=c.client_application_id
    WHERE c.credential_prefix=$1 AND c.revoked_at IS NULL AND c.not_before<=NOW() AND (c.expires_at IS NULL OR c.expires_at>NOW())`, [parts.prefix]);
  if (result.rowCount !== 1) throw new Error("partner_credential_rejected");
  const row = result.rows[0];
  if (row.client_state !== "active" || !subtleEqual(keyDigest(parts.secret, row.secret_salt), row.secret_digest)) throw new Error("partner_credential_rejected");
  await pool.query("UPDATE integration.api_credential SET last_used_at=NOW() WHERE id=$1::uuid", [row.credential_id]);
  return { credentialId: row.credential_id, clientId: row.client_id, tenantId: row.tenant_id, clientState: row.client_state, scopes: row.scopes, secret: parts.secret };
}

function eventScope(eventType: string) {
  if (eventType === "operations.work_order.created") return "operations.jobs.write";
  if (eventType === "operations.tracking.position") return "operations.tracking.write";
  return "operations.events.write";
}

export async function ingestPartnerEvent(input: { apiKey: unknown; eventType: unknown; externalEventId: unknown; signature: unknown; rawBody: Buffer; parsedBody: unknown }) {
  const eventType = text(input.eventType, "partner_event_type", 96);
  if (!/^[a-z][a-z0-9_.-]{2,95}$/.test(eventType)) throw new Error("invalid_partner_event_type");
  const externalEventId = text(input.externalEventId, "external_event_id", 160);
  const credential = await authenticateApiKey(input.apiKey);
  const requiredScope = eventScope(eventType);
  if (!credential.scopes.includes(requiredScope)) throw new Error("partner_scope_forbidden");
  const signature = text(input.signature, "partner_signature", 128);
  const expected = `hmac-sha256=${createHmac("sha256", credential.secret).update(input.rawBody).digest("hex")}`;
  if (!subtleEqual(Buffer.from(signature), Buffer.from(expected))) throw new Error("partner_signature_rejected");
  if (!input.parsedBody || typeof input.parsedBody !== "object" || Array.isArray(input.parsedBody)) throw new Error("invalid_partner_event_payload");
  const pool = await getPool();
  const payload = input.parsedBody as Record<string, unknown>;
  const result = await pool.query(`INSERT INTO integration.inbound_event
      (client_application_id, credential_id, event_type, external_event_id, payload_digest, payload, signature_version, state)
    VALUES ($1::uuid,$2::uuid,$3,$4,$5,$6::jsonb,'hmac-sha256-v1','accepted')
    ON CONFLICT (client_application_id, external_event_id) DO NOTHING
    RETURNING id::text, correlation_id::text, state::text, received_at`,
    [credential.clientId, credential.credentialId, eventType, externalEventId, hexDigest(input.rawBody), JSON.stringify(payload)]);
  if (result.rowCount === 0) {
    const existing = await pool.query(`SELECT id::text, correlation_id::text, state::text, received_at FROM integration.inbound_event
      WHERE client_application_id=$1::uuid AND external_event_id=$2`, [credential.clientId, externalEventId]);
    return { ...existing.rows[0], idempotent: true };
  }
  return { ...result.rows[0], idempotent: false };
}

export function partnerErrorStatus(error: unknown) {
  const code = error instanceof Error ? error.message : "partner_integration_error";
  if (code.includes("rejected") || code.includes("forbidden")) return { status: 401, code };
  if (code.includes("not_found")) return { status: 404, code };
  if (code.startsWith("invalid_") || code.includes("scope")) return { status: 400, code };
  if (code.includes("duplicate")) return { status: 409, code: "partner_event_duplicate" };
  return { status: 503, code: "partner_integration_unavailable" };
}
