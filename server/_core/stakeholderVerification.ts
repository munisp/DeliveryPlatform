import { Pool } from "pg";
import { ENV } from "./env";
import { sendEmail, sendSMS } from "./notificationGateway";

let pool: Pool | null = null;
function database() {
  if (!ENV.databaseUrl)
    throw new Error("stakeholder_verification_database_unconfigured");
  if (!pool) {
    pool = new Pool({
      connectionString: ENV.databaseUrl,
      ssl:
        ENV.isProduction && !ENV.databaseUrl.includes("sslmode=disable")
          ? {
              rejectUnauthorized: true,
              ...(ENV.databaseSslCa ? { ca: ENV.databaseSslCa } : {}),
            }
          : false,
      max: 5,
    });
  }
  return pool;
}

type SubjectType =
  | "driver"
  | "vehicle_asset"
  | "field_technician"
  | "merchant"
  | "fleet_provider"
  | "operator";
type CheckType =
  | "identity_document"
  | "liveness"
  | "driving_licence"
  | "criminal_record"
  | "sanctions"
  | "vehicle_registry"
  | "commercial_insurance"
  | "technician_credential"
  | "beneficial_owner"
  | "operator_recertification";
type CheckState =
  | "passed"
  | "failed"
  | "manual_review"
  | "unavailable"
  | "expired";
type Decision = "verify" | "reject" | "suspend" | "expire";

function one<T>(rows: T[], label: string): T {
  if (!rows[0]) throw new Error(`${label}_not_found`);
  return rows[0];
}

export async function startVerificationCase(input: {
  actorUserId: number;
  subjectType: SubjectType;
  subjectKey: string;
  subjectUserId?: number | null;
  jurisdiction: string;
  purpose: string;
  idempotencyKey: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT verification.start_case($1,$2::verification.subject_type,$3,$4,$5,$6,$7) AS id`,
    [
      input.actorUserId,
      input.subjectType,
      input.subjectKey,
      input.subjectUserId ?? null,
      input.jurisdiction,
      input.purpose,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "verification_case").id;
}

export async function recordVerificationConsent(input: {
  actorUserId: number;
  caseId: string;
  consentVersion: string;
  disclosureDigestHex: string;
  expiresAt: string;
  idempotencyKey: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT verification.record_consent($1,$2::uuid,$3,$4,$5::timestamptz,$6) AS id`,
    [
      input.actorUserId,
      input.caseId,
      input.consentVersion,
      input.disclosureDigestHex,
      input.expiresAt,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "verification_consent").id;
}

export async function withdrawVerificationConsent(input: {
  actorUserId: number;
  caseId: string;
  idempotencyKey: string;
}) {
  const result = await database().query<{ state: string }>(
    `SELECT verification.withdraw_consent($1,$2::uuid,$3) AS state`,
    [input.actorUserId, input.caseId, input.idempotencyKey],
  );
  return one(result.rows, "verification_consent_withdrawal").state;
}

export async function recordVerificationEvidence(input: {
  actorUserId: number;
  caseId: string;
  evidenceKind: string;
  objectKey: string;
  contentType:
    | "application/pdf"
    | "image/jpeg"
    | "image/png"
    | "image/heic"
    | "video/mp4";
  sha256Hex: string;
  captureMetadata: Record<string, unknown>;
  idempotencyKey: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT verification.record_evidence($1,$2::uuid,$3,$4,$5,$6,$7::jsonb,$8) AS id`,
    [
      input.actorUserId,
      input.caseId,
      input.evidenceKind,
      input.objectKey,
      input.contentType,
      input.sha256Hex,
      JSON.stringify(input.captureMetadata),
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "verification_evidence").id;
}

export async function enqueueVerificationProcessing(input: {
  actorUserId: number;
  caseId: string;
  evidenceId: string;
  processor:
    | "paddleocr"
    | "docling"
    | "vlm_document"
    | "liveness"
    | "document_forensics";
  idempotencyKey: string;
}) {
  const result = await database().query<{ id: string }>(
    `SELECT verification.enqueue_processing($1,$2::uuid,$3::uuid,$4,$5) AS id`,
    [
      input.actorUserId,
      input.caseId,
      input.evidenceId,
      input.processor,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "verification_processing_job").id;
}

export async function listVerificationCases(
  actorUserId: number,
  limit: number,
) {
  const result = await database().query<{
    id: string;
    subject_type: SubjectType;
    subject_key: string;
    jurisdiction: string;
    purpose: string;
    state: string;
    expires_at: Date | null;
    updated_at: Date;
  }>(`SELECT * FROM verification.list_cases_for_actor($1,$2)`, [
    actorUserId,
    limit,
  ]);
  return result.rows.map((row) => ({
    id: row.id,
    subjectType: row.subject_type,
    subjectKey: row.subject_key,
    jurisdiction: row.jurisdiction,
    purpose: row.purpose,
    state: row.state,
    expiresAt: row.expires_at?.toISOString() ?? null,
    updatedAt: row.updated_at.toISOString(),
  }));
}

export async function getVerificationChecks(
  actorUserId: number,
  caseId: string,
) {
  const result = await database().query<{
    check_type: CheckType;
    state: CheckState;
    provider_key: string;
    checked_at: Date;
    expires_at: Date | null;
    detail_code: string | null;
  }>(`SELECT * FROM verification.get_case_checks_for_actor($1,$2::uuid)`, [
    actorUserId,
    caseId,
  ]);
  return result.rows.map((row) => ({
    checkType: row.check_type,
    state: row.state,
    providerKey: row.provider_key,
    checkedAt: row.checked_at.toISOString(),
    expiresAt: row.expires_at?.toISOString() ?? null,
    detailCode: row.detail_code,
  }));
}

export async function recordVerificationProviderCheck(input: {
  actorUserId: number;
  caseId: string;
  checkType: CheckType;
  providerKey: string;
  state: CheckState;
  providerReference?: string | null;
  responseDigestHex?: string | null;
  expiresAt?: string | null;
  detailCode?: string | null;
  idempotencyKey: string;
}) {
  const result = await database().query<{ state: CheckState }>(
    `SELECT verification.record_provider_check($1,$2::uuid,$3::verification.check_type,$4,$5::verification.check_state,$6,$7,$8::timestamptz,$9,$10) AS state`,
    [
      input.actorUserId,
      input.caseId,
      input.checkType,
      input.providerKey,
      input.state,
      input.providerReference ?? null,
      input.responseDigestHex ?? null,
      input.expiresAt ?? null,
      input.detailCode ?? null,
      input.idempotencyKey,
    ],
  );
  return one(result.rows, "verification_provider_check").state;
}

export async function decideVerificationCase(input: {
  actorUserId: number;
  caseId: string;
  decision: Decision;
  reason: string;
  expiresAt?: string | null;
  idempotencyKey: string;
}) {
  const result = await database().query<{ state: string }>(
    `SELECT verification.decide_case($1,$2::uuid,$3::verification.decision,$4,$5::timestamptz,$6) AS state`,
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
