import { createHmac, randomUUID } from "node:crypto";
import { getPool } from "../db";

export type OpsActor = { id: number; tenantId: string };

type WorkState = "draft" | "queued" | "allocated" | "in_progress" | "completed" | "cancelled" | "failed";

const transitions: Record<WorkState, ReadonlySet<WorkState>> = {
  draft: new Set(["queued", "cancelled"]),
  queued: new Set(["allocated", "cancelled"]),
  allocated: new Set(["in_progress", "cancelled"]),
  in_progress: new Set(["completed", "failed", "cancelled"]),
  completed: new Set(),
  cancelled: new Set(),
  failed: new Set(),
};

function requireText(value: unknown, field: string, max: number): string {
  const normalized = `${value ?? ""}`.trim();
  if (!normalized || normalized.length > max) throw new Error(`invalid_${field}`);
  return normalized;
}

function requireUuid(value: unknown, field: string): string {
  const normalized = `${value ?? ""}`.trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new Error(`invalid_${field}`);
  }
  return normalized;
}

function finiteCoordinate(value: unknown, min: number, max: number, field: string): number {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < min || numeric > max) throw new Error(`invalid_${field}`);
  return numeric;
}

function tenantIdFor(actor: OpsActor) {
  const tenant = actor.tenantId.trim();
  if (!tenant || tenant.length > 128) throw new Error("tenant_context_required");
  return tenant;
}

function safeMetadata(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function safeWebhookEndpoint(value: unknown): string {
  const endpoint = requireText(value, "endpoint_url", 2048);
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new Error("invalid_endpoint_url"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) throw new Error("invalid_endpoint_url");
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || /^127\.|^10\.|^192\.168\.|^169\.254\.|^0\./.test(host) || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) {
    throw new Error("webhook_private_network_endpoint_forbidden");
  }
  return parsed.toString();
}

export async function listOperationsSnapshot(actor: OpsActor) {
  const pool = await getPool();
  const tenantId = tenantIdFor(actor);
  const [zones, orders, events, subscriptions, workflows, geofences, positions] = await Promise.all([
    pool.query(`SELECT id::text, code, display_name, active, dispatch_enabled, created_at, updated_at
      FROM operations.service_zone WHERE tenant_id = $1 ORDER BY display_name ASC LIMIT 100`, [tenantId]),
    pool.query(`SELECT o.id::text, o.external_reference, o.title, o.state::text, o.priority, o.scheduled_for, o.updated_at,
        z.display_name AS zone_name, o.assignee_user_id
      FROM operations.work_order o LEFT JOIN operations.service_zone z ON z.id = o.service_zone_id
      WHERE o.tenant_id = $1 ORDER BY o.priority DESC, o.updated_at DESC LIMIT 200`, [tenantId]),
    pool.query(`SELECT e.id::text, e.event_type, e.previous_state::text, e.next_state::text, e.created_at, o.external_reference
      FROM operations.work_order_event e JOIN operations.work_order o ON o.id = e.work_order_id
      WHERE o.tenant_id = $1 ORDER BY e.created_at DESC LIMIT 100`, [tenantId]),
    pool.query(`SELECT id::text, display_name, endpoint_url, event_types, active, created_at
      FROM operations.webhook_subscription WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 50`, [tenantId]),
    pool.query(`SELECT id::text, workflow_code, version, display_name, state::text, policy_version, published_at, updated_at
      FROM operations.workflow_definition WHERE tenant_id = $1 ORDER BY workflow_code ASC, version DESC LIMIT 100`, [tenantId]),
    pool.query(`SELECT id::text, code, display_name, active, dwell_threshold_seconds, updated_at
      FROM operations.geofence WHERE tenant_id = $1 ORDER BY display_name ASC LIMIT 100`, [tenantId]),
    pool.query(`SELECT p.work_order_id::text, p.subject_user_id, p.observed_at, ST_X(p.point::geometry) AS longitude,
        ST_Y(p.point::geometry) AS latitude, p.accuracy_m, p.integrity_score, p.source, o.external_reference
      FROM operations.current_tracking_position p JOIN operations.work_order o ON o.id = p.work_order_id
      WHERE p.tenant_id = $1 ORDER BY p.observed_at DESC LIMIT 250`, [tenantId]),
  ]);
  return { zones: zones.rows, orders: orders.rows, events: events.rows, subscriptions: subscriptions.rows, workflows: workflows.rows, geofences: geofences.rows, positions: positions.rows };
}

export async function assertWorkOrderTenant(actor: OpsActor, value: unknown) {
  const tenantId = tenantIdFor(actor);
  const workOrderId = requireUuid(value, "work_order_id");
  const pool = await getPool();
  const result = await pool.query("SELECT id::text FROM operations.work_order WHERE id = $1::uuid AND tenant_id = $2", [workOrderId, tenantId]);
  if (result.rowCount !== 1) throw new Error("work_order_not_found");
  return workOrderId;
}

export async function createWorkflowDefinition(actor: OpsActor, input: { workflowCode: unknown; displayName: unknown; transitions: unknown; requiredStopKinds?: unknown; inputSchema?: unknown; policyVersion: unknown }) {
  const tenantId = tenantIdFor(actor);
  const workflowCode = requireText(input.workflowCode, "workflow_code", 64).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{1,62}$/.test(workflowCode)) throw new Error("invalid_workflow_code");
  const displayName = requireText(input.displayName, "workflow_name", 160);
  const policyVersion = requireText(input.policyVersion, "policy_version", 80);
  const transitionsValue = safeMetadata(input.transitions);
  const transitionEntries = Object.entries(transitionsValue);
  if (transitionEntries.length === 0 || transitionEntries.length > 16 || transitionEntries.some(([from, to]) => !Object.hasOwn(transitions, from) || !Array.isArray(to) || to.some((next) => typeof next !== "string" || !transitions[from as WorkState]?.has(next as WorkState)))) {
    throw new Error("invalid_workflow_transitions");
  }
  const requiredStopKinds = input.requiredStopKinds === undefined ? [] : input.requiredStopKinds;
  if (!Array.isArray(requiredStopKinds) || requiredStopKinds.length > 4 || requiredStopKinds.some((kind) => typeof kind !== "string" || !["pickup", "dropoff", "checkpoint", "return"].includes(kind))) throw new Error("invalid_required_stop_kinds");
  const inputSchema = safeMetadata(input.inputSchema);
  const pool = await getPool();
  const result = await pool.query(`WITH next_version AS (
      SELECT COALESCE(MAX(version), 0) + 1 AS version FROM operations.workflow_definition WHERE tenant_id=$1 AND workflow_code=$2
    ) INSERT INTO operations.workflow_definition
      (tenant_id, workflow_code, version, display_name, work_state_transitions, required_stop_kinds, input_schema, policy_version, created_by)
    SELECT $1,$2,next_version.version,$3,$4::jsonb,$5::text[],$6::jsonb,$7,$8 FROM next_version
    RETURNING id::text, workflow_code, version, display_name, state::text, policy_version, created_at`,
    [tenantId, workflowCode, displayName, JSON.stringify(transitionsValue), requiredStopKinds, JSON.stringify(inputSchema), policyVersion, actor.id]);
  return result.rows[0];
}

export async function publishWorkflowDefinition(actor: OpsActor, input: { workflowId: unknown; idempotencyKey: unknown }) {
  const tenantId = tenantIdFor(actor);
  const workflowId = requireUuid(input.workflowId, "workflow_id");
  requireText(input.idempotencyKey, "idempotency_key", 128);
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const definition = await client.query(`SELECT id::text, workflow_code, state::text FROM operations.workflow_definition
      WHERE id=$1::uuid AND tenant_id=$2 FOR UPDATE`, [workflowId, tenantId]);
    if (definition.rowCount !== 1) throw new Error("workflow_not_found");
    const current = definition.rows[0].state as string;
    if (current === "published") { await client.query("COMMIT"); return { id: workflowId, state: current, idempotent: true }; }
    if (current !== "draft") throw new Error("workflow_not_publishable");
    await client.query(`UPDATE operations.workflow_definition SET state='published', published_by=$3, published_at=NOW(), updated_at=NOW()
      WHERE id=$1::uuid AND tenant_id=$2`, [workflowId, tenantId, actor.id]);
    await client.query(`UPDATE operations.workflow_definition SET state='archived', archived_at=NOW(), updated_at=NOW()
      WHERE tenant_id=$1 AND workflow_code=$2 AND id<>$3::uuid AND state='published'`, [tenantId, definition.rows[0].workflow_code, workflowId]);
    await client.query("COMMIT");
    return { id: workflowId, state: "published", idempotent: false };
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}

export async function createGeofence(actor: OpsActor, input: { code: unknown; displayName: unknown; polygon: unknown; dwellThresholdSeconds?: unknown; metadata?: unknown }) {
  const tenantId = tenantIdFor(actor);
  const code = requireText(input.code, "geofence_code", 64).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9_-]{1,62}$/.test(code)) throw new Error("invalid_geofence_code");
  const displayName = requireText(input.displayName, "geofence_name", 160);
  if (!Array.isArray(input.polygon) || input.polygon.length < 3 || input.polygon.length > 500) throw new Error("invalid_geofence_polygon");
  const points = input.polygon.map((point) => {
    if (!Array.isArray(point) || point.length !== 2) throw new Error("invalid_geofence_polygon");
    return [finiteCoordinate(point[0], -180, 180, "longitude"), finiteCoordinate(point[1], -90, 90, "latitude")];
  });
  points.push([...points[0]]);
  const dwellThresholdSeconds = input.dwellThresholdSeconds === undefined ? 300 : Number(input.dwellThresholdSeconds);
  if (!Number.isInteger(dwellThresholdSeconds) || dwellThresholdSeconds < 30 || dwellThresholdSeconds > 86400) throw new Error("invalid_dwell_threshold_seconds");
  const pool = await getPool();
  const result = await pool.query(`INSERT INTO operations.geofence (tenant_id, code, display_name, boundary, dwell_threshold_seconds, metadata, created_by)
    VALUES ($1,$2,$3,ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($4),4326))::geography,$5,$6::jsonb,$7)
    RETURNING id::text, code, display_name, active, dwell_threshold_seconds, created_at`,
  [tenantId, code, displayName, JSON.stringify({ type: "Polygon", coordinates: [points] }), dwellThresholdSeconds, JSON.stringify(safeMetadata(input.metadata)), actor.id]);
  return result.rows[0];
}

export async function recordGeofenceEventsForPosition(actor: OpsActor, input: { workOrderId: unknown; positionId: unknown; idempotencyKey: unknown }) {
  const tenantId = tenantIdFor(actor);
  const workOrderId = requireUuid(input.workOrderId, "work_order_id");
  const positionId = Number(input.positionId);
  if (!Number.isInteger(positionId) || positionId < 1) throw new Error("invalid_position_id");
  const idempotencyKey = requireText(input.idempotencyKey, "idempotency_key", 128);
  const pool = await getPool();
  const result = await pool.query(`WITH current_position AS (
      SELECT p.id, p.observed_at, p.point, p.subject_user_id FROM operations.tracking_position p
      JOIN operations.work_order o ON o.id=p.work_order_id
      WHERE p.id=$1 AND p.work_order_id=$2::uuid AND o.tenant_id=$3
    ), transitions AS (
      SELECT g.id AS geofence_id, CASE WHEN ST_Covers(g.boundary::geometry, current_position.point::geometry) THEN 'entered' ELSE 'exited' END AS event_type,
        current_position.observed_at, current_position.id AS position_id, current_position.subject_user_id
      FROM operations.geofence g CROSS JOIN current_position WHERE g.tenant_id=$3 AND g.active=true
    ) INSERT INTO operations.geofence_event (tenant_id, geofence_id, work_order_id, subject_user_id, position_id, event_type, observed_at, idempotency_key, decision_context)
    SELECT $3, geofence_id, $2::uuid, subject_user_id, position_id, event_type::operations.geofence_event_type, observed_at,
      $4 || ':' || geofence_id::text, jsonb_build_object('source_position_id', position_id)
    FROM transitions ON CONFLICT (tenant_id, geofence_id, idempotency_key) DO NOTHING
    RETURNING id::text, geofence_id::text, event_type::text, observed_at`, [positionId, workOrderId, tenantId, idempotencyKey]);
  return result.rows;
}

export async function createServiceZone(actor: OpsActor, input: { code: unknown; displayName: unknown; polygon: unknown; metadata?: unknown }) {
  const tenantId = tenantIdFor(actor);
  const code = requireText(input.code, "zone_code", 64).toUpperCase();
  const displayName = requireText(input.displayName, "zone_name", 160);
  if (!Array.isArray(input.polygon) || input.polygon.length < 3 || input.polygon.length > 500) throw new Error("invalid_zone_polygon");
  const coordinates = input.polygon.map((point) => {
    if (!Array.isArray(point) || point.length !== 2) throw new Error("invalid_zone_polygon");
    return [finiteCoordinate(point[0], -180, 180, "longitude"), finiteCoordinate(point[1], -90, 90, "latitude")];
  });
  coordinates.push([...coordinates[0]]);
  const geojson = JSON.stringify({ type: "Polygon", coordinates: [coordinates] });
  const pool = await getPool();
  const result = await pool.query(`INSERT INTO operations.service_zone
    (tenant_id, code, display_name, boundary, metadata, created_by)
    VALUES ($1,$2,$3,ST_Multi(ST_SetSRID(ST_GeomFromGeoJSON($4),4326))::geography,$5::jsonb,$6)
    RETURNING id::text, code, display_name, active, dispatch_enabled, created_at`,
  [tenantId, code, displayName, geojson, JSON.stringify(safeMetadata(input.metadata)), actor.id]);
  return result.rows[0];
}

export async function createWorkOrder(actor: OpsActor, input: { externalReference: unknown; title: unknown; priority?: unknown; serviceZoneId?: unknown; scheduledFor?: unknown; stops?: unknown; metadata?: unknown }) {
  const tenantId = tenantIdFor(actor);
  const externalReference = requireText(input.externalReference, "external_reference", 128);
  const title = requireText(input.title, "work_order_title", 240);
  const priority = input.priority === undefined ? 3 : Number(input.priority);
  if (!Number.isInteger(priority) || priority < 1 || priority > 5) throw new Error("invalid_priority");
  const zoneId = input.serviceZoneId ? requireUuid(input.serviceZoneId, "service_zone_id") : null;
  let scheduledFor: Date | null = null;
  if (input.scheduledFor) {
    scheduledFor = new Date(`${input.scheduledFor}`);
    if (Number.isNaN(scheduledFor.getTime())) throw new Error("invalid_scheduled_for");
  }
  const stops = input.stops === undefined ? [] : input.stops;
  if (!Array.isArray(stops) || stops.length > 12) throw new Error("invalid_stops");
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (zoneId) {
      const zone = await client.query(`SELECT 1 FROM operations.service_zone WHERE id = $1::uuid AND tenant_id = $2 AND active = true AND dispatch_enabled = true`, [zoneId, tenantId]);
      if (zone.rowCount !== 1) throw new Error("service_zone_not_dispatchable");
    }
    const order = await client.query(`INSERT INTO operations.work_order
      (tenant_id, external_reference, title, state, priority, service_zone_id, scheduled_for, metadata, created_by)
      VALUES ($1,$2,$3,'draft',$4,$5::uuid,$6,$7::jsonb,$8)
      RETURNING id::text, state::text, state_version, created_at`,
    [tenantId, externalReference, title, priority, zoneId, scheduledFor, JSON.stringify(safeMetadata(input.metadata)), actor.id]);
    const orderId = order.rows[0].id as string;
    for (let index = 0; index < stops.length; index += 1) {
      const stop = stops[index] as Record<string, unknown>;
      const kind = requireText(stop.kind, "stop_kind", 32);
      if (!["pickup", "dropoff", "checkpoint", "return"].includes(kind)) throw new Error("invalid_stop_kind");
      const displayName = requireText(stop.displayName, "stop_display_name", 160);
      const address = requireText(stop.address, "stop_address", 500);
      const longitude = finiteCoordinate(stop.longitude, -180, 180, "longitude");
      const latitude = finiteCoordinate(stop.latitude, -90, 90, "latitude");
      await client.query(`INSERT INTO operations.work_order_stop (work_order_id, sequence_no, stop_kind, display_name, address_text, location, metadata)
        VALUES ($1::uuid,$2,$3::operations.stop_kind,$4,$5,ST_SetSRID(ST_MakePoint($6,$7),4326)::geography,$8::jsonb)`,
      [orderId, index + 1, kind, displayName, address, longitude, latitude, JSON.stringify(safeMetadata(stop.metadata))]);
    }
    const event = await appendEvent(client, orderId, "work_order_created", null, "draft", actor.id, `create:${externalReference}`, { stopCount: stops.length });
    await enqueueWebhookDeliveries(client, tenantId, event.id, event.eventType, { workOrderId: orderId, externalReference, state: "draft" });
    await client.query("COMMIT");
    return { ...order.rows[0], id: orderId };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function transitionWorkOrder(actor: OpsActor, input: { workOrderId: unknown; nextState: unknown; idempotencyKey: unknown; assigneeUserId?: unknown; payload?: unknown }) {
  const tenantId = tenantIdFor(actor);
  const orderId = requireUuid(input.workOrderId, "work_order_id");
  const nextState = requireText(input.nextState, "next_state", 32) as WorkState;
  if (!(nextState in transitions)) throw new Error("invalid_next_state");
  const idempotencyKey = requireText(input.idempotencyKey, "idempotency_key", 128);
  const assigneeUserId = input.assigneeUserId === undefined || input.assigneeUserId === null ? null : Number(input.assigneeUserId);
  if (assigneeUserId !== null && (!Number.isInteger(assigneeUserId) || assigneeUserId < 1)) throw new Error("invalid_assignee_user_id");
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const order = await client.query(`SELECT id::text, state::text, state_version FROM operations.work_order WHERE id = $1::uuid AND tenant_id = $2 FOR UPDATE`, [orderId, tenantId]);
    if (order.rowCount !== 1) throw new Error("work_order_not_found");
    const current = order.rows[0].state as WorkState;
    const duplicate = await client.query(`SELECT next_state::text FROM operations.work_order_event WHERE work_order_id = $1::uuid AND idempotency_key = $2`, [orderId, idempotencyKey]);
    if (duplicate.rowCount === 1) {
      await client.query("COMMIT");
      return { id: orderId, state: duplicate.rows[0].next_state, idempotent: true };
    }
    if (!transitions[current].has(nextState)) throw new Error("invalid_work_order_transition");
    if (nextState === "allocated" && assigneeUserId === null) throw new Error("assignee_required_for_allocation");
    const completedAt = nextState === "completed" ? new Date() : null;
    await client.query(`UPDATE operations.work_order SET state = $3::operations.work_state, state_version = state_version + 1,
        assignee_user_id = COALESCE($4, assignee_user_id), completed_at = COALESCE($5, completed_at), updated_at = NOW()
      WHERE id = $1::uuid AND tenant_id = $2`, [orderId, tenantId, nextState, assigneeUserId, completedAt]);
    const event = await appendEvent(client, orderId, `work_order_${nextState}`, current, nextState, actor.id, idempotencyKey, safeMetadata(input.payload));
    await enqueueWebhookDeliveries(client, tenantId, event.id, event.eventType, { workOrderId: orderId, previousState: current, state: nextState });
    await client.query("COMMIT");
    return { id: orderId, state: nextState, idempotent: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}

export async function recordTrackingPosition(actor: OpsActor, input: { workOrderId: unknown; latitude: unknown; longitude: unknown; observedAt: unknown; accuracyM?: unknown; integrityScore?: unknown; source: unknown }) {
  const tenantId = tenantIdFor(actor);
  const orderId = requireUuid(input.workOrderId, "work_order_id");
  const latitude = finiteCoordinate(input.latitude, -90, 90, "latitude");
  const longitude = finiteCoordinate(input.longitude, -180, 180, "longitude");
  const observedAt = new Date(`${input.observedAt ?? ""}`);
  if (Number.isNaN(observedAt.getTime()) || observedAt.getTime() > Date.now() + 60_000) throw new Error("invalid_observed_at");
  const accuracyM = input.accuracyM === undefined ? null : finiteCoordinate(input.accuracyM, 0, 100_000, "accuracy_m");
  const integrityScore = input.integrityScore === undefined ? 100 : Number(input.integrityScore);
  if (!Number.isInteger(integrityScore) || integrityScore < 0 || integrityScore > 100) throw new Error("invalid_integrity_score");
  const source = requireText(input.source, "tracking_source", 64);
  const pool = await getPool();
  const result = await pool.query(`INSERT INTO operations.tracking_position
    (tenant_id, work_order_id, subject_user_id, observed_at, point, accuracy_m, integrity_score, source)
    SELECT $1, o.id, o.assignee_user_id, $3, ST_SetSRID(ST_MakePoint($4,$5),4326)::geography, $6, $7, $8
    FROM operations.work_order o WHERE o.id = $2::uuid AND o.tenant_id = $1
    RETURNING id, observed_at`, [tenantId, orderId, observedAt, longitude, latitude, accuracyM, integrityScore, source]);
  if (result.rowCount !== 1) throw new Error("work_order_not_found");
  return result.rows[0];
}

export async function createWebhookSubscription(actor: OpsActor, input: { displayName: unknown; endpointUrl: unknown; secretRef: unknown; eventTypes: unknown }) {
  const tenantId = tenantIdFor(actor);
  const displayName = requireText(input.displayName, "subscription_name", 160);
  const endpointUrl = safeWebhookEndpoint(input.endpointUrl);
  const secretRef = requireText(input.secretRef, "secret_ref", 128);
  if (!Array.isArray(input.eventTypes) || input.eventTypes.length === 0 || input.eventTypes.length > 32) throw new Error("invalid_event_types");
  const eventTypes = input.eventTypes.map((eventType) => requireText(eventType, "event_type", 96));
  const pool = await getPool();
  const result = await pool.query(`INSERT INTO operations.webhook_subscription (tenant_id, display_name, endpoint_url, secret_ref, event_types, created_by)
    VALUES ($1,$2,$3,$4,$5::text[],$6) RETURNING id::text, display_name, endpoint_url, event_types, active, created_at`,
  [tenantId, displayName, endpointUrl, secretRef, eventTypes, actor.id]);
  return result.rows[0];
}

async function appendEvent(client: { query: Function }, workOrderId: string, eventType: string, previousState: WorkState | null, nextState: WorkState, actorId: number, idempotencyKey: string, payload: Record<string, unknown>) {
  const sequence = await client.query(`SELECT COALESCE(MAX(sequence_no), 0) + 1 AS next_sequence FROM operations.work_order_event WHERE work_order_id = $1::uuid`, [workOrderId]);
  const result = await client.query(`INSERT INTO operations.work_order_event
    (work_order_id, sequence_no, event_type, previous_state, next_state, actor_user_id, idempotency_key, payload)
    VALUES ($1::uuid,$2,$3,$4::operations.work_state,$5::operations.work_state,$6,$7,$8::jsonb)
    RETURNING id::text, event_type`, [workOrderId, Number(sequence.rows[0].next_sequence), eventType, previousState, nextState, actorId, idempotencyKey, JSON.stringify(payload)]);
  return { id: result.rows[0].id as string, eventType: result.rows[0].event_type as string };
}

async function enqueueWebhookDeliveries(client: { query: Function }, tenantId: string, eventId: string, eventType: string, payload: Record<string, unknown>) {
  await client.query(`INSERT INTO operations.webhook_delivery (subscription_id, event_id, event_type, payload)
    SELECT id, $2::uuid, $3, $4::jsonb FROM operations.webhook_subscription
    WHERE tenant_id = $1 AND active = true AND $3 = ANY(event_types)
    ON CONFLICT (subscription_id, event_id) DO NOTHING`, [tenantId, eventId, eventType, JSON.stringify(payload)]);
}

function webhookSecrets(): Record<string, string> {
  const value = process.env.OPERATIONS_WEBHOOK_SECRETS_JSON ?? "{}";
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].length >= 32));
  } catch { return {}; }
}

export async function deliverDueOperationalWebhooks(limit = 25) {
  const pool = await getPool();
  const client = await pool.connect();
  const claimed: Array<{ id: string; endpointUrl: string; secretRef: string; eventType: string; payload: Record<string, unknown>; attemptCount: number }> = [];
  try {
    await client.query("BEGIN");
    const result = await client.query(`WITH due AS (
      SELECT d.id FROM operations.webhook_delivery d
      WHERE d.state IN ('queued','retry_scheduled') AND d.next_attempt_at <= NOW()
      ORDER BY d.next_attempt_at ASC FOR UPDATE SKIP LOCKED LIMIT $1
    )
    UPDATE operations.webhook_delivery d SET state = 'delivering', attempt_count = attempt_count + 1, updated_at = NOW()
    FROM due JOIN operations.webhook_subscription s ON s.id = d.subscription_id
    WHERE d.id = due.id
    RETURNING d.id::text, s.endpoint_url, s.secret_ref, d.event_type, d.payload, d.attempt_count`, [limit]);
    claimed.push(...result.rows.map((row) => ({ id: row.id, endpointUrl: row.endpoint_url, secretRef: row.secret_ref, eventType: row.event_type, payload: row.payload, attemptCount: row.attempt_count })));
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }

  const secrets = webhookSecrets();
  for (const delivery of claimed) {
    const secret = secrets[delivery.secretRef];
    if (!secret) {
      await pool.query(`UPDATE operations.webhook_delivery SET state='dead_letter', last_error='secret_reference_unavailable', updated_at=NOW() WHERE id=$1::uuid`, [delivery.id]);
      continue;
    }
    const body = JSON.stringify({ id: delivery.id, eventType: delivery.eventType, occurredAt: new Date().toISOString(), data: delivery.payload });
    const signature = createHmac("sha256", secret).update(body).digest("hex");
    try {
      const response = await fetch(delivery.endpointUrl, { method: "POST", headers: { "content-type": "application/json", "x-switchos-event-signature": `sha256=${signature}`, "x-switchos-delivery-id": delivery.id }, body, signal: AbortSignal.timeout(8_000) });
      if (response.status >= 200 && response.status < 300) {
        await pool.query(`UPDATE operations.webhook_delivery SET state='delivered', response_status=$2, delivered_at=NOW(), last_error=NULL, updated_at=NOW() WHERE id=$1::uuid`, [delivery.id, response.status]);
      } else {
        await scheduleWebhookRetry(pool, delivery.id, delivery.attemptCount, `http_${response.status}`, response.status);
      }
    } catch (error) {
      await scheduleWebhookRetry(pool, delivery.id, delivery.attemptCount, error instanceof Error ? error.message.slice(0, 500) : "delivery_network_error", null);
    }
  }
  return { claimed: claimed.length };
}

async function scheduleWebhookRetry(pool: Awaited<ReturnType<typeof getPool>>, deliveryId: string, attemptCount: number, error: string, responseStatus: number | null) {
  const terminal = attemptCount >= 8;
  const delaySeconds = Math.min(3600, 15 * (2 ** Math.max(0, attemptCount - 1)));
  await pool.query(`UPDATE operations.webhook_delivery
    SET state = $2::operations.delivery_state, response_status=$3, last_error=$4,
        next_attempt_at = CASE WHEN $2 = 'dead_letter' THEN next_attempt_at ELSE NOW() + ($5::text || ' seconds')::interval END,
        updated_at=NOW() WHERE id=$1::uuid`, [deliveryId, terminal ? "dead_letter" : "retry_scheduled", responseStatus, error, delaySeconds]);
}

export function logisticsErrorStatus(error: unknown) {
  const code = error instanceof Error ? error.message : "operations_error";
  if (code === "work_order_not_found") return { status: 404, code };
  if (code.includes("transition") || code.includes("dispatchable")) return { status: 409, code };
  if (code.startsWith("invalid_") || code.includes("required") || code.includes("forbidden")) return { status: 400, code };
  if (code.includes("duplicate key")) return { status: 409, code: "duplicate_operations_record" };
  return { status: 503, code: "operations_unavailable" };
}

export function operationalDeliveryWorkerId() { return randomUUID(); }
