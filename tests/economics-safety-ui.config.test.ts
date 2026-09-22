import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("wave B3 economics + safety UI surfaces (R2 manifest, R3 SOS, R6 fare transparency, R7 take rate, R8 fare floor, R9 cost index)", () => {
  it("routes the driver safety center and market economics workspaces", () => {
    const app = source("client/src/App.tsx");
    expect(app).toContain('import("@/pages/DriverSafetyCenter")');
    expect(app).toContain('import("@/pages/MarketEconomics")');
    expect(app).toContain('path="/safety" component={DriverSafetyCenter}');
    expect(app).toContain(
      'path="/market-economics" component={MarketEconomics}',
    );
  });

  it("exposes both workspaces in navigation", () => {
    const layout = source("client/src/components/DashboardLayout.tsx");
    expect(layout).toContain('label: "Driver Safety"');
    expect(layout).toContain('path: "/safety"');
    expect(layout).toContain('label: "Market Economics"');
    expect(layout).toContain('path: "/market-economics"');
  });

  it("bridges every contracted procedure through typed wrappers with no any leakage into pages", () => {
    const bridge = source("client/src/lib/trpcEconomicsSafety.ts");
    // economics router resolves as economicsPolicy ?? economics
    expect(bridge).toContain("bridgeClient.economicsPolicy ??");
    expect(bridge).toContain("bridgeClient.economics");
    for (const procedure of [
      "getFareFloor.useQuery",
      "getTakeRate.useQuery",
      "updateCostIndex.useMutation",
      "publishTakeRate.useMutation",
      "checkFareAgainstFloor.useMutation",
      "recordFloorOverride.useMutation",
      "pricingTransparency.getOfferBreakdown.useQuery",
      "pricingTransparency.getMyNetEarningsSummary.useQuery",
      "safety.attachManifest.useMutation",
      "safety.getManifest.useQuery",
      "safety.triggerSOS.useMutation",
      "safety.cancelSOS.useMutation",
      "safety.resolveSOS.useMutation",
      "safety.listActiveSOS.useQuery",
    ]) {
      expect(bridge).toContain(procedure);
    }
    for (const type of [
      "FareFloor",
      "TakeRate",
      "FareFloorCheck",
      "CostIndex",
      "OfferBreakdown",
      "NetEarningsSummary",
      "TripManifest",
      "ManifestPassengerInput",
      "ManifestPassenger",
      "SOSAlert",
    ]) {
      expect(bridge).toContain(`export interface ${type}`);
    }
    for (const surface of [
      "client/src/pages/DriverSafetyCenter.tsx",
      "client/src/pages/MarketEconomics.tsx",
      "client/src/components/FareBreakdown.tsx",
      "client/src/components/PassengerManifestForm.tsx",
    ]) {
      const surfaceSource = source(surface);
      expect(surfaceSource).toContain("@/lib/trpcEconomicsSafety");
      expect(surfaceSource).not.toContain('from "@/lib/trpc"');
      expect(surfaceSource).not.toMatch(/\bas any\b/);
    }
  });

  it("fare breakdown renders line items, deadhead pickup note, and bold net-to-driver", () => {
    const breakdown = source("client/src/components/FareBreakdown.tsx");
    expect(breakdown).toContain("useOfferBreakdown");
    expect(breakdown).toContain("Base fare");
    expect(breakdown).toContain("Distance");
    expect(breakdown).toContain("Time");
    expect(breakdown).toContain("Deadhead credit");
    expect(breakdown).toContain("Surge (");
    expect(breakdown).toContain("Platform fee (");
    expect(breakdown).toContain("Net to driver");
    expect(breakdown).toContain("font-bold");
    expect(breakdown).toContain("— deadhead credited");
    expect(breakdown).toContain("amountMinor / 100");
    const offers = source("client/src/pages/DriverOfferFairness.tsx");
    expect(offers).toContain(
      'import FareBreakdown from "@/components/FareBreakdown"',
    );
    expect(offers).toContain("<FareBreakdown offerId={offer.offerId} />");
  });

  it("driver safety center supports hold-to-confirm SOS, cancel, manifest chips, and earnings summary", () => {
    const safety = source("client/src/pages/DriverSafetyCenter.tsx");
    expect(safety).toContain("useTriggerSOS");
    expect(safety).toContain("useCancelSOS");
    expect(safety).toContain("useManifest");
    expect(safety).toContain("useMyNetEarningsSummary");
    expect(safety).toContain("onPointerDown");
    expect(safety).toContain("HOLD_TO_CONFIRM_MS = 3_000");
    expect(safety).toContain("Cancel SOS");
    expect(safety).toContain("Verified rider");
    expect(safety).toContain("Unverified rider");
    expect(safety).toContain("Manifest verified");
    expect(safety).toContain("<FareBreakdown offerId={latestOfferId} />");
    expect(safety).toContain("useSessionProfile");
    expect(safety).toContain("useActiveSOS");
    expect(safety).toContain("useResolveSOS");
  });

  it("market economics console gates operators and wires floor, take rate, check, and override", () => {
    const economics = source("client/src/pages/MarketEconomics.tsx");
    expect(economics).toContain("useFareFloor");
    expect(economics).toContain("useTakeRate");
    expect(economics).toContain("useUpdateCostIndex");
    expect(economics).toContain("usePublishTakeRate");
    expect(economics).toContain("useCheckFareAgainstFloor");
    expect(economics).toContain("useRecordFloorOverride");
    expect(economics).toContain("useSessionProfile");
    expect(economics).toContain("commission");
    expect(economics).toContain("posts to council");
    expect(economics).toContain("requiresOverride");
  });

  it("booking surface embeds the passenger manifest composer (R2)", () => {
    const form = source("client/src/components/PassengerManifestForm.tsx");
    expect(form).toContain("useAttachManifest");
    expect(form).toContain("Add passenger");
    expect(form).toContain("NIN (optional)");
    expect(form).toContain("manifestVerified");
    const rider = source("client/src/pages/RiderApp.tsx");
    expect(rider).toContain(
      'import PassengerManifestForm from "@/components/PassengerManifestForm"',
    );
    expect(rider).toContain("<PassengerManifestForm />");
  });
});
