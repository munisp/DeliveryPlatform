/**
 * Wire-shape normalizers for the economics and pricing-transparency routers
 * (`economics`, `pricingTransparency`).
 *
 * The server returns raw snake_case Postgres rows (see
 * server/_core/economicsPolicy.ts and server/_core/offerEconomics.ts) while
 * the PWA pages consume the camelCase DTOs declared in
 * `./trpcEconomicsSafety`. Money columns are Postgres bigints and may arrive
 * as strings, so every minor-unit field is coerced with `Number` — without
 * this the fare breakdown renders NaN. These functions are free of
 * trpc/react imports so the wire contract test
 * (tests/pwa-wire-contract.test.ts) can exercise them against fixtures copied
 * verbatim from the server modules.
 */
import type {
  CostIndex,
  FareFloor,
  NetEarningsSummary,
  OfferBreakdown,
  TakeRate,
} from "./trpcEconomicsSafety";

// ---------- wire rows (column names verbatim from server/_core/economicsPolicy.ts;
// props optional because the typed client sees superjson-serialized output) ----------

/** server `_core/economicsPolicy.ts` `CostIndex` */
export interface CostIndexWire {
  fuel_price_minor?: number;
  cpi_bp?: number;
  maintenance_index_bp?: number;
  source?: string;
  updated_at?: string;
}

/** server `_core/economicsPolicy.ts` `FareFloorPolicyRow & { floor_minor: number }` */
export interface FareFloorPolicyRowWire {
  id?: string;
  market_id?: string;
  cost_index?: CostIndexWire;
  sustainability_multiplier?: string | number;
  active?: boolean;
  consultation_id?: string | null;
  created_by?: number | string | null;
  created_at?: string | Date;
  floor_minor?: number;
}

/** server `_core/economicsPolicy.ts` `TakeRateRow` */
export interface TakeRateRowWire {
  id?: string;
  market_id?: string;
  rate_bps?: number;
  basis?: string;
  effective_from?: string | Date;
  consultation_id?: string | null;
  version?: number;
  created_by?: number | string | null;
  created_at?: string | Date;
}

// ---------- wire rows (column names verbatim from server/_core/offerEconomics.ts;
// props optional because the typed client sees superjson-serialized output) ----------

/** server `_core/offerEconomics.ts` `OfferEconomicsBreakdownRow` */
export interface OfferEconomicsBreakdownRowWire {
  id?: string;
  offer_id?: string;
  market_id?: string | null;
  base_minor?: string | number;
  distance_minor?: string | number;
  time_minor?: string | number;
  deadhead_minor?: string | number;
  pickup_seconds?: number;
  pickup_meters?: number;
  surge_bps?: number;
  take_rate_bps?: number;
  platform_fee_minor?: string | number;
  net_to_driver_minor?: string | number;
  currency?: string;
  created_at?: string | Date;
}

/** server `_core/offerEconomics.ts` `getMyNetEarningsSummary` return shape */
export interface NetEarningsSummaryWire {
  currency?: string;
  windowDays?: number;
  offers?: number;
  grossMinor?: number;
  deadheadMinor?: number;
  platformFeeMinor?: number;
  netToDriverMinor?: number;
}

// ---------- coercion helpers ----------

/** bigint columns arrive as string|number; coerce defensively, never NaN. */
function minor(value: string | number | null | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

// ---------- economics normalizers ----------

export function normalizeCostIndex(wire: CostIndexWire): CostIndex {
  return {
    fuelPriceMinor: minor(wire.fuel_price_minor),
    cpiBp: minor(wire.cpi_bp),
    maintenanceIndexBp: minor(wire.maintenance_index_bp),
    source: typeof wire.source === "string" ? wire.source : "unknown",
    updatedAt:
      typeof wire.updated_at === "string"
        ? wire.updated_at
        : new Date(0).toISOString(),
  };
}

/** Map `economics.getFareFloor` (raw policy row + floor_minor) to the DTO. */
export function normalizeFareFloor(
  row: FareFloorPolicyRowWire | null,
): FareFloor | null {
  if (!row) return null;
  return {
    id: row.id,
    marketId: row.market_id,
    costIndex: normalizeCostIndex(row.cost_index ?? {}),
    floorMinor: minor(row.floor_minor),
    sustainabilityMultiplier: minor(row.sustainability_multiplier),
    active: Boolean(row.active),
    consultationId: row.consultation_id ?? null,
  };
}

/** Map `economics.getTakeRate` (raw registry row) to the DTO. */
export function normalizeTakeRate(row: TakeRateRowWire | null): TakeRate | null {
  if (!row) return null;
  return {
    marketId: row.market_id,
    rateBps: minor(row.rate_bps),
    basis: row.basis,
    effectiveFrom: iso(row.effective_from),
    version: minor(row.version),
  };
}

// ---------- pricingTransparency normalizers ----------

/**
 * Map `pricingTransparency.getOfferBreakdown` (raw
 * `offer_economics_breakdowns` row) to the DTO. All bigint money columns are
 * coerced to numbers so the fare breakdown never renders NaN.
 */
export function normalizeOfferBreakdown(
  row: OfferEconomicsBreakdownRowWire,
): OfferBreakdown {
  return {
    offerId: row.offer_id,
    marketId: row.market_id ?? "",
    baseMinor: minor(row.base_minor),
    distanceMinor: minor(row.distance_minor),
    timeMinor: minor(row.time_minor),
    deadheadMinor: minor(row.deadhead_minor),
    pickupSeconds: minor(row.pickup_seconds),
    pickupMeters: minor(row.pickup_meters),
    surgeBps: minor(row.surge_bps),
    takeRateBps: minor(row.take_rate_bps),
    platformFeeMinor: minor(row.platform_fee_minor),
    netToDriverMinor: minor(row.net_to_driver_minor),
    currency: row.currency ?? "NGN",
  };
}

/**
 * Map `pricingTransparency.getMyNetEarningsSummary` to the DTO. The server
 * already returns camelCase keys, but under different names (`offers`,
 * `platformFeeMinor`, `netToDriverMinor`) than the earnings card consumes
 * (`trips30d`, `platformFeesMinor`, `netMinor`).
 */
export function normalizeNetEarningsSummary(
  row: NetEarningsSummaryWire,
): NetEarningsSummary {
  return {
    currency: row.currency ?? "NGN",
    trips30d: minor(row.offers),
    grossMinor: minor(row.grossMinor),
    deadheadMinor: minor(row.deadheadMinor),
    platformFeesMinor: minor(row.platformFeeMinor),
    netMinor: minor(row.netToDriverMinor),
  };
}
