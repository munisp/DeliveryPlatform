/**
 * Wave A3 bridge (R1 rider verification, R4 deactivation appeals, R5 worker
 * council). The `council`, `deactivation`, and `riderVerification` routers are
 * being implemented on the server in parallel; until they land in the AppRouter
 * type, every access goes through this module's typed wrappers so pages never
 * touch `any`. Post-merge tightening = delete the casts here.
 */
import { trpc } from "@/lib/trpc";

// ---------- council ----------

export type ConsultationStatus = "open" | "closed" | "activated" | "withdrawn";
export type ConsultationStance = "support" | "object" | "comment";

export interface ConsultationResponseCounts {
  support: number;
  object: number;
  comment: number;
}

export interface ConsultationMyResponse {
  stance: ConsultationStance;
  body: string;
}

export interface ConsultationObject {
  id: string;
  kind: string;
  title: string;
  payload: unknown;
  status: ConsultationStatus;
  responseSlaAt: string | null;
  activatedAt: string | null;
  createdAt: string;
  responseCounts: ConsultationResponseCounts;
  myResponse: ConsultationMyResponse | null;
}

export interface ConsultationResponse {
  id: string;
  memberId: string;
  stance: ConsultationStance;
  body: string;
  createdAt: string;
}

export interface ConsultationDetail extends ConsultationObject {
  responses: ConsultationResponse[];
}

// ---------- deactivation ----------

export interface DeactivationCase {
  id: string;
  subjectRole: string;
  causeCode: string;
  egregious: boolean;
  status: string;
  noticeSentAt: string | null;
  effectiveAt: string | null;
  protectedActivity: boolean;
}

export interface DeactivationAppeal {
  id: string;
  status: string;
  slaDueAt: string | null;
  decision: AppealDecision | null;
  reviewerId: string | null;
}

export interface DeactivationCaseSummary {
  id: string;
  subjectUserId: string;
  subjectRole: string;
  causeCode: string;
  status: string;
  effectiveAt: string | null;
  appeals: DeactivationAppeal[];
}

export type AppealDecision = "upheld" | "reinstated" | "reinstated_with_backpay";

// ---------- rider verification ----------

export interface RiderBadge {
  verified: boolean;
  firstName: string | null;
  rating: number | null;
}

export interface VerificationStatus {
  status: string;
  badgeLevel: "none" | "verified";
  flags: string[];
}

// ---------- shared typed result shapes ----------

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

export interface TrustMutation<TVars> {
  mutate: (vars: TVars, options?: TrustMutationOptions) => void;
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
  error: { message: string } | null;
  reset: () => void;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const trustClient = trpc as any;

function asQuery<TData>(query: any): TrustQuery<TData> {
  return query as TrustQuery<TData>;
}

function asMutation<TVars>(mutation: any): TrustMutation<TVars> {
  return mutation as TrustMutation<TVars>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------- council hooks ----------

export function useConsultations(status?: ConsultationStatus) {
  return asQuery<ConsultationObject[]>(
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
  return asMutation<{ id: string; stance: ConsultationStance; body: string }>(
    trustClient.council.respondToConsultation.useMutation(),
  );
}

// ---------- deactivation hooks ----------

export function useMyDeactivationCase() {
  return asQuery<DeactivationCase | null>(
    trustClient.deactivation.getMyCase.useQuery(),
  );
}

export function useFileAppeal() {
  return asMutation<{ caseId: string; statement: string }>(
    trustClient.deactivation.fileAppeal.useMutation(),
  );
}

export function useDeactivationCases(status?: string) {
  return asQuery<DeactivationCaseSummary[]>(
    trustClient.deactivation.listCases.useQuery(status ? { status } : {}),
  );
}

export function useReviewAppeal() {
  return asMutation<{
    appealId: string;
    decision: AppealDecision;
    rationale: string;
  }>(trustClient.deactivation.reviewAppeal.useMutation());
}

// ---------- rider verification hooks ----------

export function useOfferRiderBadge(offerId: string) {
  return asQuery<RiderBadge>(
    trustClient.riderVerification.getOfferRiderBadge.useQuery({ offerId }),
  );
}

export function useMyVerificationStatus() {
  return asQuery<VerificationStatus>(
    trustClient.riderVerification.getMyVerificationStatus.useQuery(),
  );
}

export function useSubmitVerification() {
  return asMutation<{ idType: string; idRef: string }>(
    trustClient.riderVerification.submitVerification.useMutation(),
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
      void utils.deactivation.listCases.invalidate();
    },
    riderVerification: () => {
      void utils.riderVerification.getOfferRiderBadge.invalidate();
      void utils.riderVerification.getMyVerificationStatus.invalidate();
    },
  };
}
