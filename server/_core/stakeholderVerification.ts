/**
 * Stakeholder verification engine (F2): fail-closed KYC/verification for
 * drivers, riders, couriers, merchants, fleet providers, technicians, and
 * influencers. The SQL functions (drizzle/0053) own all rules and audit;
 * this module only calls them. Fail-closed means a case starts in
 * manual_review and only an explicit operator decision with recorded
 * reason can verify, reject, or suspend it.
 */
import { Pool } from "pg";
import { ENV } from "./env";
import { sendEmail, sendSMS } from "./notificationGateway";

let pool: Pool | null = null;
function database(): Pool {
  if (!pool) {
    pool = new Pool({ connectionString: ENV.databaseUrl, max: 4 });
  }
  return pool;
}

export const SUBJECT_TYPES = [
  "driver",
  "rider",
  "courier",
  "merchant",
  "fleet_provider",
  "field_technician",
  "influencer",
] as const;
export type SubjectType = (typeof SUBJECT_TYPES)[number];

const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/;

function requireIdempotencyKey(key: string): void {
  if (!IDEMPOTENCY_KEY.test(key)) {
    throw new Error("invalid_idempotency_key");
  }
}

export async function startVerificationCase(input: {
  actorUserId: number;
  subjectType: SubjectType;
  subjectKey: string;
  subjectUserId?: number | null;
  requiredDocs?: string[];
  idempotencyKey: string;
}): Promise<{ id: string; state: string }> {
  requireIdempotencyKey(input.idempotencyKey);
  const docs = JSON.stringify(input.requiredDocs ?? []);
  const result = await database().query<{
    id: string;
    state: string;
  }>(
    `SELECT id, state::text AS state FROM verification.start_case($1,$2,$3,$4,$5::jsonb,$6)`,
    [
      input.actorUserId,
      input.subjectType,
      input.subjectKey,
      input.subjectUserId ?? null,
      docs,
      input.idempotencyKey,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("verification_case_start_failed");
  return { id: row.id, state: row.state };
}

export async function getVerificationCase(caseId: string): Promise<{
  id: string;
  subjectType: string;
  subjectKey: string;
  subjectUserId: number | null;
  state: string;
  requiredDocs: unknown;
  submittedDocs: unknown;
  decidedBy: number | null;
  decisionReason: string | null;
  verifiedAt: string | null;
  expiresAt: string | null;
} | null> {
  const result = await database().query(
    `SELECT id, subject_type::text AS "subjectType", subject_key AS "subjectKey",
            subject_user_id AS "subjectUserId", state::text AS state,
            required_docs AS "requiredDocs", submitted_docs AS "submittedDocs",
            decided_by_user_id AS "decidedBy", decision_reason AS "decisionReason",
            verified_at AS "verifiedAt", expires_at AS "expiresAt"
       FROM verification.verification_case WHERE id = $1`,
    [caseId],
  );
  return (result.rows[0] as never) ?? null;
}

/** Fail-closed helper: true only when the case state is exactly 'verified' and not expired. */
export async function isVerified(caseId: string): Promise<boolean> {
  const result = await database().query<{ ok: boolean }>(
    `SELECT (state = 'verified'::verification.case_state
            AND (expires_at IS NULL OR expires_at > now())) AS ok
       FROM verification.verification_case WHERE id = $1`,
    [caseId],
  );
  return result.rows[0]?.ok === true;
}

/** Fail-closed helper by subject: any non-expired verified case for the subject. */
export async function hasVerifiedCase(
  subjectType: SubjectType,
  subjectKey: string,
): Promise<boolean> {
  const result = await database().query<{ ok: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM verification.verification_case
        WHERE subject_type = $1::verification.subject_type
          AND subject_key = $2
          AND state = 'verified'::verification.case_state
          AND (expires_at IS NULL OR expires_at > now())
     ) AS ok`,
    [subjectType, subjectKey],
  );
  return result.rows[0]?.ok === true;
}

export async function submitVerificationDocuments(input: {
  actorUserId: number;
  caseId: string;
  documents: Array<{ type: string; reference: string }>;
  idempotencyKey: string;
}): Promise<string> {
  requireIdempotencyKey(input.idempotencyKey);
  const result = await database().query<{ state: string }>(
    `SELECT verification.submit_documents($1,$2,$3::jsonb,$4) AS state`,
    [
      input.actorUserId,
      input.caseId,
      JSON.stringify(input.documents),
      input.idempotencyKey,
    ],
  );
  const row = result.rows[0];
  if (!row) throw new Error("verification_documents_failed");
  return row.state;
}

export type Decision = "verify" | "reject" | "suspend";

export async function decideVerificationCase(input: {
  actorUserId: number;
  caseId: string;
  decision: Decision;
  reason: string;
  expiresAt?: string | null;
  idempotencyKey: string;
}): Promise<string> {
  requireIdempotencyKey(input.idempotencyKey);
  const result = await database().query<{ state: string }>(
    `SELECT verification.decide_case($1,$2,$3::verification.decision,$4,$5,$6) AS state`,
    [
      input.actorUserId,
      input.caseId,
      input.decision,
      input.reason,
      input.expiresAt ?? null,
      input.idempotencyKey,
    ],
  );
  const state = one(result.rows, "verification_case_decision").state;
  // Notify the case subject of the decision. Fail-open (Audit A P1-8): a
  // notification outage must never block or roll back the decision.
  await notifyVerificationDecision(input.caseId, input.decision, state).catch(
    (error) =>
      console.warn(
        "[stakeholderVerification] decision notification failed; continuing",
        error,
      ),
  );
  return state;
}

/**
 * Look up the case subject's contact and dispatch the decision notice.
 * Never throws into the decision path.
 */
async function notifyVerificationDecision(
  caseId: string,
  decision: Decision,
  state: string,
): Promise<void> {
  try {
    const found = await database().query<{
      subject_user_id: number | null;
      subject_type: string;
      subject_key: string;
    }>(
      `SELECT subject_user_id, subject_type::text AS subject_type, subject_key
       FROM verification.verification_case WHERE id = $1::uuid`,
      [caseId],
    );
    const subject = found.rows[0];
    if (!subject?.subject_user_id) return;
    const contact = await database().query<{
      email: string | null;
      phone: string | null;
    }>(`SELECT email, phone FROM public.users WHERE id = $1`, [
      subject.subject_user_id,
    ]);
    const user = contact.rows[0];
    const message = `Your ${subject.subject_type} verification case ${caseId} was decided: ${state} (${decision}). If rejected or suspended you may file an appeal within 14 days.`;
    const metadata = {
      notificationType: "verification.case.decided",
      caseId,
      decision,
      state,
    };
    if (user?.email) {
      await sendEmail(
        user.email,
        "SwitchOS verification decision",
        message,
        metadata,
      );
    } else if (user?.phone) {
      await sendSMS(user.phone, message, metadata);
    }
  } catch (error) {
    console.warn(
      "[stakeholderVerification] decision notification unavailable; continuing",
      error,
    );
  }
}

function one<T>(rows: T[], label: string): T {
  const row = rows[0];
  if (row == null) throw new Error(label);
  return row;
}
