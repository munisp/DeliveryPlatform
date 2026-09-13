import type { Request, Response } from "express";
import { Pool } from "pg";
import { ENV } from "./env";
import type { SessionUser } from "./trpc";

const ALLOWED_SCOPES = new Set(["admin", "customer", "merchant", "driver"]);
const POLL_MS = 5_000;
const HEARTBEAT_MS = 15_000;
const MAX_STREAM_MS = 55 * 60 * 1000;
let pool: Pool | null = null;

function db() {
  if (!pool) {
    pool = new Pool({
      connectionString: ENV.databaseUrl,
      ssl: ENV.isProduction && !ENV.databaseUrl.includes("sslmode=disable") ? { rejectUnauthorized: true, ...(ENV.databaseSslCa ? { ca: ENV.databaseSslCa } : {}) } : false,
      max: 4,
      application_name: "delivery-realtime-tracking",
    });
  }
  return pool;
}

export type TrackingDelta = {
  cursor: number;
  orderId: number;
  observedAt: string;
  latitude: number;
  longitude: number;
  accuracyM: number | null;
  etaSeconds: number | null;
};

function actorScope(user: SessionUser, requested: string) {
  if (!ALLOWED_SCOPES.has(requested)) throw new Error("tracking_scope_invalid");
  const role = `${user.role ?? ""}`.toLowerCase();
  if (requested === "admin" && !["admin", "platform_admin", "super_admin"].includes(role)) {
    throw new Error("tracking_scope_denied");
  }
  return requested;
}

export async function listRoleScopedTrackingDeltas(input: { user: SessionUser; scope: string; cursor: number; limit?: number }) {
  const cursor = Number.isSafeInteger(input.cursor) && input.cursor >= 0 ? input.cursor : 0;
  const scope = actorScope(input.user, input.scope);
  const result = await db().query(
    "SELECT cursor,order_id,observed_at,latitude,longitude,accuracy_m,eta_seconds FROM operations.list_role_scoped_delivery_tracking($1,$2,$3,$4)",
    [input.user.id, scope, cursor, Math.min(250, Math.max(1, input.limit ?? 100))],
  );
  return result.rows.map((row) => ({
    cursor: Number(row.cursor), orderId: Number(row.order_id), observedAt: new Date(row.observed_at).toISOString(),
    latitude: Number(row.latitude), longitude: Number(row.longitude), accuracyM: row.accuracy_m === null ? null : Number(row.accuracy_m),
    etaSeconds: row.eta_seconds === null ? null : Number(row.eta_seconds),
  })) satisfies TrackingDelta[];
}

function sse(res: Response, event: string, body: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(body)}\n\n`);
}

export async function openRoleScopedTrackingStream(req: Request, res: Response, user: SessionUser) {
  const scope = actorScope(user, req.params.scope);
  const parsed = Number(req.query.cursor ?? 0);
  let cursor = Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
  let closed = false;
  let inFlight = false;
  res.status(200).set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();
  sse(res, "ready", { scope, cursor, retry_after_ms: POLL_MS });
  const tick = async () => {
    if (closed || inFlight) return;
    inFlight = true;
    try {
      const deltas = await listRoleScopedTrackingDeltas({ user, scope, cursor, limit: 250 });
      if (deltas.length) {
        cursor = deltas[deltas.length - 1].cursor;
        sse(res, "tracking.delta", { cursor, deltas });
      }
    } catch {
      sse(res, "error", { code: "tracking_stream_unavailable" });
    } finally { inFlight = false; }
  };
  await tick();
  const poll = setInterval(() => void tick(), POLL_MS);
  const heartbeat = setInterval(() => sse(res, "heartbeat", { cursor }), HEARTBEAT_MS);
  const expiry = setTimeout(() => { sse(res, "rotate", { cursor }); res.end(); }, MAX_STREAM_MS);
  req.on("close", () => { closed = true; clearInterval(poll); clearInterval(heartbeat); clearTimeout(expiry); });
}
