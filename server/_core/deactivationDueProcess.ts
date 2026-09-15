import { TRPCError } from "@trpc/server";

import { getPool } from "../db";

/**
 * Just-cause deactivation due process (R4).
 *
 * - Bounded cause taxonomy; anything outside it is rejected up front.
 * - 14-day notice for non-egregious causes; egregious causes take effect
 *   immediately.
 * - Anti-retaliation shield: cases marked protected_activity require a
 *   non-empty elevated justification from the initiating operator.
 * - Appeals carry a 14-day SLA and must be decided by a reviewer who is NOT
 *   the original decider (separation of duties).
 * - Backpay: the settlement/payout store (payout_settlements) is read-only
 *   from the server tier — there is no public credit API — so
 *   'reinstated_with_backpay' records a pending row in public.backpay_credits
 *   (drizzle/0081) for finance reconciliation to settle. No settlement
 *   integration is fabricated.
 */

export const DEACTIVATION_CAUSES = [
  "SAFETY",
  "FRAUD",
  "DOCUMENTS",
  "CONDUCT",
  "POLICY",
  "OTHER",
] as const;
export type DeactivationCause = (typeof DEACTIVATION_CAUSES)[number];

export const DEACTIVATION_SUBJECT_ROLES = [
  "driver",
  "courier",
  "merchant",
  "rider",
] as const;
export type DeactivationSubjectRole =
  (typeof DEACTIVATION_SUBJECT_ROLES)[number];

export const APPEAL_DECISIONS = [
  "upheld",
  "reinstated",
  "reinstated_with_backpay",
] as const;
export type AppealDecision = (typeof APPEAL_DECISIONS)[number];

export const NOTICE_PERIOD_DAYS = 14;
export const APPEAL_SLA_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export type DeactivationCaseRow = {
  id: string;
  subject_user_id: number | string;
  subject_role: DeactivationSubjectRole;
  cause_code: DeactivationCause;
  egregious: boolean;
  evidence: unknown;
  status: string;
  notice_sent_at: string | Date | null;
  effective_at: string | Date | null;
  decided_by: number | string | null;
  protected_activity: boolean;
  created_at: string | Date;
  updated_at: string | Date;
};

export type DeactivationAppealRow = {
  id: string;
  case_id: string;
  appellant_user_id: number | string;
  statement: string;
  status: string;
  reviewer_id: number | string | null;
  decided_at: string | Date | null;
  decision: AppealDecision | null;
  rationale: string | null;
  sla_due_at: string | Date;
  created_at: string | Date;
};

function requireCause(code: string): DeactivationCause {
  if (!(DEACTIVATION_CAUSES as readonly string[]).includes(code)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `invalid_cause_code:${code}`,
    });
  }
  return code as DeactivationCause;
}

function requireSubjectRole(role: string): DeactivationSubjectRole {
  if (!(DEACTIVATION_SUBJECT_ROLES as readonly string[]).includes(role)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `invalid_subject_role:${role}`,
    });
  }
  return role as DeactivationSubjectRole;
}

export async function initiateCase(
  actorUserId: number,
  input: {
    subjectUserId: number;
    subjectRole: string;
    causeCode: string;
    egregious?: boolean;
    evidence?: unknown[];
    protectedActivity?: boolean;
    elevatedJustification?: string;
  },
): Promise<DeactivationCaseRow> {
  const causeCode = requireCause(input.causeCode);
  const subjectRole = requireSubjectRole(input.subjectRole);
  const egregious = input.egregious === true;
  const protectedActivity = input.protectedActivity === true;

  if (protectedActivity && !input.elevatedJustification?.trim()) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "elevated_justification_required_for_protected_activity",
    });
  }

  const now = new Date();
  const effectiveAt = egregious
    ? now
    : new Date(now.getTime() + NOTICE_PERIOD_DAYS * DAY_MS);
  const status = egregious ? "active" : "notice";

  const pool = await getPool();
  const inserted = await pool.query<DeactivationCaseRow>(
    `INSERT INTO public.deactivation_cases
       (subject_user_id, subject_role, cause_code, egregious, evidence,
        status, notice_sent_at, effective_at, decided_by, protected_activity)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)
     RETURNING *`,
    [
      input.subjectUserId,
      subjectRole,
      causeCode,
      egregious,
      JSON.stringify(input.evidence ?? []),
      status,
      now,
      effectiveAt,
      actorUserId,
      protectedActivity,
    ],
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "deactivation_case_creation_failed",
    });
  }
  return row;
}

export async function getMyCase(subjectUserId: number): Promise<{
  case: DeactivationCaseRow | null;
  appeals: DeactivationAppealRow[];
}> {
  const pool = await getPool();
  const caseResult = await pool.query<DeactivationCaseRow>(
    `SELECT * FROM public.deactivation_cases
     WHERE subject_user_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [subjectUserId],
  );
  const found = caseResult.rows[0] ?? null;
  if (!found) return { case: null, appeals: [] };
  const appeals = await pool.query<DeactivationAppealRow>(
    `SELECT * FROM public.deactivation_appeals
     WHERE case_id = $1
     ORDER BY created_at DESC`,
    [found.id],
  );
  return { case: found, appeals: appeals.rows };
}

export async function fileAppeal(
  subjectUserId: number,
  input: { caseId: string; statement: string },
): Promise<DeactivationAppealRow> {
  const pool = await getPool();
  const caseResult = await pool.query<DeactivationCaseRow>(
    `SELECT * FROM public.deactivation_cases WHERE id = $1`,
    [input.caseId],
  );
  const found = caseResult.rows[0];
  if (!found) {
    throw new TRPCError({ code: "NOT_FOUND", message: "case_not_found" });
  }
  if (Number(found.subject_user_id) !== subjectUserId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "appeal_limited_to_own_case",
    });
  }
  const slaDueAt = new Date(Date.now() + APPEAL_SLA_DAYS * DAY_MS);
  const inserted = await pool.query<DeactivationAppealRow>(
    `INSERT INTO public.deactivation_appeals
       (case_id, appellant_user_id, statement, sla_due_at)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.caseId, subjectUserId, input.statement, slaDueAt],
  );
  const appeal = inserted.rows[0];
  if (!appeal) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "appeal_creation_failed",
    });
  }
  await pool.query(
    `UPDATE public.deactivation_cases
     SET status = 'appealed', updated_at = now()
     WHERE id = $1`,
    [input.caseId],
  );
  return appeal;
}

export async function listCases(input?: {
  status?: string;
}): Promise<DeactivationCaseRow[]> {
  const pool = await getPool();
  if (input?.status) {
    const result = await pool.query<DeactivationCaseRow>(
      `SELECT * FROM public.deactivation_cases
       WHERE status = $1
       ORDER BY created_at DESC
       LIMIT 200`,
      [input.status],
    );
    return result.rows;
  }
  const result = await pool.query<DeactivationCaseRow>(
    `SELECT * FROM public.deactivation_cases
     ORDER BY created_at DESC
     LIMIT 200`,
  );
  return result.rows;
}

type AppealWithCase = DeactivationAppealRow & {
  case_decided_by: number | string | null;
  case_subject_user_id: number | string;
};

async function loadAppealWithCase(appealId: string): Promise<AppealWithCase> {
  const pool = await getPool();
  const result = await pool.query<AppealWithCase>(
    `SELECT a.*, c.decided_by AS case_decided_by,
            c.subject_user_id AS case_subject_user_id
     FROM public.deactivation_appeals a
     JOIN public.deactivation_cases c ON c.id = a.case_id
     WHERE a.id = $1`,
    [appealId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "appeal_not_found" });
  }
  return row;
}

export async function assignReviewer(input: {
  appealId: string;
  reviewerId: number;
}): Promise<DeactivationAppealRow> {
  const appeal = await loadAppealWithCase(input.appealId);
  if (
    appeal.case_decided_by !== null &&
    Number(appeal.case_decided_by) === input.reviewerId
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "reviewer_must_differ_from_decider",
    });
  }
  const pool = await getPool();
  const updated = await pool.query<DeactivationAppealRow>(
    `UPDATE public.deactivation_appeals
     SET reviewer_id = $2, status = 'in_review'
     WHERE id = $1
     RETURNING *`,
    [input.appealId, input.reviewerId],
  );
  const row = updated.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "reviewer_assignment_failed",
    });
  }
  return row;
}

export async function reviewAppeal(input: {
  appealId: string;
  decision: AppealDecision;
  rationale: string;
  backpayAmountMinor?: number;
}): Promise<DeactivationAppealRow> {
  if (!(APPEAL_DECISIONS as readonly string[]).includes(input.decision)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `invalid_appeal_decision:${input.decision}`,
    });
  }
  const appeal = await loadAppealWithCase(input.appealId);
  if (appeal.reviewer_id === null) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "appeal_has_no_assigned_reviewer",
    });
  }
  if (
    appeal.case_decided_by !== null &&
    Number(appeal.case_decided_by) === Number(appeal.reviewer_id)
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "reviewer_must_differ_from_decider",
    });
  }

  const pool = await getPool();
  const updated = await pool.query<DeactivationAppealRow>(
    `UPDATE public.deactivation_appeals
     SET status = 'decided', decided_at = now(), decision = $2, rationale = $3
     WHERE id = $1
     RETURNING *`,
    [input.appealId, input.decision, input.rationale],
  );
  const decided = updated.rows[0];
  if (!decided) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "appeal_decision_failed",
    });
  }

  const caseStatus = input.decision === "upheld" ? "upheld" : "reinstated";
  await pool.query(
    `UPDATE public.deactivation_cases
     SET status = $2, updated_at = now()
     WHERE id = $1`,
    [appeal.case_id, caseStatus],
  );

  if (input.decision === "reinstated_with_backpay") {
    // No public settlement credit API exists; record a pending credit for
    // finance reconciliation (see module header).
    await pool.query(
      `INSERT INTO public.backpay_credits
         (appeal_id, user_id, amount_minor, currency, status)
       VALUES ($1, $2, $3, 'NGN', 'pending')`,
      [
        input.appealId,
        Number(appeal.case_subject_user_id),
        Math.max(0, Math.trunc(input.backpayAmountMinor ?? 0)),
      ],
    );
  }
  return decided;
}

/**
 * Anti-retaliation flag maintenance. Applies to the subject's most recent
 * deactivation case (the flag lives on the case, not the user, because it
 * qualifies a specific deactivation decision).
 */
export async function setProtectedActivity(input: {
  userId: number;
  protected: boolean;
}): Promise<{ updated: boolean }> {
  const pool = await getPool();
  const updated = await pool.query<{ id: string }>(
    `UPDATE public.deactivation_cases
     SET protected_activity = $2, updated_at = now()
     WHERE id = (
       SELECT id FROM public.deactivation_cases
       WHERE subject_user_id = $1
       ORDER BY created_at DESC
       LIMIT 1
     )
     RETURNING id`,
    [input.userId, input.protected],
  );
  return { updated: (updated.rowCount ?? 0) > 0 };
}
