import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import maplibregl, { type Map as MapLibreMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  CarFront,
  Crosshair,
  MapPin,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";

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
  integrity_score: number;
  source: string;
};

type VehicleTrackingMapProps = {
  positions: DurableTrackingPosition[];
  isLoading: boolean;
  error: string | null;
  refreshedAt: string | null;
};

type RenderedMarker = {
  marker: maplibregl.Marker;
  root: Root;
};

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

function markerTone(integrityScore: number) {
  if (integrityScore >= 80) return "vehicle-map-marker--verified";
  if (integrityScore >= 50) return "vehicle-map-marker--caution";
  return "vehicle-map-marker--low-integrity";
}

function positionSummary(position: DurableTrackingPosition) {
  const accuracy =
    position.accuracy_m === null || !Number.isFinite(position.accuracy_m)
      ? "accuracy unavailable"
      : `±${Math.round(position.accuracy_m)} m`;
  return `${position.external_reference} · ${position.latitude.toFixed(5)}, ${position.longitude.toFixed(5)} · integrity ${position.integrity_score} · ${accuracy}`;
}

function createPopupContent(position: DurableTrackingPosition) {
  const content = document.createElement("div");
  content.className = "vehicle-map-popup";

  const title = document.createElement("strong");
  title.textContent = position.external_reference;
  content.append(title);

  const detail = document.createElement("span");
  detail.textContent = `Observed ${new Date(position.observed_at).toLocaleString()} · integrity ${position.integrity_score}`;
  content.append(detail);

  const coordinate = document.createElement("span");
  coordinate.textContent = `${position.latitude.toFixed(5)}, ${position.longitude.toFixed(5)}`;
  content.append(coordinate);

  return content;
}

export default function VehicleTrackingMap({
  positions,
  isLoading,
  error,
  refreshedAt,
}: VehicleTrackingMapProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<MapLibreMap | null>(null);
  const markersRef = useRef<RenderedMarker[]>([]);
  const [mapReady, setMapReady] = useState(false);
  const [mapError, setMapError] = useState<string | null>(null);
  const [reloadGeneration, setReloadGeneration] = useState(0);

  const renderablePositions = useMemo(
    () => positions.filter(isRenderablePosition).slice(0, 250),
    [positions],
  );
  const mapStyleUrl =
    import.meta.env.VITE_MAP_STYLE_URL?.trim() || defaultMapStyle;

  useEffect(() => {
    const container = mapContainerRef.current;
    if (!container || mapRef.current) return;

    const map = new maplibregl.Map({
      container,
      style: mapStyleUrl,
      center: defaultMapCenter,
      zoom: 11,
    });
    mapRef.current = map;
    map.addControl(
      new maplibregl.NavigationControl({ visualizePitch: true }),
      "top-right",
    );
    map.addControl(
      new maplibregl.ScaleControl({ maxWidth: 120, unit: "metric" }),
      "bottom-left",
    );

    let loaded = false;
    const markReady = () => {
      loaded = true;
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
      markersRef.current.forEach(({ marker, root }) => {
        marker.remove();
        root.unmount();
      });
      markersRef.current = [];
      map.remove();
      mapRef.current = null;
    };
  }, [mapStyleUrl, reloadGeneration]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    markersRef.current.forEach(({ marker, root }) => {
      marker.remove();
      root.unmount();
    });
    markersRef.current = [];

    if (renderablePositions.length === 0) return;

    const bounds = new maplibregl.LngLatBounds();
    for (const position of renderablePositions) {
      const markerElement = document.createElement("button");
      markerElement.type = "button";
      markerElement.className = `vehicle-map-marker ${markerTone(position.integrity_score)}`;
      markerElement.setAttribute(
        "aria-label",
        `Open vehicle tracking detail for ${position.external_reference}`,
      );
      markerElement.title = positionSummary(position);

      const root = createRoot(markerElement);
      root.render(<CarFront aria-hidden="true" className="h-4 w-4" />);

      const popup = new maplibregl.Popup({
        offset: 24,
        closeButton: true,
      }).setDOMContent(createPopupContent(position));
      const marker = new maplibregl.Marker({
        element: markerElement,
        anchor: "bottom",
      })
        .setLngLat([position.longitude, position.latitude])
        .setPopup(popup)
        .addTo(map);

      markersRef.current.push({ marker, root });
      bounds.extend([position.longitude, position.latitude]);
    }

    if (renderablePositions.length === 1) {
      const [position] = renderablePositions;
      map.easeTo({
        center: [position.longitude, position.latitude],
        zoom: 14,
        duration: 450,
      });
      return;
    }

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
              Latest tenant-scoped, durable vehicle positions. Automobile
              markers are derived only from authenticated tracking records and
              refresh with the operations snapshot every 20 seconds.
            </CardDescription>
          </div>
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <RefreshCw className="h-3.5 w-3.5" />
            {refreshedAt
              ? `Updated ${new Date(refreshedAt).toLocaleTimeString()}`
              : "Waiting for tracking data"}
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
              Loading durable vehicle positions…
            </div>
          ) : null}
          {!isLoading && renderablePositions.length === 0 ? (
            <div className="pointer-events-none absolute inset-0 grid place-items-center px-6 text-center text-sm text-slate-300">
              <div className="max-w-md space-y-2">
                <Crosshair className="mx-auto h-7 w-7 text-slate-500" />
                <p>
                  No durable current vehicle positions are available for this
                  tenant.
                </p>
              </div>
            </div>
          ) : null}
        </div>

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
            <div className="text-xs uppercase tracking-wide text-slate-500">
              Visible vehicles
            </div>
            <div className="mt-1 text-2xl font-semibold text-white">
              {renderablePositions.length}
            </div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-3">
            <div className="text-xs uppercase tracking-wide text-slate-500">
              Verified integrity
            </div>
            <div className="mt-1 text-2xl font-semibold text-emerald-300">
              {
                renderablePositions.filter(
                  (position) => position.integrity_score >= 80,
                ).length
              }
            </div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-3">
            <div className="text-xs uppercase tracking-wide text-slate-500">
              Review attention
            </div>
            <div className="mt-1 text-2xl font-semibold text-amber-300">
              {
                renderablePositions.filter(
                  (position) => position.integrity_score < 80,
                ).length
              }
            </div>
          </div>
        </div>

        {renderablePositions.length > 0 ? (
          <div className="grid gap-2 lg:grid-cols-2">
            {renderablePositions.slice(0, 8).map((position) => (
              <div
                key={position.work_order_id}
                className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-300"
              >
                <div className="font-medium text-white">
                  {position.external_reference}
                </div>
                <div className="mt-1 text-xs text-slate-400">
                  {positionSummary(position)}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
