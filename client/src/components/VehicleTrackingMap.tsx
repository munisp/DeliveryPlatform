import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { MapPin, RefreshCw } from "lucide-react";
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

function MapCanvasFallback({ positions }: { positions: DurableTrackingPosition[] }) {
  const visible = positions.filter(isRenderablePosition).slice(0, 8);
  return (
    <Card className="overflow-hidden">
      <CardHeader className="border-b border-slate-800 bg-slate-950/60">
        <CardTitle className="flex items-center gap-2"><MapPin className="h-5 w-5 text-cyan-300" />Live automobile monitoring</CardTitle>
        <CardDescription>Loading the interactive role-scoped map. The accessible tracking list remains available while map assets load.</CardDescription>
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

  return (
    <div ref={containerRef}>
      {loadCanvas ? (
        <Suspense fallback={<MapCanvasFallback positions={props.positions} />}>
          <MapLibreFleetCanvas {...props} />
        </Suspense>
      ) : (
        <Card className="overflow-hidden">
          <CardHeader className="border-b border-slate-800 bg-slate-950/60">
            <CardTitle className="flex items-center gap-2"><MapPin className="h-5 w-5 text-cyan-300" />Live automobile monitoring</CardTitle>
            <CardDescription>Interactive MapLibre layers are loaded on visibility to keep the initial PWA route lightweight.</CardDescription>
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

export const vehicleTrackingMapForTest = { featureCollection, isRenderablePosition, integrityColor };
