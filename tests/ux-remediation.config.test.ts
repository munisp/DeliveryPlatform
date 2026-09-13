import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const read = (relative: string) =>
  readFileSync(resolve(root, relative), "utf8");

describe("UX remediation: orphaned routes, error boundary, error/empty states", () => {
  it("wires every previously orphaned route into the sidebar navigation", () => {
    const navigation = read("client/src/components/DashboardLayout.tsx");
    const app = read("client/src/App.tsx");

    const routes: Array<[string, string]> = [
      ["/consoles/trust", "Trust Console"],
      ["/consoles/experiments", "Experiment Console"],
      ["/compliance/vertical-packs", "Vertical Compliance"],
      ["/consoles/checkout", "Checkout Insights"],
      ["/consoles/merchant-ads", "Merchant Ads Studio"],
      ["/mobility", "Mobility Overview"],
      ["/mobility/rider", "Rider App"],
      ["/mobility/business", "Business Travel"],
      ["/mobility/freight", "Freight Operations"],
      ["/mobility/healthcare", "Healthcare Transport"],
      ["/consoles/courier-radar", "Courier Trip Radar"],
      ["/consoles/merchant-hub", "Merchant Hub"],
      ["/courier-portal", "Courier Portal"],
    ];

    for (const [path, label] of routes) {
      expect(app).toContain(`path="${path}"`);
      expect(navigation).toContain(`path: "${path}"`);
      expect(navigation).toContain(`label: "${label}"`);
    }

    expect(navigation).toContain('label: "Operator consoles"');
    expect(navigation).toContain('label: "Mobility"');
    expect(navigation).toContain('label: "Self-serve"');
  });

  it("routes the merchant commerce portal and keeps the merchant-channels link live", () => {
    const app = read("client/src/App.tsx");
    const channels = read("client/src/pages/MerchantChannels.tsx");
    const routers = read("server/routers.ts");

    expect(app).toContain(
      'import MerchantCommercePortal from "@/pages/MerchantCommercePortal";',
    );
    expect(app).toContain('path="/merchant-commerce"');
    expect(channels).toContain('href="/merchant-commerce"');
    // Backing procedures must exist; the page must never fake them.
    expect(routers).toContain("merchantCommerce: router(");
    expect(routers).toContain("profile: authenticatedProcedure");
    expect(routers).toContain("beginOnboarding: authenticatedProcedure");
  });

  it("wraps the router outlet and each workspace section in error boundaries", () => {
    const app = read("client/src/App.tsx");
    const layout = read("client/src/components/DashboardLayout.tsx");
    const boundary = read("client/src/components/ErrorBoundary.tsx");

    expect(boundary).toContain("getDerivedStateFromError");
    expect(boundary).toContain("componentDidCatch");
    expect(boundary).toContain("Reload page");
    expect(boundary).toContain("reportClientError");
    expect(boundary).toContain("import.meta.env.DEV");

    expect(app).toContain('<ErrorBoundary variant="app"');
    expect(layout).toContain('<ErrorBoundary variant="section"');
  });

  it("renders explicit error states with retry on the console and mobility pages", () => {
    const queryState = read("client/src/components/QueryState.tsx");
    expect(queryState).toContain("QueryErrorState");
    expect(queryState).toContain("onRetry");
    expect(queryState).toContain("EmptyState");

    for (const page of [
      "TrustConsole",
      "ExperimentConsole",
      "CheckoutInsights",
      "MerchantAdsStudio",
      "MerchantHub",
      "CourierTripRadar",
      "VerticalCompliance",
      "MobilityOverview",
      "RiderApp",
      "BusinessTravel",
      "FreightOperations",
      "HealthcareTransport",
    ]) {
      const source = read(`client/src/pages/${page}.tsx`);
      expect(source).toContain("QueryErrorState");
      expect(source).toContain("isError");
      expect(source).toContain("refetch()");
    }
  });
});
