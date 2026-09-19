/**
 * Driver onboarding (P0): self-serve application flow wired to the
 * fail-closed verification engine (stakeholderVerification / 0053).
 *
 * Flow: apply -> (verification case opened in manual_review) -> operator
 * decides the verification case -> operator approves/rejects the
 * application. Approval is IMPOSSIBLE unless the bound verification case
 * is in state 'verified' and unexpired — checked both here and inside the
 * 0091 approve_driver_application SQL function (defense in depth).
 *
 * Applications live in public.driver_applications (drizzle/0091).
 */

import { TRPCError } from "@trpc/server";

import { getPool } from "../db";
import { sendEmail, sendSMS } from "./notificationGateway";
import { startVerificationCase } from "./stakeholderVerification";

export type DriverApplicationStatus =
  | "submitted"
  | "in_review"
  | "approved"
  | "rejected";

export type DriverApplication = {
  id: string;
  userId: number;
  status: DriverApplicationStatus;
  verificationCaseId: string;
  verificationCaseState: string | null;
  fullName: string;
  phone: string | null;
  city: string | null;
  vehicle: Record<string, unknown>;
  rejectionReason: string | null;
  createdAt: string;
  updatedAt: string;
};

const REQUIRED_DOCS = ["license", "identity", "vehicle_registration"];

type ApplicationRow = {
  id: string;
  user_id: number;
  status: DriverApplicationStatus;
  verification_case_id: string;
  verification_case_state: string | null;
  full_name: string;
  phone: string | null;
  city: string | null;
  vehicle: Record<string, unknown>;
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
    LEFT JOIN verification.verification_case c ON c.id = a.verification_case_id
`;

function toApplication(row: ApplicationRow): DriverApplication {
  return {
    id: row.id,
    userId: row.user_id,
    status: row.status,
    verificationCaseId: row.verification_case_id,
    verificationCaseState: row.verification_case_state,
    fullName: row.full_name,
    phone: row.phone,
    city: row.city,
    vehicle: row.vehicle ?? {},
    rejectionReason: row.rejection_reason,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

/** Self-serve: submit (or resubmit after rejection) a driver application. */
export async function submitDriverApplication(
  userId: number,
  input: {
    fullName: string;
    phone?: string;
    city?: string;
    vehicle?: Record<string, unknown>;
    idempotencyKey: string;
  },
): Promise<DriverApplication> {
  const fullName = input.fullName.trim();
  if (fullName.length < 2 || fullName.length > 120) {
    throw new TRPCError({
      code: "BAD_REQUEST",
      message: "full_name_length_invalid",
    });
  }

  const pool = await getPool();

  const existing = await pool.query<ApplicationRow>(
    `${APPLICATION_SELECT} WHERE a.user_id = $1 ORDER BY a.created_at DESC LIMIT 1`,
    [userId],
  );
  const current = existing.rows[0];
  if (current && current.status !== "rejected") {
    throw new TRPCError({
      code: "CONFLICT",
      message: `driver_application_already_${current.status}`,
    });
  }

  // Open the fail-closed verification case bound to this applicant. The case
  // starts in manual_review; nothing downstream can verify itself.
  const verificationCase = await startVerificationCase({
    actorUserId: userId,
    subjectType: "driver",
    subjectKey: `driver-application:${userId}`,
    subjectUserId: userId,
    requiredDocs: REQUIRED_DOCS,
    idempotencyKey: input.idempotencyKey,
  });

  const inserted = await pool.query<ApplicationRow>(
    `INSERT INTO public.driver_applications
       (user_id, verification_case_id, full_name, phone, city, vehicle, status)
     VALUES ($1, $2::uuid, $3, $4, $5, $6::jsonb, 'submitted')
     RETURNING *`,
    [
      userId,
      verificationCase.id,
      fullName,
      input.phone ?? null,
      input.city ?? null,
      JSON.stringify(input.vehicle ?? {}),
    ],
  );
  const row = inserted.rows[0];
  if (!row) {
    throw new TRPCError({
      code: "INTERNAL_SERVER_ERROR",
      message: "driver_application_creation_failed",
    });
  }
  const joined = await pool.query<ApplicationRow>(
    `${APPLICATION_SELECT} WHERE a.id = $1 LIMIT 1`,
    [row.id],
  );
  return toApplication(joined.rows[0] ?? { ...row, verification_case_state: verificationCase.state });
}

/** Self-serve: the caller's own latest application (or null). */
export async function getMyDriverApplication(
  userId: number,
): Promise<DriverApplication | null> {
  const pool = await getPool();
  const result = await pool.query<ApplicationRow>(
    `${APPLICATION_SELECT} WHERE a.user_id = $1 ORDER BY a.created_at DESC LIMIT 1`,
    [userId],
  );
  const row = result.rows[0];
  return row ? toApplication(row) : null;
}

/** Operator: move a submitted application into review. */
export async function reviewDriverApplication(
  applicationId: string,
): Promise<DriverApplication> {
  const pool = await getPool();
  const updated = await pool.query<ApplicationRow>(
    `UPDATE public.driver_applications
        SET status = 'in_review', updated_at = now()
      WHERE id = $1 AND status = 'submitted'
      RETURNING *`,
    [applicationId],
  );
  if (!updated.rows[0]) {
    throw new TRPCError({
      code: "CONFLICT",
      message: "driver_application_not_submitted",
    });
  }
  const joined = await pool.query<ApplicationRow>(
    `${APPLICATION_SELECT} WHERE a.id = $1 LIMIT 1`,
    [applicationId],
  );
  return toApplication(joined.rows[0]!);
}

/**
 * Operator: approve or reject. Approval is fail-closed on the bound
 * verification case: it must be 'verified' and unexpired. The 0091 SQL
 * function re-checks the same rule inside the database.
 */
export async function decideDriverApplication(input: {
  applicationId: string;
  decision: "approved" | "rejected";
  rejectionReason?: string;
}): Promise<DriverApplication> {
  const pool = await getPool();
  const current = await pool.query<ApplicationRow>(
    `${APPLICATION_SELECT} WHERE a.id = $1 LIMIT 1`,
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
    // Idempotent: deciding an already-decided application is a no-op echo.
    return toApplication(application);
  }

  if (input.decision === "rejected") {
    const reason = input.rejectionReason?.trim();
    if (!reason || reason.length < 3) {
      throw new TRPCError({
        code: "BAD_REQUEST",
        message: "rejection_reason_required",
      });
    }
    await pool.query(
      `UPDATE public.driver_applications
          SET status = 'rejected', rejection_reason = $2, updated_at = now()
        WHERE id = $1`,
      [input.applicationId, reason],
    );
  } else {
    const verified =
      application.verification_case_state === "verified";
    if (!verified) {
      throw new TRPCError({
        code: "CONFLICT",
        message: "verification_not_verified",
      });
    }
    // Materialize the driver profile so dispatch can see the driver. The
    // drivers table is keyed on open_id in this stack; resolve it from the
    // public user and upsert.
    const userResult = await pool.query<{
      open_id: string;
      name: string | null;
      email: string | null;
    }>(`SELECT open_id, name, email FROM public.users WHERE id = $1`, [
      application.user_id,
    ]);
    const user = userResult.rows[0];
    if (!user?.open_id) {
      throw new TRPCError({
        code: "PRECONDITION_FAILED",
        message: "driver_user_missing_open_id",
      });
    }
    await pool.query(
      `INSERT INTO public.drivers (open_id, name, phone, status, vehicle_info, rating, total_trips, total_earnings_kobo, created_at, updated_at)
       VALUES ($1, $2, $3, 'offline', $4::jsonb, 500, 0, 0, now(), now())
       ON CONFLICT (open_id) DO UPDATE
          SET name = EXCLUDED.name,
              phone = COALESCE(EXCLUDED.phone, drivers.phone),
              vehicle_info = COALESCE(EXCLUDED.vehicle_info, drivers.vehicle_info),
              updated_at = now()`,
      [
        user.open_id,
        application.full_name,
        application.phone,
        JSON.stringify(application.vehicle ?? {}),
      ],
    );
    await pool.query(
      `UPDATE public.driver_applications
          SET status = 'approved', updated_at = now()
        WHERE id = $1`,
      [input.applicationId],
    );
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

/** Operator: list applications, optionally filtered by status. */
export async function listDriverApplications(status?: DriverApplicationStatus) {
  const pool = await getPool();
  if (status) {
    const result = await pool.query<ApplicationRow>(
      `${APPLICATION_SELECT} WHERE a.status = $1 ORDER BY a.created_at DESC LIMIT 200`,
      [status],
    );
    return result.rows.map(toApplication);
  }
  const result = await pool.query<ApplicationRow>(
    `${APPLICATION_SELECT} ORDER BY a.created_at DESC LIMIT 200`,
  );
  return result.rows.map(toApplication);
}
