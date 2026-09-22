import { TRPCError } from "@trpc/server";

import { getPool } from "../db";
import { createHotCache } from "./hotCache";
import { postConsultation } from "./workerCouncil";

/**
 * Driver protection (R11 insurance/downtime, R12 remittance-aware floor).
 *
 * R11: each market publishes a protection policy — a per-trip micro-premium
 * and protection levy priced into the market cost index (so riders fund the
 * cover, not drivers) plus an accident-downtime daily stipend. Enrollment is
 * automatic-by-default with an opt-out only where the policy allows it.
 * Claims follow filed -> approved -> paid (or rejected). Vetted maintenance
 * providers are listed vetted-first.
 *
 * R12: hire-purchase/rental remittance schedules can only change with a
 * driver-facing notice that requires re-acceptance; enforcement of new
 * terms is blocked (canEnforceRemittance) until the driver accepts OR the
 * 14-day mediation window expires. Mediation requests extend the window.
 * Repossession-style enforcement without notice is structurally blocked.
 */

export const CLAIM_KINDS = ["accident_downtime", "maintenance", "other"] as const;
export type ClaimKind = (typeof CLAIM_KINDS)[number];

export const REMITTANCE_FREQUENCIES = ["daily", "weekly", "monthly"] as const;
export type RemittanceFrequency = (typeof REMITTANCE_FREQUENCIES)[number];

export const MEDIATION_WINDOW_DAYS = 14;

export type ProtectionPolicyRow = {
  id: string;
  market_id: string;
  micro_premium_minor: number | string;
  downtime_daily_stipend_minor: number | string;
  protection_levy_minor: number | string;
  opt_out_allowed: boolean;
  active: boolean;
  consultation_id: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

export type ProtectionEnrollmentRow = {
  id: string;
  driver_id: number | string;
  policy_id: string;
  status: "enrolled" | "opted_out" | "suspended";
  enrolled_at: string | Date;
  opt_out_at: string | Date | null;
};

export type ProtectionClaimRow = {
  id: string;
  enrollment_id: string;
  kind: ClaimKind;
  status: "filed" | "approved" | "rejected" | "paid";
  amount_minor: number | string | null;
  currency: string;
  evidence: unknown;
  filed_at: string | Date;
  decided_at: string | Date | null;
  decided_by: number | string | null;
};

export type MaintenanceProviderRow = {
  id: string;
  name: string;
  city: string;
  services: unknown;
  vetted: boolean;
  contact: unknown;
  created_at: string | Date;
};

export type RemittanceScheduleRow = {
  id: string;
  driver_id: number | string;
  vehicle_contract_ref: string | null;
  amount_minor: number | string;
  currency: string;
  frequency: RemittanceFrequency;
  next_due_at: string | Date | null;
  status: "current" | "renegotiating" | "mediation" | "defaulted";
  version: number;
  created_at: string | Date;
  updated_at: string | Date;
};

export type RemittanceChangeNoticeRow = {
  id: string;
  schedule_id: string;
  old_amount_minor: number | string;
  new_amount_minor: number | string;
  effective_at: string | Date;
  requires_reacceptance: boolean;
  accepted_at: string | Date | null;
  mediation_window_ends_at: string | Date | null;
  created_at: string | Date;
};

/**
 * Hot-read cache (perf wave W2, audit finding 9): getPolicy is a single
 * indexed SELECT by unique market_id read on enrollment/claim/premium paths,
 * written only by upsertPolicy. TTL 5m + write-through invalidation. Null
 * results (market without a policy) are cached too.
 */
const PROTECTION_POLICY_CACHE_TTL_MS = 5 * 60_000;

const protectionPolicyCache = createHotCache<ProtectionPolicyRow | null>({
  ttlMs: PROTECTION_POLICY_CACHE_TTL_MS,
});

/**
 * Invalidate cached protection-policy reads. Called by upsertPolicy;
 * exported (no argument = clear everything) for tests.
 */
export function invalidateProtectionPolicyCache(marketId?: string): void {
  if (marketId === undefined) {
    protectionPolicyCache.clear();
    return;
  }
  protectionPolicyCache.invalidate(marketId);
}

export async function getPolicy(
  marketId: string,
): Promise<ProtectionPolicyRow | null> {
  const cached = protectionPolicyCache.get(marketId);
  if (cached !== undefined) return cached;
  const pool = await getPool();
  const result = await pool.query<ProtectionPolicyRow>(
    `SELECT * FROM public.protection_policies WHERE market_id = $1`,
    [marketId],
  );
  const policy = result.rows[0] ?? null;
  protectionPolicyCache.set(marketId, policy);
  return policy;
}

export async function getMyEnrollment(driverId: number): Promise<{
  enrollment: ProtectionEnrollmentRow;
  policy: ProtectionPolicyRow;
} | null> {
  const pool = await getPool();
  const result = await pool.query<
    ProtectionEnrollmentRow & { policy_id_ref: string }
  >(
    `SELECT e.*, p.id AS policy_id_ref
     FROM public.protection_enrollments e
     JOIN public.protection_policies p ON p.id = e.policy_id
     WHERE e.driver_id = $1`,
    [driverId],
  );
  const row = result.rows[0];
  if (!row) return null;
  const policy = await pool.query<ProtectionPolicyRow>(
    `SELECT * FROM public.protection_policies WHERE id = $1`,
    [row.policy_id],
  );
  if (!policy.rows[0]) return null;
  return { enrollment: row, policy: policy.rows[0] };
}

export async function enroll(
  driverId: number,
  input: { marketId: string },
): Promise<{ enrollment: ProtectionEnrollmentRow; policy: ProtectionPolicyRow }> {
  const policy = await getPolicy(input.marketId);
  if (!policy || !policy.active) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "protection_policy_not_found",
    });
  }
  const pool = await getPool();
  const upserted = await pool.query<ProtectionEnrollmentRow>(
    `INSERT INTO public.protection_enrollments (driver_id, policy_id)
     VALUES ($1, $2)
     ON CONFLICT (driver_id)
     DO UPDATE SET policy_id = EXCLUDED.policy_id,
                   status = 'enrolled',
                   opt_out_at = NULL
     RETURNING *`,
    [driverId, policy.id],
  );
  const enrollment = upserted.rows[0];
  if (!enrollment) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "protection_enrollment_failed",
    });
  }
  return { enrollment, policy };
}

export async function optOut(
  driverId: number,
): Promise<ProtectionEnrollmentRow> {
  const current = await getMyEnrollment(driverId);
  if (!current) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "protection_enrollment_not_found",
    });
  }
  if (!current.policy.opt_out_allowed) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "opt_out_not_allowed",
    });
  }
  const pool = await getPool();
  const updated = await pool.query<ProtectionEnrollmentRow>(
    `UPDATE public.protection_enrollments
     SET status = 'opted_out', opt_out_at = now()
     WHERE id = $1 AND status = 'enrolled'
     RETURNING *`,
    [current.enrollment.id],
  );
  const row = updated.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "protection_enrollment_not_enrolled",
    });
  }
  return row;
}

export async function fileClaim(
  driverId: number,
  input: { kind: ClaimKind; amountMinor?: number; evidence?: Record<string, unknown> },
): Promise<ProtectionClaimRow> {
  const current = await getMyEnrollment(driverId);
  if (!current || current.enrollment.status !== "enrolled") {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "active_protection_enrollment_required",
    });
  }
  const pool = await getPool();
  const inserted = await pool.query<ProtectionClaimRow>(
    `INSERT INTO public.protection_claims
       (enrollment_id, kind, amount_minor, evidence)
     VALUES ($1, $2, $3, $4::jsonb)
     RETURNING *`,
    [
      current.enrollment.id,
      input.kind,
      input.amountMinor ?? null,
      JSON.stringify(input.evidence ?? {}),
    ],
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "protection_claim_file_failed",
    });
  }
  return row;
}

export async function listMyClaims(
  driverId: number,
): Promise<ProtectionClaimRow[]> {
  const pool = await getPool();
  const result = await pool.query<ProtectionClaimRow>(
    `SELECT c.* FROM public.protection_claims c
     JOIN public.protection_enrollments e ON e.id = c.enrollment_id
     WHERE e.driver_id = $1
     ORDER BY c.filed_at DESC
     LIMIT 100`,
    [driverId],
  );
  return result.rows;
}

/** Allowed claim transitions: filed -> approved|rejected; approved -> paid|rejected. */
const CLAIM_TRANSITIONS: Record<ProtectionClaimRow["status"], ReadonlyArray<ProtectionClaimRow["status"]>> = {
  filed: ["approved", "rejected"],
  approved: ["paid", "rejected"],
  rejected: [],
  paid: [],
};

export async function decideClaim(
  operatorUserId: number,
  input: {
    claimId: string;
    decision: "approved" | "rejected" | "paid";
    amountMinor?: number;
  },
): Promise<ProtectionClaimRow> {
  const pool = await getPool();
  const existing = await pool.query<ProtectionClaimRow>(
    `SELECT * FROM public.protection_claims WHERE id = $1`,
    [input.claimId],
  );
  const claim = existing.rows[0];
  if (!claim) {
    throw new TRPCError({ code: "NOT_FOUND", message: "protection_claim_not_found" });
  }
  if (!CLAIM_TRANSITIONS[claim.status].includes(input.decision)) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `invalid_claim_transition:${claim.status}_to_${input.decision}`,
    });
  }
  const updated = await pool.query<ProtectionClaimRow>(
    `UPDATE public.protection_claims
     SET status = $2,
         decided_at = now(),
         decided_by = $3,
         amount_minor = COALESCE($4, amount_minor)
     WHERE id = $1
     RETURNING *`,
    [input.claimId, input.decision, operatorUserId, input.amountMinor ?? null],
  );
  const row = updated.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "protection_claim_decision_failed",
    });
  }
  return row;
}

/**
 * Advisory worker-council auto-post for protection policy changes — mirrors
 * the autoPostEconomicsConsultation pattern (never blocks the mutation).
 */
async function autoPostProtectionConsultation(input: {
  actorUserId: number;
  title: string;
  payload: Record<string, unknown>;
}): Promise<string | null> {
  try {
    const consultation = await postConsultation(input.actorUserId, {
      kind: "other",
      title: input.title,
      payload: input.payload,
      responseSlaHours: 72,
    });
    return consultation.id;
  } catch (error) {
    console.warn(
      "[driverProtection] worker-council consultation auto-post failed; proceeding",
      error,
    );
    return null;
  }
}

export async function upsertPolicy(
  actorUserId: number,
  input: {
    marketId: string;
    microPremiumMinor?: number;
    downtimeDailyStipendMinor?: number;
    protectionLevyMinor?: number;
    optOutAllowed?: boolean;
    active?: boolean;
  },
): Promise<{ policy: ProtectionPolicyRow; consultationId: string | null }> {
  const pool = await getPool();
  const upserted = await pool.query<ProtectionPolicyRow>(
    `INSERT INTO public.protection_policies
       (market_id, micro_premium_minor, downtime_daily_stipend_minor,
        protection_levy_minor, opt_out_allowed, active)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (market_id)
     DO UPDATE SET
       micro_premium_minor = EXCLUDED.micro_premium_minor,
       downtime_daily_stipend_minor = EXCLUDED.downtime_daily_stipend_minor,
       protection_levy_minor = EXCLUDED.protection_levy_minor,
       opt_out_allowed = EXCLUDED.opt_out_allowed,
       active = EXCLUDED.active,
       updated_at = now()
     RETURNING *`,
    [
      input.marketId,
      input.microPremiumMinor ?? 0,
      input.downtimeDailyStipendMinor ?? 0,
      input.protectionLevyMinor ?? 0,
      input.optOutAllowed ?? true,
      input.active ?? true,
    ],
  );
  const policy = upserted.rows[0];
  if (!policy) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "protection_policy_upsert_failed",
    });
  }
  invalidateProtectionPolicyCache(input.marketId);
  const consultationId = await autoPostProtectionConsultation({
    actorUserId,
    title: `Driver protection policy ${input.marketId}`,
    payload: {
      policy_id: policy.id,
      market_id: input.marketId,
      micro_premium_minor: input.microPremiumMinor ?? 0,
      downtime_daily_stipend_minor: input.downtimeDailyStipendMinor ?? 0,
      protection_levy_minor: input.protectionLevyMinor ?? 0,
      opt_out_allowed: input.optOutAllowed ?? true,
      active: input.active ?? true,
    },
  });
  return { policy, consultationId };
}

export async function listMaintenanceProviders(input: {
  city?: string;
}): Promise<MaintenanceProviderRow[]> {
  const pool = await getPool();
  if (input.city) {
    const result = await pool.query<MaintenanceProviderRow>(
      `SELECT * FROM public.maintenance_providers
       WHERE lower(city) = lower($1)
       ORDER BY vetted DESC, name ASC
       LIMIT 200`,
      [input.city],
    );
    return result.rows;
  }
  const result = await pool.query<MaintenanceProviderRow>(
    `SELECT * FROM public.maintenance_providers
     ORDER BY vetted DESC, name ASC
     LIMIT 200`,
  );
  return result.rows;
}

async function getLatestSchedule(
  driverId: number,
): Promise<RemittanceScheduleRow | null> {
  const pool = await getPool();
  const result = await pool.query<RemittanceScheduleRow>(
    `SELECT * FROM public.remittance_schedules
     WHERE driver_id = $1
     ORDER BY version DESC
     LIMIT 1`,
    [driverId],
  );
  return result.rows[0] ?? null;
}

async function getLatestNotice(
  scheduleId: string,
): Promise<RemittanceChangeNoticeRow | null> {
  const pool = await getPool();
  const result = await pool.query<RemittanceChangeNoticeRow>(
    `SELECT * FROM public.remittance_change_notices
     WHERE schedule_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [scheduleId],
  );
  return result.rows[0] ?? null;
}

export async function getMyRemittanceSchedule(driverId: number): Promise<{
  schedule: RemittanceScheduleRow;
  latestNotice: RemittanceChangeNoticeRow | null;
} | null> {
  const schedule = await getLatestSchedule(driverId);
  if (!schedule) return null;
  const latestNotice = await getLatestNotice(schedule.id);
  return { schedule, latestNotice };
}

/**
 * Pure enforcement gate (R12), exported for unit tests: new remittance terms
 * cannot be enforced against the driver until the driver has accepted the
 * change notice OR the mediation window has expired. Notices that do not
 * require re-acceptance (and the absence of any pending notice) are
 * enforceable.
 */
export function canEnforceRemittance(
  schedule: Pick<RemittanceScheduleRow, "status"> | null,
  notice: Pick<
    RemittanceChangeNoticeRow,
    "accepted_at" | "mediation_window_ends_at" | "requires_reacceptance"
  > | null,
  now: Date = new Date(),
): boolean {
  if (!schedule || !notice) return true;
  if (!notice.requires_reacceptance) return true;
  if (notice.accepted_at) return true;
  if (notice.mediation_window_ends_at) {
    const windowEnds = new Date(notice.mediation_window_ends_at).getTime();
    if (Number.isFinite(windowEnds) && now.getTime() >= windowEnds) {
      return true;
    }
  }
  return false;
}

export async function notifyRemittanceChange(
  operatorUserId: number,
  input: { scheduleId: string; newAmountMinor: number; effectiveAt: string },
): Promise<{ notice: RemittanceChangeNoticeRow; schedule: RemittanceScheduleRow }> {
  const pool = await getPool();
  const existing = await pool.query<RemittanceScheduleRow>(
    `SELECT * FROM public.remittance_schedules WHERE id = $1`,
    [input.scheduleId],
  );
  const schedule = existing.rows[0];
  if (!schedule) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "remittance_schedule_not_found",
    });
  }
  const inserted = await pool.query<RemittanceChangeNoticeRow>(
    `INSERT INTO public.remittance_change_notices
       (schedule_id, old_amount_minor, new_amount_minor, effective_at,
        requires_reacceptance, mediation_window_ends_at)
     VALUES ($1, $2, $3, $4::timestamptz, true,
             $4::timestamptz + interval '14 days')
     RETURNING *`,
    [
      input.scheduleId,
      schedule.amount_minor,
      input.newAmountMinor,
      input.effectiveAt,
    ],
  );
  const notice = inserted.rows[0];
  if (!notice) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "remittance_notice_failed",
    });
  }
  const updated = await pool.query<RemittanceScheduleRow>(
    `UPDATE public.remittance_schedules
     SET status = 'renegotiating', updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [input.scheduleId],
  );
  return { notice, schedule: updated.rows[0] ?? schedule };
}

/**
 * Driver accepts a remittance change: the notice is stamped and a new
 * schedule version (version + 1) carrying the new amount becomes the
 * authoritative 'current' row. Prior versions remain as history.
 */
export async function acceptRemittanceChange(
  driverId: number,
  input: { noticeId: string },
): Promise<{ notice: RemittanceChangeNoticeRow; schedule: RemittanceScheduleRow }> {
  const pool = await getPool();
  const existing = await pool.query<RemittanceChangeNoticeRow>(
    `SELECT n.* FROM public.remittance_change_notices n
     JOIN public.remittance_schedules s ON s.id = n.schedule_id
     WHERE n.id = $1 AND s.driver_id = $2`,
    [input.noticeId, driverId],
  );
  const notice = existing.rows[0];
  if (!notice) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "remittance_notice_not_found",
    });
  }
  if (notice.accepted_at) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "remittance_notice_already_accepted",
    });
  }
  const scheduleResult = await pool.query<RemittanceScheduleRow>(
    `SELECT * FROM public.remittance_schedules WHERE id = $1`,
    [notice.schedule_id],
  );
  const schedule = scheduleResult.rows[0];
  if (!schedule) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "remittance_schedule_not_found",
    });
  }
  const accepted = await pool.query<RemittanceChangeNoticeRow>(
    `UPDATE public.remittance_change_notices
     SET accepted_at = now()
     WHERE id = $1
     RETURNING *`,
    [input.noticeId],
  );
  const nextVersion = await pool.query<RemittanceScheduleRow>(
    `INSERT INTO public.remittance_schedules
       (driver_id, vehicle_contract_ref, amount_minor, currency, frequency,
        next_due_at, status, version)
     VALUES ($1, $2, $3, $4, $5, $6, 'current', $7)
     RETURNING *`,
    [
      schedule.driver_id,
      schedule.vehicle_contract_ref,
      notice.new_amount_minor,
      schedule.currency,
      schedule.frequency,
      schedule.next_due_at,
      Number(schedule.version) + 1,
    ],
  );
  const newSchedule = nextVersion.rows[0];
  if (!newSchedule) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "remittance_schedule_version_failed",
    });
  }
  return { notice: accepted.rows[0] ?? notice, schedule: newSchedule };
}

export async function requestMediation(
  driverId: number,
  input: { scheduleId: string },
): Promise<{
  schedule: RemittanceScheduleRow;
  notice: RemittanceChangeNoticeRow | null;
}> {
  const pool = await getPool();
  const existing = await pool.query<RemittanceScheduleRow>(
    `SELECT * FROM public.remittance_schedules
     WHERE id = $1 AND driver_id = $2`,
    [input.scheduleId, driverId],
  );
  const schedule = existing.rows[0];
  if (!schedule) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "remittance_schedule_not_found",
    });
  }
  if (schedule.status !== "renegotiating" && schedule.status !== "mediation") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "remittance_schedule_not_in_renegotiation",
    });
  }
  const updated = await pool.query<RemittanceScheduleRow>(
    `UPDATE public.remittance_schedules
     SET status = 'mediation', updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [input.scheduleId],
  );
  const noticeUpdated = await pool.query<RemittanceChangeNoticeRow>(
    `UPDATE public.remittance_change_notices
     SET mediation_window_ends_at = now() + interval '14 days'
     WHERE id = (
       SELECT id FROM public.remittance_change_notices
       WHERE schedule_id = $1 AND accepted_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1
     )
     RETURNING *`,
    [input.scheduleId],
  );
  return {
    schedule: updated.rows[0] ?? schedule,
    notice: noticeUpdated.rows[0] ?? null,
  };
}
