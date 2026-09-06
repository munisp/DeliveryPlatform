import { Pool } from "pg";
import { ENV } from "./env";

type WorkOrderState =
  | "requested"
  | "scheduled"
  | "assigned"
  | "en_route"
  | "on_site"
  | "completed"
  | "cancelled";
type WorkOrderPriority = "low" | "normal" | "high" | "urgent";
type TechnicianState = "active" | "suspended" | "inactive";

let pool: Pool | null = null;

function database() {
  if (!ENV.databaseUrl) throw new Error("field_service_database_unconfigured");
  if (!pool) {
    pool = new Pool({
      connectionString: ENV.databaseUrl,
      ssl:
        ENV.isProduction && !ENV.databaseUrl.includes("sslmode=disable")
          ? {
              rejectUnauthorized: true,
              ...(ENV.databaseSslCa ? { ca: ENV.databaseSslCa } : {}),
            }
          : false,
      max: 5,
    });
  }
  return pool;
}

function one<T>(rows: T[], label: string): T {
  const row = rows[0];
  if (!row) throw new Error(`${label}_not_found`);
  return row;
}

export type FieldServiceWorkOrder = {
  id: string;
  publicReference: string;
  customerId: number;
  providerId: number;
  state: WorkOrderState;
  priority: WorkOrderPriority;
  scheduledStartAt: string | null;
  assignedTechnicianUserId: number | null;
  updatedAt: string;
};

export async function upsertServiceArea(input: {
  actorUserId: number;
  providerId: number;
  code: string;
  displayName: string;
  boundaryGeoJson: Record<string, unknown>;
  timezone: string;
  active: boolean;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT field_service.upsert_service_area($1,$2,$3,$4,$5::jsonb,$6,$7) AS id`,
    [
      input.actorUserId,
      input.providerId,
      input.code,
      input.displayName,
      JSON.stringify(input.boundaryGeoJson),
      input.timezone,
      input.active,
    ],
  );
  return one(result.rows, "service_area").id;
}

export async function upsertTechnician(input: {
  actorUserId: number;
  userId: number;
  providerId: number;
  displayName: string;
  employeeReference?: string | null;
  skills: string[];
  state: TechnicianState;
}) {
  const result = await database().query<{ user_id: number }>(
    `SELECT field_service.upsert_technician($1,$2,$3,$4,$5,$6::jsonb,$7::field_service.technician_state) AS user_id`,
    [
      input.actorUserId,
      input.userId,
      input.providerId,
      input.displayName,
      input.employeeReference ?? null,
      JSON.stringify(input.skills),
      input.state,
    ],
  );
  return Number(one(result.rows, "technician").user_id);
}

export async function setTechnicianServiceArea(input: {
  actorUserId: number;
  technicianUserId: number;
  serviceAreaId: string;
  active: boolean;
}) {
  await database().query(
    `SELECT field_service.set_technician_service_area($1,$2,$3::uuid,$4)`,
    [
      input.actorUserId,
      input.technicianUserId,
      input.serviceAreaId,
      input.active,
    ],
  );
}

export async function createWorkOrder(input: {
  actorUserId: number;
  customerId: number;
  providerId: number;
  serviceAreaId: string;
  title: string;
  description: string;
  serviceAddress: string;
  latitude?: number | null;
  longitude?: number | null;
  priority: WorkOrderPriority;
  scheduledStartAt?: string | null;
  scheduledEndAt?: string | null;
  sourceOrderId?: number | null;
  idempotencyKey: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT field_service.create_work_order($1,$2,$3::uuid,$4,$5,$6,$7,$8,$9::field_service.work_order_priority,$10::timestamptz,$11::timestamptz,$12,$13,$14) AS id`,
    [
      input.customerId,
      input.providerId,
      input.serviceAreaId,
      input.title,
      input.description,
      input.serviceAddress,
      input.latitude ?? null,
      input.longitude ?? null,
      input.priority,
      input.scheduledStartAt ?? null,
      input.scheduledEndAt ?? null,
      input.sourceOrderId ?? null,
      input.actorUserId,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "work_order").id;
}

export async function scheduleWorkOrder(input: {
  workOrderId: string;
  actorUserId: number;
  scheduledStartAt: string;
  scheduledEndAt: string;
  idempotencyKey: string;
}) {
  const result = await database().query<{ state: WorkOrderState }>(
    `SELECT field_service.schedule_work_order($1::uuid,$2,$3::timestamptz,$4::timestamptz,$5) AS state`,
    [
      input.workOrderId,
      input.actorUserId,
      input.scheduledStartAt,
      input.scheduledEndAt,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "work_order_state").state;
}

export async function assignWorkOrder(input: {
  workOrderId: string;
  actorUserId: number;
  technicianUserId: number;
  idempotencyKey: string;
}) {
  const result = await database().query<{ state: WorkOrderState }>(
    `SELECT field_service.assign_work_order($1::uuid,$2,$3,$4) AS state`,
    [
      input.workOrderId,
      input.actorUserId,
      input.technicianUserId,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "work_order_state").state;
}

export async function advanceWorkOrder(input: {
  workOrderId: string;
  technicianUserId: number;
  action: "depart" | "arrive";
  note?: string | null;
  idempotencyKey: string;
}) {
  const result = await database().query<{ state: WorkOrderState }>(
    `SELECT field_service.advance_work_order($1::uuid,$2,$3,$4,$5) AS state`,
    [
      input.workOrderId,
      input.technicianUserId,
      input.action,
      input.note ?? null,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "work_order_state").state;
}

export async function completeWorkOrder(input: {
  workOrderId: string;
  technicianUserId: number;
  completionSummary: string;
  objectKey: string;
  contentType: "image/jpeg" | "image/png" | "image/heic" | "application/pdf";
  sha256Hex: string;
  idempotencyKey: string;
}) {
  const result = await database().query<{ state: WorkOrderState }>(
    `SELECT field_service.complete_work_order($1::uuid,$2,$3,$4,$5,$6,$7) AS state`,
    [
      input.workOrderId,
      input.technicianUserId,
      input.completionSummary,
      input.objectKey,
      input.contentType,
      input.sha256Hex,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "work_order_state").state;
}

export async function cancelWorkOrder(input: {
  workOrderId: string;
  actorUserId: number;
  reason: string;
  idempotencyKey: string;
}) {
  const result = await database().query<{ state: WorkOrderState }>(
    `SELECT field_service.cancel_work_order($1::uuid,$2,$3,$4) AS state`,
    [input.workOrderId, input.actorUserId, input.reason, input.idempotencyKey],
  );
  return one(result.rows, "work_order_state").state;
}

export async function listWorkOrders(input: {
  actorUserId: number;
  state?: WorkOrderState;
  limit: number;
}) {
  const result = await database().query<{
    id: string;
    public_reference: string;
    customer_id: number;
    provider_id: number;
    state: WorkOrderState;
    priority: WorkOrderPriority;
    scheduled_start_at: Date | null;
    assigned_technician_user_id: number | null;
    updated_at: Date;
  }>(
    `SELECT * FROM field_service.list_work_orders_for_actor($1,$2::field_service.work_order_state,$3)`,
    [input.actorUserId, input.state ?? null, input.limit],
  );
  return result.rows.map(
    (row): FieldServiceWorkOrder => ({
      id: row.id,
      publicReference: row.public_reference,
      customerId: Number(row.customer_id),
      providerId: Number(row.provider_id),
      state: row.state,
      priority: row.priority,
      scheduledStartAt: row.scheduled_start_at
        ? new Date(row.scheduled_start_at).toISOString()
        : null,
      assignedTechnicianUserId:
        row.assigned_technician_user_id === null
          ? null
          : Number(row.assigned_technician_user_id),
      updatedAt: new Date(row.updated_at).toISOString(),
    }),
  );
}

export async function getWorkOrderDetail(input: {
  actorUserId: number;
  workOrderId: string;
}) {
  const result = await database().query<{ detail: Record<string, unknown> }>(
    `SELECT field_service.get_work_order_detail_for_actor($1,$2::uuid) AS detail`,
    [input.actorUserId, input.workOrderId],
  );
  return one(result.rows, "work_order").detail;
}
