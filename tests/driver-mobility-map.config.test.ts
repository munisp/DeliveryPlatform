import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("Driver Mobility durable vehicle map", () => {
  it("loads MapLibre progressively while preserving bounded accessible position context", () => {
    const wrapper = read("client/src/components/VehicleTrackingMap.tsx");
    const canvas = read("client/src/components/MapLibreFleetCanvas.tsx");
    const model = read("client/src/components/vehicleTrackingMapModel.ts");

    expect(wrapper).toContain('lazy(() => import("@/components/MapLibreFleetCanvas"))');
    expect(wrapper).toContain("IntersectionObserver");
    expect(wrapper).toContain("Load interactive map");
    expect(canvas).toContain('import { LngLatBounds, Map, NavigationControl, Popup, ScaleControl, type GeoJSONSource, type Map as MapLibreMap } from "maplibre-gl"');
    expect(canvas).toContain('import "maplibre-gl/dist/maplibre-gl.css"');
    expect(canvas).toContain("const defaultMapStyle");
    expect(canvas).toContain("positions.filter(isRenderablePosition).slice(0, 250)");
    expect(canvas).toContain("new Map({");
    expect(canvas).toContain("map.addSource(TRACKING_SOURCE_ID");
    expect(canvas).toContain("cluster: true");
    expect(canvas).toContain('type: "circle"');
    expect(canvas).toContain("source.setData(featureCollection(renderablePositions))");
    expect(canvas).toContain("getClusterExpansionZoom");
    expect(canvas).toContain("setDOMContent(");
    expect(canvas).not.toContain("new Marker");
    expect(canvas).not.toContain("setHTML(");
    expect(canvas).toContain("No authorized current vehicle positions are available");
    expect(model).toContain("function isRenderablePosition");
    expect(model).toContain("function featureCollection");
  });

  it("uses a role-resolved cursor SSE stream with bounded reconnect, freshness, and operator control", () => {
    const page = read("client/src/pages/DriverMobility.tsx");
    const stream = read("client/src/lib/useRoleScopedTracking.ts");
    const layout = read("client/src/components/PlatformSummaryPage.tsx");

    expect(page).toContain('useRoleScopedTracking("me")');
    expect(page).not.toContain('fetch("/api/operations/snapshot"');
    expect(page).not.toContain("refetchInterval: 20_000");
    expect(page).toContain("freshness={tracking.freshness}");
    expect(page).toContain("onPause={tracking.pause}");
    expect(page).toContain("onResume={tracking.resume}");
    expect(stream).toContain("/api/tracking/live/${encodeURIComponent(scope)}/snapshot");
    expect(stream).toContain("new EventSource(");
    expect(stream).toContain('stream.addEventListener("tracking.delta"');
    expect(stream).toContain("cursorRef.current");
    expect(stream).toContain("withCredentials: true");
    expect(stream).toContain("function reconnectDelay");
    expect(stream).toContain('window.addEventListener("offline"');
    expect(stream).toContain('status: "paused"');
    expect(stream).toContain("freshnessFor");
    expect(layout.indexOf("{monitoringPanel}")).toBeLessThan(
      layout.indexOf("{error && !loading ? ("),
    );
  });

  it("keeps Tailwind integration and isolates map libraries in a deferred vendor chunk", () => {
    const vite = read("vite.config.ts");
    const css = read("client/src/index.css");

    expect(vite).toContain('import tailwindcss from "@tailwindcss/vite"');
    expect(vite).toContain("tailwindcss(),");
    expect(vite).toContain("react(),");
    expect(vite).toContain("viteStaticCopy(");
    expect(vite).toContain('return "vendor-map"');
    expect(vite).toContain('return "vendor-cesium"');
    expect(vite).toContain("chunkSizeWarningLimit: 500");
    expect(css).toContain('@import "tailwindcss";');
    expect(css).toContain(".vehicle-map-popup");
  });
});
