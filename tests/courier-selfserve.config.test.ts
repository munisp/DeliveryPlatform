import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("courier self-serve portal", () => {
  it("ships migration 0074 as an additive, idempotent rental charge ledger", () => {
    const migration = source("drizzle/0074_rental_payment_ledger_link.sql");
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS public.vehicle_rental_charges",
    );
    expect(migration).toContain(
      "REFERENCES vehicle_access.access_contract(id) ON DELETE RESTRICT",
    );
    expect(migration).toContain(
      "REFERENCES public.users(id) ON DELETE RESTRICT",
    );
    expect(migration).toContain("UNIQUE (contract_id, charge_type)");
    expect(migration).toContain("ledger_reference text NOT NULL UNIQUE");
    expect(migration).toContain("vehicle_rental_charges_driver_status_idx");
    expect(migration).not.toMatch(/\bDROP TABLE\b/i);
    expect(migration).not.toMatch(/\bALTER TABLE\b/i);
  });

  it("scopes every self-serve procedure to the authenticated caller", () => {
    const router = source("server/_core/selfserveRouter.ts");
    expect(router).toContain("export const selfserveRouter = router({");
    expect(router).not.toContain("publicProcedure");
    expect(router).not.toContain("workspaceReadProcedure");
    expect(router).not.toContain("protectedProcedure");
    const procedureCount = (
      router.match(/authenticatedProcedure/g) ?? []
    ).length;
    // myDriverProfile, myIncentives, mySettlements, myPerformance,
    // myMarketplaceProfile, myVehicleOffers, myVehicleContracts,
    // myRentalAddOns, myRentalCharges, requestRental,
    // transitionRentalContract, myFairnessOffers, declineOffer
    expect(procedureCount).toBe(13);
    // every wrapper passes the caller's identity through
    expect(router).toContain("actorUserId: ctx.user.id");
    expect(router).toContain("workerUserId: ctx.user.id");
    expect(router).toContain("listTransparentDriverOffers(ctx.user.id)");
    expect(router).toContain("driverUserId: ctx.user.id");
    expect(router).toContain("WHERE driver_user_id = $1");
  });

  it("resolves the caller's driver row via open_id with email fallback", () => {
    const router = source("server/_core/selfserveRouter.ts");
    expect(router).toContain("export async function resolveDriverForUser");
    expect(router).toContain("d.open_id = $1");
    expect(router).toContain("lower(d.email) = lower($2)");
    expect(router).toContain("no_driver_profile_linked");
  });

  it("posts an idempotent activation charge when a contract activates", () => {
    const router = source("server/_core/selfserveRouter.ts");
    expect(router).toContain("export async function recordRentalCharge");
    expect(router).toContain(
      "INSERT INTO public.vehicle_rental_charges",
    );
    expect(router).toContain("ON CONFLICT (contract_id, charge_type) DO NOTHING");
    expect(router).toContain('if (state === "active")');
    // wraps, never edits, the vehicle-access transition function
    expect(router).toContain("transitionVehicleAccessContract({");
  });

  it("registers the router key, page route, and honest empty states", () => {
    const routers = source("server/routers.ts");
    expect(routers).toContain(
      'import { selfserveRouter } from "./_core/selfserveRouter";',
    );
    expect(routers).toContain("selfserve: selfserveRouter,");

    const app = source("client/src/App.tsx");
    expect(app).toContain('import CourierPortal from "@/pages/CourierPortal";');
    expect(app).toContain(
      '<Route path="/courier-portal" component={CourierPortal} />',
    );

    const page = source("client/src/pages/CourierPortal.tsx");
    expect(page).toContain("trpc.selfserve.myIncentives.useQuery");
    expect(page).toContain("trpc.selfserve.mySettlements.useQuery");
    expect(page).toContain("trpc.selfserve.myVehicleOffers.useQuery");
    expect(page).toContain("trpc.selfserve.myVehicleContracts.useQuery");
    expect(page).toContain("trpc.selfserve.myRentalCharges.useQuery");
    expect(page).toContain("trpc.selfserve.myFairnessOffers.useQuery");
    expect(page).toContain("trpc.selfserve.requestRental.useMutation");
    expect(page).toContain("trpc.selfserve.declineOffer.useMutation");
    expect(page).toContain("No courier profile is linked to this account");
    // no fabricated demo data
    expect(page).not.toMatch(/Math\.max\(4/);
    expect(page).not.toMatch(/lorem/i);
  });
});
