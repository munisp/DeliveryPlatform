/**
 * Wave A3 bridge (R1 rider verification, R4 deactivation appeals, R5 worker
 * council). The `council`, `deactivation`, and `riderVerification` routers
 * are registered in the AppRouter type, so this module now consumes the
 * typed client directly. The server returns raw snake_case Postgres rows for
 * council and deactivation reads; the bridge normalizes them via
 * `./trustWire` into the camelCase DTOs below so pages never touch wire
 * shapes (see tests/pwa-wire-contract.test.ts for the wire contract).
 */
import { trpc } from "@/lib/trpc";
import {
  normalizeConsultationDetail,
  normalizeConsultationList,
  normalizeDeactivationCaseList,
  normalizeMyDeactivationCase,
} from "@/lib/trustWire";

// ---------- council ----------

export type ConsultationStatus = "open" | "closed" | "activated" | "withdrawn";
export type ConsultationStance = "support" | "object" | "comment";

export interface ConsultationResponseCounts {
  support: number;
  object: number;
  comment: number;
  /**
   * Unattributed response total. The server wire exposes only a scalar
   * `response_count` (no per-stance split), so stance buckets are zero and
   * the real total lives here until the server ships stance counts.
   */
  total: number;
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

/** Matches the `deactivation.listCases` input enum in deactivationRouter.ts. */
export type DeactivationCaseStatus =
  | "notice"
  | "active"
  | "appealed"
  | "reinstated"
  | "upheld"
  | "closed";

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

const trustClient = trpc;

/**
 * Adapt a typed trpc query result to the bridge's `TrustQuery` shape,
 * mapping the raw wire data through `normalize` so pages only ever see the
 * camelCase DTO.
 */
function asQuery<TWire, TData>(
  query: TrustQuery<TWire>,
  normalize: (wire: TWire) => TData,
): TrustQuery<TData> {
  return {
    ...query,
    data: query.data === undefined ? undefined : normalize(query.data),
  };
}

function asMutation<TVars>(mutation: TrustMutation<TVars>): TrustMutation<TVars> {
  return mutation;
}

function identity<TData>(wire: TData): TData {
  return wire;
}

// ---------- council hooks ----------

export function useConsultations(status?: ConsultationStatus) {
  return asQuery(
    trustClient.council.listConsultations.useQuery(status ? { status } : {}),
    normalizeConsultationList,
  );
}

export function useConsultation(id: string | null) {
  return asQuery(
    trustClient.council.getConsultation.useQuery(
      { id: id ?? "" },
      { enabled: Boolean(id) },
    ),
    normalizeConsultationDetail,
  );
}

export function useRespondToConsultation() {
  return asMutation<{ id: string; stance: ConsultationStance; body: string }>(
    trustClient.council.respondToConsultation.useMutation(),
  );
}

// ---------- deactivation hooks ----------

export function useMyDeactivationCase() {
  return asQuery(
    trustClient.deactivation.getMyCase.useQuery(),
    normalizeMyDeactivationCase,
  );
}

export function useFileAppeal() {
  return asMutation<{ caseId: string; statement: string }>(
    trustClient.deactivation.fileAppeal.useMutation(),
  );
}

export function useDeactivationCases(status?: DeactivationCaseStatus) {
  return asQuery(
    trustClient.deactivation.listCases.useQuery(status ? { status } : {}),
    normalizeDeactivationCaseList,
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
// riderVerification reads already map to camelCase server-side
// (server/_core/riderVerification.ts), so these pass through unchanged.

export function useOfferRiderBadge(offerId: string) {
  return asQuery(
    trustClient.riderVerification.getOfferRiderBadge.useQuery({ offerId }),
    identity,
  );
}

export function useMyVerificationStatus() {
  return asQuery(
    trustClient.riderVerification.getMyVerificationStatus.useQuery(),
    identity,
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
