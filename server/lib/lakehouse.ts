import { eq, and, lt, desc, sql } from "drizzle-orm";
import { getDb } from "../db";
import {
  documentEvents,
  paymentEvents,
  scanEvents,
  slabTransactions,
  telemetryEvents,
  telemetryEventsArchive,
} from "../../drizzle/schema";

// ---------------------------------------------------------------------------
// Lakehouse Writer — append-only event emitter for the analytics layer.
// All writes are fire-and-forget: analytics must NEVER block business ops.
// ---------------------------------------------------------------------------

export type TelemetryEventType =
  | "company.created"
  | "employee.created"
  | "scan.completed"
  | "payment.recorded"
  | "payroll.processed"
  | "creditNote.issued"
  | "instrument.tokenized"
  | "instrument.detokenized";

function reportLakehouseError(err: unknown) {
  console.error("[Lakehouse] write failed (non-blocking):", err);
}

/**
 * Primary entry point. Emit a telemetry event without awaiting persistence.
 */
export function emitTelemetry(
  companyId: number | null,
  eventType: TelemetryEventType | string,
  payload: Record<string, unknown> = {}
): void {
  const db = getDb();
  if (!db) return;
  void db
    .insert(telemetryEvents)
    .values({
      companyId,
      eventType,
      payloadJson: payload,
      createdAt: new Date(),
    })
    .catch(reportLakehouseError);
}

export function emitPaymentEvent(
  paymentId: number,
  companyId: number,
  amount: string | number,
  status: string,
  payload: Record<string, unknown> = {}
): void {
  const db = getDb();
  if (!db) return;
  void db
    .insert(paymentEvents)
    .values({
      paymentId,
      companyId,
      amount: String(amount),
      status,
      payloadJson: payload,
      createdAt: new Date(),
    })
    .catch(reportLakehouseError);
}

export function emitScanEvent(
  vehicleId: number,
  companyId: number,
  result: string,
  payload: Record<string, unknown> = {}
): void {
  const db = getDb();
  if (!db) return;
  void db
    .insert(scanEvents)
    .values({
      vehicleId,
      companyId,
      result,
      payloadJson: payload,
      createdAt: new Date(),
    })
    .catch(reportLakehouseError);
}

export function emitDocumentEvent(
  documentId: number,
  companyId: number,
  action: string,
  payload: Record<string, unknown> = {}
): void {
  const db = getDb();
  if (!db) return;
  void db
    .insert(documentEvents)
    .values({
      documentId,
      companyId,
      action,
      payloadJson: payload,
      createdAt: new Date(),
    })
    .catch(reportLakehouseError);
}

export function emitSlabTransaction(
  companyId: number,
  slabType: string,
  quantity: number,
  payload: Record<string, unknown> = {}
): void {
  const db = getDb();
  if (!db) return;
  void db
    .insert(slabTransactions)
    .values({
      companyId,
      slabType,
      quantity,
      payloadJson: payload,
      createdAt: new Date(),
    })
    .catch(reportLakehouseError);
}

// ---------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------

export async function getRecentTelemetry(companyId: number, limit = 50) {
  const db = getDb();
  if (!db) return [];
  return db
    .select()
    .from(telemetryEvents)
    .where(eq(telemetryEvents.companyId, companyId))
    .orderBy(desc(telemetryEvents.createdAt))
    .limit(limit);
}

export async function getTelemetryByType(eventType: string, limit = 100) {
  const db = getDb();
  if (!db) return [];
  return db
    .select()
    .from(telemetryEvents)
    .where(eq(telemetryEvents.eventType, eventType))
    .orderBy(desc(telemetryEvents.createdAt))
    .limit(limit);
}

// ---------------------------------------------------------------------------
// Retention — archive events older than `days` (default 90) into
// telemetryEventsArchive, then delete from the hot table.
// Returns the number of rows archived.
// ---------------------------------------------------------------------------

export async function archiveOldEvents(days = 90): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  // Move rows to archive
  await db.execute(sql`
    INSERT INTO telemetry_events_archive (id, company_id, event_type, payload_json, created_at, archived_at)
    SELECT id, company_id, event_type, payload_json, created_at, NOW()
    FROM telemetry_events
    WHERE created_at < ${cutoff}
  `);

  const result: any = await db
    .delete(telemetryEvents)
    .where(lt(telemetryEvents.createdAt, cutoff));

  const affected = Number(result?.rowCount ?? result?.[0]?.affectedRows ?? 0);
  return Number.isFinite(affected) ? affected : 0;
}

export async function countHotEvents(): Promise<number> {
  const db = getDb();
  if (!db) return 0;
  const rows = await db
    .select({ count: sql<number>`COUNT(*)` })
    .from(telemetryEvents);
  return Number(rows[0]?.count ?? 0);
}
