import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const migration = readFileSync(
  resolve(root, "drizzle/0050_gig_worker_vehicle_access.sql"),
  "utf8",
);
const service = readFileSync(
  resolve(root, "server/_core/vehicleAccess.ts"),
  "utf8",
);
const router = readFileSync(resolve(root, "server/routers.ts"), "utf8");
const page = readFileSync(
  resolve(root, "client/src/pages/VehicleAccessOperations.tsx"),
  "utf8",
);
const rentalPanel = readFileSync(
  resolve(root, "client/src/components/VehicleRentalOperationsPanel.tsx"),
  "utf8",
);
const app = readFileSync(resolve(root, "client/src/App.tsx"), "utf8");

describe("gig-worker vehicle-access implementation", () => {
  it("keeps lifecycle state and evidence transitions PostgreSQL-authoritative", () => {
    expect(migration).toContain(
      "CREATE TYPE vehicle_access.asset_state AS ENUM ('intake','available','reserved','active_access','return_pending','maintenance_hold','safety_hold','retired')",
    );
    expect(migration).toContain(
      "CREATE TYPE vehicle_access.contract_state AS ENUM ('requested','approved','active','return_pending','closed','cancelled','suspended')",
    );
    expect(migration).toContain(
      "EXCLUDE USING gist (asset_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&)",
    );
    expect(migration).toContain("FOR UPDATE;");
    expect(migration).toContain("vehicle_access.prevent_append_only_mutation");
    expect(migration).toContain("required valid asset evidence missing");
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS vehicle_access.worker_eligibility",
    );
    expect(migration).toContain("verified worker eligibility required");
    expect(migration).toContain("handover inspection required");
    expect(migration).toContain("return inspection required");
    expect(migration).toContain("vehicle_access.contract.suspended");
  });

  it("uses restricted service functions rather than direct table mutation", () => {
    expect(service).toContain("vehicle_access.request_contract");
    expect(service).toContain("vehicle_access.transition_contract");
    expect(service).toContain("vehicle_access.record_inspection");
    expect(service).not.toMatch(/\bINSERT\s+INTO\s+vehicle_access\./i);
    expect(service).not.toMatch(/\bUPDATE\s+vehicle_access\./i);
  });

  it("registers worker and operator routes with bounded input validation", () => {
    expect(router).toContain("vehicleAccess: router({");
    expect(router).toContain("requestContract: authenticatedProcedure");
    expect(router).toContain("operateTransition: operatorMutationProcedure(\"operate\")");
    expect(router).toMatch(
      /z\.enum\(\[\s*"approve",\s*"handover",\s*"close",\s*"suspend",\s*"begin_safe_return",\s*\]\)/,
    );
    expect(router).toContain("verifyWorkerEligibility: operatorMutationProcedure(\"operate\")");
    expect(router).toContain("allowedWorkCategories");
    expect(router).toContain("sha256Hex");
  });

  it("makes the worker and operator workspace reachable in the client", () => {
    expect(page).toContain("trpc.vehicleAccess.listOffers.useQuery");
    expect(rentalPanel).toContain(
      "trpc.vehicleAccess.requestContractWithAddOns.useMutation",
    );
    expect(page).toContain("trpc.vehicleAccess.recordInspection.useMutation");
    expect(page).toContain("trpc.vehicleAccess.operateTransition.useMutation");
    expect(app).toContain('href: "/vehicle-access"');
    expect(app).toContain(
      '<Route path="/vehicle-access" component={VehicleAccessOperations} />',
    );
  });
});
