import { randomUUID } from "node:crypto";

import pg from "pg";

import { ENV } from "./env";
import { dispatchLongCatMessage } from "./notificationGateway";
import { recordOperationalEvent } from "./operationalEvents";

export type LongCatActionKind =
  | "sms_followup"
  | "merchant_callback"
  | "service_recovery_credit"
  | "reservation_booking";

export type LongCatActionStatus = "queued" | "completed" | "failed";

export type LongCatActionRequest = {
  sessionId?: string | null;
  customerPhone?: string | null;
  customerName?: string | null;
  merchantName?: string | null;
  kind: LongCatActionKind;
  reason: string;
  notes?: string | null;
  reservation?: {
    partySize: number;
    requestedAt: string;
    location: string;
  } | null;
  compensation?: {
    amount: number;
    currency: string;
    incidentType: string;
  } | null;
};

export type LongCatActionResult = {
  action_id: string;
  kind: LongCatActionKind;
  status: LongCatActionStatus;
  execution_summary: string;
  dispatch: {
    attempted: boolean;
    accepted: boolean;
    request_id: string | null;
    error: string | null;
  };
  booking_reference: string | null;
  created_at: string;
};

const { Pool } = pg;
let pool: pg.Pool | null = null;

// TLS verification is always on for database connections. The only way to
// disable it is the development-only DATABASE_TLS_SKIP_VERIFY flag, which
// env.ts refuses to honor in production.
function buildDatabaseSsl(useSsl: boolean) {
  if (!useSsl) return false;
  if (ENV.databaseTlsSkipVerify) {
    console.warn(
      "[SECURITY] DATABASE_TLS_SKIP_VERIFY=true: TLS certificate verification is DISABLED for the LongCat actions database connection. This is a development-only override and is rejected in production.",
    );
    return { rejectUnauthorized: false as const };
  }
  return {
    rejectUnauthorized: true as const,
    ...(ENV.databaseSslCa ? { ca: ENV.databaseSslCa } : {}),
  };
}

function getPool() {
  if (!pool) {
    pool = new Pool({
      connectionString: ENV.databaseUrl,
      ssl: buildDatabaseSsl(ENV.databaseUrl.includes("sslmode=require")),
    });
  }
  return pool;
}

let schemaReady: Promise<void> | null = null;

async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = (async () => {
      const db = getPool();
      await db.query(`
        CREATE TABLE IF NOT EXISTS longcat_action_runs (
          action_id UUID PRIMARY KEY,
          session_id UUID,
          customer_phone TEXT,
          customer_name TEXT,
          merchant_name TEXT,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          reason TEXT NOT NULL,
          notes TEXT,
          reservation_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          compensation_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          dispatch_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          execution_summary TEXT NOT NULL,
          booking_reference TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    })();
  }
  await schemaReady;
}

function normalizePhone(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function reservationSummary(reservation: LongCatActionRequest["reservation"]) {
  if (!reservation) return null;
  return `Reservation request for ${reservation.partySize} guests at ${reservation.location} on ${reservation.requestedAt}`;
}

function compensationSummary(compensation: LongCatActionRequest["compensation"]) {
  if (!compensation) return null;
  return `Recovery credit ${compensation.amount.toFixed(2)} ${compensation.currency} for ${compensation.incidentType}`;
}

async function dispatchForAction(input: LongCatActionRequest, actionId: string) {
  const customerPhone = normalizePhone(input.customerPhone);
  if (!customerPhone) {
    return { attempted: false, accepted: false, request_id: null, error: "customer phone not configured" };
  }

  const message = (() => {
    switch (input.kind) {
      case "sms_followup":
        return input.notes?.trim() || `SwitchOS follow-up: ${input.reason}`;
      case "merchant_callback":
        return `A ${input.merchantName ?? "merchant"} callback has been scheduled regarding ${input.reason}.`;
      case "service_recovery_credit":
        return `${compensationSummary(input.compensation) ?? "A service recovery credit has been prepared."}`;
      case "reservation_booking":
        return `${reservationSummary(input.reservation) ?? "A reservation request has been logged."}`;
      default:
        return input.reason;
    }
  })();

  try {
    const dispatch = await dispatchLongCatMessage({
      customerPhone,
      customerName: input.customerName ?? null,
      sessionId: input.sessionId ?? actionId,
      message,
      channel: "sms",
      reason: input.kind,
    });
    return {
      attempted: true,
      accepted: dispatch.accepted,
      request_id: dispatch.requestId,
      error: dispatch.accepted ? null : "dispatcher_rejected",
    };
  } catch (error) {
    return {
      attempted: true,
      accepted: false,
      request_id: null,
      error: error instanceof Error ? error.message : "dispatch_failed",
    };
  }
}

export async function executeLongCatAction(input: LongCatActionRequest): Promise<LongCatActionResult> {
  await ensureSchema();

  const actionId = randomUUID();
  const createdAt = new Date().toISOString();
  const bookingReference = input.kind === "reservation_booking" ? `LCAT-BOOK-${actionId.slice(0, 8).toUpperCase()}` : null;
  const dispatch = await dispatchForAction(input, actionId);
  const status: LongCatActionStatus = dispatch.attempted && !dispatch.accepted ? "failed" : "completed";
  const executionSummary = [
    input.kind === "reservation_booking" ? reservationSummary(input.reservation) : null,
    input.kind === "service_recovery_credit" ? compensationSummary(input.compensation) : null,
    input.kind === "merchant_callback" ? `Merchant callback requested for ${input.merchantName ?? "merchant"}.` : null,
    input.kind === "sms_followup" ? `SMS follow-up prepared for ${input.customerName ?? input.customerPhone ?? "customer"}.` : null,
    input.reason,
  ].filter(Boolean).join(" ");

  const db = getPool();
  await db.query(
    `INSERT INTO longcat_action_runs (
       action_id, session_id, customer_phone, customer_name, merchant_name, kind, status, reason, notes,
       reservation_json, compensation_json, dispatch_json, execution_summary, booking_reference, created_at, updated_at
     ) VALUES (
       $1, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12::jsonb, $13, $14, NOW(), NOW()
     )`,
    [
      actionId,
      input.sessionId ?? null,
      normalizePhone(input.customerPhone),
      input.customerName?.trim() || null,
      input.merchantName?.trim() || null,
      input.kind,
      status,
      input.reason,
      input.notes?.trim() || null,
      JSON.stringify(input.reservation ?? {}),
      JSON.stringify(input.compensation ?? {}),
      JSON.stringify(dispatch),
      executionSummary,
      bookingReference,
    ],
  );

  await recordOperationalEvent({
    eventType: "longcat.action.executed",
    outcome: status === "completed" ? "success" : "failure",
    payload: {
      actionId,
      kind: input.kind,
      sessionId: input.sessionId ?? null,
      dispatchAccepted: dispatch.accepted,
      bookingReference,
    },
  });

  return {
    action_id: actionId,
    kind: input.kind,
    status,
    execution_summary: executionSummary,
    dispatch,
    booking_reference: bookingReference,
    created_at: createdAt,
  };
}
