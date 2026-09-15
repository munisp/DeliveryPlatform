import { TRPCError } from "@trpc/server";

import { getPool } from "../db";

/**
 * Worker council consultation (R5).
 *
 * Platform changes that affect workers (pricing, commission, deactivation
 * and safety policy, transitions) are posted as consultation objects. A
 * consultation cannot be activated until its response SLA has elapsed OR
 * every active council member has responded — the roundtable cannot simply
 * be refused or skipped.
 */

export const CONSULTATION_KINDS = [
  "pricing",
  "commission",
  "deactivation_policy",
  "safety_policy",
  "transition",
  "other",
] as const;
export type ConsultationKind = (typeof CONSULTATION_KINDS)[number];

export const CONSULTATION_STANCES = ["support", "object", "comment"] as const;
export type ConsultationStance = (typeof CONSULTATION_STANCES)[number];

export type ConsultationRow = {
  id: string;
  kind: ConsultationKind;
  title: string;
  payload: unknown;
  status: "open" | "closed" | "activated" | "withdrawn";
  posted_by: number | string | null;
  response_sla_at: string | Date;
  activated_at: string | Date | null;
  created_at: string | Date;
};

export type CouncilMemberRow = {
  id: string;
  user_id: number | string;
  constituency: string;
  role: string;
  active: boolean;
  appointed_at: string | Date;
  created_at: string | Date;
};

export type ConsultationResponseRow = {
  id: string;
  consultation_id: string;
  member_id: string;
  stance: ConsultationStance;
  body: string;
  created_at: string | Date;
};

export async function listConsultations(input?: {
  status?: string;
}): Promise<Array<ConsultationRow & { response_count: number }>> {
  const pool = await getPool();
  const base = `
    SELECT c.*,
           (SELECT count(*)::int FROM public.consultation_responses r
             WHERE r.consultation_id = c.id) AS response_count
    FROM public.consultation_objects c`;
  if (input?.status) {
    const result = await pool.query<ConsultationRow & { response_count: number }>(
      `${base} WHERE c.status = $1 ORDER BY c.created_at DESC LIMIT 200`,
      [input.status],
    );
    return result.rows;
  }
  const result = await pool.query<ConsultationRow & { response_count: number }>(
    `${base} ORDER BY c.created_at DESC LIMIT 200`,
  );
  return result.rows;
}

async function getActiveMembership(
  userId: number,
): Promise<CouncilMemberRow | null> {
  const pool = await getPool();
  const result = await pool.query<CouncilMemberRow>(
    `SELECT * FROM public.council_members
     WHERE user_id = $1 AND active = true`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function getConsultation(
  consultationId: string,
  viewerUserId?: number,
): Promise<{
  consultation: ConsultationRow & { response_count: number };
  myResponse: ConsultationResponseRow | null;
}> {
  const pool = await getPool();
  const result = await pool.query<ConsultationRow & { response_count: number }>(
    `SELECT c.*,
            (SELECT count(*)::int FROM public.consultation_responses r
              WHERE r.consultation_id = c.id) AS response_count
     FROM public.consultation_objects c
     WHERE c.id = $1`,
    [consultationId],
  );
  const consultation = result.rows[0];
  if (!consultation) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "consultation_not_found",
    });
  }
  let myResponse: ConsultationResponseRow | null = null;
  if (viewerUserId !== undefined) {
    const membership = await getActiveMembership(viewerUserId);
    if (membership) {
      const response = await pool.query<ConsultationResponseRow>(
        `SELECT * FROM public.consultation_responses
         WHERE consultation_id = $1 AND member_id = $2`,
        [consultationId, membership.id],
      );
      myResponse = response.rows[0] ?? null;
    }
  }
  return { consultation, myResponse };
}

export async function respondToConsultation(
  userId: number,
  input: { id: string; stance: ConsultationStance; body: string },
): Promise<ConsultationResponseRow> {
  const membership = await getActiveMembership(userId);
  if (!membership) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "active_council_membership_required",
    });
  }
  const pool = await getPool();
  const consultation = await pool.query<ConsultationRow>(
    `SELECT * FROM public.consultation_objects WHERE id = $1`,
    [input.id],
  );
  if (!consultation.rows[0]) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "consultation_not_found",
    });
  }
  // One response per member per consultation — re-posting upserts.
  const upserted = await pool.query<ConsultationResponseRow>(
    `INSERT INTO public.consultation_responses
       (consultation_id, member_id, stance, body)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (consultation_id, member_id)
     DO UPDATE SET stance = EXCLUDED.stance, body = EXCLUDED.body
     RETURNING *`,
    [input.id, membership.id, input.stance, input.body],
  );
  const row = upserted.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "consultation_response_failed",
    });
  }
  return row;
}

export async function postConsultation(
  actorUserId: number,
  input: {
    kind: ConsultationKind;
    title: string;
    payload: unknown;
    responseSlaHours: number;
  },
): Promise<ConsultationRow> {
  const pool = await getPool();
  const inserted = await pool.query<ConsultationRow>(
    `INSERT INTO public.consultation_objects
       (kind, title, payload, posted_by, response_sla_at)
     VALUES ($1, $2, $3::jsonb, $4, now() + ($5 || ' hours')::interval)
     RETURNING *`,
    [
      input.kind,
      input.title,
      JSON.stringify(input.payload ?? {}),
      actorUserId,
      input.responseSlaHours,
    ],
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "consultation_creation_failed",
    });
  }
  return row;
}

export async function closeConsultation(input: {
  id: string;
}): Promise<ConsultationRow> {
  const pool = await getPool();
  const updated = await pool.query<ConsultationRow>(
    `UPDATE public.consultation_objects
     SET status = 'closed'
     WHERE id = $1 AND status = 'open'
     RETURNING *`,
    [input.id],
  );
  const row = updated.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "consultation_not_open",
    });
  }
  return row;
}

/**
 * Activation gate: reject unless the response SLA has elapsed OR every
 * active council member has responded. This is the enforcement point that
 * prevents the platform from activating worker-affecting changes without
 * consultation.
 */
export async function activateConsultation(input: {
  id: string;
}): Promise<ConsultationRow> {
  const pool = await getPool();
  const gate = await pool.query<{
    status: string;
    response_sla_at: string | Date;
    active_members: number;
    responded_members: number;
  }>(
    `SELECT c.status,
            c.response_sla_at,
            (SELECT count(*)::int FROM public.council_members m
              WHERE m.active = true) AS active_members,
            (SELECT count(DISTINCT r.member_id)::int
              FROM public.consultation_responses r
              JOIN public.council_members m ON m.id = r.member_id
              WHERE r.consultation_id = c.id AND m.active = true
            ) AS responded_members
     FROM public.consultation_objects c
     WHERE c.id = $1`,
    [input.id],
  );
  const row = gate.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "consultation_not_found",
    });
  }
  if (row.status !== "open") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "consultation_not_open",
    });
  }
  const slaElapsed = new Date(row.response_sla_at).getTime() <= Date.now();
  const allResponded =
    row.active_members === 0 || row.responded_members >= row.active_members;
  if (!slaElapsed && !allResponded) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "consultation_gate_unmet:response_sla_open_and_members_outstanding",
    });
  }
  const updated = await pool.query<ConsultationRow>(
    `UPDATE public.consultation_objects
     SET status = 'activated', activated_at = now()
     WHERE id = $1 AND status = 'open'
     RETURNING *`,
    [input.id],
  );
  const activated = updated.rows[0];
  if (!activated) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "consultation_not_open",
    });
  }
  return activated;
}

export async function addCouncilMember(input: {
  userId: number;
  constituency?: string;
}): Promise<CouncilMemberRow> {
  const pool = await getPool();
  const upserted = await pool.query<CouncilMemberRow>(
    `INSERT INTO public.council_members (user_id, constituency)
     VALUES ($1, $2)
     ON CONFLICT (user_id)
     DO UPDATE SET constituency = EXCLUDED.constituency, active = true
     RETURNING *`,
    [input.userId, input.constituency ?? "drivers"],
  );
  const row = upserted.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "council_member_creation_failed",
    });
  }
  return row;
}

/**
 * Wave B hook: economics/policy mutation paths call this before applying a
 * worker-affecting change. v1 returns the latest open consultation of the
 * given kind, or null when none is open.
 */
export async function requireConsultationGate(
  kind: string,
): Promise<{ consultationId: string } | null> {
  const pool = await getPool();
  const result = await pool.query<{ id: string }>(
    `SELECT id FROM public.consultation_objects
     WHERE kind = $1 AND status = 'open'
     ORDER BY created_at DESC
     LIMIT 1`,
    [kind],
  );
  const row = result.rows[0];
  return row ? { consultationId: row.id } : null;
}
