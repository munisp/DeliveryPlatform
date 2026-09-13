import type { Request, Response } from "express";
import { Client, Pool } from "pg";
import { ENV } from "./env";
import type { SessionUser } from "./trpc";

const ALLOWED_SCOPES = new Set(["admin", "customer", "merchant", "driver", "me"]);
const RESYNC_MS = 60_000;
const HEARTBEAT_MS = 15_000;
const MAX_STREAM_MS = 55 * 60 * 1000;
const TRACKING_DELTA_CHANNEL = "delivery_tracking_delta";
const NOTIFIER_RECONNECT_MS = 5_000;
let pool: Pool | null = null;
let notificationClient: Client | null = null;
let notificationStart: Promise<void> | null = null;
let notificationReconnect: ReturnType<typeof setTimeout> | null = null;
const notificationListeners = new Set<() => void>();

function databaseSsl() {
  return ENV.isProduction && !ENV.databaseUrl.includes("sslmode=disable")
    ? { rejectUnauthorized: true, ...(ENV.databaseSslCa ? { ca: ENV.databaseSslCa } : {}) }
    : false;
}

function db() {
  if (!pool) {
    pool = new Pool({
      connectionString: ENV.databaseUrl,
      ssl: databaseSsl(),
      max: 4,
      application_name: "delivery-realtime-tracking",
    });
  }
  return pool;
}

function scheduleNotificationReconnect() {
  if (notificationReconnect || !notificationListeners.size) return;
  notificationReconnect = setTimeout(() => {
    notificationReconnect = null;
    void ensureNotificationClient();
  }, NOTIFIER_RECONNECT_MS);
  notificationReconnect.unref?.();
}

async function closeNotificationClient() {
  if (notificationReconnect) {
    clearTimeout(notificationReconnect);
    notificationReconnect = null;
  }
  const active = notificationClient;
  notificationClient = null;
  if (active) await active.end().catch(() => undefined);
}

async function ensureNotificationClient() {
  if (!notificationListeners.size || notificationClient) return;
  if (notificationStart) return notificationStart;

  notificationStart = (async () => {
    const client = new Client({
      connectionString: ENV.databaseUrl,
      ssl: databaseSsl(),
      application_name: "delivery-realtime-tracking-notifier",
    });
    const disconnect = () => {
      if (notificationClient !== client) return;
      notificationClient = null;
      scheduleNotificationReconnect();
    };
    client.on("notification", (message) => {
      if (message.channel !== TRACKING_DELTA_CHANNEL) return;
      for (const listener of notificationListeners) {
        try {
          listener();
        } catch {
          // Individual SSE handlers retain their own error response and resync guard.
        }
      }
    });
    client.on("error", disconnect);
    client.on("end", disconnect);
    try {
      await client.connect();
      await client.query(`LISTEN ${TRACKING_DELTA_CHANNEL}`);
      if (!notificationListeners.size) {
        await client.end();
        return;
      }
      notificationClient = client;
    } catch {
      await client.end().catch(() => undefined);
      scheduleNotificationReconnect();
    }
  })().finally(() => {
    notificationStart = null;
  });
  return notificationStart;
}

async function subscribeToTrackingNotifications(listener: () => void) {
  notificationListeners.add(listener);
  await ensureNotificationClient();
  return () => {
    notificationListeners.delete(listener);
    if (!notificationListeners.size) void closeNotificationClient();
  };
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

export type RoleScopedTrackingSnapshot = {
  cursor: number;
  truncated: boolean;
  deltas: TrackingDelta[];
};

function actorScope(user: SessionUser, requested: string) {
  if (!ALLOWED_SCOPES.has(requested)) throw new Error("tracking_scope_invalid");
  const role = `${user.role ?? ""}`.toLowerCase();
  if (requested === "me") {
    if (["admin", "platform_admin", "super_admin"].includes(role)) return "admin";
    if (["merchant", "merchant_owner", "merchant_manager"].includes(role)) return "merchant";
    if (["driver", "courier", "technician"].includes(role)) return "driver";
    if (["customer", "rider"].includes(role)) return "customer";
    throw new Error("tracking_scope_denied");
  }
  if (requested === "admin" && !["admin", "platform_admin", "super_admin"].includes(role)) {
    throw new Error("tracking_scope_denied");
  }
  return requested;
}

function mapTrackingDelta(row: Record<string, unknown>): TrackingDelta {
  return {
    cursor: Number(row.cursor),
    orderId: Number(row.order_id),
    observedAt: new Date(`${row.observed_at}`).toISOString(),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    accuracyM: row.accuracy_m === null ? null : Number(row.accuracy_m),
    etaSeconds: row.eta_seconds === null ? null : Number(row.eta_seconds),
  };
}

export async function listRoleScopedTrackingDeltas(input: { user: SessionUser; scope: string; cursor: number; limit?: number }) {
  const cursor = Number.isSafeInteger(input.cursor) && input.cursor >= 0 ? input.cursor : 0;
  const scope = actorScope(input.user, input.scope);
  const result = await db().query(
    "SELECT cursor,order_id,observed_at,latitude,longitude,accuracy_m,eta_seconds FROM operations.list_role_scoped_delivery_tracking($1,$2,$3,$4)",
    [input.user.id, scope, cursor, Math.min(250, Math.max(1, input.limit ?? 100))],
  );
  return result.rows.map(mapTrackingDelta) satisfies TrackingDelta[];
}

export async function getRoleScopedTrackingSnapshot(input: {
  user: SessionUser;
  scope: string;
  limit?: number;
}): Promise<RoleScopedTrackingSnapshot> {
  const scope = actorScope(input.user, input.scope);
  const result = await db().query(
    "SELECT stream_cursor,truncated,cursor,order_id,observed_at,latitude,longitude,accuracy_m,eta_seconds FROM operations.list_role_scoped_delivery_tracking_snapshot($1,$2,$3)",
    [input.user.id, scope, Math.min(250, Math.max(1, input.limit ?? 250))],
  );
  const first = result.rows[0] as Record<string, unknown> | undefined;
  return {
    cursor: first ? Number(first.stream_cursor) : 0,
    truncated: first?.truncated === true,
    deltas: result.rows.map(mapTrackingDelta),
  };
}

export type TrackingSessionResolver = (headers: Request["headers"]) => Promise<SessionUser | null>;

function trackingErrorStatus(error: unknown) {
  return error instanceof Error && error.message === "tracking_scope_denied" ? 403 : 400;
}

export async function handleRoleScopedTrackingSnapshot(
  req: Request,
  res: Response,
  resolveSession: TrackingSessionResolver,
) {
  const user = await resolveSession(req.headers);
  if (!user) { res.status(401).json({ error: "authentication_required" }); return; }
  try {
    const snapshot = await getRoleScopedTrackingSnapshot({
      user,
      scope: req.params.scope,
      limit: Number(req.query.limit ?? 250),
    });
    res.set("Cache-Control", "no-store").status(200).json(snapshot);
  } catch (error) {
    const code = error instanceof Error ? error.message : "tracking_snapshot_unavailable";
    res.status(trackingErrorStatus(error)).json({ error: code });
  }
}

export async function handleRoleScopedTrackingStream(
  req: Request,
  res: Response,
  resolveSession: TrackingSessionResolver,
) {
  const user = await resolveSession(req.headers);
  if (!user) { res.status(401).json({ error: "authentication_required" }); return; }
  try {
    await openRoleScopedTrackingStream(req, res, user);
  } catch (error) {
    const code = error instanceof Error ? error.message : "tracking_stream_unavailable";
    res.status(trackingErrorStatus(error)).json({ error: code });
  }
}

export async function closeRoleScopedTrackingPoolForTest() {
  await closeNotificationClient();
  const active = pool;
  pool = null;
  if (active) await active.end();
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
  sse(res, "ready", { scope, cursor, retry_after_ms: NOTIFIER_RECONNECT_MS });

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
    } finally {
      inFlight = false;
    }
  };

  const unsubscribe = await subscribeToTrackingNotifications(() => { void tick(); });
  await tick();
  // A low-frequency resync guards against a database notification disconnect or missed wake-up.
  const resync = setInterval(() => void tick(), RESYNC_MS);
  const heartbeat = setInterval(() => sse(res, "heartbeat", { cursor }), HEARTBEAT_MS);
  const expiry = setTimeout(() => { sse(res, "rotate", { cursor }); res.end(); }, MAX_STREAM_MS);
  req.on("close", () => {
    closed = true;
    unsubscribe();
    clearInterval(resync);
    clearInterval(heartbeat);
    clearTimeout(expiry);
  });
}
