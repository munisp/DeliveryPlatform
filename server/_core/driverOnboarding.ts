import { TRPCError } from "@trpc/server";

import { getPool } from "../db";
import { sendEmail, sendSMS } from "./notificationGateway";
import { startVerificationCase } from "./stakeholderVerification";

/**
 * Driver onboarding (Audit A P0-1).
 *
 * Before this module there was NO driver registration: `drivers` rows were
 * seed-only and any authenticated session whose open_id/email matched a row
 * silently inherited the driver identity, earnings view, settlements and
 * offer stream. This module adds the gated flow:
 *
 *   apply (self-serve) -> KYC case (verification engine, subject_type
 *   'driver') -> operator decision. Approval REQUIRES the bound case to be
 *   'verified' (identity_document, liveness, driving_licence,
 *   criminal_record, sanctions per drizzle/0053) and only then creates/links
 *   the `drivers` row, binding it to the applicant's open_id.
 *
 * Access rule (documented, shared with selfserveRouter +
 * driverDispatchFairness): driver-surface access requires an APPROVED
 * application whose bound verification case is VERIFIED
 * (getVerifiedDriverAccess). The legacy open_id/email driver-row match alone
 * no longer grants access; fail-safe is denial / an empty offer stream.
 */

export const DRIVER_APPLICATION_STATUSES = [
  "submitted",
  "in_review",
  "approved",
  "rejected",
  "withdrawn",
] as const;
export type DriverApplicationStatus =
  (typeof DRIVER_APPLICATION_STATUSES)[number];

export type DriverVehicle = {
  type?: string;
  number?: string;
  licenseNumber?: string;
};

export type DriverApplication = {
  id: string;
  userId: number;
  status: DriverApplicationStatus;
  verificationCaseId: string | null;
  verificationCaseState: string | null;
  fullName: string;
  phone: string | null;
  city: string | null;
  vehicle: DriverVehicle;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
};

type ApplicationRow = {
  id: string;
  user_id: number | string;
  status: DriverApplicationStatus;
  verification_case_id: string | null;
  verification_case_state: string | null;
  full_name: string;
  phone: string | null;
  city: string | null;
  vehicle: unknown;
  rejection_reason: string | null;
  created_at: string | Date;
  updated_at: string | Date;
};

const APPLICATION_SELECT = `
  SELECT a.id, a.user_id, a.status, a.verification_case_id,
         c.state::text AS verification_case_state,
         a.full_name, a.phone, a.city, a.vehicle, a.rejection_reason,
         a.created_at, a.updated_at
  FROM public.driver_applications a
  LEFT JOIN verification.verification_case c ON c.id = a.verification_case_id`;

function toApplication(row: ApplicationRow): DriverApplication {
  return {
    id: row.id,
    userId: Number(row.user_id),
    status: row.status,
    verificationCaseId: row.verification_case_id,
    verificationCaseState: row.verification_case_state,
    fullName: row.full_name,
    phone: row.phone,
    city: row.city,
    vehicle:
      row.vehicle && typeof row.vehicle === "object"
        ? (row.vehicle as DriverVehicle)
        : {},
    rejectionReason: row.rejection_reason,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/**
 * File a driver application. Idempotent per user: a second call while an
 * application is still active (submitted / in_review) returns the existing
 * application instead of duplicating it (the partial unique index from
 * drizzle/0091 is the hard backstop; the unique-violation race path simply
 * re-reads the winner).
 *
 * The KYC case is opened through the shared stakeholder verification engine
 * (subject_type 'driver', strictest required-check set) and linked onto the
 * application so approval can require a VERIFIED case.
 */
export async function applyDriver(input: {
  userId: number;
  fullName: string;
  phone?: string | null;
  city?: string | null;
  vehicle?: DriverVehicle | null;
}): Promise<DriverApplication> {
  const pool = await getPool();
  const existing = await pool.query<ApplicationRow>(
    `${APPLICATION_SELECT}
     WHERE a.user_id = $1 AND a.status IN ('submitted', 'in_review')
     ORDER BY a.created_at DESC
     LIMIT 1`,
    [input.userId],
  );
  if (existing.rows[0]) return toApplication(existing.rows[0]);

  let inserted: ApplicationRow | undefined;
  try {
    const result = await pool.query<ApplicationRow>(
      `INSERT INTO public.driver_applications (user_id, full_name, phone, city, vehicle)
       VALUES ($1, $2, $3, $4, $5::jsonb)
       RETURNING id, user_id, status, verification_case_id,
                 NULL::text AS verification_case_state,
                 full_name, phone, city, vehicle, rejection_reason,
                 created_at, updated_at`,
      [
        input.userId,
        input.fullName,
        input.phone ?? null,
        input.city ?? null,
        JSON.stringify(input.vehicle ?? {}),
      ],
    );
    inserted = result.rows[0];
  } catch (error) {
    // Lost the one-active-application race: return the concurrent winner.
    if ((error as { code?: string }).code === "23505") {
      const raced = await pool.query<ApplicationRow>(
        `${APPLICATION_SELECT}
         WHERE a.user_id = $1 AND a.status IN ('submitted', 'in_review')
         ORDER BY a.created_at DESC
         LIMIT 1`,
        [input.userId],
      );
      if (raced.rows[0]) return toApplication(raced.rows[0]);
    }
    throw error;
  }
  if (!inserted) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "driver_application_create_failed",
    });
  }

  const caseId = await startVerificationCase({
    actorUserId: input.userId,
    subjectType: "driver",
    subjectKey: `driver-application-${inserted.id}`,
    subjectUserId: input.userId,
    jurisdiction: "NG",
    purpose: "driver_onboarding",
    idempotencyKey: `driver-apply-${inserted.id}`,
  });
  const linked = await pool.query<ApplicationRow>(
    `${APPLICATION_SELECT}
     WHERE a.id = $1`,
    [inserted.id],
  );
  await pool.query(
    `UPDATE public.driver_applications
     SET verification_case_id = $2, updated_at = now()
     WHERE id = $1`,
    [inserted.id, caseId],
  );
  const row = linked.rows[0];
  return toApplication(
    row ? { ...row, verification_case_id: caseId } : inserted,
  );
}

export async function getMyDriverApplication(
  userId: number,
): Promise<DriverApplication | null> {
  const pool = await getPool();
  const result = await pool.query<ApplicationRow>(
    `${APPLICATION_SELECT}
     WHERE a.user_id = $1
     ORDER BY a.created_at DESC
     LIMIT 1`,
    [userId],
  );
  return result.rows[0] ? toApplication(result.rows[0]) : null;
}

export async function withdrawMyDriverApplication(
  userId: number,
): Promise<DriverApplication> {
  const pool = await getPool();
  const result = await pool.query<ApplicationRow>(
    `UPDATE public.driver_applications
     SET status = 'withdrawn', updated_at = now()
     WHERE user_id = $1 AND status IN ('submitted', 'in_review')
     RETURNING id`,
    [userId],
  );
  const id = result.rows[0]?.id;
  if (!id) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "no_active_driver_application",
    });
  }
  const application = await pool.query<ApplicationRow>(
    `${APPLICATION_SELECT}
     WHERE a.id = $1`,
    [id],
  );
  return toApplication(application.rows[0]!);
}

export async function listDriverApplications(input?: {
  status?: DriverApplicationStatus;
  limit?: number;
}): Promise<DriverApplication[]> {
  const pool = await getPool();
  const result = await pool.query<ApplicationRow>(
    `${APPLICATION_SELECT}
     WHERE ($1::text IS NULL OR a.status = $1)
     ORDER BY a.created_at DESC
     LIMIT $2`,
    [input?.status ?? null, Math.min(Math.max(input?.limit ?? 50, 1), 200)],
  );
  return result.rows.map(toApplication);
}

/**
 * Verified-driver access rule (single source of truth).
 *
 * Returns the caller's approved application + verified KYC case, or null.
 * Null means NO driver-surface access: self-serve earnings/settlements/
 * performance paths throw and the dispatch offer stream is empty. A silent
 * open_id/email match against a (possibly seeded) drivers row is explicitly
 * NOT sufficient.
 */
export async function getVerifiedDriverAccess(
  publicUserId: number,
): Promise<{ applicationId: string; verificationCaseId: string } | null> {
  const pool = await getPool();
  const result = await pool.query<{
    application_id: string;
    verification_case_id: string;
  }>(
    `SELECT a.id AS application_id, a.verification_case_id
     FROM public.driver_applications a
     JOIN verification.verification_case c
       ON c.id = a.verification_case_id AND c.state = 'verified'
     WHERE a.user_id = $1 AND a.status = 'approved'
     ORDER BY a.updated_at DESC
     LIMIT 1`,
    [publicUserId],
  );
  const row = result.rows[0];
  return row
    ? {
        applicationId: row.application_id,
        verificationCaseId: row.verification_case_id,
      }
    : null;
}

/**
 * Operator decision on a driver application.
 *
 * - approve REQUIRES the bound verification case to be 'verified' — an
 *   operator cannot wave a driver through without completed KYC. Approval
 *   creates the `drivers` row (or refreshes the one already bound to the
 *   applicant's open_id) so dispatch/self-serve linkage resolves to a real,
 *   verified identity.
 * - reject REQUIRES a reason (surfaced to the applicant).
 * Deciding an already-decided application is a no-op returning current state.
 */
export async function decideDriverApplication(input: {
  applicationId: string;
  decision: "approved" | "rejected";
  rejectionReason?: string | null;
}): Promise<DriverApplication> {
  const pool = await getPool();
  const current = await pool.query<ApplicationRow>(
    `${APPLICATION_SELECT}
     WHERE a.id = $1
     LIMIT 1`,
    [input.applicationId],
  );
  const application = current.rows[0];
  if (!application) {
    throw new TRPCError({
      code: "NOT_FOUND",
      message: "driver_application_not_found",
    });
  }
  if (application.status === "approved" || application.status === "rejected") {
    return toApplication(application);
  }

  if (input.decision === "rejected") {
    const reason = input.rejectionReason?.trim();
    if (!reason) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "driver_rejection_reason_required",
      });
    }
    const updated = await pool.query<ApplicationRow>(
      `UPDATE public.driver_applications
       SET status = 'rejected', rejection_reason = $2, updated_at = now()
       WHERE id = $1 AND status IN ('submitted', 'in_review')
       RETURNING id`,
      [input.applicationId, reason],
    );
    if (!updated.rows[0]) {
      const raced = await pool.query<ApplicationRow>(
        `${APPLICATION_SELECT} WHERE a.id = $1 LIMIT 1`,
        [input.applicationId],
      );
      return toApplication(raced.rows[0]!);
    }
  } else {
    if (
      !application.verification_case_id ||
      application.verification_case_state !== "verified"
    ) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "driver_case_not_verified: approval requires the bound KYC case to be verified",
      });
    }
    // Create/bind the drivers row. Linkage convention (documented in
    // selfserveRouter): drivers.open_id matches users.open_id; resolveDriverForUser
    // keeps the case-insensitive email fallback for legacy seeded rows.
    const userResult = await pool.query<{
      open_id: string;
      name: string | null;
      email: string | null;
    }>(`SELECT open_id, name, email FROM public.users WHERE id = $1`, [
      application.user_id,
    ]);
    const publicUser = userResult.rows[0];
    if (!publicUser) {
      throw new TRPCError({
        code: "NOT_FOUND",
        message: "driver_application_user_not_found",
      });
    }
    const vehicle =
      application.vehicle && typeof application.vehicle === "object"
        ? (application.vehicle as DriverVehicle)
        : {};
    await pool.query(
      `INSERT INTO public.drivers (open_id, name, email, phone, vehicle_type, vehicle_number, license_number)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (open_id) DO UPDATE SET
         name = EXCLUDED.name,
         email = EXCLUDED.email,
         phone = EXCLUDED.phone,
         vehicle_type = EXCLUDED.vehicle_type,
         vehicle_number = EXCLUDED.vehicle_number,
         license_number = EXCLUDED.license_number,
         updated_at = now()`,
      [
        publicUser.open_id,
        application.full_name,
        publicUser.email,
        application.phone ?? "",
        vehicle.type ?? null,
        vehicle.number ?? null,
        vehicle.licenseNumber ?? null,
      ],
    );
    const updated = await pool.query<ApplicationRow>(
      `UPDATE public.driver_applications
       SET status = 'approved', updated_at = now()
       WHERE id = $1 AND status IN ('submitted', 'in_review')
       RETURNING id`,
      [input.applicationId],
    );
    if (!updated.rows[0]) {
      const raced = await pool.query<ApplicationRow>(
        `${APPLICATION_SELECT} WHERE a.id = $1 LIMIT 1`,
        [input.applicationId],
      );
      return toApplication(raced.rows[0]!);
    }
  }

  const finalRow = await pool.query<ApplicationRow>(
    `${APPLICATION_SELECT} WHERE a.id = $1 LIMIT 1`,
    [input.applicationId],
  );
  const decided = toApplication(finalRow.rows[0]!);
  // Notify the applicant of the decision. Fail-open (Audit A P1-8): a
  // notification outage never blocks the operator decision.
  await notifyDriverApplicationDecision(decided).catch((error) =>
    console.warn(
      "[driverOnboarding] decision notification failed; continuing",
      error,
    ),
  );
  return decided;
}

/**
 * Dispatch the application decision notice to the applicant (email
 * preferred, SMS fallback). Never throws into the decision path.
 */
async function notifyDriverApplicationDecision(
  application: DriverApplication,
): Promise<void> {
  try {
    const pool = await getPool();
    const contact = await pool.query<{
      email: string | null;
      phone: string | null;
    }>(`SELECT email, phone FROM public.users WHERE id = $1`, [
      application.userId,
    ]);
    const user = contact.rows[0];
    const reasonSuffix =
      application.status === "rejected" && application.rejectionReason
        ? ` Reason: ${application.rejectionReason}`
        : "";
    const message = `Your driver application was ${application.status}.${reasonSuffix}`;
    const metadata = {
      notificationType: "driver.application.decided",
      applicationId: application.id,
      status: application.status,
    };
    const email = user?.email ?? null;
    const phone = application.phone ?? user?.phone ?? null;
    if (email) {
      await sendEmail(
        email,
        "SwitchOS driver application decision",
        message,
        metadata,
      );
    } else if (phone) {
      await sendSMS(phone, message, metadata);
    }
  } catch (error) {
    console.warn(
      "[driverOnboarding] decision notification unavailable; continuing",
      error,
    );
  }
}
