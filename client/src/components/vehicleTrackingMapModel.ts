import type { TrackingFreshness, TrackingStreamStatus } from "@/lib/useRoleScopedTracking";

export type DurableTrackingPosition = {
  work_order_id: string;
  external_reference: string;
  subject_user_id: number | null;
  observed_at: string;
  longitude: number;
  latitude: number;
  accuracy_m: number | null;
  integrity_score: number | null;
  source: string;
  eta_seconds?: number | null;
};

export type VehicleTrackingMapProps = {
  positions: DurableTrackingPosition[];
  isLoading: boolean;
  error: string | null;
  refreshedAt: string | null;
  streamStatus?: TrackingStreamStatus;
  freshness?: TrackingFreshness;
  truncated?: boolean;
  onPause?: () => void;
  onResume?: () => void;
};

export type TrackingFeatureProperties = {
  id: string;
  externalReference: string;
  observedAt: string;
  accuracyM: number | null;
  integrityScore: number | null;
  source: string;
  etaSeconds: number | null;
};

export function isRenderablePosition(position: DurableTrackingPosition) {
  return (
    Number.isFinite(position.longitude) &&
    Number.isFinite(position.latitude) &&
    position.longitude >= -180 &&
    position.longitude <= 180 &&
    position.latitude >= -90 &&
    position.latitude <= 90
  );
}

export function integrityColor(score: number | null) {
  if (score === null) return "#94A3B8";
  if (score >= 80) return "#34D399";
  if (score >= 50) return "#FBBF24";
  return "#FB7185";
}

export function positionSummary(position: DurableTrackingPosition) {
  const accuracy =
    position.accuracy_m === null || !Number.isFinite(position.accuracy_m)
      ? "accuracy unavailable"
      : `±${Math.round(position.accuracy_m)} m`;
  const integrity =
    position.integrity_score === null
      ? "integrity unavailable"
      : `integrity ${position.integrity_score}`;
  const eta =
    position.eta_seconds === null || position.eta_seconds === undefined
      ? "ETA unavailable"
      : `ETA ${Math.ceil(position.eta_seconds / 60)} min`;
  return `${position.external_reference} · ${position.latitude.toFixed(5)}, ${position.longitude.toFixed(5)} · ${integrity} · ${accuracy} · ${eta}`;
}

export function featureCollection(positions: DurableTrackingPosition[]) {
  return {
    type: "FeatureCollection" as const,
    features: positions.map((position) => ({
      type: "Feature" as const,
      id: position.work_order_id,
      geometry: {
        type: "Point" as const,
        coordinates: [position.longitude, position.latitude] as [number, number],
      },
      properties: {
        id: position.work_order_id,
        externalReference: position.external_reference,
        observedAt: position.observed_at,
        accuracyM: position.accuracy_m,
        integrityScore: position.integrity_score,
        source: position.source,
        etaSeconds: position.eta_seconds ?? null,
      } satisfies TrackingFeatureProperties,
    })),
  };
}
