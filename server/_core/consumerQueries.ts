import { createHash } from "node:crypto";

import { TRPCError } from "@trpc/server";

import { getPool } from "../db";

/**
 * Real pool-backed query layer for the consumer account surface (/account).
 *
 * Every function is scoped to the caller's own `public.users.id`
 * (consumerUserId) — the unified domain subject established by session
 * unification (PR #23) and resolvePublicUser. Data sources:
 *
 * - public.orders               (customer_id = public.users.id) — order list,
 *                               detail and the timeline's real timestamp
 *                               columns (created/scheduled/actual pickup,
 *                               estimated/actual delivery).
 * - public.transactions         (order_id, recipient_type 'customer') — the
 *                               consumer's payment/refund ledger rows.
 * - mojaloop_transfers          joined on transfer_id = transactions
 *                               .transaction_id where a transfer exists, so
 *                               the live transfer state is shown next to each
 *                               ledger row (never assumed to exist).
 * - mojaloop_refunds            joined on original_transfer_id =
 *                               transactions.transaction_id for refund rows.
 * - public.support_tickets      (customer_id, order_id) — dispute/support
 *                               cases; the write path derives a deterministic
 *                               ticket_number from the idempotency key and
 *                               relies on the existing UNIQUE(ticket_number)
 *                               constraint for replay safety.
 * - public.wallets              (user_id UNIQUE) — the consumer's stored
 *                               balance row when one has been provisioned.
 * - public.loyalty_points /
 *   public.loyalty_transactions — real loyalty balance and journal.
 *
 * Errors propagate to the tRPC layer (fail-closed); nothing here fabricates
 * zeros on failure.
 */

export type ConsumerOrderSummary = {
  id: number;
  orderNumber: string;
  status: string;
  totalAmount: number;
  currency: string;
  verticalName: string | null;
  providerName: string | null;
  driverName: string | null;
  deliveryAddress: string | null;
  estimatedDeliveryTime: string | null;
  actualDeliveryTime: string | null;
  createdAt: string;
  updatedAt: string;
  openSupportCases: number;
};

export type ConsumerLedgerEntry = {
  id: number;
  transactionId: string;
  orderId: number | null;
  orderNumber: string | null;
  type: string;
  amount: number;
  currency: string;
  status: string;
  paymentMethod: string | null;
  transferState: string | null;
  refundState: string | null;
  refundAmount: number | null;
  createdAt: string;
};

export type ConsumerOrderTimelineEvent = {
  kind:
    | "placed"
    | "pickup_scheduled"
    | "picked_up"
    | "delivered"
    | "delivery_estimate"
    | "status"
    | "transaction";
  label: string;
  occurredAt: string;
  detail: string | null;
};

export type ConsumerOrderDetail = {
  order: {
    id: number;
    orderNumber: string;
    status: string;
    totalAmount: number;
    platformFee: number;
    driverFee: number;
    currency: string;
    verticalName: string | null;
    providerName: string | null;
    driverName: string | null;
    pickupAddress: string | null;
    deliveryAddress: string | null;
    scheduledPickupTime: string | null;
    actualPickupTime: string | null;
    estimatedDeliveryTime: string | null;
    actualDeliveryTime: string | null;
    notes: string | null;
    createdAt: string;
    updatedAt: string;
  };
  timeline: ConsumerOrderTimelineEvent[];
  ledger: ConsumerLedgerEntry[];
  supportCases: ConsumerSupportCase[];
};

export type ConsumerSupportCase = {
  id: number;
  ticketNumber: string;
  orderId: number | null;
  orderNumber: string | null;
  type: string;
  priority: string;
  status: string;
  subject: string;
  description: string;
  resolution: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
};

export type ConsumerWalletView = {
  /** Null when no wallets row has been provisioned for this consumer. */
  wallet: {
    id: number;
    userType: string;
    balance: number;
    currency: string;
    updatedAt: string;
  } | null;
  ledger: ConsumerLedgerEntry[];
  totals: {
    paidTotal: number;
    refundTotal: number;
    currency: string;
  };
  loyalty: {
    pointsBalance: number;
    lifetimePoints: number;
    tier: string;
    recent: Array<{
      id: number;
      transactionType: string;
      points: number;
      orderId: number | null;
      description: string | null;
      createdAt: string;
    }>;
  } | null;
};

function toNumber(value: unknown, digits = 2): number {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return Number(n.toFixed(digits));
}

function toIso(value: unknown): string | null {
  if (!value) return null;
  const d = new Date(value as string | Date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const ORDER_SELECT = `
  SELECT
    o.id,
    o.order_number,
    o.status::text AS status,
    o.total_amount::numeric AS total_amount,
    o.platform_fee::numeric AS platform_fee,
    o.driver_fee::numeric AS driver_fee,
    v.name AS vertical_name,
    sp.business_name AS provider_name,
    d.name AS driver_name,
    o.pickup_address,
    o.delivery_address,
    o.scheduled_pickup_time,
    o.actual_pickup_time,
    o.estimated_delivery_time,
    o.actual_delivery_time,
    o.notes,
    o.created_at,
    o.updated_at,
    (
      SELECT COUNT(*)::int
      FROM public.support_tickets st
      WHERE st.order_id = o.id AND st.status IN ('open', 'in_progress')
    ) AS open_support_cases
  FROM public.orders o
  LEFT JOIN public.service_verticals v ON v.id = o.vertical_id
  LEFT JOIN public.service_providers sp ON sp.id = COALESCE(o.service_provider_id, o.provider_id)
  LEFT JOIN public.drivers d ON d.id = o.driver_id
`;

function mapOrderRow(row: any): ConsumerOrderSummary {
  return {
    id: Number(row.id),
    orderNumber: String(row.order_number),
    status: String(row.status),
    totalAmount: toNumber(row.total_amount),
    currency: "EUR",
    verticalName: row.vertical_name ?? null,
    providerName: row.provider_name ?? null,
    driverName: row.driver_name ?? null,
    deliveryAddress: row.delivery_address ?? null,
    estimatedDeliveryTime: toIso(row.estimated_delivery_time),
    actualDeliveryTime: toIso(row.actual_delivery_time),
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date(0).toISOString(),
    openSupportCases: Number(row.open_support_cases ?? 0),
  };
}

function mapLedgerRow(row: any): ConsumerLedgerEntry {
  return {
    id: Number(row.id),
    transactionId: String(row.transaction_id),
    orderId: row.order_id === null || row.order_id === undefined ? null : Number(row.order_id),
    orderNumber: row.order_number ?? null,
    type: String(row.type),
    amount: toNumber(row.amount),
    currency: String(row.currency ?? "EUR"),
    status: String(row.status),
    paymentMethod: row.payment_method ?? null,
    transferState: row.transfer_state ?? null,
    refundState: row.refund_state ?? null,
    refundAmount:
      row.refund_amount === null || row.refund_amount === undefined
        ? null
        : toNumber(row.refund_amount),
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
  };
}

function mapCaseRow(row: any): ConsumerSupportCase {
  return {
    id: Number(row.id),
    ticketNumber: String(row.ticket_number),
    orderId: row.order_id === null || row.order_id === undefined ? null : Number(row.order_id),
    orderNumber: row.order_number ?? null,
    type: String(row.type),
    priority: String(row.priority),
    status: String(row.status),
    subject: String(row.subject),
    description: String(row.description),
    resolution: row.resolution ?? null,
    createdAt: toIso(row.created_at) ?? new Date(0).toISOString(),
    updatedAt: toIso(row.updated_at) ?? new Date(0).toISOString(),
    resolvedAt: toIso(row.resolved_at),
  };
}

export async function listConsumerOrders(
  consumerUserId: number,
  limit = 25,
): Promise<ConsumerOrderSummary[]> {
  const pool = await getPool();
  const result = await pool.query(
    `${ORDER_SELECT}
     WHERE o.customer_id = $1
     ORDER BY o.created_at DESC
     LIMIT $2`,
    [consumerUserId, limit],
  );
  return result.rows.map(mapOrderRow);
}

const LEDGER_SELECT = `
  SELECT
    t.id,
    t.transaction_id,
    t.order_id,
    o.order_number,
    t.type::text AS type,
    t.amount::numeric AS amount,
    t.currency,
    t.status::text AS status,
    t.payment_method,
    mt.state AS transfer_state,
    mr.state AS refund_state,
    mr.amount AS refund_amount,
    t.created_at
  FROM public.transactions t
  LEFT JOIN public.orders o ON o.id = t.order_id
  LEFT JOIN mojaloop_transfers mt ON mt.transfer_id = t.transaction_id
  LEFT JOIN mojaloop_refunds mr ON mr.original_transfer_id = t.transaction_id
`;

export async function getConsumerOrderDetail(
  consumerUserId: number,
  orderId: number,
): Promise<ConsumerOrderDetail | null> {
  const pool = await getPool();
  const orderResult = await pool.query(
    `${ORDER_SELECT}
     WHERE o.id = $1 AND o.customer_id = $2
     LIMIT 1`,
    [orderId, consumerUserId],
  );
  const row = orderResult.rows[0];
  if (!row) return null;

  const [ledgerResult, casesResult] = await Promise.all([
    pool.query(
      `${LEDGER_SELECT}
       WHERE t.order_id = $1
       ORDER BY t.created_at DESC
       LIMIT 50`,
      [orderId],
    ),
    pool.query(
      `SELECT st.*, o.order_number
       FROM public.support_tickets st
       LEFT JOIN public.orders o ON o.id = st.order_id
       WHERE st.order_id = $1 AND st.customer_id = $2
       ORDER BY st.created_at DESC
       LIMIT 25`,
      [orderId, consumerUserId],
    ),
  ]);

  const summary = mapOrderRow(row);
  const ledger = ledgerResult.rows.map(mapLedgerRow);
  const supportCases = casesResult.rows.map(mapCaseRow);

  const timeline: ConsumerOrderTimelineEvent[] = [];
  timeline.push({
    kind: "placed",
    label: "Order placed",
    occurredAt: summary.createdAt,
    detail: `Order ${summary.orderNumber}`,
  });
  const scheduledPickup = toIso(row.scheduled_pickup_time);
  if (scheduledPickup) {
    timeline.push({
      kind: "pickup_scheduled",
      label: "Pickup scheduled",
      occurredAt: scheduledPickup,
      detail: row.pickup_address ?? null,
    });
  }
  const actualPickup = toIso(row.actual_pickup_time);
  if (actualPickup) {
    timeline.push({
      kind: "picked_up",
      label: "Picked up",
      occurredAt: actualPickup,
      detail: row.driver_name ? `Courier: ${row.driver_name}` : null,
    });
  }
  const estimatedDelivery = toIso(row.estimated_delivery_time);
  if (estimatedDelivery) {
    timeline.push({
      kind: "delivery_estimate",
      label: "Estimated delivery",
      occurredAt: estimatedDelivery,
      detail: row.delivery_address ?? null,
    });
  }
  const actualDelivery = toIso(row.actual_delivery_time);
  if (actualDelivery) {
    timeline.push({
      kind: "delivered",
      label: "Delivered",
      occurredAt: actualDelivery,
      detail: row.delivery_address ?? null,
    });
  }
  for (const entry of ledger) {
    timeline.push({
      kind: "transaction",
      label:
        entry.type === "refund"
          ? `Refund ${entry.status}`
          : `Payment ${entry.status}`,
      occurredAt: entry.createdAt,
      detail: entry.transferState
        ? `Transfer state: ${entry.transferState}`
        : null,
    });
  }
  timeline.sort(
    (a, b) =>
      new Date(a.occurredAt).getTime() - new Date(b.occurredAt).getTime(),
  );

  return {
    order: {
      id: summary.id,
      orderNumber: summary.orderNumber,
      status: summary.status,
      totalAmount: summary.totalAmount,
      platformFee: toNumber(row.platform_fee),
      driverFee: toNumber(row.driver_fee),
      currency: summary.currency,
      verticalName: summary.verticalName,
      providerName: summary.providerName,
      driverName: summary.driverName,
      pickupAddress: row.pickup_address ?? null,
      deliveryAddress: summary.deliveryAddress,
      scheduledPickupTime: scheduledPickup,
      actualPickupTime: actualPickup,
      estimatedDeliveryTime: estimatedDelivery,
      actualDeliveryTime: actualDelivery,
      notes: row.notes ?? null,
      createdAt: summary.createdAt,
      updatedAt: summary.updatedAt,
    },
    timeline,
    ledger,
    supportCases,
  };
}

export async function listConsumerSupportCases(
  consumerUserId: number,
  limit = 25,
): Promise<ConsumerSupportCase[]> {
  const pool = await getPool();
  const result = await pool.query(
    `SELECT st.*, o.order_number
     FROM public.support_tickets st
     LEFT JOIN public.orders o ON o.id = st.order_id
     WHERE st.customer_id = $1
     ORDER BY st.created_at DESC
     LIMIT $2`,
    [consumerUserId, limit],
  );
  return result.rows.map(mapCaseRow);
}

const SUPPORT_CASE_TYPES = [
  "order_issue",
  "payment",
  "driver",
  "general",
  "claim",
  "refund",
] as const;

export type ConsumerSupportCaseType = (typeof SUPPORT_CASE_TYPES)[number];

/**
 * Open a dispute/support case for the consumer, idempotently.
 *
 * Idempotency is anchored on the existing UNIQUE(ticket_number) constraint:
 * the ticket number is derived deterministically from the consumer id and
 * the caller-supplied idempotency key, so a replayed submission collides and
 * returns the pre-existing case instead of creating a duplicate. When an
 * orderId is supplied the order must belong to this consumer (scoped WHERE),
 * otherwise the mutation fails with NOT_FOUND rather than linking a case to
 * someone else's order.
 */
export async function openConsumerSupportCase(input: {
  consumerUserId: number;
  orderId: number | null;
  type: ConsumerSupportCaseType;
  subject: string;
  description: string;
  idempotencyKey: string;
}): Promise<ConsumerSupportCase> {
  if (!SUPPORT_CASE_TYPES.includes(input.type)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `unsupported_support_case_type: ${input.type}`,
    });
  }

  const pool = await getPool();

  if (input.orderId !== null) {
    const owned = await pool.query(
      `SELECT 1 FROM public.orders WHERE id = $1 AND customer_id = $2 LIMIT 1`,
      [input.orderId, input.consumerUserId],
    );
    if (!owned.rows[0]) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "order_not_found_for_consumer",
      });
    }
  }

  const ticketNumber = `CS-${createHash("sha256")
    .update(`${input.consumerUserId}:${input.idempotencyKey}`)
    .digest("hex")
    .slice(0, 24)}`;

  const inserted = await pool.query(
    `INSERT INTO public.support_tickets (
       ticket_number, customer_id, order_id, type, priority, status,
       subject, description
     )
     VALUES ($1, $2, $3, $4::ticket_type, 'medium', 'open', $5, $6)
     ON CONFLICT (ticket_number) DO NOTHING
     RETURNING *,
       (SELECT o.order_number FROM public.orders o WHERE o.id = order_id) AS order_number`,
    [
      ticketNumber,
      input.consumerUserId,
      input.orderId,
      input.type,
      input.subject,
      input.description,
    ],
  );

  const row =
    inserted.rows[0] ??
    (
      await pool.query(
        `SELECT st.*,
                (SELECT o.order_number FROM public.orders o WHERE o.id = st.order_id) AS order_number
         FROM public.support_tickets st
         WHERE st.ticket_number = $1 AND st.customer_id = $2
         LIMIT 1`,
        [ticketNumber, input.consumerUserId],
      )
    ).rows[0];

  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "support_case_write_failed",
    });
  }
  return mapCaseRow(row);
}

export async function getConsumerWalletView(
  consumerUserId: number,
  ledgerLimit = 50,
): Promise<ConsumerWalletView> {
  const pool = await getPool();

  const [walletResult, ledgerResult, totalsResult, loyaltyResult, loyaltyTxResult] =
    await Promise.all([
      pool.query(
        `SELECT id, user_type, balance::numeric AS balance, currency, updated_at
         FROM public.wallets
         WHERE user_id = $1
         LIMIT 1`,
        [consumerUserId],
      ),
      pool.query(
        `${LEDGER_SELECT}
         WHERE (t.order_id IN (SELECT id FROM public.orders WHERE customer_id = $1))
            OR (t.recipient_type = 'customer' AND t.recipient_id = $1)
         ORDER BY t.created_at DESC
         LIMIT $2`,
        [consumerUserId, ledgerLimit],
      ),
      pool.query(
        `SELECT
           COALESCE(SUM(t.amount::numeric) FILTER (WHERE t.type = 'payment' AND t.status = 'completed'), 0) AS paid_total,
           COALESCE(SUM(t.amount::numeric) FILTER (WHERE t.type = 'refund' AND t.status = 'completed'), 0) AS refund_total
         FROM public.transactions t
         WHERE (t.order_id IN (SELECT id FROM public.orders WHERE customer_id = $1))
            OR (t.recipient_type = 'customer' AND t.recipient_id = $1)`,
        [consumerUserId],
      ),
      pool.query(
        `SELECT points_balance, lifetime_points, tier
         FROM public.loyalty_points
         WHERE user_id = $1
         LIMIT 1`,
        [consumerUserId],
      ),
      pool.query(
        `SELECT id, transaction_type, points, order_id, description, created_at
         FROM public.loyalty_transactions
         WHERE user_id = $1
         ORDER BY created_at DESC
         LIMIT 10`,
        [consumerUserId],
      ),
    ]);

  const walletRow = walletResult.rows[0];
  const loyaltyRow = loyaltyResult.rows[0];
  const totalsRow = totalsResult.rows[0] ?? {};

  return {
    wallet: walletRow
      ? {
          id: Number(walletRow.id),
          userType: String(walletRow.user_type),
          balance: toNumber(walletRow.balance),
          currency: String(walletRow.currency ?? "EUR"),
          updatedAt: toIso(walletRow.updated_at) ?? new Date(0).toISOString(),
        }
      : null,
    ledger: ledgerResult.rows.map(mapLedgerRow),
    totals: {
      paidTotal: toNumber(totalsRow.paid_total),
      refundTotal: toNumber(totalsRow.refund_total),
      currency: "EUR",
    },
    loyalty: loyaltyRow
      ? {
          pointsBalance: Number(loyaltyRow.points_balance ?? 0),
          lifetimePoints: Number(loyaltyRow.lifetime_points ?? 0),
          tier: String(loyaltyRow.tier ?? "bronze"),
          recent: loyaltyTxResult.rows.map((tx: any) => ({
            id: Number(tx.id),
            transactionType: String(tx.transaction_type),
            points: Number(tx.points ?? 0),
            orderId:
              tx.order_id === null || tx.order_id === undefined
                ? null
                : Number(tx.order_id),
            description: tx.description ?? null,
            createdAt: toIso(tx.created_at) ?? new Date(0).toISOString(),
          })),
        }
      : null,
  };
}
