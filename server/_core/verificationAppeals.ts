import { TRPCError } from "@trpc/server";

import { getPool } from "../db";
import { sendEmail, sendSMS } from "./notificationGateway";

/**
 * Verification appeal due process (Audit A P1-10).
 *
 * The stakeholder verification engine can reject/suspend/expire a case but
 * had no appeal path (deactivation appeals covered only post-onboarding
 * sanctions). This module adds it:
 *
 * - fileVerificationAppeal (self-serve): the case subject appeals a
 *   'rejected' or 'suspended' case; the case moves to 'appealed'
 *   (drizzle/0092 enum value) and the appeal carries a 14-day SLA.
 * - decideVerificationAppeal (operator): decides 'upheld' (case returns to
 *   'rejected') or 'overturned' (case returns to 'manual_review' for a fresh
 *   decision). Separation of duties: the reviewer must NOT be the operator
 *   who decided the original case — enforced here in code.
 *
 * Notifications are fail-open everywhere: a gateway outage never blocks the
 * appeal lifecycle.
 */

export const VERIFICATION_APPEAL_SLA_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export const VERIFICATION_APPEAL_DECISIONS = ["upheld", "overturned"] as const;
export type VerificationAppealDecision =
  (typeof VERIFICATION_APPEAL_DECISIONS)[number];

export type VerificationAppealRow = {
  id: string;
  case_id: string;
  appellant_user_id: number | string;
  statement: string;
  status: "filed" | "in_review" | "decided";
  decision: VerificationAppealDecision | null;
  rationale: string | null;
  reviewer_id: number | string | null;
  sla_due_at: string | Date;
  created_at: string | Date;
};

const APPEALABLE_STATES = ["rejected", "suspended"] as const;

export async function fileVerificationAppeal(
  userId: number,
  input: { caseId: string; statement: string },
): Promise<VerificationAppealRow> {
  const statement = input.statement.trim();
  if (statement.length < 3 || statement.length > 4000) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "appeal_statement_length_invalid",
    });
  }
  const pool = await getPool();
  const caseResult = await pool.query<{
    id: string;
    subject_user_id: number | null;
    state: string;
  }>(
    `SELECT id, subject_user_id, state::text AS state
     FROM verification.verification_case WHERE id = $1`,
    [input.caseId],
  );
  const found = caseResult.rows[0];
  if (!found) {
    throw new TRPCError({ code: "NOT_FOUND", message: "case_not_found" });
  }
  if (found.subject_user_id === null || Number(found.subject_user_id) !== userId) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "appeal_limited_to_own_case",
    });
  }
  if (!(APPEALABLE_STATES as readonly string[]).includes(found.state)) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `case_state_not_appealable:${found.state}`,
    });
  }
  const existing = await pool.query<{ id: string }>(
    `SELECT id FROM public.verification_appeals
     WHERE case_id = $1 AND status <> 'decided'
     LIMIT 1`,
    [input.caseId],
  );
  if (existing.rows[0]) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "open_appeal_already_exists",
    });
  }
  const slaDueAt = new Date(Date.now() + VERIFICATION_APPEAL_SLA_DAYS * DAY_MS);
  const inserted = await pool.query<VerificationAppealRow>(
    `INSERT INTO public.verification_appeals
       (case_id, appellant_user_id, statement, sla_due_at)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [input.caseId, userId, statement, slaDueAt],
  );
  const appeal = inserted.rows[0];
  if (!appeal) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "appeal_creation_failed",
    });
  }
  await pool.query(
    `UPDATE verification.verification_case
     SET state = 'appealed', updated_at = now()
     WHERE id = $1`,
    [input.caseId],
  );
  return appeal;
}

export async function listMyVerificationAppeals(
  userId: number,
): Promise<VerificationAppealRow[]> {
  const pool = await getPool();
  const result = await pool.query<VerificationAppealRow>(
    `SELECT * FROM public.verification_appeals
     WHERE appellant_user_id = $1
     ORDER BY created_at DESC
     LIMIT 100`,
    [userId],
  );
  return result.rows;
}

export async function listVerificationAppeals(input?: {
  status?: string;
}): Promise<VerificationAppealRow[]> {
  const pool = await getPool();
  if (input?.status) {
    const result = await pool.query<VerificationAppealRow>(
      `SELECT * FROM public.verification_appeals
       WHERE status = $1
       ORDER BY sla_due_at
       LIMIT 200`,
      [input.status],
    );
    return result.rows;
  }
  const result = await pool.query<VerificationAppealRow>(
    `SELECT * FROM public.verification_appeals
     ORDER BY sla_due_at
     LIMIT 200`,
  );
  return result.rows;
}

type AppealWithCase = VerificationAppealRow & {
  case_state: string;
  case_decided_by: number | string | null;
};

export async function decideVerificationAppeal(
  operatorUserId: number,
  input: {
    appealId: string;
    decision: VerificationAppealDecision;
    rationale: string;
  },
): Promise<VerificationAppealRow> {
  if (
    !(VERIFICATION_APPEAL_DECISIONS as readonly string[]).includes(
      input.decision,
    )
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `invalid_appeal_decision:${input.decision}`,
    });
  }
  const rationale = input.rationale.trim();
  if (rationale.length < 3 || rationale.length > 4000) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "appeal_rationale_length_invalid",
    });
  }
  const pool = await getPool();
  const found = await pool.query<AppealWithCase>(
    `SELECT a.*, c.state::text AS case_state,
            c.decided_by_user_id AS case_decided_by
     FROM public.verification_appeals a
     JOIN verification.verification_case c ON c.id = a.case_id
     WHERE a.id = $1`,
    [input.appealId],
  );
  const appeal = found.rows[0];
  if (!appeal) {
    throw new TRPCError({ code: "NOT_FOUND", message: "appeal_not_found" });
  }
  if (appeal.status === "decided") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "appeal_already_decided",
    });
  }
  // Separation of duties: the appeal reviewer must not be the operator who
  // decided the original verification case.
  if (
    appeal.case_decided_by !== null &&
    Number(appeal.case_decided_by) === operatorUserId
  ) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "reviewer_must_differ_from_decider",
    });
  }

  const updated = await pool.query<VerificationAppealRow>(
    `UPDATE public.verification_appeals
     SET status = 'decided', decision = $2, rationale = $3, reviewer_id = $4
     WHERE id = $1 AND status <> 'decided'
     RETURNING *`,
    [input.appealId, input.decision, rationale, operatorUserId],
  );
  const decided = updated.rows[0];
  if (!decided) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "appeal_already_decided",
    });
  }

  // upheld: the original rejection stands; overturned: the case goes back to
  // manual_review so a different operator can re-decide it.
  const nextCaseState =
    input.decision === "overturned" ? "manual_review" : "rejected";
  await pool.query(
    `UPDATE verification.verification_case
     SET state = $2::verification.case_state, updated_at = now()
     WHERE id = $1`,
    [appeal.case_id, nextCaseState],
  );

  // Notify the appellant of the appeal outcome. Fail-open.
  await notifyAppealDecision(decided, input.decision).catch((error) =>
    console.warn(
      "[verificationAppeals] appeal decision notification failed; continuing",
      error,
    ),
  );
  return decided;
}

async function notifyAppealDecision(
  appeal: VerificationAppealRow,
  decision: VerificationAppealDecision,
): Promise<void> {
  try {
    const pool = await getPool();
    const contact = await pool.query<{
      email: string | null;
      phone: string | null;
    }>(`SELECT email, phone FROM public.users WHERE id = $1`, [
      Number(appeal.appellant_user_id),
    ]);
    const user = contact.rows[0];
    const message = `Your verification appeal for case ${appeal.case_id} was decided: ${decision}.`;
    const metadata = {
      notificationType: "verification.appeal.decided",
      appealId: appeal.id,
      caseId: appeal.case_id,
      decision,
    };
    if (user?.email) {
      await sendEmail(
        user.email,
        "SwitchOS verification appeal decision",
        message,
        metadata,
      );
    } else if (user?.phone) {
      await sendSMS(user.phone, message, metadata);
    }
  } catch (error) {
    console.warn(
      "[verificationAppeals] appeal decision notification unavailable; continuing",
      error,
    );
  }
}
