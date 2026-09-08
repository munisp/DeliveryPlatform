import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("Driver Mobility durable vehicle map", () => {
  it("uses MapLibre and only displays bounded durable position input", () => {
    const map = readFileSync(
      resolve(root, "client/src/components/VehicleTrackingMap.tsx"),
      "utf8",
    );

    expect(map).toContain(
      'import maplibregl, { type Map as MapLibreMap } from "maplibre-gl"',
    );
    expect(map).toContain('import "maplibre-gl/dist/maplibre-gl.css"');
    expect(map).toContain("const defaultMapStyle");
    expect(map).toContain(
      "positions.filter(isRenderablePosition).slice(0, 250)",
    );
    expect(map).toContain("new maplibregl.Map");
    expect(map).toContain("new maplibregl.Marker");
    expect(map).toContain("setDOMContent(");
    expect(map).not.toContain("setHTML(");
    expect(map).toContain("No durable current vehicle positions are available");
    expect(map).toMatch(
      /Automobile\s+markers are derived only from authenticated\s+tracking records/,
    );
  });

  it("refreshes authenticated tenant-scoped positions separately from the summary query", () => {
    const page = readFileSync(
      resolve(root, "client/src/pages/DriverMobility.tsx"),
      "utf8",
    );
    const layout = readFileSync(
      resolve(root, "client/src/components/PlatformSummaryPage.tsx"),
      "utf8",
    );

    expect(page).toContain('fetch("/api/operations/snapshot"');
    expect(page).toContain('credentials: "include"');
    expect(page).toContain('cache: "no-store"');
    expect(page).toContain("refetchInterval: 20_000");
    expect(page).toContain("<VehicleTrackingMap");
    expect(page).toContain("vehicle_tracking_unavailable");
    expect(layout.indexOf("{monitoringPanel}")).toBeLessThan(
      layout.indexOf("{error && !loading ? ("),
    );
  });

  it("retains the Tailwind v4 Vite integration required for the monitoring PWA layout", () => {
    const vite = readFileSync(resolve(root, "vite.config.ts"), "utf8");
    const css = readFileSync(resolve(root, "client/src/index.css"), "utf8");

    expect(vite).toContain('import tailwindcss from "@tailwindcss/vite"');
    expect(vite).toContain("plugins: [tailwindcss(), react()]");
    expect(css).toContain('@import "tailwindcss";');
    expect(css).toContain(".vehicle-map-marker");
  });
});
