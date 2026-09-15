/**
 * Wave B3 bridge (R2 passenger manifest, R3 driver safety / SOS, R6 fare
 * transparency, R7 take-rate registry, R8 fare floor, R9 cost index). The
 * `economicsPolicy` (or `economics`), `pricingTransparency`, and `safety`
 * routers are being implemented on the server in parallel; until they land
 * in the AppRouter type, every access goes through this module's typed
 * wrappers so pages never touch `any`. The economics router name is resolved
 * as `economicsPolicy ?? economics` so either server registration works.
 * Post-merge tightening = delete the casts here.
 */
import { trpc } from "@/lib/trpc";

// ---------- economicsPolicy / economics (R7 take rate, R8 fare floor, R9 cost index) ----------

export interface CostIndex {
  fuelPriceMinor: number;
  cpiBp: number;
  maintenanceIndexBp: number;
  source: string;
  updatedAt: string;
}

export interface FareFloor {
  id: string;
  marketId: string;
  costIndex: CostIndex;
  sustainabilityMultiplier: number;
  active: boolean;
  consultationId: string | null;
}

export interface TakeRate {
  marketId: string;
  rateBps: number;
  basis: string;
  effectiveFrom: string;
  version: number;
}

export interface FareFloorCheck {
  allowed: boolean;
  floorMinor: number;
  requiresOverride: boolean;
}

// ---------- pricingTransparency (R6 fare breakdown) ----------

export interface OfferBreakdown {
  offerId: string;
  marketId: string;
  baseMinor: number;
  distanceMinor: number;
  timeMinor: number;
  deadheadMinor: number;
  pickupSeconds: number;
  pickupMeters: number;
  surgeBps: number;
  takeRateBps: number;
  platformFeeMinor: number;
  netToDriverMinor: number;
  currency: string;
}

export interface NetEarningsSummary {
  currency: string;
  trips30d: number;
  grossMinor: number;
  deadheadMinor: number;
  platformFeesMinor: number;
  netMinor: number;
}

// ---------- safety (R2 passenger manifest, R3 SOS) ----------

export interface ManifestPassengerInput {
  name: string;
  nin?: string;
}

export interface ManifestPassenger {
  name: string;
  verified: boolean;
  flags: string[];
}

export interface ManifestResult {
  manifestVerified: boolean;
  results: unknown;
}

export interface TripManifest {
  tripId: string;
  manifestVerified: boolean;
  passengers: ManifestPassenger[];
}

export type SOSRole = "driver" | "rider";

export interface SOSAlert {
  id: string;
  status: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const bridgeClient = trpc as any;
const economicsRouter = bridgeClient.economicsPolicy ?? bridgeClient.economics;

function asQuery<TData>(query: any): EconomicsSafetyQuery<TData> {
  return query as EconomicsSafetyQuery<TData>;
}

function asMutation<TVars, TData = unknown>(
  mutation: any,
): EconomicsSafetyMutation<TVars, TData> {
  return mutation as EconomicsSafetyMutation<TVars, TData>;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------- shared typed result shapes ----------

export interface EconomicsSafetyQuery<TData> {
  data: TData | undefined;
  isLoading: boolean;
  isError: boolean;
  isRefetching: boolean;
  error: { message: string } | null;
  refetch: () => Promise<unknown>;
}

export interface EconomicsSafetyMutationOptions {
  onSuccess?: () => void;
  onError?: (error: { message: string }) => void;
}

export interface EconomicsSafetyMutation<TVars, TData = unknown> {
  mutate: (vars: TVars, options?: EconomicsSafetyMutationOptions) => void;
  data: TData | undefined;
  isPending: boolean;
  isError: boolean;
  isSuccess: boolean;
  error: { message: string } | null;
  reset: () => void;
}

// ---------- economicsPolicy / economics hooks ----------

export function useFareFloor(marketId: string) {
  return asQuery<FareFloor | null>(
    economicsRouter.getFareFloor.useQuery(
      { marketId },
      { enabled: Boolean(marketId) },
    ),
  );
}

export function useTakeRate(marketId: string) {
  return asQuery<TakeRate | null>(
    economicsRouter.getTakeRate.useQuery(
      { marketId },
      { enabled: Boolean(marketId) },
    ),
  );
}

export function useUpdateCostIndex() {
  return asMutation<{
    marketId: string;
    fuelPriceMinor: number;
    cpiBp: number;
    maintenanceIndexBp: number;
    source: string;
  }>(economicsRouter.updateCostIndex.useMutation());
}

export function usePublishTakeRate() {
  return asMutation<{
    marketId: string;
    rateBps: number;
    basis: string;
    effectiveFrom: string;
    consultationId: string;
  }>(economicsRouter.publishTakeRate.useMutation());
}

export function useCheckFareAgainstFloor() {
  return asMutation<{ marketId: string; fareMinor: number }, FareFloorCheck>(
    economicsRouter.checkFareAgainstFloor.useMutation(),
  );
}



export function useRecordFloorOverride() {
  return asMutation<{
    marketId: string;
    fareMinor: number;
    justification: string;
  }>(economicsRouter.recordFloorOverride.useMutation());
}

// ---------- driver offers (typed in AppRouter; wrapped here so safety pages stay bridge-only) ----------

export interface DriverOfferRef {
  offerId: string;
}

export function useMyOffers() {
  return asQuery<DriverOfferRef[]>(
    bridgeClient.driverDispatchFairness.listMyOffers.useQuery(),
  );
}

// ---------- pricingTransparency hooks ----------

export function useOfferBreakdown(offerId: string) {
  return asQuery<OfferBreakdown>(
    bridgeClient.pricingTransparency.getOfferBreakdown.useQuery(
      { offerId },
      { enabled: Boolean(offerId) },
    ),
  );
}

export function useMyNetEarningsSummary() {
  return asQuery<NetEarningsSummary>(
    bridgeClient.pricingTransparency.getMyNetEarningsSummary.useQuery(),
  );
}

// ---------- safety hooks ----------

export function useAttachManifest() {
  return asMutation<
    { tripId: string; passengers: ManifestPassengerInput[] },
    ManifestResult
  >(bridgeClient.safety.attachManifest.useMutation());
}

export function useManifest(tripId: string) {
  return asQuery<TripManifest>(
    bridgeClient.safety.getManifest.useQuery(
      { tripId },
      { enabled: Boolean(tripId) },
    ),
  );
}

export function useTriggerSOS() {
  return asMutation<
    { tripId?: string; role: SOSRole; lat?: number; lng?: number },
    SOSAlert
  >(bridgeClient.safety.triggerSOS.useMutation());
}

export function useCancelSOS() {
  return asMutation<{ sosId: string }>(
    bridgeClient.safety.cancelSOS.useMutation(),
  );
}

export function useResolveSOS() {
  return asMutation<{ sosId: string }>(
    bridgeClient.safety.resolveSOS.useMutation(),
  );
}

export function useActiveSOS() {
  return asQuery<SOSAlert[]>(bridgeClient.safety.listActiveSOS.useQuery());
}

// ---------- invalidation helpers ----------

export function useEconomicsSafetyInvalidation() {
  const utils = bridgeClient.useUtils();
  const economicsUtils = utils.economicsPolicy ?? utils.economics;
  return {
    economics: () => {
      void economicsUtils?.getFareFloor?.invalidate();
      void economicsUtils?.getTakeRate?.invalidate();
    },
    pricingTransparency: () => {
      void utils.pricingTransparency.getOfferBreakdown.invalidate();
      void utils.pricingTransparency.getMyNetEarningsSummary.invalidate();
    },
    safety: () => {
      void utils.safety.getManifest.invalidate();
      void utils.safety.listActiveSOS.invalidate();
    },
  };
}
