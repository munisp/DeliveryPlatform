import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("driver dispatch fairness controls", () => {
  it("persists transparent fare, destination, pickup, and commission disclosures", () => {
    const migration = source("drizzle/0051_driver_dispatch_fairness.sql");
    expect(migration).toContain("mobility.driver_offer_disclosure");
    expect(migration).toContain("destination_address text NOT NULL");
    expect(migration).toContain(
      "expected_driver_net_kobo = gross_fare_kobo - taxes_and_fees_kobo - platform_commission_kobo",
    );
    expect(migration).toContain("platform_commission_bp BETWEEN 0 AND 1500");
    expect(migration).toContain("pickup_distance_above_policy_limit");
    expect(migration).toContain("pickup_time_above_policy_limit");
    expect(migration).toContain(
      "transparent driver offer disclosure required before acceptance",
    );
  });

  it("records declines without automatically penalizing driver eligibility or account state", () => {
    const migration = source("drizzle/0051_driver_dispatch_fairness.sql");
    expect(migration).toContain("mobility.driver_offer_decline");
    expect(migration).toContain("pickup_distance_unprofitable");
    expect(migration).toContain(
      "Deliberately no change to driver_profile, driver_eligibility, rating, or suspension state.",
    );
    expect(migration).toContain("rematch_required");
  });

  it("allocates a bounded pickup subsidy only when the driver floor and platform contribution target can both be met", () => {
    const economics = source("drizzle/0052_driver_offer_economics.sql");
    expect(economics).toContain("mobility.driver_offer_economics_policy");
    expect(economics).toContain("fuel_cost_index_bp BETWEEN 5000 AND 30000");
    expect(economics).toContain(
      "maintenance_cost_index_bp BETWEEN 5000 AND 30000",
    );
    expect(economics).toContain("driver_earnings_floor_kobo");
    expect(economics).toContain("pickup_subsidy_kobo");
    expect(economics).toContain("driver_earnings_floor_unmet");
    expect(economics).toContain("platform_contribution_target_unmet");
    expect(economics).toContain("v_fairness.platform_commission_bp");
    expect(economics).toContain("SKIP LOCKED");
  });

  it("uses the database fairness function from the matching worker and exposes bounded internal offer operations", () => {
    const worker = source("services/go/ride-matching-worker/main.go");
    expect(worker).toContain("mobility.create_transparent_driver_offer");
    expect(worker).toContain(
      'mux.HandleFunc("/offers/disclosures", svc.offerDisclosuresHandler)',
    );
    expect(worker).toContain(
      'mux.HandleFunc("/offers/decline", svc.declineOfferHandler)',
    );
    expect(worker).toContain("validDriverOfferDeclineReason");
    expect(worker).toContain("validIdempotencyKey");
  });

  it("binds driver actions to the authenticated identity while retaining database operator checks for policy changes", () => {
    const router = source("server/routers.ts");
    const page = source("client/src/pages/DriverOfferFairness.tsx");
    const app = source("client/src/App.tsx");
    expect(router).toContain("driverDispatchFairness: router({");
    expect(router).toContain("listMyOffers: authenticatedProcedure");
    expect(router).toContain("declineOffer: authenticatedProcedure");
    expect(router).toContain("driverUserId: ctx.user!.id");
    expect(router).toContain("setPolicy: operatorMutationProcedure(\"write_platform\")");
    expect(router).toContain("setEconomicsPolicy: operatorMutationProcedure(\"write_platform\")");
    expect(router).toContain(
      "fuelCostIndexBp: z.number().int().min(5000).max(30000)",
    );
    expect(page).toContain("Expected driver proceeds");
    expect(page).toContain("Published earnings floor");
    expect(page).toContain("Pickup subsidy");
    expect(page).toContain("Driver floor and pickup-subsidy policy");
    expect(page).toContain("Destination before acceptance");
    expect(page).toContain("does not suspend the driver");
    expect(app).toContain('path="/driver-offers"');
  });
});
