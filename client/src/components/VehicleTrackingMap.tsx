import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Box, Download, MapPin, RefreshCw } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  featureCollection,
  integrityColor,
  isRenderablePosition,
  positionSummary,
  type DurableTrackingPosition,
  type VehicleTrackingMapProps,
} from "@/components/vehicleTrackingMapModel";

export type { DurableTrackingPosition, VehicleTrackingMapProps } from "@/components/vehicleTrackingMapModel";

const MapLibreFleetCanvas = lazy(() => import("@/components/MapLibreFleetCanvas"));
const CesiumFleetGlobe = lazy(() => import("@/components/CesiumFleetGlobe"));
const geolibreWorkspaceUrl = import.meta.env.VITE_GEOLIBRE_WORKSPACE_URL?.trim() ?? "";

type Renderer = "maplibre" | "cesium";

function downloadAuthorizedGeoJson(positions: DurableTrackingPosition[]) {
  const content = JSON.stringify(featureCollection(positions.filter(isRenderablePosition)), null, 2);
  const url = URL.createObjectURL(new Blob([content], { type: "application/geo+json" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `switchos-authorized-tracking-${new Date().toISOString().replace(/[:.]/g, "-")}.geojson`;
  anchor.click();
  URL.revokeObjectURL(url);
}

function MapCanvasFallback({ positions, renderer }: { positions: DurableTrackingPosition[]; renderer: Renderer }) {
  const visible = positions.filter(isRenderablePosition).slice(0, 8);
  const label = renderer === "cesium" ? "3D globe" : "interactive role-scoped map";
  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b border-slate-800 bg-slate-950/60">
        <CardTitle className="flex items-center gap-2"><MapPin className="h-5 w-5 text-cyan-300" />Live automobile monitoring</CardTitle>
        <CardDescription>Loading the {label}. The accessible tracking list remains available while rendering assets load.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 pt-4">
        <div className="grid min-h-64 place-items-center rounded-xl border border-slate-800 bg-slate-950 text-sm text-slate-300">
          <span className="inline-flex items-center gap-2"><RefreshCw className="h-4 w-4 animate-spin" />Preparing map layers…</span>
        </div>
        {visible.map((position) => <div key={position.work_order_id} className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-300">{positionSummary(position)}</div>)}
      </CardContent>
    </Card>
  );
}

export default function VehicleTrackingMap(props: VehicleTrackingMapProps) {
  const [loadCanvas, setLoadCanvas] = useState(false);
  const [renderer, setRenderer] = useState<Renderer>("maplibre");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const target = containerRef.current;
    if (!target || typeof IntersectionObserver === "undefined") {
      const timer = window.setTimeout(() => setLoadCanvas(true), 1_500);
      return () => window.clearTimeout(timer);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setLoadCanvas(true);
          observer.disconnect();
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  const switchRenderer = (next: Renderer) => {
    setRenderer(next);
    setLoadCanvas(true);
  };

  return (
    <div ref={containerRef} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2">
        <div className="flex items-center gap-2" role="group" aria-label="Tracking renderer">
          <button type="button" onClick={() => switchRenderer("maplibre")} aria-pressed={renderer === "maplibre"} className="rounded-md border border-cyan-300/40 px-3 py-1.5 text-sm font-medium text-cyan-100 focus:outline-none focus:ring-2 focus:ring-cyan-300">2D map</button>
          <button type="button" onClick={() => switchRenderer("cesium")} aria-pressed={renderer === "cesium"} className="inline-flex items-center gap-1 rounded-md border border-violet-300/40 px-3 py-1.5 text-sm font-medium text-violet-100 focus:outline-none focus:ring-2 focus:ring-violet-300"><Box className="h-4 w-4" />3D globe</button>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => downloadAuthorizedGeoJson(props.positions)} className="inline-flex items-center gap-1 rounded-md border border-slate-600 px-3 py-1.5 text-sm text-slate-100 focus:outline-none focus:ring-2 focus:ring-cyan-300"><Download className="h-4 w-4" />Export authorized GeoJSON</button>
          {geolibreWorkspaceUrl ? <button type="button" onClick={() => window.open(geolibreWorkspaceUrl, "_blank", "noopener,noreferrer")} className="rounded-md border border-emerald-300/40 px-3 py-1.5 text-sm text-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-300">Open GeoLibre workspace</button> : null}
        </div>
      </div>
      {loadCanvas ? (
        <Suspense fallback={<MapCanvasFallback positions={props.positions} renderer={renderer} />}>
          {renderer === "maplibre" ? <MapLibreFleetCanvas {...props} /> : <CesiumFleetGlobe positions={props.positions} selectedId={selectedId} onSelect={setSelectedId} />}
        </Suspense>
      ) : (
        <Card className="overflow-hidden">
          <CardHeader className="border-b border-slate-800 bg-slate-950/60">
            <CardTitle className="flex items-center gap-2"><MapPin className="h-5 w-5 text-cyan-300" />Live automobile monitoring</CardTitle>
            <CardDescription>Interactive MapLibre layers load on visibility. CesiumJS 3D assets load only when selected.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3 pt-4">
            <button type="button" onClick={() => setLoadCanvas(true)} className="inline-flex rounded-md border border-cyan-300/40 px-3 py-2 text-sm font-medium text-cyan-100 focus:outline-none focus:ring-2 focus:ring-cyan-300">Load interactive map</button>
            {props.positions.filter(isRenderablePosition).slice(0, 8).map((position) => <div key={position.work_order_id} className="rounded-lg border border-slate-800 bg-slate-950/60 px-3 py-2 text-sm text-slate-300">{positionSummary(position)}</div>)}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

export const vehicleTrackingMapForTest = { featureCollection, isRenderablePosition, integrityColor, downloadAuthorizedGeoJson };
