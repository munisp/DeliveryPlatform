import { TRPCError } from "@trpc/server";

import { getPool } from "../db";
import { ENV } from "./env";
import { createHotCache } from "./hotCache";
import { resilientFetch } from "./resilientFetch";
import { assertConsultationEligible, postConsultation } from "./workerCouncil";

/**
 * Cost-indexed fare floor (R6) and published take-rate registry (R7).
 *
 * The fare floor keeps driver-facing prices above the real operating cost of
 * a market: floor = fuel_price_minor x (cpi_bp / 10000) x
 * (maintenance_index_bp / 10000) x sustainability_multiplier. Index basis
 * points default to 10000 (= 1.0x) so a bare fuel price is a valid floor.
 *
 * Take-rate changes are worker-affecting economics and are gated through the
 * worker council: publishTakeRate requires an activation-eligible
 * consultation object of kind 'commission' (see workerCouncil).
 *
 * P7 flexible pricing modes: mobility.fare_rule_version carries a pricing
 * block (pricing_model / platform_fee_flat_kobo / platform_fee_payer,
 * drizzle/0106) supporting four models — 'commission' (percentage take
 * rate), 'flat_fee' (0% commission + a flat per-trip platform fee paid by
 * rider or driver), 'zero_commission' (0%, no fee) and 'subsidized'
 * (negative take rate down to -2000 bps = a bounded driver bonus funded by
 * the platform). Pricing-model publishes ride the SAME worker-council
 * consultation gate (kind 'commission') as take-rate changes.
 */

export type CostIndex = {
  fuel_price_minor: number;
  cpi_bp: number;
  maintenance_index_bp: number;
  source: string;
  updated_at: string;
};

export type FareFloorPolicyRow = {
  id: string;
  market_id: string;
  cost_index: CostIndex;
  sustainability_multiplier: string | number;
  active: boolean;
  consultation_id: string | null;
  created_by: number | string | null;
  created_at: string | Date;
};

export type TakeRateRow = {
  id: string;
  market_id: string;
  rate_bps: number;
  basis: "gross" | "net_of_tolls" | "net_of_costs";
  effective_from: string | Date;
  consultation_id: string | null;
  version: number;
  created_by: number | string | null;
  created_at: string | Date;
};

export const INDEX_BASE_BP = 10_000;

/** drizzle/0106: take_rate_registry rate_bps BETWEEN -2000 AND 5000. */
export const MIN_TAKE_RATE_BPS = -2000;
export const MAX_TAKE_RATE_BPS = 5000;

/**
 * Hot-read cache (perf wave W2, audit finding 9): the fare floor and latest
 * take rate are single indexed SELECTs read on every fare check / economics
 * call but written rarely (admin updateCostIndex / publishTakeRate /
 * recordFloorOverride). TTL 60s + write-through invalidation on the serving
 * process keeps fare-path reads off the database. Null results are cached
 * too — a market with no policy is the common case.
 */
const ECONOMICS_POLICY_CACHE_TTL_MS = 60_000;

const fareFloorPolicyCache = createHotCache<
  (FareFloorPolicyRow & { floor_minor: number }) | null
>({ ttlMs: ECONOMICS_POLICY_CACHE_TTL_MS });
const takeRateCache = createHotCache<TakeRateRow | null>({
  ttlMs: ECONOMICS_POLICY_CACHE_TTL_MS,
});
// P7: zone-scoped pricing block (fare_rule_version pricing columns), same
// hot-cache pattern as the take rate. Keyed `pricing:${zoneId}`.
const pricingModelCache = createHotCache<PricingPolicyBlock | null>({
  ttlMs: ECONOMICS_POLICY_CACHE_TTL_MS,
});

/**
 * Invalidate cached economics policy reads. Called by every mutation below;
 * exported (no argument = clear everything) for tests.
 */
export function invalidateEconomicsPolicyCache(marketId?: string): void {
  if (marketId === undefined) {
    fareFloorPolicyCache.clear();
    takeRateCache.clear();
    pricingModelCache.clear();
    return;
  }
  fareFloorPolicyCache.invalidate(`floor:${marketId}`);
  takeRateCache.invalidate(`take:${marketId}`);
}

/**
 * Invalidate the cached pricing block for one zone (called by
 * publishPricingModel) or every zone (tests / full reset).
 */
export function invalidatePricingModelCache(zoneId?: string): void {
  if (zoneId === undefined) {
    pricingModelCache.clear();
    return;
  }
  pricingModelCache.invalidate(`pricing:${zoneId}`);
}

function parseCostIndex(raw: unknown): CostIndex | null {
  if (!raw || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const fuel = Number(value.fuel_price_minor);
  if (!Number.isFinite(fuel) || fuel < 0) return null;
  const cpi = Number(value.cpi_bp);
  const maintenance = Number(value.maintenance_index_bp);
  return {
    fuel_price_minor: fuel,
    cpi_bp: Number.isFinite(cpi) ? cpi : INDEX_BASE_BP,
    maintenance_index_bp: Number.isFinite(maintenance)
      ? maintenance
      : INDEX_BASE_BP,
    source: typeof value.source === "string" ? value.source : "unknown",
    updated_at:
      typeof value.updated_at === "string"
        ? value.updated_at
        : new Date(0).toISOString(),
  };
}

/**
 * Pure floor computation, exported for tests. All money is minor units
 * (kobo). Index bps clamp to >= 0; multiplier falls back to 1.000 when the
 * numeric column arrives as a string.
 */
export function computeFareFloorMinor(
  costIndex: Pick<CostIndex, "fuel_price_minor" | "cpi_bp" | "maintenance_index_bp">,
  sustainabilityMultiplier: number | string = 1,
): number {
  const multiplier = Number(sustainabilityMultiplier);
  const fuel = Math.max(0, Number(costIndex.fuel_price_minor) || 0);
  const cpi = Math.max(0, Number(costIndex.cpi_bp) || 0);
  const maintenance = Math.max(0, Number(costIndex.maintenance_index_bp) || 0);
  // Integer arithmetic first (exact below 2^53), then the decimal multiplier
  // with an epsilon guard so exact products are not ceil'd up by FP error.
  const indexed = (fuel * cpi * maintenance) / (INDEX_BASE_BP * INDEX_BASE_BP);
  const raw = indexed * (Number.isFinite(multiplier) ? multiplier : 1);
  return Math.ceil(raw - 1e-9);
}

export async function getFareFloorPolicy(
  marketId: string,
): Promise<(FareFloorPolicyRow & { floor_minor: number }) | null> {
  const cacheKey = `floor:${marketId}`;
  const cached = fareFloorPolicyCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const pool = await getPool();
  const result = await pool.query<FareFloorPolicyRow>(
    `SELECT * FROM public.fare_floor_policies
     WHERE market_id = $1 AND active = true
     LIMIT 1`,
    [marketId],
  );
  const row = result.rows[0];
  if (!row) {
    fareFloorPolicyCache.set(cacheKey, null);
    return null;
  }
  const costIndex = parseCostIndex(row.cost_index);
  const floorMinor = costIndex
    ? computeFareFloorMinor(costIndex, row.sustainability_multiplier)
    : 0;
  const policy = { ...row, floor_minor: floorMinor };
  fareFloorPolicyCache.set(cacheKey, policy);
  return policy;
}

export async function getLatestTakeRate(
  marketId: string,
): Promise<TakeRateRow | null> {
  const cacheKey = `take:${marketId}`;
  const cached = takeRateCache.get(cacheKey);
  if (cached !== undefined) return cached;
  const pool = await getPool();
  const result = await pool.query<TakeRateRow>(
    `SELECT * FROM public.take_rate_registry
     WHERE market_id = $1
     ORDER BY version DESC
     LIMIT 1`,
    [marketId],
  );
  const rate = result.rows[0] ?? null;
  takeRateCache.set(cacheKey, rate);
  return rate;
}

/**
 * Upsert the cost index of the active floor policy for a market. When no
 * active policy exists yet, one is provisioned with the default
 * sustainability multiplier so markets can be onboarded cost-index-first.
 */
export async function updateCostIndex(
  actorUserId: number,
  input: {
    marketId: string;
    fuelPriceMinor: number;
    cpiBp: number;
    maintenanceIndexBp: number;
    source: string;
  },
): Promise<FareFloorPolicyRow & { floor_minor: number }> {
  const pool = await getPool();
  const costIndex: CostIndex = {
    fuel_price_minor: input.fuelPriceMinor,
    cpi_bp: input.cpiBp,
    maintenance_index_bp: input.maintenanceIndexBp,
    source: input.source,
    updated_at: new Date().toISOString(),
  };
  const updated = await pool.query<FareFloorPolicyRow>(
    `UPDATE public.fare_floor_policies
     SET cost_index = $2::jsonb
     WHERE market_id = $1 AND active = true
     RETURNING *`,
    [input.marketId, JSON.stringify(costIndex)],
  );
  let row = updated.rows[0];
  if (!row) {
    const inserted = await pool.query<FareFloorPolicyRow>(
      `INSERT INTO public.fare_floor_policies
         (market_id, cost_index, created_by)
       VALUES ($1, $2::jsonb, $3)
       RETURNING *`,
      [input.marketId, JSON.stringify(costIndex), actorUserId],
    );
    row = inserted.rows[0];
  }
  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "fare_floor_policy_upsert_failed",
    });
  }
  invalidateEconomicsPolicyCache(input.marketId);
  return { ...row, floor_minor: computeFareFloorMinor(costIndex, row.sustainability_multiplier) };
}

/**
 * Publish a new take-rate version for a market. Requires an
 * activation-eligible consultation object of kind 'commission' — the worker
 * council gate for platform take-rate changes (R5/R7).
 */
export async function publishTakeRate(
  actorUserId: number,
  input: {
    marketId: string;
    rateBps: number;
    basis: "gross" | "net_of_tolls" | "net_of_costs";
    effectiveFrom: string;
    consultationId: string;
  },
): Promise<TakeRateRow> {
  await assertConsultationEligible(input.consultationId, "commission");
  const pool = await getPool();
  const next = await pool.query<{ next_version: number }>(
    `SELECT COALESCE(max(version), 0) + 1 AS next_version
     FROM public.take_rate_registry
     WHERE market_id = $1`,
    [input.marketId],
  );
  const nextVersion = Number(next.rows[0]?.next_version ?? 1);
  const inserted = await pool.query<TakeRateRow>(
    `INSERT INTO public.take_rate_registry
       (market_id, rate_bps, basis, effective_from, consultation_id, version, created_by)
     VALUES ($1, $2, $3, $4::timestamptz, $5, $6, $7)
     RETURNING *`,
    [
      input.marketId,
      input.rateBps,
      input.basis,
      input.effectiveFrom,
      input.consultationId,
      nextVersion,
      actorUserId,
    ],
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "take_rate_publish_failed",
    });
  }
  invalidateEconomicsPolicyCache(input.marketId);
  return row;
}

export async function checkFareAgainstFloor(input: {
  marketId: string;
  fareMinor: number;
}): Promise<{ allowed: boolean; floorMinor: number | null; requiresOverride: boolean }> {
  const policy = await getFareFloorPolicy(input.marketId);
  if (!policy) {
    return { allowed: true, floorMinor: null, requiresOverride: false };
  }
  const allowed = input.fareMinor >= policy.floor_minor;
  return { allowed, floorMinor: policy.floor_minor, requiresOverride: !allowed };
}

/**
 * Record an operator override of the fare floor. Every override is auditable
 * (fare_floor_overrides) AND auto-posted to the worker council as a 'pricing'
 * consultation object so the floor cannot be quietly undercut (R5/R6).
 */
export async function recordFloorOverride(
  actorUserId: number,
  input: { marketId: string; fareMinor: number; justification: string },
): Promise<{ overrideId: string; floorMinor: number; consultationId: string }> {
  const policy = await getFareFloorPolicy(input.marketId);
  if (!policy) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "fare_floor_policy_not_found",
    });
  }
  const pool = await getPool();
  const inserted = await pool.query<{ id: string }>(
    `INSERT INTO public.fare_floor_overrides
       (market_id, operator_id, justification, fare_minor, floor_minor)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      input.marketId,
      actorUserId,
      input.justification,
      input.fareMinor,
      policy.floor_minor,
    ],
  );
  const override = inserted.rows[0];
  if (!override) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "fare_floor_override_failed",
    });
  }
  // Overrides accompany manual floor interventions; drop the cached read so
  // the next fare check re-reads the policy the operator just acted on.
  invalidateEconomicsPolicyCache(input.marketId);
  const consultation = await postConsultation(actorUserId, {
    kind: "pricing",
    title: `Fare floor override in ${input.marketId}`,
    payload: {
      override_id: override.id,
      market_id: input.marketId,
      fare_minor: input.fareMinor,
      floor_minor: policy.floor_minor,
      justification: input.justification,
    },
    responseSlaHours: 72,
  });
  return {
    overrideId: override.id,
    floorMinor: policy.floor_minor,
    consultationId: consultation.id,
  };
}

export type MarketEconomicsReportRow = {
  id: string;
  market_id: string;
  period: unknown;
  report: unknown;
  created_at: string | Date;
};

export type MarketEconomicsReportResult = {
  marketId: string;
  persisted: boolean;
  unavailable: boolean;
  reportId: string | null;
  createdAt: string | null;
};

/**
 * Generate a published market economics report through the market-economics
 * service (POST /reports/generate) and persist the machine-readable output
 * in public.market_economics_reports (drizzle/0092) — durability belongs to
 * the caller, the service only caches in-memory.
 *
 * The request carries the currently published take rate and fare floor for
 * the market. Per-trip aggregates are not exported server-side yet, so
 * `trips` is an empty set (the service accepts it and reports zero-volume
 * economics); wiring the trip aggregate export is follow-up work.
 *
 * Fail-open: a service outage never throws into the operator path — the
 * result is { persisted: false, unavailable: true }.
 */
export async function generateMarketEconomicsReport(
  actorUserId: number,
  input: { marketId: string; periodStart: string; periodEnd: string },
): Promise<MarketEconomicsReportResult> {
  const takeRate = await getLatestTakeRate(input.marketId);
  const floor = await getFareFloorPolicy(input.marketId);
  const base = ENV.marketEconomicsUrl.replace(/\/$/, "");
  try {
    const response = await resilientFetch(`${base}/reports/generate`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Internal-Service-Token": ENV.internalServiceToken,
      },
      body: JSON.stringify({
        market_id: input.marketId,
        period: { start: input.periodStart, end: input.periodEnd },
        trips: [],
        published_take_rate_bps: takeRate?.rate_bps ?? 0,
        fare_floor_minor: floor?.floor_minor ?? 0,
      }),
      timeoutMs: 10_000,
      maxAttempts: 1,
    });
    if (!response.ok) {
      throw new Error(`reports/generate returned status ${response.status}`);
    }
    const body = (await response.json()) as { report?: unknown };
    if (!body.report || typeof body.report !== "object") {
      throw new Error("reports/generate response invalid");
    }
    const pool = await getPool();
    const inserted = await pool.query<MarketEconomicsReportRow>(
      `INSERT INTO public.market_economics_reports (market_id, period, report)
       VALUES ($1, $2::jsonb, $3::jsonb)
       RETURNING *`,
      [
        input.marketId,
        JSON.stringify({ start: input.periodStart, end: input.periodEnd }),
        JSON.stringify(body.report),
      ],
    );
    const row = inserted.rows[0];
    if (!row) {
      throw new Error("market_economics_report_persist_failed");
    }
    return {
      marketId: input.marketId,
      persisted: true,
      unavailable: false,
      reportId: row.id,
      createdAt: new Date(row.created_at).toISOString(),
    };
  } catch (error) {
    console.warn(
      `[economicsPolicy] market-economics reports/generate unavailable for ${input.marketId} (actor ${actorUserId}); failing open`,
      error,
    );
    return {
      marketId: input.marketId,
      persisted: false,
      unavailable: true,
      reportId: null,
      createdAt: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Flexible pricing modes (P7)
// ---------------------------------------------------------------------------

export type PricingModel =
  | "commission"
  | "flat_fee"
  | "zero_commission"
  | "subsidized";

export type PlatformFeePayer = "rider" | "driver";

export const PRICING_MODELS: readonly PricingModel[] = [
  "commission",
  "flat_fee",
  "zero_commission",
  "subsidized",
];

/**
 * Zone-scoped pricing block resolved from the live mobility
 * .fare_rule_version row (drizzle/0106 columns). flatFeeKobo is 0 unless the
 * model is 'flat_fee' (the fee-required invariant is enforced by the
 * fare_rule_version_flat_fee_required_check CHECK and again TS-side in
 * publishPricingModel).
 */
export type PricingPolicyBlock = {
  fareRuleId: string;
  zoneId: string;
  model: PricingModel;
  flatFeeKobo: number;
  feePayer: PlatformFeePayer;
};

/** Raw pricing columns as read from mobility.fare_rule_version. */
export type PricingModelRow = {
  pricing_model?: string | null;
  platform_fee_flat_kobo?: string | number | null;
  platform_fee_payer?: string | null;
};

/**
 * Normalize the pricing columns of a fare_rule_version row into the pricing
 * triple. Legacy rows (or a database without drizzle/0106 applied) read as
 * the pre-P7 behaviour: commission model, no flat fee, rider payer. Unknown
 * model/payer values fall back to the same safe defaults.
 */
export function normalizePricingModelRow(row: PricingModelRow): {
  model: PricingModel;
  flatFeeKobo: number;
  feePayer: PlatformFeePayer;
} {
  const model = PRICING_MODELS.includes(row.pricing_model as PricingModel)
    ? (row.pricing_model as PricingModel)
    : "commission";
  const rawFee = Number(row.platform_fee_flat_kobo);
  const flatFeeKobo =
    model === "flat_fee" && Number.isFinite(rawFee) && rawFee > 0
      ? Math.trunc(rawFee)
      : 0;
  const feePayer: PlatformFeePayer =
    row.platform_fee_payer === "driver" ? "driver" : "rider";
  return { model, flatFeeKobo, feePayer };
}

/**
 * Resolve the active pricing block for a service zone: the live
 * fare_rule_version pricing columns (hot-cached per zone like the take
 * rate) plus the published take rate for the market (which may be negative
 * down to -2000 bps — a bounded subsidy). The take rate is resolved per call
 * through getLatestTakeRate's own cache so publishTakeRate invalidation
 * stays authoritative even though the pricing cache is keyed by zone.
 * Returns null when the zone has no live fare rule version.
 */
export async function resolvePricingModel(
  zoneId: string,
  marketId?: string,
): Promise<(PricingPolicyBlock & { takeRateBps: number }) | null> {
  const cacheKey = `pricing:${zoneId}`;
  let block = pricingModelCache.get(cacheKey);
  if (block === undefined) {
    const pool = await getPool();
    const result = await pool.query<
      PricingModelRow & { fare_rule_id: string }
    >(
      `SELECT id AS fare_rule_id, pricing_model, platform_fee_flat_kobo,
              platform_fee_payer
         FROM mobility.fare_rule_version
        WHERE zone_id = $1
          AND effective_from <= now()
          AND (effective_to IS NULL OR effective_to > now())
        ORDER BY effective_from DESC
        LIMIT 1`,
      [zoneId],
    );
    const row = result.rows[0];
    block = row
      ? { fareRuleId: row.fare_rule_id, zoneId, ...normalizePricingModelRow(row) }
      : null;
    pricingModelCache.set(cacheKey, block);
  }
  if (!block) return null;
  const takeRate = marketId ? await getLatestTakeRate(marketId) : null;
  return { ...block, takeRateBps: takeRate ? Number(takeRate.rate_bps) : 0 };
}

export type SettlementSplit = {
  /** Driver take-home. commission negative => includes the driver bonus. */
  driverEarningsKobo: bigint;
  /** Platform commission; negative under 'subsidized' (a driver bonus). */
  commissionKobo: bigint;
  /** Flat per-trip platform fee (0 unless the model is 'flat_fee'). */
  platformFeeKobo: bigint;
  feePayer: PlatformFeePayer;
};

/**
 * Pure settlement split for one trip, integer kobo exact (BigInt; the bps
 * multiply truncates toward zero, so a subsidy bonus is never rounded up).
 * `grossKobo` is the SETTLEMENT gross (the fare portion; a rider-paid flat
 * fee sits outside it — see drizzle/0106 header). Honours all four models:
 *
 * - commission:     commission = gross x rateBps / 10000
 * - zero_commission / flat_fee: commission = 0 (flat fee replaces the take)
 * - subsidized:     commission = gross x rateBps / 10000 with rateBps < 0,
 *                   i.e. a driver bonus; clamped to >= -gross (the 0106 CHECK
 *                   bounds the published rate at -2000 bps, well inside).
 *
 * Identity (matches trip_settlement_identity_check):
 *   gross = driverEarnings + commission + tax + (platformFee when driver-paid)
 * A rider-paid fee is OUTSIDE the identity (collected on top of gross).
 */
export function computeSettlementSplit(input: {
  grossKobo: number | bigint;
  taxKobo?: number | bigint;
  pricing: {
    model: PricingModel;
    takeRateBps?: number;
    flatFeeKobo?: number | bigint | null;
    feePayer?: PlatformFeePayer;
  };
}): SettlementSplit {
  const gross = BigInt(input.grossKobo);
  const tax = BigInt(input.taxKobo ?? 0);
  const rateBps = Math.trunc(Number(input.pricing.takeRateBps ?? 0));
  let commissionKobo: bigint;
  if (
    input.pricing.model === "commission" ||
    input.pricing.model === "subsidized"
  ) {
    commissionKobo = (gross * BigInt(rateBps)) / 10_000n;
    if (commissionKobo < -gross) commissionKobo = -gross;
  } else {
    commissionKobo = 0n;
  }
  const feePayer: PlatformFeePayer =
    input.pricing.feePayer === "driver" ? "driver" : "rider";
  const rawFee = BigInt(
    input.pricing.model === "flat_fee" ? (input.pricing.flatFeeKobo ?? 0) : 0,
  );
  const platformFeeKobo = rawFee > 0n ? rawFee : 0n;
  const driverEarningsKobo =
    gross - tax - commissionKobo - (feePayer === "driver" ? platformFeeKobo : 0n);
  return { driverEarningsKobo, commissionKobo, platformFeeKobo, feePayer };
}

/** Validate the pricing-model invariants TS-side (they back the 0106 CHECKs). */
export function assertValidPricingModelInput(input: {
  model: PricingModel;
  flatFeeKobo?: number | null;
}): void {
  if (!PRICING_MODELS.includes(input.model)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "pricing_model_invalid",
    });
  }
  const fee = input.flatFeeKobo;
  if (input.model === "flat_fee") {
    if (fee === null || fee === undefined || !Number.isInteger(fee) || fee < 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "platform_fee_required_for_flat_fee",
      });
    }
  } else if (fee !== null && fee !== undefined && fee !== 0) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "platform_fee_only_for_flat_fee",
    });
  }
}

function nextPricingVersion(current: string): string {
  if (/^\d+$/.test(current)) return String(Number(current) + 1);
  return `${current}+pricing.${Date.now()}`;
}

export type PublishPricingModelResult = {
  fareRuleId: string;
  zoneId: string;
  version: string;
  model: PricingModel;
  flatFeeKobo: number;
  feePayer: PlatformFeePayer;
  effectiveFrom: string;
};

/**
 * Publish a new pricing model for a zone (P7). Versioned: the live
 * fare_rule_version row is closed (effective_to = now) and a successor row
 * is inserted with identical fare parameters and the new pricing block, so
 * fare history is preserved and the one-live-row partial unique index holds.
 * Worker-council gated through the SAME 'commission' consultation kind as
 * take-rate changes (P7_SPEC deliverable 2: the consultation gate extends to
 * pricing-model changes).
 */
export async function publishPricingModel(
  actorUserId: number,
  input: {
    zoneId: string;
    model: PricingModel;
    flatFeeKobo?: number | null;
    feePayer: PlatformFeePayer;
    consultationId: string;
    version?: string;
  },
): Promise<PublishPricingModelResult> {
  assertValidPricingModelInput(input);
  await assertConsultationEligible(input.consultationId, "commission");
  const pool = await getPool();
  const client = await pool.connect();
  let inserted: { id: string; effective_from: string | Date } | undefined;
  let version = "";
  try {
    await client.query("BEGIN");
    const live = await client.query<
      {
        id: string;
        zone_id: string;
        version: string;
        currency: string;
        base_kobo: string | number;
        per_km_kobo: string | number;
        per_minute_kobo: string | number;
        minimum_kobo: string | number;
        cancellation_kobo: string | number;
        demand_cap_basis_points: number;
      }
    >(
      `SELECT id, zone_id, version, currency, base_kobo, per_km_kobo,
              per_minute_kobo, minimum_kobo, cancellation_kobo,
              demand_cap_basis_points
         FROM mobility.fare_rule_version
        WHERE zone_id = $1
          AND effective_from <= now()
          AND (effective_to IS NULL OR effective_to > now())
        ORDER BY effective_from DESC
        LIMIT 1
        FOR UPDATE`,
      [input.zoneId],
    );
    const current = live.rows[0];
    if (!current) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "fare_rule_version_not_found",
      });
    }
    await client.query(
      `UPDATE mobility.fare_rule_version SET effective_to = now() WHERE id = $1`,
      [current.id],
    );
    version = input.version ?? nextPricingVersion(current.version);
    const result = await client.query<{ id: string; effective_from: string }>(
      `INSERT INTO mobility.fare_rule_version (
         zone_id, version, currency, base_kobo, per_km_kobo, per_minute_kobo,
         minimum_kobo, cancellation_kobo, demand_cap_basis_points,
         effective_from, effective_to, approved_by,
         pricing_model, platform_fee_flat_kobo, platform_fee_payer
       ) VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9,
         now(), NULL, $10,
         $11, $12, $13
       ) RETURNING id, effective_from`,
      [
        current.zone_id,
        version,
        current.currency,
        current.base_kobo,
        current.per_km_kobo,
        current.per_minute_kobo,
        current.minimum_kobo,
        current.cancellation_kobo,
        current.demand_cap_basis_points,
        actorUserId,
        input.model,
        input.model === "flat_fee" ? input.flatFeeKobo ?? null : null,
        input.feePayer,
      ],
    );
    inserted = result.rows[0];
    if (!inserted) {
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: "pricing_model_publish_failed",
      });
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  invalidatePricingModelCache(input.zoneId);
  return {
    fareRuleId: inserted.id,
    zoneId: input.zoneId,
    version,
    model: input.model,
    flatFeeKobo: input.model === "flat_fee" ? Number(input.flatFeeKobo) : 0,
    feePayer: input.feePayer,
    effectiveFrom: new Date(inserted.effective_from).toISOString(),
  };
}

/** Example fare levels (kobo) for previewPricingImpact: ₦1,500 / ₦4,000 / ₦9,000. */
export const PREVIEW_FARE_LEVELS_KOBO = [150_000, 400_000, 900_000];

export type PricingImpactPreview = {
  model: PricingModel;
  feePayer: PlatformFeePayer;
  flatFeeKobo: number;
  takeRateBps: number;
  examples: Array<{
    grossKobo: number;
    riderTotalKobo: number;
    driverEarningsKobo: number;
    commissionKobo: number;
    platformFeeKobo: number;
  }>;
};

/**
 * Pure what-if preview for operators (no writes, no DB): run the settlement
 * split for a candidate pricing block at three fare levels. Tax is zero in
 * the preview so the pricing effect is isolated.
 */
export function previewPricingImpact(input: {
  model: PricingModel;
  feePayer: PlatformFeePayer;
  flatFeeKobo?: number | null;
  takeRateBps?: number;
  fareLevelsKobo?: number[];
}): PricingImpactPreview {
  assertValidPricingModelInput(input);
  const takeRateBps = Math.trunc(Number(input.takeRateBps ?? 0));
  if (takeRateBps < MIN_TAKE_RATE_BPS || takeRateBps > MAX_TAKE_RATE_BPS) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "take_rate_out_of_bounds",
    });
  }
  const levels =
    input.fareLevelsKobo && input.fareLevelsKobo.length > 0
      ? input.fareLevelsKobo
      : PREVIEW_FARE_LEVELS_KOBO;
  return {
    model: input.model,
    feePayer: input.feePayer,
    flatFeeKobo: input.model === "flat_fee" ? Number(input.flatFeeKobo) : 0,
    takeRateBps,
    examples: levels.map((gross) => {
      const split = computeSettlementSplit({
        grossKobo: gross,
        taxKobo: 0,
        pricing: {
          model: input.model,
          takeRateBps,
          flatFeeKobo: input.flatFeeKobo ?? 0,
          feePayer: input.feePayer,
        },
      });
      return {
        grossKobo: gross,
        riderTotalKobo:
          gross +
          (split.feePayer === "rider" ? Number(split.platformFeeKobo) : 0),
        driverEarningsKobo: Number(split.driverEarningsKobo),
        commissionKobo: Number(split.commissionKobo),
        platformFeeKobo: Number(split.platformFeeKobo),
      };
    }),
  };
}
