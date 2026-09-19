/**
 * Worker council / gig-worker representation (EU Platform Work Directive
 * 2024/2831 art. 35, ILO R188): platforms above a size threshold must
 * consult worker representatives on algorithmic-management changes
 * (pricing, allocation, monitoring). This module backs the council
 * membership registry, consultation objects, and consultation responses.
 * Consultations opened on protected topics (TAKE_RATE, FARE_FLOOR,
 * WORK_COUNCIL) carry a mandatory response SLA.
 */

import { TRPCError } from "@trpc/server";

import { getPool } from "../db";
import { sendEmail, sendSMS } from "./notificationGateway";

export type CouncilMemberRow = {
  user_id: number;
  platform_scope: string;
  seat: "elected" | "appointed" | "observer";
  active: boolean;
  appointed_at: string | Date;
  created_at: string | Date;
};

export type ConsultationKind =
  | "algorithmic_management"
  | "take_rate"
  | "fare_floor"
  | "work_council"
  | "monitoring"
  | "deactivation_policy";

export type ConsultationRow = {
  id: string;
  kind: ConsultationKind;
  title: string;
  payload: unknown;
  status: "open" | "responded" | "closed";
  posted_by: number;
  response_sla_at: string | Date;
  activated_at: string | Date | null;
  created_at: string | Date;
};

const CONSULTATION_KINDS: ConsultationKind[] = [
  "algorithmic_management",
  "take_rate",
  "fare_floor",
  "work_council",
  "monitoring",
  "deactivation_policy",
];

export async function listMembers(scope = "switchos") {
  const pool = await getPool();
  const result = await pool.query<CouncilMemberRow>(
    `SELECT * FROM public.council_members
     WHERE platform_scope = $1 AND active = true
     ORDER BY appointed_at`,
    [scope],
  );
  return result.rows;
}

export async function isActiveMember(userId: number, scope = "switchos") {
  const pool = await getPool();
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM public.council_members
       WHERE user_id = $1 AND platform_scope = $2 AND active = true
     ) AS exists`,
    [userId, scope],
  );
  return result.rows[0]?.exists === true;
}

export async function postConsultation(
  actorUserId: number,
  input: {
    kind: ConsultationKind;
    title: string;
    payload: unknown;
    responseSlaHours?: number;
  },
): Promise<ConsultationRow> {
  if (!CONSULTATION_KINDS.includes(input.kind)) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: `invalid_consultation_kind:${input.kind}`,
    });
  }
  const slaHours = Math.min(24 * 30, Math.max(24, input.responseSlaHours ?? 72));
  const pool = await getPool();
  const inserted = await pool.query<ConsultationRow>(
    `INSERT INTO public.consultation_objects (kind, title, payload, posted_by, response_sla_at)
     VALUES ($1, $2, $3::jsonb, $4, now() + ($5 || ' hours')::interval)
     RETURNING *`,
    [
      input.kind,
      input.title,
      JSON.stringify(input.payload ?? {}),
      actorUserId,
      slaHours,
    ],
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "consultation_creation_failed",
    });
  }
  // Notify every active council member that a new consultation needs their
  // response (Audit A P1-8: members were never notified). Fail-open: a
  // notification outage never blocks posting the consultation.
  await notifyActiveMembersOfConsultation(row).catch((error) =>
    console.warn(
      "[workerCouncil] consultation member notification failed; continuing",
      error,
    ),
  );
  return row;
}

/**
 * Dispatch the new-consultation notice to all active council members
 * (email preferred, SMS fallback). Never throws into the posting path.
 */
async function notifyActiveMembersOfConsultation(
  consultation: ConsultationRow,
): Promise<void> {
  try {
    const pool = await getPool();
    const members = await pool.query<{
      user_id: number | string;
      email: string | null;
      phone: string | null;
    }>(
      `SELECT m.user_id, u.email, u.phone
       FROM public.council_members m
       JOIN public.users u ON u.id = m.user_id
       WHERE m.active = true
       LIMIT 200`,
    );
    const message = `A new worker-council consultation "${consultation.title}" (kind: ${consultation.kind}) was posted and awaits your response by ${new Date(consultation.response_sla_at).toISOString()}.`;
    for (const member of members.rows) {
      const metadata = {
        notificationType: "council.consultation.posted",
        consultationId: consultation.id,
        kind: consultation.kind,
      };
      try {
        if (member.email) {
          await sendEmail(
            member.email,
            "SwitchOS worker council consultation",
            message,
            metadata,
          );
        } else if (member.phone) {
          await sendSMS(member.phone, message, metadata);
        }
      } catch (error) {
        console.warn(
          `[workerCouncil] consultation notice to member ${member.user_id} failed; continuing`,
          error,
        );
      }
    }
  } catch (error) {
    console.warn(
      "[workerCouncil] consultation member notification unavailable; continuing",
      error,
    );
  }
}

export async function respondToConsultation(
  memberUserId: number,
  input: { consultationId: string; stance: "support" | "object" | "abstain"; comment: string },
) {
  if (!(await isActiveMember(memberUserId))) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "council_membership_required",
    });
  }
  const pool = await getPool();
  const consultation = await pool.query<ConsultationRow>(
    `SELECT * FROM public.consultation_objects WHERE id = $1`,
    [input.consultationId],
  );
  const row = consultation.rows[0];
  if (!row) {
    throw new TRPCError({ code: "NOT_FOUND", message: "consultation_not_found" });
  }
  if (row.status !== "open") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "consultation_not_open",
    });
  }
  await pool.query(
    `INSERT INTO public.consultation_responses (consultation_id, member_user_id, stance, comment)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (consultation_id, member_user_id)
     DO UPDATE SET stance = EXCLUDED.stance, comment = EXCLUDED.comment, responded_at = now()`,
    [input.consultationId, memberUserId, input.stance, input.comment],
  );
  await pool.query(
    `UPDATE public.consultation_objects SET status = 'responded' WHERE id = $1`,
    [input.consultationId],
  );
  return { consultationId: input.consultationId, stance: input.stance };
}

export async function getConsultation(id: string) {
  const pool = await getPool();
  const consultation = await pool.query<ConsultationRow>(
    `SELECT * FROM public.consultation_objects WHERE id = $1`,
    [id],
  );
  const row = consultation.rows[0] ?? null;
  if (!row) return null;
  const responses = await pool.query(
    `SELECT member_user_id AS "memberUserId", stance, comment,
            responded_at AS "respondedAt"
       FROM public.consultation_responses WHERE consultation_id = $1
       ORDER BY responded_at`,
    [id],
  );
  return { ...row, responses: responses.rows };
}

export async function listConsultations(status?: string) {
  const pool = await getPool();
  if (status) {
    const result = await pool.query<ConsultationRow>(
      `SELECT * FROM public.consultation_objects WHERE status = $1
       ORDER BY created_at DESC LIMIT 100`,
      [status],
    );
    return result.rows;
  }
  const result = await pool.query<ConsultationRow>(
    `SELECT * FROM public.consultation_objects ORDER BY created_at DESC LIMIT 100`,
  );
  return result.rows;
}
