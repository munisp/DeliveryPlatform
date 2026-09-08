import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const migration = readFileSync(
  resolve(root, "drizzle/0058_gig_vehicle_rental_operations.sql"),
  "utf8",
);
const service = readFileSync(
  resolve(root, "server/_core/vehicleAccess.ts"),
  "utf8",
);
const router = readFileSync(resolve(root, "server/routers.ts"), "utf8");
const panel = readFileSync(
  resolve(root, "client/src/components/VehicleRentalOperationsPanel.tsx"),
  "utf8",
);
const vehicleAccessRouter = router.slice(
  router.indexOf("vehicleAccess: router({"),
  router.indexOf("  commerceFulfillment: router({"),
);
const page = readFileSync(
  resolve(root, "client/src/pages/VehicleAccessOperations.tsx"),
  "utf8",
);

describe("gig vehicle-rental operations", () => {
  it("keeps location history and agreement/add-on selections immutable", () => {
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS vehicle_access.provider_location",
    );
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS vehicle_access.asset_location_assignment",
    );
    expect(migration).toContain(
      "CREATE OR REPLACE VIEW vehicle_access.current_asset_location",
    );
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS vehicle_access.contract_add_on_selection",
    );
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS vehicle_access.contract_agreement_acceptance",
    );
    expect(migration).toContain("vehicle-rental evidence is append-only");
    expect(migration).toContain("worker agreement acceptance required");
    expect(migration).toContain(
      "billing_units integer NOT NULL CHECK (billing_units >= 1)",
    );
    expect(migration).toContain(
      "total_price_minor = unit_price_minor * quantity * billing_units",
    );
  });

  it("blocks overlapping availability and requires function-authorized lifecycle changes", () => {
    expect(migration).toContain(
      "EXCLUDE USING gist (asset_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)",
    );
    expect(migration).toContain("availability block conflicts with contract");
    expect(migration).toContain("extension conflicts with availability block");
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION vehicle_access.request_contract_with_add_ons",
    );
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION vehicle_access.record_agreement_acceptance",
    );
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION vehicle_access.decide_contract_extension",
    );
    expect(migration).toContain(
      "idempotency key reused with different add-on selection",
    );
    expect(migration).toContain("duplicate add-on selection");
    expect(migration).toContain("add-on total exceeds bigint range");
    expect(migration).toContain(
      "REVOKE ALL ON ALL TABLES IN SCHEMA vehicle_access FROM PUBLIC",
    );
    expect(migration).toContain(
      "REVOKE ALL ON ALL FUNCTIONS IN SCHEMA vehicle_access FROM vehicle_access_service",
    );
    expect(migration).toContain(
      "GRANT EXECUTE ON FUNCTION vehicle_access.request_contract_with_add_ons",
    );
    expect(migration).toContain("SET search_path = pg_catalog, vehicle_access");
    expect(migration).toContain("'active_availability_block_items'");
    expect(migration).toContain("'requested_extension_items'");
    expect(migration).toContain("'provider_locations'");
  });

  it("calls authority functions exclusively from the typed store", () => {
    for (const fn of [
      "create_provider_location",
      "assign_asset_location",
      "create_availability_block",
      "cancel_availability_block",
      "create_rental_add_on",
      "request_contract_with_add_ons",
      "record_agreement_acceptance",
      "request_contract_extension",
      "decide_contract_extension",
      "rental_operations_snapshot",
    ]) {
      expect(service).toContain(`vehicle_access.${fn}`);
    }
    expect(service).not.toMatch(/\bINSERT\s+INTO\s+vehicle_access\./i);
    expect(service).not.toMatch(/\bUPDATE\s+vehicle_access\./i);
    expect(service).not.toMatch(/\bDELETE\s+FROM\s+vehicle_access\./i);
  });

  it("exposes bounded worker and operator routes without financial settlement handling", () => {
    expect(vehicleAccessRouter).toContain(
      "requestContractWithAddOns: authenticatedProcedure",
    );
    expect(vehicleAccessRouter).toContain(
      "acceptAgreement: authenticatedProcedure",
    );
    expect(vehicleAccessRouter).toContain(
      "requestExtension: authenticatedProcedure",
    );
    expect(vehicleAccessRouter).toContain(
      "createProviderLocation: protectedProcedure",
    );
    expect(vehicleAccessRouter).toContain(
      "createAvailabilityBlock: protectedProcedure",
    );
    expect(vehicleAccessRouter).toContain(
      "assignAssetLocation: protectedProcedure",
    );
    expect(vehicleAccessRouter).toContain(
      "cancelAvailabilityBlock: protectedProcedure",
    );
    expect(vehicleAccessRouter).toContain(
      "createRentalAddOn: protectedProcedure",
    );
    expect(vehicleAccessRouter).toContain(
      "decideExtension: protectedProcedure",
    );
    expect(vehicleAccessRouter).toContain("agreementSha256Hex");
    expect(vehicleAccessRouter).toContain("acceptanceSha256Hex");
    expect(vehicleAccessRouter).toMatch(/\.array\s*\(/);
    expect(vehicleAccessRouter).not.toMatch(/(?:settle|transfer|tigerbeetle)/i);
  });

  it("uses one add-on-aware request UX and exposes agreement, extension, location, block, add-on, and snapshot operations", () => {
    expect(panel).toContain("requestContractWithAddOns.useMutation");
    expect(panel).toContain("acceptAgreement.useMutation");
    expect(panel).toContain("requestExtension.useMutation");
    expect(panel).toContain("createProviderLocation.useMutation");
    expect(panel).toContain("createAvailabilityBlock.useMutation");
    expect(panel).toContain("createRentalAddOn.useMutation");
    expect(panel).toContain("rentalOperationsSnapshot.useQuery");
    expect(panel).toContain("assignAssetLocation.useMutation");
    expect(panel).toContain("cancelAvailabilityBlock.useMutation");
    expect(panel).toContain("decideExtension.useMutation");
    expect(panel).toContain("useSessionProfile");
    expect(panel).toContain("Immutable agreement acceptance recorded");
    expect(page).toContain(
      "<VehicleRentalOperationsPanel onNotice={setNotice} />",
    );
    expect(page).not.toContain(
      "trpc.vehicleAccess.requestContract.useMutation",
    );
  });
});
