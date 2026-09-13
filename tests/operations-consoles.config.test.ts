import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { consolesRouter } from "../server/_core/consolesRouter";

function source(relativePath: string) {
  return readFileSync(resolve(process.cwd(), relativePath), "utf8");
}

describe("operations consoles wiring contracts", () => {
  it("exposes every console procedure over workspaceReadProcedure", async () => {
    const procedures = Object.keys((consolesRouter as any)._def.procedures);

    expect(procedures).toEqual(
      expect.arrayContaining([
        "merchantHub",
        "checkoutSummary",
        "courierTripRadar",
        "trustConsole",
        "experimentConsole",
        "merchantAds",
        "consumerMarketplace",
      ]),
    );

    const routerSource = source("server/_core/consolesRouter.ts");
    expect(routerSource).not.toContain("publicProcedure");
    expect(routerSource.match(/workspaceReadProcedure/g)?.length).toBeGreaterThanOrEqual(7);
  });

  it("wraps the existing db.ts query layers without new tables or stubbed data", () => {
    const routerSource = source("server/_core/consolesRouter.ts");

    for (const fn of [
      "getMerchantHubSummary",
      "getCheckoutSummary",
      "getCourierTripRadarSummary",
      "getTrustConsoleSummary",
      "getExperimentConsoleSummary",
      "getMerchantAdsSummary",
      "getConsumerMarketplaceSummary",
    ]) {
      expect(routerSource).toContain(fn);
      expect(source("server/db.ts")).toContain(`export async function ${fn}`);
    }

    expect(routerSource).not.toContain("CREATE TABLE");
    expect(routerSource).not.toContain("Math.random");
  });

  it("registers the consoles router on the app router and wires every console route", () => {
    const routers = source("server/routers.ts");
    expect(routers).toContain('import { consolesRouter } from "./_core/consolesRouter";');
    expect(routers).toContain("consoles: consolesRouter");

    const app = source("client/src/App.tsx");
    const routes: Array<[string, string]> = [
      ["/consoles/merchant-hub", "MerchantHub"],
      ["/consoles/checkout", "CheckoutInsights"],
      ["/consoles/courier-radar", "CourierTripRadar"],
      ["/consoles/trust", "TrustConsole"],
      ["/consoles/experiments", "ExperimentConsole"],
      ["/consoles/merchant-ads", "MerchantAdsStudio"],
    ];
    for (const [path, component] of routes) {
      expect(app).toContain(`path="${path}" component={${component}}`);
      expect(app).toContain(`import ${component} from "@/pages/${component}";`);
    }
  });

  it("renders live tRPC data with honest empty states on every console page", () => {
    const pages: Array<[string, string]> = [
      ["client/src/pages/MerchantHub.tsx", "trpc.consoles.merchantHub.useQuery"],
      ["client/src/pages/CheckoutInsights.tsx", "trpc.consoles.checkoutSummary.useQuery"],
      ["client/src/pages/CourierTripRadar.tsx", "trpc.consoles.courierTripRadar.useQuery"],
      ["client/src/pages/TrustConsole.tsx", "trpc.consoles.trustConsole.useQuery"],
      ["client/src/pages/ExperimentConsole.tsx", "trpc.consoles.experimentConsole.useQuery"],
      ["client/src/pages/MerchantAdsStudio.tsx", "trpc.consoles.merchantAds.useQuery"],
    ];

    for (const [file, hook] of pages) {
      const page = source(file);
      expect(page).toContain(hook);
      expect(page).toContain("length === 0");
      expect(page).not.toContain("Math.random");
      expect(page).not.toContain("lorem");
    }
  });
});
