/**
 * Wave B3 bridge (R2 passenger manifest, R3 driver safety / SOS, R6 fare
 * transparency, R7 take-rate registry, R8 fare floor, R9 cost index). The
 * `economics`, `pricingTransparency`, and `safety` routers are registered in
 * the AppRouter type, so this module consumes the typed client directly. The
 * economics router name is resolved as `economicsPolicy ?? economics` so
 * either server registration works. Economics and pricing-transparency reads
 * return raw snake_case Postgres rows server-side; the bridge normalizes
 * them via `./economicsWire` into the camelCase DTOs below so pages never
 * touch wire shapes (see tests/pwa-wire-contract.test.ts for the contract).
 */
import { useMutation } from "@tanstack/react-query";

import { trpc } from "@/lib/trpc";
import {
  normalizeFareFloor,
  normalizeNetEarningsSummary,
  normalizeOfferBreakdown,
  normalizeTakeRate,
} from "@/lib/economicsWire";

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
  /** Computed server-side from the cost index (economicsPolicy.ts). */
  floorMinor: number;
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

/**
 * Typed client with the legacy `economicsPolicy` alias preserved as an
 * optional intersection member — the alias is not part of the AppRouter
 * type, so the fallback resolves to `economics` at type level too.
 */
const bridgeClient = trpc as typeof trpc & {
  economicsPolicy?: typeof trpc.economics;
};
const economicsRouter = bridgeClient.economicsPolicy ?? bridgeClient.economics;

/**
 * Adapt a typed trpc query result to the bridge's query shape, mapping the
 * raw wire data through `normalize` so pages only ever see the camelCase
 * DTO.
 */
function asQuery<TWire, TData>(
  query: EconomicsSafetyQuery<TWire>,
  normalize: (wire: TWire) => TData,
): EconomicsSafetyQuery<TData> {
  return {
    ...query,
    data: query.data === undefined ? undefined : normalize(query.data),
  };
}

function asMutation<TVars, TData = unknown>(
  mutation: EconomicsSafetyMutation<TVars, TData>,
): EconomicsSafetyMutation<TVars, TData> {
  return mutation;
}

/**
 * Adapt a typed trpc mutation whose settled `data` is a raw wire row,
 * mapping it to the camelCase DTO the pages read.
 */
function asMutationMapping<TVars, TWireData, TData>(
  mutation: EconomicsSafetyMutation<TVars, TWireData>,
  mapData: (wire: TWireData) => TData,
): EconomicsSafetyMutation<TVars, TData> {
  return {
    ...mutation,
    data: mutation.data === undefined ? undefined : mapData(mutation.data),
  };
}

function identity<TData>(wire: TData): TData {
  return wire;
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

// ---------- economicsPolicy / economics hooks ----------

export function useFareFloor(marketId: string) {
  return asQuery(
    economicsRouter.getFareFloor.useQuery(
      { marketId },
      { enabled: Boolean(marketId) },
    ),
    normalizeFareFloor,
  );
}

export function useTakeRate(marketId: string) {
  return asQuery(
    economicsRouter.getTakeRate.useQuery(
      { marketId },
      { enabled: Boolean(marketId) },
    ),
    normalizeTakeRate,
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
  // The console collects `basis` as free-form text; the server zod enum
  // ("gross" | "net_of_tolls" | "net_of_costs") validates at the wire, so
  // the bridge widens the input type here rather than in the page.
  return asMutation<{
    marketId: string;
    rateBps: number;
    basis: string;
    effectiveFrom: string;
    consultationId: string;
  }>(
    economicsRouter.publishTakeRate.useMutation() as unknown as EconomicsSafetyMutation<{
      marketId: string;
      rateBps: number;
      basis: string;
      effectiveFrom: string;
      consultationId: string;
    }>,
  );
}

export function useCheckFareAgainstFloor() {
  // `checkFareAgainstFloor` is registered as a query procedure server-side
  // (server/_core/economicsRouter.ts), so
  // `economics.checkFareAgainstFloor.useMutation` does not exist on the
  // typed client. Wrap the query fetcher in a react-query mutation so the
  // operator floor-check flow (mutate + settled data) keeps working.
  const utils = bridgeClient.useUtils();
  const economicsUtils =
    (utils as unknown as { economicsPolicy?: typeof utils.economics })
      .economicsPolicy ?? utils.economics;
  return asMutation<{ marketId: string; fareMinor: number }, FareFloorCheck>(
    useMutation({
      mutationFn: (vars: { marketId: string; fareMinor: number }) =>
        economicsUtils.checkFareAgainstFloor.fetch(vars),
    }),
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
  return asQuery(
    bridgeClient.driverDispatchFairness.listMyOffers.useQuery(),
    identity,
  );
}

// ---------- pricingTransparency hooks ----------

export function useOfferBreakdown(offerId: string) {
  return asQuery(
    bridgeClient.pricingTransparency.getOfferBreakdown.useQuery(
      { offerId },
      { enabled: Boolean(offerId) },
    ),
    normalizeOfferBreakdown,
  );
}

export function useMyNetEarningsSummary() {
  return asQuery(
    bridgeClient.pricingTransparency.getMyNetEarningsSummary.useQuery(),
    normalizeNetEarningsSummary,
  );
}

// ---------- safety hooks ----------
// safety reads already map to camelCase server-side
// (server/_core/tripSafety.ts), so these pass through unchanged.

export function useAttachManifest() {
  // attachManifest returns the raw passenger_manifests row (snake_case
  // `manifest_verified`); map the settled data to the ManifestResult DTO.
  return asMutationMapping<
    { tripId: string; passengers: ManifestPassengerInput[] },
    { manifest_verified?: boolean; passengers?: unknown },
    ManifestResult
  >(bridgeClient.safety.attachManifest.useMutation(), (wire) => ({
    manifestVerified: Boolean(wire.manifest_verified),
    results: wire.passengers ?? [],
  }));
}

export function useManifest(tripId: string) {
  return asQuery(
    bridgeClient.safety.getManifest.useQuery(
      { tripId },
      { enabled: Boolean(tripId) },
    ),
    identity,
  );
}

export function useTriggerSOS() {
  // triggerSOS returns the raw sos_alerts row; map the settled data to the
  // SOSAlert DTO the safety center tracks.
  return asMutationMapping<
    { tripId?: string; role: SOSRole; lat?: number; lng?: number },
    { id?: string; status?: string },
    SOSAlert
  >(bridgeClient.safety.triggerSOS.useMutation(), (wire) => ({
    id: String(wire.id ?? ""),
    status: wire.status ?? "active",
  }));
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
  return asQuery(bridgeClient.safety.listActiveSOS.useQuery(), identity);
}

// ---------- invalidation helpers ----------

export function useEconomicsSafetyInvalidation() {
  const utils = bridgeClient.useUtils();
  const economicsUtils =
    (utils as unknown as { economicsPolicy?: typeof utils.economics })
      .economicsPolicy ?? utils.economics;
  return {
    economics: () => {
      void economicsUtils.getFareFloor.invalidate();
      void economicsUtils.getTakeRate.invalidate();
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
