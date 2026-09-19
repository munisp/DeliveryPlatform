/**
 * Deactivation Due Process — ILO Termination of Employment Recommendation
 * No. 166 and the EU Platform Work Directive 2024/2831 ch. III require
 * notice, evidence, human review, and appeal before a platform worker is
 * deactivated. This module implements that lifecycle:
 *
 *   initiate  -> notice period (14 days) | immediate (egregious only)
 *   appeal    -> worker appeals with a statement before/after effective date
 *   decide    -> a DIFFERENT operator reviews and upholds/overturns
 *   reinstate -> overturned decisions restore platform access
 *
 * All state lives in public.deactivation_cases / public.deactivation_appeals
 * (drizzle/0057_deactivation_due_process.sql). Cause codes are constrained
 * by the migration CHECK (FRAUD, SAFETY, DOCUMENTS, POLICY, CONDUCT,
 * INACTIVITY) with a PROTECTED_ACTIVITY_FLAG that demands elevated
 * justification — deactivating a worker for organising, collective action,
 * or regulatory complaints is an unfair-labour-practice vector.
 */

import { TRPCError } from "@trpc/server";

import { getPool } from "../db";
import { sendEmail, sendSMS } from "./notificationGateway";

export const NOTICE_PERIOD_DAYS = 14;
export const APPEAL_WINDOW_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

const CAUSES = [
  "FRAUD",
  "SAFETY",
  "DOCUMENTS",
  "POLICY",
  "CONDUCT",
  "INACTIVITY",
  "PROTECTED_ACTIVITY_FLAG",
] as const;
export type DeactivationCause = (typeof CAUSES)[number];

const SUBJECT_ROLES = ["driver", "courier", "rider", "merchant"] as const;
export type DeactivationSubjectRole = (typeof SUBJECT_ROLES)[number];

export type DeactivationCaseRow = {
  id: string;
  subject_user_id: number;
  subject_role: DeactivationSubjectRole;
  cause_code: DeactivationCause;
  egregious: boolean;
  evidence: unknown;
  status: "notice" | "active" | "appealed" | "overturned";
  notice_sent_at: string | Date;
  effective_at: string | Date;
  decided_by: number | null;
  decided_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
};

export type DeactivationAppealRow = {
  id: string;
  case_id: string;
  appellant_user_id: number;
  statement: string;
  status: "filed" | "in_review" | "decided";
  decision: "upheld" | "overturned" | null;
  rationale: string | null;
  reviewer_id: number | null;
  created_at: string | Date;
  updated_at: string | Date;
};

function requireCause(causeCode: string): DeactivationCause {
  if (!(CAUSES as readonly string[]).includes(causeCode)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `invalid_deactivation_cause:${causeCode}`,
    });
  }
  return causeCode as DeactivationCause;
}

function requireSubjectRole(role: string): DeactivationSubjectRole {
  if (!(SUBJECT_ROLES as readonly string[]).includes(role)) {
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
  // notice_sent_at is written only AFTER the notice is actually dispatched
  // (see below) — stamping it at insert time without sending anything was
  // dishonest (Audit A P1-8 / cross-cutting 1).
  const inserted = await pool.query<DeactivationCaseRow>(
    `INSERT INTO public.deactivation_cases
       (subject_user_id, subject_role, cause_code, egregious, evidence,
        status, notice_sent_at, effective_at, decided_by, protected_activity)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, NULL, $7, $8, $9)
     RETURNING *`,
    [
      input.subjectUserId,
      subjectRole,
      causeCode,
      egregious,
      JSON.stringify(input.evidence ?? []),
      status,
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

  // Send the actual deactivation notice. Fail-open: a notification outage
  // never blocks the case; notice_sent_at simply stays NULL (honest "not
  // sent") so operators can see delivery did not happen.
  const noticeSent = await sendDeactivationNotice(pool, {
    subjectUserId: input.subjectUserId,
    subjectRole,
    causeCode,
    egregious,
    effectiveAt,
    caseId: row.id,
  });
  if (noticeSent) {
    const stamped = await pool.query<{ notice_sent_at: string | Date }>(
      `UPDATE public.deactivation_cases
       SET notice_sent_at = now(), updated_at = now()
       WHERE id = $1
       RETURNING notice_sent_at`,
      [row.id],
    );
    row.notice_sent_at = stamped.rows[0]?.notice_sent_at ?? new Date();
  }
  return row;
}

type NoticePool = { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

/**
 * Dispatch the deactivation notice to the subject (email preferred, SMS
 * fallback) via the notification gateway. Returns true when the gateway
 * accepted the notice; false on any failure or missing contact — never
 * throws into the mutation path.
 */
async function sendDeactivationNotice(
  pool: NoticePool,
  input: {
    subjectUserId: number;
    subjectRole: DeactivationSubjectRole;
    causeCode: DeactivationCause;
    egregious: boolean;
    effectiveAt: Date;
    caseId: string;
  },
): Promise<boolean> {
  try {
    const contact = await pool.query(
      `SELECT email, phone, name FROM public.users WHERE id = $1`,
      [input.subjectUserId],
    );
    const user = contact.rows[0] as
      | { email?: string | null; phone?: string | null; name?: string | null }
      | undefined;
    const message = input.egregious
      ? `Your ${input.subjectRole} account has been deactivated with immediate effect (cause: ${input.causeCode}, case ${input.caseId}). You may appeal within 14 days.`
      : `Your ${input.subjectRole} account is scheduled for deactivation on ${input.effectiveAt.toISOString()} (cause: ${input.causeCode}, case ${input.caseId}). You may appeal within 14 days.`;
    const metadata = {
      notificationType: "deactivation.notice",
      caseId: input.caseId,
      causeCode: input.causeCode,
    };
    if (user?.email) {
      await sendEmail(
        user.email,
        "SwitchOS deactivation notice",
        message,
        metadata,
      );
      return true;
    }
    if (user?.phone) {
      await sendSMS(user.phone, message, metadata);
      return true;
    }
    console.warn(
      `[deactivationDueProcess] no contact channel for user ${input.subjectUserId}; notice not sent`,
    );
    return false;
  } catch (error) {
    console.warn(
      "[deactivationDueProcess] notice dispatch failed; continuing without blocking the case",
      error,
    );
    return false;
  }
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
  if (found.subject_user_id !== subjectUserId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "appeal_limited_to_subject",
    });
  }
  if (found.status === "overturned") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "case_already_overturned",
    });
  }
  const createdAt = new Date(found.created_at).getTime();
  if (Date.now() - createdAt > APPEAL_WINDOW_DAYS * DAY_MS) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "appeal_window_expired",
    });
  }
  const inserted = await pool.query<DeactivationAppealRow>(
    `INSERT INTO public.deactivation_appeals (case_id, appellant_user_id, statement)
     VALUES ($1, $2, $3)
     RETURNING *`,
    [input.caseId, subjectUserId, input.statement],
  );
  await pool.query(
    `UPDATE public.deactivation_cases SET status = 'appealed', updated_at = now() WHERE id = $1`,
    [input.caseId],
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "appeal_creation_failed",
    });
  }
  return row;
}

export async function listOpenAppeals(): Promise<
  Array<DeactivationAppealRow & { case: DeactivationCaseRow | null }>
> {
  const pool = await getPool();
  const appeals = await pool.query<DeactivationAppealRow>(
    `SELECT * FROM public.deactivation_appeals
     WHERE status IN ('filed', 'in_review')
     ORDER BY created_at ASC`,
  );
  const results: Array<DeactivationAppealRow & { case: DeactivationCaseRow | null }> = [];
  for (const appeal of appeals.rows) {
    const caseResult = await pool.query<DeactivationCaseRow>(
      `SELECT * FROM public.deactivation_cases WHERE id = $1`,
      [appeal.case_id],
    );
    results.push({ ...appeal, case: caseResult.rows[0] ?? null });
  }
  return results;
}

/**
 * A reviewer decides an appeal. The reviewer MUST NOT be the operator who
 * initiated the deactivation (due-process separation of duties).
 */
export async function decideAppeal(
  reviewerId: number,
  input: {
    appealId: string;
    decision: "upheld" | "overturned";
    rationale: string;
  },
): Promise<{ appeal: DeactivationAppealRow; reinstated: boolean }> {
  const pool = await getPool();
  const appealResult = await pool.query<DeactivationAppealRow>(
    `SELECT * FROM public.deactivation_appeals WHERE id = $1`,
    [input.appealId],
  );
  const appeal = appealResult.rows[0];
  if (!appeal) {
    throw new TRPCError({ code: "NOT_FOUND", message: "appeal_not_found" });
  }
  if (appeal.status === "decided") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "appeal_already_decided",
    });
  }

  const caseResult = await pool.query<DeactivationCaseRow>(
    `SELECT * FROM public.deactivation_cases WHERE id = $1`,
    [appeal.case_id],
  );
  const found = caseResult.rows[0];
  if (!found) {
    throw new TRPCError({ code: "NOT_FOUND", message: "case_not_found" });
  }
  if (found.decided_by === reviewerId) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "reviewer_must_differ_from_initiator",
    });
  }

  const updated = await pool.query<DeactivationAppealRow>(
    `UPDATE public.deactivation_appeals
     SET status = 'decided', decision = $2, rationale = $3, reviewer_id = $4, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [input.appealId, input.decision, input.rationale, reviewerId],
  );

  let reinstated = false;
  if (input.decision === "overturned") {
    await pool.query(
      `UPDATE public.deactivation_cases SET status = 'overturned', updated_at = now() WHERE id = $1`,
      [appeal.case_id],
    );
    reinstated = true;
  }

  const row = updated.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "appeal_decision_failed",
    });
  }
  return { appeal: row, reinstated };
}
