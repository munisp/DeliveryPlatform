import { TRPCError } from "@trpc/server";

import { getPool } from "../db";
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
  const pool = await getPool();
  const result = await pool.query<FareFloorPolicyRow>(
    `SELECT * FROM public.fare_floor_policies
     WHERE market_id = $1 AND active = true
     LIMIT 1`,
    [marketId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const costIndex = parseCostIndex(row.cost_index);
  const floorMinor = costIndex
    ? computeFareFloorMinor(costIndex, row.sustainability_multiplier)
    : 0;
  return { ...row, floor_minor: floorMinor };
}

export async function getLatestTakeRate(
  marketId: string,
): Promise<TakeRateRow | null> {
  const pool = await getPool();
  const result = await pool.query<TakeRateRow>(
    `SELECT * FROM public.take_rate_registry
     WHERE market_id = $1
     ORDER BY version DESC
     LIMIT 1`,
    [marketId],
  );
  return result.rows[0] ?? null;
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
