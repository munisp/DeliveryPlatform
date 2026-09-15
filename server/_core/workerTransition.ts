import { TRPCError } from "@trpc/server";

import { getPool } from "../db";
import { postConsultation } from "./workerCouncil";

/**
 * Worker transition protocol (R13).
 *
 * Transition programs (voluntary exit, role change, vehicle ownership,
 * severance) are published with explicit terms — `gratuity_minor` and
 * `deficit_forgiveness` — after a worker-council consultation (kind
 * 'transition', auto-posted on creation). Enrollment is unique per
 * (program, worker).
 *
 * Completion records `exit_gratuity_minor` and `deficits_waived_minor`
 * EXPLICITLY on the enrollment row: the transcript grievance was opaque
 * deficit deductions silently consuming a N40k exit gratuity, so when a
 * program's terms carry `deficit_forgiveness: true` the operator MUST pass
 * the waived amount explicitly (it may be 0, but it may not be implicit).
 */

export const TRANSITION_PROGRAM_KINDS = [
  "voluntary_exit",
  "role_change",
  "vehicle_ownership",
  "severance",
] as const;
export type TransitionProgramKind = (typeof TRANSITION_PROGRAM_KINDS)[number];

export const TRANSITION_ENROLLMENT_STATUSES = [
  "enrolled",
  "in_progress",
  "completed",
  "withdrawn",
] as const;
export type TransitionEnrollmentStatus =
  (typeof TRANSITION_ENROLLMENT_STATUSES)[number];

export type TransitionProgramTerms = {
  gratuity_minor?: number;
  deficit_forgiveness?: boolean;
  [key: string]: unknown;
};

export type TransitionProgramRow = {
  id: string;
  title: string;
  kind: TransitionProgramKind;
  terms: TransitionProgramTerms;
  open: boolean;
  consultation_id: string | null;
  created_at: string | Date;
};

export type TransitionEnrollmentRow = {
  id: string;
  program_id: string;
  worker_id: number | string;
  status: TransitionEnrollmentStatus;
  exit_gratuity_minor: number | string;
  deficits_waived_minor: number | string;
  completed_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
};

/**
 * Pure enrollment status transition, exported for tests.
 * enrolled -> in_progress -> completed; enrolled/in_progress -> withdrawn.
 * Terminal states (completed, withdrawn) never move again.
 */
export function assertEnrollmentTransition(
  current: TransitionEnrollmentStatus,
  target: TransitionEnrollmentStatus,
): void {
  const allowed: Record<TransitionEnrollmentStatus, TransitionEnrollmentStatus[]> = {
    enrolled: ["in_progress", "withdrawn"],
    in_progress: ["completed", "withdrawn"],
    completed: [],
    withdrawn: [],
  };
  if (!allowed[current].includes(target)) {
    throw new TRPCError({
      code: "CONFLICT",
      message: `invalid_enrollment_transition:${current}_to_${target}`,
    });
  }
}

export async function listPrograms(input?: {
  includeClosed?: boolean;
}): Promise<TransitionProgramRow[]> {
  const pool = await getPool();
  if (input?.includeClosed) {
    const result = await pool.query<TransitionProgramRow>(
      `SELECT * FROM public.transition_programs ORDER BY created_at DESC LIMIT 200`,
    );
    return result.rows;
  }
  const result = await pool.query<TransitionProgramRow>(
    `SELECT * FROM public.transition_programs
     WHERE open = true
     ORDER BY created_at DESC LIMIT 200`,
  );
  return result.rows;
}

export async function getMyEnrollments(workerId: number): Promise<
  Array<TransitionEnrollmentRow & { program_title: string; program_kind: TransitionProgramKind }>
> {
  const pool = await getPool();
  const result = await pool.query<
    TransitionEnrollmentRow & { program_title: string; program_kind: TransitionProgramKind }
  >(
    `SELECT e.*, p.title AS program_title, p.kind AS program_kind
     FROM public.transition_enrollments e
     JOIN public.transition_programs p ON p.id = e.program_id
     WHERE e.worker_id = $1
     ORDER BY e.created_at DESC`,
    [workerId],
  );
  return result.rows;
}

async function getProgram(programId: string): Promise<TransitionProgramRow> {
  const pool = await getPool();
  const result = await pool.query<TransitionProgramRow>(
    `SELECT * FROM public.transition_programs WHERE id = $1`,
    [programId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "transition_program_not_found",
    });
  }
  return row;
}

/**
 * Enroll a worker into an open program. Unique per (program, worker): a
 * second live enrollment is a CONFLICT; a previously withdrawn enrollment is
 * re-activated in place so the audit history on the row survives.
 */
export async function enroll(
  workerId: number,
  input: { programId: string },
): Promise<TransitionEnrollmentRow> {
  const program = await getProgram(input.programId);
  if (!program.open) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "transition_program_closed",
    });
  }
  const pool = await getPool();
  const existing = await pool.query<TransitionEnrollmentRow>(
    `SELECT * FROM public.transition_enrollments
     WHERE program_id = $1 AND worker_id = $2`,
    [input.programId, workerId],
  );
  const prior = existing.rows[0];
  if (prior && prior.status !== "withdrawn") {
    throw new TRPCError({
      code: "CONFLICT",
      message: "already_enrolled",
    });
  }
  if (prior) {
    const reactivated = await pool.query<TransitionEnrollmentRow>(
      `UPDATE public.transition_enrollments
       SET status = 'enrolled', updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [prior.id],
    );
    return reactivated.rows[0]!;
  }
  const inserted = await pool.query<TransitionEnrollmentRow>(
    `INSERT INTO public.transition_enrollments (program_id, worker_id)
     VALUES ($1, $2)
     ON CONFLICT (program_id, worker_id) DO NOTHING
     RETURNING *`,
    [input.programId, workerId],
  );
  const row = inserted.rows[0];
  if (!row) {
    // Lost the race against a concurrent enrollment.
    throw new TRPCError({ code: "CONFLICT", message: "already_enrolled" });
  }
  return row;
}

/** Withdraw from one of the caller's own enrollments. */
export async function withdraw(
  workerId: number,
  input: { enrollmentId: string },
): Promise<TransitionEnrollmentRow> {
  const pool = await getPool();
  const current = await pool.query<TransitionEnrollmentRow>(
    `SELECT * FROM public.transition_enrollments
     WHERE id = $1 AND worker_id = $2`,
    [input.enrollmentId, workerId],
  );
  const row = current.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "transition_enrollment_not_found",
    });
  }
  assertEnrollmentTransition(row.status, "withdrawn");
  const updated = await pool.query<TransitionEnrollmentRow>(
    `UPDATE public.transition_enrollments
     SET status = 'withdrawn', updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [row.id],
  );
  return updated.rows[0]!;
}

/**
 * Advisory worker-council auto-post for transition programs — mirrors the
 * autoPostEconomicsConsultation pattern (never blocks the mutation).
 */
async function autoPostTransitionConsultation(input: {
  actorUserId: number;
  title: string;
  payload: Record<string, unknown>;
}): Promise<string | null> {
  try {
    const consultation = await postConsultation(input.actorUserId, {
      kind: "transition",
      title: input.title,
      payload: input.payload,
      responseSlaHours: 72,
    });
    return consultation.id;
  } catch (error) {
    console.warn(
      "[workerTransition] worker-council consultation auto-post failed; proceeding",
      error,
    );
    return null;
  }
}

export async function createProgram(
  actorUserId: number,
  input: {
    title: string;
    kind: TransitionProgramKind;
    terms?: TransitionProgramTerms;
    open?: boolean;
  },
): Promise<{ program: TransitionProgramRow; consultationId: string | null }> {
  const terms: TransitionProgramTerms = { ...(input.terms ?? {}) };
  if (
    terms.gratuity_minor !== undefined &&
    (!Number.isInteger(terms.gratuity_minor) || terms.gratuity_minor < 0)
  ) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "gratuity_minor_must_be_non_negative_integer",
    });
  }
  const pool = await getPool();
  const inserted = await pool.query<TransitionProgramRow>(
    `INSERT INTO public.transition_programs (title, kind, terms, open)
     VALUES ($1, $2, $3::jsonb, $4)
     RETURNING *`,
    [input.title, input.kind, JSON.stringify(terms), input.open ?? true],
  );
  let program = inserted.rows[0];
  if (!program) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "transition_program_creation_failed",
    });
  }
  const consultationId = await autoPostTransitionConsultation({
    actorUserId,
    title: `Transition program: ${input.title}`,
    payload: {
      program_id: program.id,
      kind: input.kind,
      terms,
    },
  });
  if (consultationId) {
    const linked = await pool.query<TransitionProgramRow>(
      `UPDATE public.transition_programs
       SET consultation_id = $2
       WHERE id = $1
       RETURNING *`,
      [program.id, consultationId],
    );
    program = linked.rows[0] ?? program;
  }
  return { program, consultationId };
}

/**
 * Advance an enrollment through its lifecycle. Completion records the exit
 * gratuity and waived deficits explicitly: when the program terms carry
 * `deficit_forgiveness: true`, `deficitsWaivedMinor` must be provided (0 is
 * a valid explicit answer; undefined is not) — no more opaque deductions.
 */
export async function advanceEnrollment(
  actorUserId: number,
  input: {
    enrollmentId: string;
    status: TransitionEnrollmentStatus;
    exitGratuityMinor?: number;
    deficitsWaivedMinor?: number;
  },
): Promise<TransitionEnrollmentRow> {
  const pool = await getPool();
  const current = await pool.query<
    TransitionEnrollmentRow & { terms: TransitionProgramTerms }
  >(
    `SELECT e.*, p.terms
     FROM public.transition_enrollments e
     JOIN public.transition_programs p ON p.id = e.program_id
     WHERE e.id = $1`,
    [input.enrollmentId],
  );
  const row = current.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "transition_enrollment_not_found",
    });
  }
  assertEnrollmentTransition(row.status, input.status);

  if (input.status === "completed") {
    const terms = row.terms ?? {};
    if (
      terms.deficit_forgiveness === true &&
      input.deficitsWaivedMinor === undefined
    ) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "deficits_waived_minor_required_when_deficit_forgiveness",
      });
    }
    const gratuity =
      input.exitGratuityMinor ?? Number(terms.gratuity_minor ?? row.exit_gratuity_minor ?? 0);
    const waived = input.deficitsWaivedMinor ?? 0;
    if (!Number.isInteger(gratuity) || gratuity < 0 || !Number.isInteger(waived) || waived < 0) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "completion_amounts_must_be_non_negative_integers",
      });
    }
    const updated = await pool.query<TransitionEnrollmentRow>(
      `UPDATE public.transition_enrollments
       SET status = 'completed',
           exit_gratuity_minor = $2,
           deficits_waived_minor = $3,
           completed_at = now(),
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [input.enrollmentId, gratuity, waived],
    );
    return updated.rows[0]!;
  }

  const updated = await pool.query<TransitionEnrollmentRow>(
    `UPDATE public.transition_enrollments
     SET status = $2, updated_at = now()
     WHERE id = $1
     RETURNING *`,
    [input.enrollmentId, input.status],
  );
  return updated.rows[0]!;
}
