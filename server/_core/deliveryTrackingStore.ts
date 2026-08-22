import { Pool } from "pg";
import { ENV } from "./env";

let pool: Pool | null = null;
function db() {
  if (!ENV.databaseUrl) throw new Error("delivery_tracking_database_unconfigured");
  if (!pool) pool = new Pool({ connectionString: ENV.databaseUrl, ssl: ENV.isProduction && !ENV.databaseUrl.includes("sslmode=disable") ? { rejectUnauthorized: true, ...(ENV.databaseSslCa ? { ca: ENV.databaseSslCa } : {}) } : false, max: 5 });
  return pool;
}

export async function recordDeliveryLocation(input: { deliveryId: string; tenantId: number; driverOperatorId: number; latitude: number; longitude: number; accuracyMeters: number | null; occurredAt: string }) {
  if (!Number.isFinite(input.latitude) || !Number.isFinite(input.longitude) || Math.abs(input.latitude) > 90 || Math.abs(input.longitude) > 180) throw new Error("invalid_delivery_location");
  await db().query(`INSERT INTO delivery_tracking_events (delivery_id, tenant_id, driver_operator_id, latitude, longitude, accuracy_meters, occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [input.deliveryId, input.tenantId, input.driverOperatorId, input.latitude, input.longitude, input.accuracyMeters, input.occurredAt]);
}

export async function getLatestDeliveryLocation(input: { deliveryId: string; tenantId: number }) {
  const result = await db().query(`SELECT latitude, longitude, accuracy_meters, occurred_at FROM delivery_tracking_events WHERE delivery_id=$1 AND tenant_id=$2 ORDER BY occurred_at DESC LIMIT 1`, [input.deliveryId, input.tenantId]);
  const row = result.rows[0];
  return row ? { latitude: Number(row.latitude), longitude: Number(row.longitude), accuracyMeters: row.accuracy_meters === null ? null : Number(row.accuracy_meters), occurredAt: new Date(row.occurred_at).toISOString() } : null;
}

export async function recordProofOfDelivery(input: { deliveryId: string; tenantId: number; driverOperatorId: number; objectKey: string; contentType: string; sha256Hex: string; capturedAt: string }) {
  if (!/^[a-f0-9]{64}$/.test(input.sha256Hex) || !["image/jpeg", "image/png", "image/webp"].includes(input.contentType)) throw new Error("invalid_delivery_proof");
  await db().query(`INSERT INTO delivery_proofs (delivery_id,tenant_id,driver_operator_id,object_key,content_type,sha256_hex,captured_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`, [input.deliveryId,input.tenantId,input.driverOperatorId,input.objectKey,input.contentType,input.sha256Hex,input.capturedAt]);
}

export async function getFinancialTopology() {
  const result = await db().query(`SELECT payer_fsp, payee_fsp, currency, COUNT(*)::int AS transfers, SUM(amount_minor)::text AS amount_minor FROM mojaloop_transfers GROUP BY payer_fsp,payee_fsp,currency ORDER BY transfers DESC LIMIT 100`);
  return result.rows.map((row) => ({ payer: String(row.payer_fsp), payee: String(row.payee_fsp), currency: String(row.currency), transfers: Number(row.transfers), amountMinor: String(row.amount_minor) }));
}
