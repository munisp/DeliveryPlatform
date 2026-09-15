/**
 * Wave E1 bridge (R2 passenger manifest, R3 SOS, R6 fare floor, R7 take-rate,
 * R8 deadhead, R9 fare breakdown). Same pattern as the PWA's
 * client/src/lib/trpcEconomicsSafety.ts: the platform routers exist on the
 * deployed API but not in the mobile app's embedded AppRouter type, so all
 * access is confined to this module's typed wrappers.
 *
 * Types match the ACTUAL wire shapes on main (verified against
 * server/_core/economicsRouter.ts, pricingTransparencyRouter.ts,
 * safetyRouter.ts, offerEconomics.ts, economicsPolicy.ts, tripSafety.ts):
 * fare floors, take rates, offer breakdowns, and SOS events are raw Postgres
 * rows (snake_case, bigint money columns may arrive as strings); manifest
 * reads and the earnings rollup are camelCase. The economics router is
 * registered as `economics` on main; the `economicsPolicy ?? economics`
 * fallback is kept so either registration resolves.
 */
import { trpc } from "@/lib/trpc";

// ---------- economics (R6 fare floor, R7 take rate) ----------

export interface CostIndex {
  fuel_price_minor: number | string;
  cpi_bp: number | string;
  maintenance_index_bp: number | string;
  source: string;
  updated_at: string;
}

export interface FareFloorPolicy {
  id: string;
  market_id: string;
  cost_index: CostIndex;
  sustainability_multiplier: number | string;
  active: boolean;
  consultation_id: string | null;
  created_at: string | Date;
  floor_minor: number | string;
}

export interface TakeRate {
  id: string;
  market_id: string;
  rate_bps: number | string;
  basis: "gross" | "net_of_tolls" | "net_of_costs" | string;
  effective_from: string | Date;
  consultation_id: string | null;
  version: number;
}

export interface FareFloorCheck {
  allowed: boolean;
  floorMinor: number | null;
  requiresOverride: boolean;
}

// ---------- pricingTransparency (R9 breakdown, R8 deadhead rollup) ----------

/** Raw offer_economics_breakdowns row; money columns are kobo minor units. */
export interface OfferBreakdown {
  offer_id: string;
  market_id: string;
  base_minor: number | string;
  distance_minor: number | string;
  time_minor: number | string;
  deadhead_minor: number | string;
  pickup_seconds: number | string;
  pickup_meters: number | string;
  surge_bps: number | string;
  take_rate_bps: number | string;
  platform_fee_minor: number | string;
  net_to_driver_minor: number | string;
  currency: string;
}

export interface NetEarningsSummary {
  currency: string;
  windowDays: number;
  offers: number;
  grossMinor: number | string;
  deadheadMinor: number | string;
  platformFeeMinor: number | string;
  netToDriverMinor: number | string;
}

/** Subset of driverDispatchFairness.listMyOffers used by the fare screens. */
export interface TransparentDriverOffer {
  offerId: string;
  tripId: string;
  expiresAt: string;
  pickupDistanceM: number;
  pickupEtaS: number;
  destinationAddress: string | null;
  grossFareKobo: number;
  expectedDriverNetKobo: number;
}

// ---------- safety (R2 passenger manifest, R3 SOS) ----------

export interface ManifestPassengerInput {
  name: string;
  nin?: string;
}

export interface ManifestPassenger {
  name: string;
  ninHash: string | null;
  verified: boolean;
  flags: string[];
}

/** attachManifest returns the stored passenger_manifests row + passengers. */
export interface AttachManifestResult {
  id: string;
  trip_id: string;
  manifest_verified: boolean;
  verified_via: string | null;
  passengers: ManifestPassenger[];
}

export interface TripManifest {
  tripId: string;
  manifestVerified: boolean;
  verifiedVia: string | null;
  passengers: { name: string; verified: boolean; flags: string[] }[];
}

export type SOSRole = "driver" | "rider";

export interface SosEvent {
  id: string;
  trip_id: string | null;
  role: SOSRole;
  status: "active" | "resolved" | "cancelled" | string;
  created_at: string | Date;
}

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

// ---------- economics hooks ----------

export function useFareFloor(marketId: string) {
  return asQuery<FareFloorPolicy | null>(
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

/**
 * Self-serve "would this fare meet the floor?" check. It is a server query,
 * so pass `enabled` only when the driver has submitted a fare to check.
 */
export function useFareFloorCheck(
  marketId: string,
  fareMinor: number | null,
  enabled: boolean,
) {
  return asQuery<FareFloorCheck>(
    economicsRouter.checkFareAgainstFloor.useQuery(
      { marketId, fareMinor: fareMinor ?? 0 },
      { enabled: enabled && Boolean(marketId) && fareMinor !== null },
    ),
  );
}

// ---------- driver offers ----------

export function useMyOffers() {
  return asQuery<TransparentDriverOffer[]>(
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
    AttachManifestResult
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
    SosEvent
  >(bridgeClient.safety.triggerSOS.useMutation());
}

export function useCancelSOS() {
  return asMutation<{ sosId: string }, SosEvent>(
    bridgeClient.safety.cancelSOS.useMutation(),
  );
}

/** Operator-only on the server; gated in the UI by operator session role. */
export function useResolveSOS() {
  return asMutation<{ sosId: string }, SosEvent>(
    bridgeClient.safety.resolveSOS.useMutation(),
  );
}

/** Operator queue; the server only exposes this to privileged sessions. */
export function useActiveSOS(enabled: boolean) {
  return asQuery<SosEvent[]>(
    bridgeClient.safety.listActiveSOS.useQuery(undefined, { enabled }),
  );
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
