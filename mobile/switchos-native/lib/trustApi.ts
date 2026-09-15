/**
 * Wave E1 bridge (R1 rider verification, R4 deactivation appeals, R5 worker
 * council). The mobile app's own embedded AppRouter does not register the
 * platform trust routers — the app talks to the deployed platform API where
 * `riderVerification`, `deactivation`, and `council` already exist on main.
 * Every access goes through this module's typed wrappers so screens never
 * touch `any` (same bridge pattern as the PWA's client/src/lib/trpcTrust.ts).
 *
 * Types below match the ACTUAL wire shapes returned by the server routers on
 * main (verified against server/_core/riderVerificationRouter.ts,
 * deactivationRouter.ts, councilRouter.ts): council and deactivation return
 * raw Postgres rows (snake_case), rider verification returns camelCase
 * objects. timestamptz columns arrive as ISO strings or Dates via superjson;
 * bigint columns can arrive as strings.
 */
import { trpc } from "@/lib/trpc";

// ---------- council (R5) ----------

export type ConsultationStatus = "open" | "closed" | "activated" | "withdrawn";
export type ConsultationStance = "support" | "object" | "comment";

/** Raw consultation_objects row plus the per-consultation response tally. */
export interface ConsultationRow {
  id: string;
  kind: string;
  title: string;
  payload: unknown;
  status: ConsultationStatus;
  posted_by: number | string | null;
  response_sla_at: string | Date | null;
  activated_at: string | Date | null;
  created_at: string | Date;
  response_count: number;
}

export interface ConsultationResponseRow {
  id: string;
  consultation_id: string;
  member_id: string;
  stance: ConsultationStance;
  body: string;
  created_at: string | Date;
}

export interface ConsultationDetail {
  consultation: ConsultationRow;
  myResponse: ConsultationResponseRow | null;
}

// ---------- deactivation (R4) ----------

export type AppealDecision = "upheld" | "reinstated" | "reinstated_with_backpay";

export interface DeactivationCaseRow {
  id: string;
  subject_user_id: number | string;
  subject_role: string;
  cause_code: string;
  egregious: boolean;
  status: string;
  notice_sent_at: string | Date | null;
  effective_at: string | Date | null;
  protected_activity: boolean;
  created_at: string | Date;
}

export interface DeactivationAppealRow {
  id: string;
  case_id: string;
  status: string;
  statement: string | null;
  sla_due_at: string | Date | null;
  decision: AppealDecision | null;
  rationale: string | null;
  decided_at: string | Date | null;
  created_at: string | Date;
}

export interface MyDeactivationCase {
  case: DeactivationCaseRow | null;
  appeals: DeactivationAppealRow[];
}

// ---------- rider verification (R1) ----------

export interface VerificationStatus {
  status: "unverified" | "pending" | "verified" | "rejected" | "suspended" | string;
  badgeLevel: "none" | "verified";
  flags: string[];
}

export interface RiderBadge {
  verified: boolean;
  firstName: string | null;
  rating: number | null;
}

export interface NameScreeningResult {
  score: number;
  flags: string[];
  plausible: boolean;
}

// ---------- shared typed result shapes (mirror of the PWA bridge) ----------

export interface TrustQuery<TData> {
  data: TData | undefined;
  isLoading: boolean;
  isError: boolean;
  isRefetching: boolean;
  error: { message: string } | null;
  refetch: () => Promise<unknown>;
}

export interface TrustMutationOptions {
  onSuccess?: () => void;
  onError?: (error: { message: string }) => void;
}

export interface TrustMutation<TVars, TData = unknown> {
  mutate: (vars: TVars, options?: TrustMutationOptions) => void;
  data: TData | undefined;
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
  error: { message: string } | null;
  reset: () => void;
}

const trustClient = trpc as any;

function asQuery<TData>(query: any): TrustQuery<TData> {
  return query as TrustQuery<TData>;
}

function asMutation<TVars, TData = unknown>(
  mutation: any,
): TrustMutation<TVars, TData> {
  return mutation as TrustMutation<TVars, TData>;
}

// ---------- council hooks ----------

export function useConsultations(status?: ConsultationStatus) {
  return asQuery<ConsultationRow[]>(
    trustClient.council.listConsultations.useQuery(status ? { status } : {}),
  );
}

export function useConsultation(id: string | null) {
  return asQuery<ConsultationDetail>(
    trustClient.council.getConsultation.useQuery(
      { id: id ?? "" },
      { enabled: Boolean(id) },
    ),
  );
}

export function useRespondToConsultation() {
  return asMutation<
    { id: string; stance: ConsultationStance; body: string },
    ConsultationResponseRow
  >(trustClient.council.respondToConsultation.useMutation());
}

// ---------- deactivation hooks ----------

export function useMyDeactivationCase() {
  return asQuery<MyDeactivationCase>(
    trustClient.deactivation.getMyCase.useQuery(),
  );
}

export function useFileAppeal() {
  return asMutation<{ caseId: string; statement: string }, DeactivationAppealRow>(
    trustClient.deactivation.fileAppeal.useMutation(),
  );
}

// ---------- rider verification hooks ----------

export function useMyVerificationStatus() {
  return asQuery<VerificationStatus>(
    trustClient.riderVerification.getMyVerificationStatus.useQuery(),
  );
}

export function useSubmitVerification() {
  return asMutation<{ idType: string; idRef: string }, { status: string }>(
    trustClient.riderVerification.submitVerification.useMutation(),
  );
}

/** On-demand name plausibility pre-check; call `refetch()` to run it. */
export function useScreenName(name: string, enabled: boolean) {
  return asQuery<NameScreeningResult>(
    trustClient.riderVerification.screenName.useQuery(
      { name },
      { enabled: enabled && name.trim().length > 0 },
    ),
  );
}

export function useOfferRiderBadge(offerId: string) {
  return asQuery<RiderBadge>(
    trustClient.riderVerification.getOfferRiderBadge.useQuery(
      { offerId },
      { enabled: Boolean(offerId) },
    ),
  );
}

// ---------- invalidation helpers ----------

export function useTrustInvalidation() {
  const utils = trustClient.useUtils();
  return {
    council: () => {
      void utils.council.listConsultations.invalidate();
      void utils.council.getConsultation.invalidate();
    },
    deactivation: () => {
      void utils.deactivation.getMyCase.invalidate();
    },
    riderVerification: () => {
      void utils.riderVerification.getOfferRiderBadge.invalidate();
      void utils.riderVerification.getMyVerificationStatus.invalidate();
    },
  };
}
