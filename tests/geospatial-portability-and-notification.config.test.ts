import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("geospatial portability and event-driven tracking contracts", () => {
  it("uses a patched MapLibre line and removes the Manus Vite runtime dependency", () => {
    const packageJson = read("package.json");
    const lockfile = read("pnpm-lock.yaml");
    expect(packageJson).toContain('"maplibre-gl": "^6.9.0"');
    expect(packageJson).not.toContain("vite-plugin-manus-runtime");
    expect(lockfile).not.toContain("vite-plugin-manus-runtime");
  });

  it("keeps MapLibre and Cesium lazy while exposing a safe GeoLibre interchange path", () => {
    const wrapper = read("client/src/components/VehicleTrackingMap.tsx");
    const vite = read("vite.config.ts");
    expect(wrapper).toContain('lazy(() => import("@/components/MapLibreFleetCanvas"))');
    expect(wrapper).toContain('lazy(() => import("@/components/CesiumFleetGlobe"))');
    expect(wrapper).toContain("downloadAuthorizedGeoJson");
    expect(wrapper).toContain("VITE_GEOLIBRE_WORKSPACE_URL");
    const globe = read("client/src/components/CesiumFleetGlobe.tsx");
    expect(vite).not.toContain('return "vendor-cesium-engine"');
    expect(vite).toContain("node_modules/@cesium/engine/Source/Workers/*");
    expect(vite).not.toContain("node_modules/cesium/Build/Cesium");
    expect(globe).toContain("@cesium/engine/Source/Widget/CesiumWidget.js");
    expect(globe).not.toContain('from "cesium"');
    expect(globe).not.toContain("createOsmBuildingsAsync");
  });

  it("uses a cursor-only PostgreSQL wake-up and retains bounded resynchronization", () => {
    const migration = read("drizzle/0069_realtime_tracking_delta_notifications.sql");
    const tracking = read("server/_core/realtimeTracking.ts");
    expect(migration).toContain("pg_notify('delivery_tracking_delta', v_cursor::text)");
    expect(migration).not.toMatch(/pg_notify\([^\n]*(?:NEW\.(?:latitude|longitude|delivery_id)|v_order\.)/);
    expect(tracking).toContain("LISTEN ${TRACKING_DELTA_CHANNEL}");
    expect(tracking).toContain("const RESYNC_MS = 60_000");
    expect(tracking).not.toContain("const POLL_MS = 5_000");
  });

  it("uses generic self-hosted object-storage configuration for mobile runtime paths", () => {
    const env = read("mobile/switchos-native/server/_core/env.ts");
    const storage = read("mobile/switchos-native/server/storage.ts");
    const proxy = read("mobile/switchos-native/server/_core/storageProxy.ts");
    const appConfig = read("mobile/switchos-native/app.config.ts");
    expect(env).toContain("OBJECT_STORAGE_ENDPOINT");
    expect(storage).toContain("@aws-sdk/client-s3");
    expect(proxy).toContain('app.get("/storage/*"');
    expect([env, storage, proxy, appConfig].join("\n").toLowerCase()).not.toContain("manus");
  });
});
