/**
 * Wire-shape normalizers for the trust routers (`council`, `deactivation`).
 *
 * The server returns raw snake_case Postgres rows (see
 * server/_core/workerCouncil.ts and server/_core/deactivationDueProcess.ts);
 * the PWA pages consume the camelCase DTOs declared in `./trpcTrust`. These
 * pure functions perform the row -> DTO mapping so the bridge hooks can
 * normalize query results before pages see them. They are deliberately free
 * of trpc/react imports so the wire contract test
 * (tests/pwa-wire-contract.test.ts) can exercise them against fixtures copied
 * verbatim from the server modules.
 */
import type {
  ConsultationDetail,
  ConsultationObject,
  DeactivationAppeal,
  DeactivationCase,
  DeactivationCaseSummary,
} from "./trpcTrust";

// ---------- wire rows (column names verbatim from server/_core/workerCouncil.ts;
// props optional because the typed client sees superjson-serialized output) ----------

/** server `_core/workerCouncil.ts` `ConsultationRow & { response_count: number }` */
export interface CouncilConsultationRow {
  id?: string;
  kind?: string;
  title?: string;
  payload?: unknown;
  status?: "open" | "closed" | "activated" | "withdrawn";
  posted_by?: number | string | null;
  response_sla_at?: string | Date;
  activated_at?: string | Date | null;
  created_at?: string | Date;
  response_count?: number;
}

/** server `_core/workerCouncil.ts` `ConsultationResponseRow` */
export interface CouncilConsultationResponseRow {
  id?: string;
  consultation_id?: string;
  member_id?: string;
  stance?: "support" | "object" | "comment";
  body?: string;
  created_at?: string | Date;
}

/** server `_core/workerCouncil.ts` `getConsultation` return envelope */
export interface CouncilConsultationDetailResult {
  consultation?: CouncilConsultationRow;
  myResponse?: CouncilConsultationResponseRow | null;
}

// ---------- wire rows (column names verbatim from server/_core/deactivationDueProcess.ts;
// props optional because the typed client sees superjson-serialized output) ----------

/** server `_core/deactivationDueProcess.ts` `DeactivationCaseRow` */
export interface DeactivationCaseRow {
  id?: string;
  subject_user_id?: number | string;
  subject_role?: string;
  cause_code?: string;
  egregious?: boolean;
  evidence?: unknown;
  status?: string;
  notice_sent_at?: string | Date | null;
  effective_at?: string | Date | null;
  decided_by?: number | string | null;
  protected_activity?: boolean;
  created_at?: string | Date;
  updated_at?: string | Date;
}

/** server `_core/deactivationDueProcess.ts` `DeactivationAppealRow` */
export interface DeactivationAppealRow {
  id?: string;
  case_id?: string;
  appellant_user_id?: number | string;
  statement?: string;
  status?: string;
  reviewer_id?: number | string | null;
  decided_at?: string | Date | null;
  decision?: "upheld" | "reinstated" | "reinstated_with_backpay" | null;
  rationale?: string | null;
  sla_due_at?: string | Date;
  created_at?: string | Date;
}

/** server `_core/deactivationDueProcess.ts` `getMyCase` return envelope */
export interface DeactivationMyCaseResult {
  case?: DeactivationCaseRow | null;
  appeals?: DeactivationAppealRow[];
}

// ---------- coercion helpers ----------

function isoOrNull(value: string | Date | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

// ---------- council normalizers ----------

/**
 * Map a raw `council.listConsultations` row to the page DTO.
 *
 * The wire only carries a scalar `response_count` — no per-stance split and
 * no viewer response — so the stance buckets stay zero (never fabricated),
 * the unattributed total is preserved on `responseCounts.total`, and
 * `myResponse` is null in the list view.
 */
export function normalizeConsultationRow(
  row: CouncilConsultationRow,
): ConsultationObject {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    payload: row.payload,
    status: row.status,
    responseSlaAt: isoOrNull(row.response_sla_at),
    activatedAt: isoOrNull(row.activated_at),
    createdAt: iso(row.created_at),
    responseCounts: {
      support: 0,
      object: 0,
      comment: 0,
      total: Number(row.response_count) || 0,
    },
    myResponse: null,
  };
}

export function normalizeConsultationList(
  rows: CouncilConsultationRow[],
): ConsultationObject[] {
  return rows.map(normalizeConsultationRow);
}

/**
 * Map the `council.getConsultation` envelope `{consultation, myResponse}` to
 * the flat detail DTO. The server only returns the viewer's own response
 * (no full member-response list), so `responses` contains that response when
 * present and is otherwise empty.
 */
export function normalizeConsultationDetail(
  result: CouncilConsultationDetailResult,
): ConsultationDetail {
  const base = normalizeConsultationRow(result.consultation);
  const my = result.myResponse;
  return {
    ...base,
    myResponse: my ? { stance: my.stance, body: my.body } : null,
    responses: my
      ? [
          {
            id: my.id,
            memberId: String(my.member_id),
            stance: my.stance,
            body: my.body,
            createdAt: iso(my.created_at),
          },
        ]
      : [],
  };
}

// ---------- deactivation normalizers ----------

/**
 * Map the `deactivation.getMyCase` envelope `{case, appeals}` to the flat
 * case DTO the appeals page consumes (null when the subject has no case).
 */
export function normalizeMyDeactivationCase(
  result: DeactivationMyCaseResult,
): DeactivationCase | null {
  const row = result.case;
  if (!row) return null;
  return {
    id: row.id,
    subjectRole: row.subject_role,
    causeCode: row.cause_code,
    egregious: Boolean(row.egregious),
    status: row.status,
    noticeSentAt: isoOrNull(row.notice_sent_at),
    effectiveAt: isoOrNull(row.effective_at),
    protectedActivity: Boolean(row.protected_activity),
  };
}

export function normalizeDeactivationAppeal(
  row: DeactivationAppealRow,
): DeactivationAppeal {
  return {
    id: row.id,
    status: row.status,
    slaDueAt: isoOrNull(row.sla_due_at),
    decision: row.decision ?? null,
    reviewerId:
      row.reviewer_id === null || row.reviewer_id === undefined
        ? null
        : String(row.reviewer_id),
  };
}

/**
 * Map a raw `deactivation.listCases` row to the operator-queue DTO. The
 * server list endpoint does not join appeals, so the appeal list is empty
 * until a per-case appeal join lands server-side (review actions remain
 * available via `deactivation.reviewAppeal`).
 */
export function normalizeDeactivationCaseSummary(
  row: DeactivationCaseRow,
): DeactivationCaseSummary {
  return {
    id: row.id,
    subjectUserId: String(row.subject_user_id),
    subjectRole: row.subject_role,
    causeCode: row.cause_code,
    status: row.status,
    effectiveAt: isoOrNull(row.effective_at),
    appeals: [],
  };
}

export function normalizeDeactivationCaseList(
  rows: DeactivationCaseRow[],
): DeactivationCaseSummary[] {
  return rows.map(normalizeDeactivationCaseSummary);
}
