/**
 * Pure settlement math for the rental condition & insurance wave.
 *
 * These helpers mirror, in TypeScript, the exact arithmetic performed by
 * vehicle_access.compute_return_settlement / select_contract_insurance in
 * drizzle/0096_rental_condition_insurance.sql so the operator UI can preview
 * numbers that match what the database will persist. No I/O, no imports —
 * unit-tested directly.
 */

/** Milliseconds in one billing week (7 * 24 * 60 * 60 * 1000). */
export const MS_PER_WEEK = 604_800_000;

/**
 * Billed weeks: GREATEST(1, CEIL(diff / 1 week)) — identical to the SQL
 * `GREATEST(1, CEIL(EXTRACT(EPOCH FROM (p_now - activated_at))/604800.0)::int)`.
 * Throws when now is not strictly after activation (the SQL function is only
 * reachable on an activated contract, so a non-positive diff is a caller bug).
 */
export function computeBilledWeeks(
  activatedAtIso: string,
  nowIso: string,
): number {
  const activatedAtMs = Date.parse(activatedAtIso);
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(activatedAtMs) || !Number.isFinite(nowMs)) {
    throw new RangeError("invalid ISO timestamp");
  }
  const diffMs = nowMs - activatedAtMs;
  if (diffMs <= 0) {
    throw new RangeError("now must be after activatedAt");
  }
  return Math.max(1, Math.ceil(diffMs / MS_PER_WEEK));
}

/**
 * Included / excess kilometres for a return:
 * included = includedKmPerWeek * billedWeeks; excess = max(0, distance - included).
 */
export function computeExcessKm(args: {
  distanceKm: number;
  includedKmPerWeek: number;
  billedWeeks: number;
}): { includedKm: number; excessKm: number } {
  const includedKm = args.includedKmPerWeek * args.billedWeeks;
  const excessKm = Math.max(0, args.distanceKm - includedKm);
  return { includedKm, excessKm };
}

/**
 * Excess-km charge in minor units with a bigint-range guard mirroring the
 * SQL overflow check (RAISE 22003 in 0058 style). Throws RangeError when the
 * product is not a safe integer.
 */
export function computeExcessKmCharge(
  excessKm: number,
  excessKmPriceMinor: number,
): number {
  const charge = excessKm * excessKmPriceMinor;
  if (!Number.isSafeInteger(charge)) {
    throw new RangeError("excess km charge exceeds bigint range");
  }
  return charge;
}

/**
 * Damage-cost split between renter and insurer.
 * Without a selected tier the renter bears the full damage charge. With a
 * tier: renter pays min(damage, excess), insurance credits
 * min(max(damage - excess, 0), damageCap).
 */
export function computeDamageSplit(
  damageChargeMinor: number,
  tier: { excessMinor: number; damageCapMinor: number } | null,
): { renterLiabilityMinor: number; insuranceCreditMinor: number } {
  if (!tier) {
    return {
      renterLiabilityMinor: damageChargeMinor,
      insuranceCreditMinor: 0,
    };
  }
  const renterLiabilityMinor = Math.min(damageChargeMinor, tier.excessMinor);
  const insuranceCreditMinor = Math.min(
    Math.max(damageChargeMinor - tier.excessMinor, 0),
    tier.damageCapMinor,
  );
  return { renterLiabilityMinor, insuranceCreditMinor };
}

/**
 * Tier-adjusted deposit: round(base * multiplierBp / 10000), matching the
 * `round(base_deposit * bp / 10000)` snapshot recompute in
 * select_contract_insurance. Math.round rounds .5 up for positive amounts.
 * Throws RangeError when the result is not a safe integer.
 */
export function computeDepositWithMultiplier(
  baseDepositMinor: number,
  multiplierBp: number,
): number {
  const deposit = Math.round((baseDepositMinor * multiplierBp) / 10_000);
  if (!Number.isSafeInteger(deposit)) {
    throw new RangeError("adjusted deposit exceeds bigint range");
  }
  return deposit;
}

/**
 * Damage zones flagged at check-in that were not flagged at check-out —
 * sorted set difference, matching the jsonb array built by
 * compute_return_settlement.
 */
export function computeNewDamageZones(
  checkOutZones: string[],
  checkInZones: string[],
): string[] {
  const atCheckOut = new Set(checkOutZones);
  return [...new Set(checkInZones.filter((zone) => !atCheckOut.has(zone)))].sort();
}
