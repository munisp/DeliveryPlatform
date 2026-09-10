import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { LngLatBounds, Map, NavigationControl, Popup, ScaleControl, type GeoJSONSource, type Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import { Crosshair, MapPin, Pause, Play, RefreshCw, ShieldAlert } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

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

type VehicleTrackingMapProps = {
  positions: DurableTrackingPosition[];
  isLoading: boolean;
  error: string | null;
  refreshedAt: string | null;
  streamStatus?: "bootstrapping" | "live" | "reconnecting" | "offline" | "paused" | "unavailable";
  freshness?: "unknown" | "fresh" | "aging" | "stale";
  truncated?: boolean;
  onPause?: () => void;
  onResume?: () => void;
};

type TrackingFeatureProperties = {
  id: string;
  externalReference: string;
  observedAt: string;
  accuracyM: number | null;
  integrityScore: number | null;
  source: string;
  etaSeconds: number | null;
};

const TRACKING_SOURCE_ID = "delivery-tracking";
const TRACKING_CLUSTER_LAYER_ID = "delivery-tracking-clusters";
const TRACKING_CLUSTER_COUNT_LAYER_ID = "delivery-tracking-cluster-count";
const TRACKING_POINT_LAYER_ID = "delivery-tracking-points";
const defaultMapCenter: [number, number] = [3.3792, 6.5244];
const defaultMapStyle = "https://tiles.openfreemap.org/styles/positron";

function isRenderablePosition(position: DurableTrackingPosition) {
  return (
    Number.isFinite(position.longitude) &&
    Number.isFinite(position.latitude) &&
    position.longitude >= -180 &&
    position.longitude <= 180 &&
    position.latitude >= -90 &&
    position.latitude <= 90
  );
}

function integrityColor(score: number | null) {
  if (score === null) return "#94A3B8";
  if (score >= 80) return "#34D399";
  if (score >= 50) return "#FBBF24";
  return "#FB7185";
}

function positionSummary(position: DurableTrackingPosition) {
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

function featureCollection(positions: DurableTrackingPosition[]) {
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

function popupContent(properties: TrackingFeatureProperties) {
  const content = document.createElement("div");
  content.className = "vehicle-map-popup";

  const title = document.createElement("strong");
  title.textContent = properties.externalReference;
  content.append(title);

  const detail = document.createElement("span");
  const integrity =
    properties.integrityScore === null
      ? "integrity unavailable"
      : `integrity ${properties.integrityScore}`;
  detail.textContent = `Observed ${new Date(properties.observedAt).toLocaleString()} · ${integrity}`;
  content.append(detail);

  const accuracy = document.createElement("span");
  accuracy.textContent =
    properties.accuracyM === null
      ? "Accuracy unavailable"
      : `Accuracy ±${Math.round(properties.accuracyM)} m`;
  content.append(accuracy);

  if (properties.etaSeconds !== null) {
    const eta = document.createElement("span");
    eta.textContent = `ETA ${Math.ceil(properties.etaSeconds / 60)} min`;
    content.append(eta);
  }
  return content;
}

export default function MapLibreFleetCanvas({
  positions,
  isLoading,
  error,
  refreshedAt,
  streamStatus = "live",
  freshness = "unknown",
  truncated = false,
  onPause,
  onResume,
}: VehicleTrackingMapProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const fittedInitialBoundsRef = useRef(false);

  const renderablePositions = useMemo(
    () => positions.filter(isRenderablePosition).slice(0, 250),
    [positions],
  );
  const selectedPosition = useMemo(
    () => renderablePositions.find((position) => position.work_order_id === selectedId) ?? null,
    [renderablePositions, selectedId],
  );
  const mapStyleUrl =
    import.meta.env.VITE_MAP_STYLE_URL?.trim() || defaultMapStyle;

  const focusPosition = useCallback((position: DurableTrackingPosition) => {
    const map = mapRef.current;
    if (!map) return;
    setSelectedId(position.work_order_id);
    map.easeTo({
      center: [position.longitude, position.latitude],
      zoom: Math.max(map.getZoom(), 14),
      duration: 350,
    });
  }, []);

  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container || mapRef.current) return;

    const map = new Map({
      container,
      style: mapStyleUrl,
      center: defaultMapCenter,
      zoom: 11,
    });
    mapRef.current = map;
    fittedInitialBoundsRef.current = false;
    map.addControl(
      new NavigationControl({ visualizePitch: true }),
      "top-right",
    );
    map.addControl(
      new ScaleControl({ maxWidth: 120, unit: "metric" }),
      "bottom-left",
    );

    let loaded = false;
    const markReady = () => {
      loaded = true;
      map.addSource(TRACKING_SOURCE_ID, {
        type: "geojson",
        data: featureCollection([]),
        cluster: true,
        clusterMaxZoom: 14,
        clusterRadius: 48,
      });
      map.addLayer({
        id: TRACKING_CLUSTER_LAYER_ID,
        type: "circle",
        source: TRACKING_SOURCE_ID,
        filter: ["has", "point_count"],
        paint: {
          "circle-color": "#0E7490",
          "circle-radius": ["step", ["get", "point_count"], 18, 10, 22, 50, 28],
          "circle-stroke-width": 2,
          "circle-stroke-color": "#CFFAFE",
        },
      });
      map.addLayer({
        id: TRACKING_CLUSTER_COUNT_LAYER_ID,
        type: "symbol",
        source: TRACKING_SOURCE_ID,
        filter: ["has", "point_count"],
        layout: {
          "text-field": ["get", "point_count_abbreviated"],
          "text-font": ["Open Sans Bold", "Arial Unicode MS Bold"],
          "text-size": 12,
        },
        paint: { "text-color": "#ECFEFF" },
      });
      map.addLayer({
        id: TRACKING_POINT_LAYER_ID,
        type: "circle",
        source: TRACKING_SOURCE_ID,
        filter: ["!", ["has", "point_count"]],
        paint: {
          "circle-color": [
            "case",
            [">=", ["coalesce", ["get", "integrityScore"], -1], 80], "#34D399",
            [">=", ["coalesce", ["get", "integrityScore"], -1], 50], "#FBBF24",
            [">=", ["coalesce", ["get", "integrityScore"], -1], 0], "#FB7185",
            "#94A3B8",
          ],
          "circle-radius": 8,
          "circle-stroke-width": 2,
          "circle-stroke-color": "#FFFFFF",
        },
      });
      map.on("click", TRACKING_CLUSTER_LAYER_ID, async (event) => {
        const feature = event.features?.[0];
        const source = map.getSource(TRACKING_SOURCE_ID) as GeoJSONSource | undefined;
        const clusterId = Number(feature?.properties?.cluster_id);
        if (!source || !Number.isSafeInteger(clusterId) || !feature?.geometry || feature.geometry.type !== "Point") return;
        try {
          const zoom = await source.getClusterExpansionZoom(clusterId);
          map.easeTo({
            center: feature.geometry.coordinates as [number, number],
            zoom,
            duration: 350,
          });
        } catch {
          // The source can be replaced during a delta update; a subsequent click can retry.
        }
      });
      map.on("click", TRACKING_POINT_LAYER_ID, (event) => {
        const feature = event.features?.[0];
        if (!feature?.geometry || feature.geometry.type !== "Point") return;
        const properties = feature.properties as TrackingFeatureProperties | undefined;
        if (!properties?.id) return;
        setSelectedId(properties.id);
        new Popup({ offset: 14, closeButton: true })
          .setLngLat(feature.geometry.coordinates as [number, number])
          .setDOMContent(popupContent(properties))
          .addTo(map);
      });
      for (const layerId of [TRACKING_CLUSTER_LAYER_ID, TRACKING_POINT_LAYER_ID]) {
        map.on("mouseenter", layerId, () => {
          map.getCanvas().style.cursor = "pointer";
        });
        map.on("mouseleave", layerId, () => {
          map.getCanvas().style.cursor = "";
        });
      }
      setMapReady(true);
      setMapError(null);
      map.resize();
    };
    const markError = () => {
      if (!loaded) {
        setMapError(
          "The base-map style is unavailable. Vehicle positions remain available in the durable tracking list below.",
        );
      }
    };

    map.once("load", markReady);
    map.on("error", markError);

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [mapStyleUrl, reloadGeneration]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const source = map.getSource(TRACKING_SOURCE_ID) as GeoJSONSource | undefined;
    if (!source) return;
    source.setData(featureCollection(renderablePositions));

    if (fittedInitialBoundsRef.current || renderablePositions.length === 0) return;
    fittedInitialBoundsRef.current = true;
    if (renderablePositions.length === 1) {
      const [position] = renderablePositions;
      map.easeTo({
        center: [position.longitude, position.latitude],
        zoom: 14,
        duration: 450,
      });
      return;
    }
    const bounds = new LngLatBounds();
    renderablePositions.forEach((position) => {
      bounds.extend([position.longitude, position.latitude]);
    });
    map.fitBounds(bounds, {
      padding: { top: 52, right: 52, bottom: 52, left: 52 },
      maxZoom: 14,
      duration: 450,
    });
  }, [mapReady, renderablePositions]);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b border-slate-800 bg-slate-950/60">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <MapPin className="h-5 w-5 text-cyan-300" />
              Live automobile monitoring
            </CardTitle>
            <CardDescription className="mt-2 max-w-3xl">
              Latest role-scoped delivery positions. MapLibre updates a clustered
              GeoJSON source from authenticated tracking deltas; no client joins
              or inferred locations are used.
            </CardDescription>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
            <RefreshCw className="h-3.5 w-3.5" />
            <span>
              {streamStatus === "live"
                ? refreshedAt
                  ? `Live · ${new Date(refreshedAt).toLocaleTimeString()}`
                  : "Live · awaiting first delta"
                : streamStatus === "reconnecting"
                  ? "Reconnecting to tracking stream"
                  : streamStatus === "bootstrapping"
                    ? "Loading tracking snapshot"
                    : streamStatus === "offline"
                      ? "Device offline"
                      : streamStatus === "paused"
                        ? "Live updates paused"
                        : "Tracking stream unavailable"}
            </span>
            {freshness !== "unknown" ? <span className={freshness === "stale" ? "text-amber-300" : freshness === "aging" ? "text-yellow-300" : "text-emerald-300"}>Data {freshness}</span> : null}
            {streamStatus === "paused" && onResume ? (
              <button type="button" onClick={onResume} className="inline-flex items-center gap-1 rounded border border-cyan-300/40 px-2 py-1 text-cyan-100 focus:outline-none focus:ring-2 focus:ring-cyan-300"><Play className="h-3 w-3" />Resume</button>
            ) : onPause ? (
              <button type="button" onClick={onPause} className="inline-flex items-center gap-1 rounded border border-slate-600 px-2 py-1 text-slate-200 focus:outline-none focus:ring-2 focus:ring-cyan-300"><Pause className="h-3 w-3" />Pause</button>
            ) : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <div className="relative h-[420px] overflow-hidden rounded-xl border border-slate-800 bg-slate-950">
          <div
            ref={mapContainerRef}
            className="absolute inset-0"
            aria-label="Live automobile tracking map"
          />
          {isLoading ? (
            <div className="pointer-events-none absolute inset-0 grid place-items-center bg-slate-950/70 text-sm text-slate-300">
              Loading role-scoped vehicle positions…
            </div>
          ) : null}
          {!isLoading && renderablePositions.length === 0 ? (
            <div className="pointer-events-none absolute inset-0 grid place-items-center px-6 text-center text-sm text-slate-300">
              <div className="max-w-md space-y-2">
                <Crosshair className="mx-auto h-7 w-7 text-slate-500" />
                <p>No authorized current vehicle positions are available.</p>
              </div>
            </div>
          ) : null}
        </div>

        {truncated ? (
          <div className="rounded-lg border border-amber-500/40 bg-amber-950/30 px-4 py-3 text-sm text-amber-100">
            This view is limited to the 250 most recent authorized positions. Zoom,
            cluster, or filter the operational workspace before using it for fleet-wide review.
          </div>
        ) : null}

        {error || mapError ? (
          <div className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-950/30 px-4 py-3 text-sm text-amber-100">
            <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <p>{error ?? mapError}</p>
              {mapError ? (
                <button
                  type="button"
                  onClick={() => {
                    setMapReady(false);
                    setMapError(null);
                    setReloadGeneration((generation) => generation + 1);
                  }}
                  className="mt-2 inline-flex rounded-md border border-amber-300/30 px-2.5 py-1.5 text-xs font-medium text-amber-100 transition hover:bg-amber-400/10 focus:outline-none focus:ring-2 focus:ring-amber-300"
                >
                  Reload base map
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        <div className="grid gap-3 md:grid-cols-3">
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-3">
            <div className="text-xs uppercase tracking-wide text-slate-500">Visible vehicles</div>
            <div className="mt-1 text-2xl font-semibold text-white">{renderablePositions.length}</div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-3">
            <div className="text-xs uppercase tracking-wide text-slate-500">Verified integrity</div>
            <div className="mt-1 text-2xl font-semibold text-emerald-300">
              {renderablePositions.filter((position) => position.integrity_score !== null && position.integrity_score >= 80).length}
            </div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-3">
            <div className="text-xs uppercase tracking-wide text-slate-500">Review attention</div>
            <div className="mt-1 text-2xl font-semibold text-amber-300">
              {renderablePositions.filter((position) => position.integrity_score === null || position.integrity_score < 80).length}
            </div>
          </div>
        </div>

        {renderablePositions.length > 0 ? (
          <div className="grid gap-2 lg:grid-cols-2" aria-label="Accessible vehicle tracking list">
            {renderablePositions.slice(0, 8).map((position) => (
              <button
                key={position.work_order_id}
                type="button"
                onClick={() => focusPosition(position)}
                className={`rounded-lg border px-3 py-2 text-left text-sm text-slate-300 focus:outline-none focus:ring-2 focus:ring-cyan-300 ${
                  selectedPosition?.work_order_id === position.work_order_id
                    ? "border-cyan-300 bg-cyan-950/30"
                    : "border-slate-800 bg-slate-950/60"
                }`}
              >
                <div className="font-medium text-white">{position.external_reference}</div>
                <div className="mt-1 text-xs text-slate-400">{positionSummary(position)}</div>
              </button>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

export const vehicleTrackingMapForTest = { featureCollection, isRenderablePosition, integrityColor };
