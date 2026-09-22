import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("mobility surfaces gap closure (0073)", () => {
  it("creates the mobility surface tables additively", () => {
    const migration = source("drizzle/0073_mobility_surfaces.sql");
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS rider_trips");
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS business_travel_accounts",
    );
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS business_travel_trips",
    );
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS freight_loads");
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS healthcare_transport_bookings",
    );
    // additive only: no drops or alterations of existing tables
    expect(migration).not.toMatch(/DROP TABLE/i);
    expect(migration).not.toMatch(/ALTER TABLE/i);
    // sensible foreign keys and indexes
    expect(migration).toContain("REFERENCES users(id)");
    expect(migration).toContain("REFERENCES drivers(id)");
    expect(migration).toContain("REFERENCES service_providers(id)");
    expect(migration).toContain("CREATE INDEX IF NOT EXISTS");
  });

  it("computes every value from real tables with no hardcoded padding", () => {
    const queries = source("server/_core/mobilityQueries.ts");
    for (const fn of [
      "getMobilityOverviewSummary",
      "getRiderAppSummary",
      "getDriverMobilitySummary",
      "getBusinessTravelSummary",
      "getFreightSummary",
      "getHealthcareTransportSummary",
    ]) {
      expect(queries).toContain(`export async function ${fn}`);
    }
    // the six dead fail-closed summaries are replaced, not re-thrown
    expect(queries).not.toContain("VERIFIED_DATA_UNAVAILABLE");
    // no padding patterns copied from the dead code
    expect(queries).not.toContain("Math.max(2,");
    expect(queries).not.toContain("Math.max(4,");
    expect(queries).not.toContain("Math.max(6,");
    expect(queries).not.toContain("Math.max(10,");
    // real data sources: new 0073 tables plus existing live tables
    expect(queries).toContain("FROM rider_trips");
    expect(queries).toContain("FROM business_travel_accounts");
    expect(queries).toContain("FROM business_travel_trips");
    expect(queries).toContain("FROM freight_loads");
    expect(queries).toContain("FROM healthcare_transport_bookings");
    expect(queries).toContain("FROM drivers");
    expect(queries).toContain("FROM service_providers");
    expect(queries).toContain("mobility.match_attempt");
  });

  it("exposes the six workspace-read procedures on the mobility router", async () => {
    const { mobilityRouter } = await import(
      "../server/_core/mobilityRouter"
    );
    const procedures = Object.keys(
      (mobilityRouter as any)._def.procedures,
    ).sort();
    expect(procedures).toEqual([
      "businessTravel",
      "driverMobility",
      "freight",
      "healthcare",
      "overview",
      "riderApp",
    ]);

    const routerSource = source("server/_core/mobilityRouter.ts");
    expect(routerSource.match(/workspaceReadProcedure/g)?.length).toBeGreaterThanOrEqual(6);
  });

  it("wires the router into appRouter with a single key", () => {
    const routers = source("server/routers.ts");
    expect(routers).toContain(
      'import { mobilityRouter } from "./_core/mobilityRouter";',
    );
    expect(routers).toContain("mobility: mobilityRouter,");
  });

  it("renders five live pages with honest empty states and wires routes", () => {
    const app = source("client/src/App.tsx");
    const routes: Array<[string, string, string]> = [
      ["/mobility", "MobilityOverview", "trpc.mobility.overview.useQuery"],
      ["/mobility/rider", "RiderApp", "trpc.mobility.riderApp.useQuery"],
      ["/mobility/business", "BusinessTravel", "trpc.mobility.businessTravel.useQuery"],
      ["/mobility/freight", "FreightOperations", "trpc.mobility.freight.useQuery"],
      ["/mobility/healthcare", "HealthcareTransport", "trpc.mobility.healthcare.useQuery"],
    ];
    for (const [path, component, hook] of routes) {
      expect(app).toContain(`path="${path}"`);
      expect(app).toContain(`import("@/pages/${component}")`);
      const page = source(`client/src/pages/${component}.tsx`);
      expect(page).toContain(hook);
      expect(page).toContain("DashboardLayout");
      // honest empty state: zero-count guidance copy, no fabricated numbers
      expect(page).toMatch(/length === 0/);
      expect(page).not.toMatch(/Math\.max\(/);
    }
  });
});
