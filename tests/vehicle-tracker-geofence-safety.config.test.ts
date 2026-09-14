import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const migration = readFileSync(
  resolve(root, "drizzle/0059_vehicle_tracker_geofence_safety_controls.sql"),
  "utf8",
);
const store = readFileSync(
  resolve(root, "server/_core/vehicleAccess.ts"),
  "utf8",
);
const ingress = readFileSync(
  resolve(root, "server/_core/vehicleTrackerIntegration.ts"),
  "utf8",
);
const router = readFileSync(resolve(root, "server/routers.ts"), "utf8");
const server = readFileSync(resolve(root, "server/_core/index.ts"), "utf8");
const panel = readFileSync(
  resolve(root, "client/src/components/VehicleTrackerSafetyPanel.tsx"),
  "utf8",
);
const validator = readFileSync(
  resolve(
    root,
    "scripts/testing/validate-vehicle-tracker-geofence-safety-controls.sh",
  ),
  "utf8",
);
const vehicleAccessRouter = router.slice(
  router.indexOf("vehicleAccess: router({"),
  router.indexOf("  commerceFulfillment: router({"),
);

describe("vehicle tracker, geofence, and safe control authority", () => {
  it("stores immutable tracker, consent, geofence, risk, and payment-signal evidence", () => {
    for (const table of [
      "vehicle_access.tracker_provider",
      "vehicle_access.vehicle_asset_tracker",
      "vehicle_access.rental_asset_geofence",
      "vehicle_access.contract_tracker_control_consent",
      "vehicle_access.vehicle_tracker_signal",
      "vehicle_access.rental_asset_geofence_event",
      "vehicle_access.rental_tracker_risk_flag",
      "vehicle_access.rental_payment_tracking_signal",
      "vehicle_access.prevent_next_start_case",
      "vehicle_access.prevent_next_start_command",
    ]) {
      expect(migration).toContain(table);
    }
    expect(migration).toContain("vehicle tracker evidence is append-only");
    expect(migration).toContain(
      "REVOKE ALL ON ALL TABLES IN SCHEMA vehicle_access FROM PUBLIC",
    );
    expect(migration).toContain("SET search_path = pg_catalog, vehicle_access");
    expect(migration).toContain(
      "tracker event id reused with different payload",
    );
  });

  it("requires stationary telemetry, consent, an uncured grace signal, no emergency, a capable tracker, and independent operators", () => {
    for (const interlock of [
      "tracker control consent required",
      "uncured payment grace signal required",
      "fresh stationary ignition-off tracker signal required",
      "emergency safety flag blocks remote control",
      "tracker prevent-next-start capability required",
      "independent operator authorization required",
      "prevent-next-start command claim fence mismatch",
    ]) {
      expect(migration).toContain(interlock);
    }
    expect(migration).toContain("SKIP LOCKED");
    expect(migration).toContain(
      "vehicle_access.prevent_next_start.failed_before_dispatch",
    );
    expect(migration).toContain("state IN ('authorized','claimed')");
  });

  it("contains no automatic engine-stop control and makes payment signals evidence-only", () => {
    expect(migration).not.toContain("prevent_next_start_command_kind");
    expect(ingress).not.toContain('action: "engine_stop"');
    expect(ingress).not.toContain('action: "engine_cut"');
    expect(ingress).toContain('action: "prevent_next_start"');
    expect(ingress).toContain("never retry automatically");
    expect(migration).not.toMatch(
      /(?:INSERT|UPDATE|DELETE).*?(?:ledger|settlement|transfer)/is,
    );
  });

  it("uses authority functions only in the typed store and validates raw webhook signatures before ingestion", () => {
    for (const fn of [
      "create_tracker_provider",
      "register_asset_tracker",
      "create_rental_asset_geofence",
      "record_tracker_control_consent",
      "record_vehicle_tracker_signal",
      "record_rental_payment_tracking_signal",
      "request_prevent_next_start",
      "authorize_prevent_next_start",
      "cancel_prevent_next_start",
      "claim_prevent_next_start_command",
      "mark_prevent_next_start_dispatched",
      "complete_prevent_next_start_command",
      "tracker_operations_snapshot",
    ]) {
      expect(store).toContain(`vehicle_access.${fn}`);
    }
    expect(store).not.toMatch(/\bINSERT\s+INTO\s+vehicle_access\./i);
    expect(store).not.toMatch(/\bUPDATE\s+vehicle_access\./i);
    expect(store).not.toMatch(/\bDELETE\s+FROM\s+vehicle_access\./i);
    expect(ingress).toContain("timingSafeEqual");
    expect(ingress).toContain("createHmac");
    expect(ingress).toContain("input.rawBody");
    expect(ingress).toContain("vehicle_tracker_signature_invalid");
  });

  it("exposes bounded worker/operator procedures and keeps device dispatch outside the browser", () => {
    for (const route of [
      "trackerOperationsSnapshot: authenticatedProcedure",
      "recordTrackerControlConsent: authenticatedProcedure",
      "createTrackerProvider: operatorMutationProcedure(\"operate\")",
      "registerAssetTracker: operatorMutationProcedure(\"operate\")",
      "createRentalAssetGeofence: operatorMutationProcedure(\"operate\")",
      "recordRentalPaymentTrackingSignal: operatorMutationProcedure(\"operate\")",
      "requestPreventNextStart: operatorMutationProcedure(\"operate\")",
      "authorizePreventNextStart: operatorMutationProcedure(\"operate\")",
      "cancelPreventNextStart: operatorMutationProcedure(\"operate\")",
    ]) {
      expect(vehicleAccessRouter).toContain(route);
    }
    expect(vehicleAccessRouter).toContain('z.literal("MultiPolygon")');
    expect(server).toContain('"/api/vehicle-trackers/events/:integrationKey"');
    expect(server).toContain(
      '"/internal/vehicle-trackers/commands/dispatch-once"',
    );
    expect(server).toContain("requireInternalServiceAccess(req, res)");
    expect(panel).toContain("useSessionProfile");
    expect(panel).toContain("never issues an engine-stop command");
    expect(panel).toMatch(/Browser actions\s+never contact a\s+tracker/);
  });

  it("exercises two-person safety authorization, altered payload rejection, append-only evidence, moving-vehicle rejection, and table/helper denials", () => {
    for (const expected of [
      "expected independent operator rejection: SQLSTATE %",
      "expected altered tracker retry rejection: SQLSTATE %",
      "expected append-only tracker evidence denial: SQLSTATE %",
      "expected moving-vehicle interlock rejection: SQLSTATE %",
      "expected internal tracker helper denial: SQLSTATE %",
      "expected direct tracker table write denial: SQLSTATE %",
      "expected untrusted tracker evidence read denial: SQLSTATE %",
      "stationary_only_prevent_next_start",
    ]) {
      expect(validator).toContain(expected);
    }
  });
});
