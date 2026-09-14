import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  deriveOnboardingChecklist,
  type MerchantOnboardingSignals,
} from "../server/_core/merchantOnboarding";

const root = resolve(__dirname, "..");
const read = (relative: string) => readFileSync(resolve(root, relative), "utf8");

const baseSignals: MerchantOnboardingSignals = {
  profile: null,
  paymentConfigured: false,
  productCount: 0,
  inventoryRowCount: 0,
  storefrontLinked: false,
};

const completeSignals: MerchantOnboardingSignals = {
  profile: {
    legalName: "Ada Foods Ltd",
    displayName: "Ada Foods",
    medusaStoreId: "store_01JABC",
    state: "active",
    onboardingCompletedAt: null,
  },
  paymentConfigured: true,
  productCount: 3,
  inventoryRowCount: 2,
  storefrontLinked: true,
};

describe("merchant onboarding checklist derivation (pure)", () => {
  it("marks every item pending when no real data exists", () => {
    const checklist = deriveOnboardingChecklist(42, baseSignals);
    expect(checklist.totalCount).toBe(5);
    expect(checklist.completedCount).toBe(0);
    expect(checklist.complete).toBe(false);
    expect(checklist.onboardingCompletedAt).toBeNull();
    for (const item of checklist.items) {
      expect(item.status).toBe("pending");
    }
  });

  it("requires non-blank profile fields before the profile item is done", () => {
    const blank = deriveOnboardingChecklist(42, {
      ...baseSignals,
      profile: {
        legalName: "  ",
        displayName: "Ada Foods",
        medusaStoreId: "store_01JABC",
        state: "draft",
        onboardingCompletedAt: null,
      },
    });
    expect(blank.items.find((item) => item.key === "profile")?.status).toBe("pending");

    const present = deriveOnboardingChecklist(42, {
      ...baseSignals,
      profile: completeSignals.profile,
    });
    expect(present.items.find((item) => item.key === "profile")?.status).toBe("done");
    expect(present.complete).toBe(false);
  });

  it("derives each remaining item from its own real signal", () => {
    const checklist = deriveOnboardingChecklist(42, {
      ...baseSignals,
      profile: completeSignals.profile,
      paymentConfigured: true,
      productCount: 1,
    });
    const byKey = Object.fromEntries(checklist.items.map((item) => [item.key, item.status]));
    expect(byKey).toEqual({
      profile: "done",
      payments: "done",
      product: "done",
      inventory: "pending",
      storefront: "pending",
    });
    expect(checklist.completedCount).toBe(3);
    expect(checklist.complete).toBe(false);
  });

  it("reports completion only when every item is done and carries the persisted timestamp", () => {
    const completedAt = "2026-05-01T12:00:00.000Z";
    const checklist = deriveOnboardingChecklist(42, {
      ...completeSignals,
      profile: { ...completeSignals.profile!, onboardingCompletedAt: completedAt },
    });
    expect(checklist.complete).toBe(true);
    expect(checklist.completedCount).toBe(checklist.totalCount);
    expect(checklist.onboardingCompletedAt).toBe(completedAt);

    const freshlyComplete = deriveOnboardingChecklist(42, completeSignals);
    expect(freshlyComplete.complete).toBe(true);
    expect(freshlyComplete.onboardingCompletedAt).toBeNull();
  });

  it("deep-links each item to its portal section or the storefront route", () => {
    const checklist = deriveOnboardingChecklist(42, baseSignals);
    const hrefs = Object.fromEntries(checklist.items.map((item) => [item.key, item.href]));
    expect(hrefs.profile).toBe("#merchant-onboarding-form");
    expect(hrefs.payments).toBe("#merchant-payments-form");
    expect(hrefs.product).toBe("#merchant-product-form");
    expect(hrefs.inventory).toBe("#merchant-inventory-form");
    expect(hrefs.storefront).toBe("/commerce-fulfillment");
  });
});

describe("merchant onboarding checklist contract", () => {
  it("persists the completion signal on the merchant portal table via a guarded migration", () => {
    const sql = read("drizzle/0079_merchant_onboarding.sql");
    expect(sql).toContain("ALTER TABLE commerce.merchant_portal");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz");
  });

  it("derives checklist state exclusively from real commerce tables", () => {
    const server = read("server/_core/merchantOnboarding.ts");
    expect(server).toContain('from "../db"');
    expect(server).toContain("commerce.merchant_portal");
    expect(server).toContain("commerce.merchant_payment_configuration");
    expect(server).toContain("commerce.merchant_catalog_product");
    expect(server).toContain("commerce.medusa_inventory_binding");
    expect(server).toContain("commerce.medusa_store_connection");
    expect(server).toContain("commerce.external_platform_connection");
    expect(server).toContain("onboarding_completed_at IS NULL");
    expect(server).not.toContain("medusaMerchantApiToken");
  });

  it("wires the onboarding progress query into the merchant commerce router with authentication", () => {
    const router = read("server/routers.ts");
    expect(router).toContain('from "./_core/merchantOnboarding"');
    expect(router).toContain("onboardingProgress: authenticatedProcedure");
    expect(router).toContain("getMerchantOnboardingProgress({ actorUserId: ctx.user!.id");
  });

  it("renders the checklist, guided empty states, and retryable error states on the portal page", () => {
    const page = read("client/src/pages/MerchantCommercePortal.tsx");
    expect(page).toContain("trpc.merchantCommerce.onboardingProgress.useQuery");
    expect(page).toContain("Onboarding checklist");
    expect(page).toContain("QueryErrorState");
    expect(page).toContain("EmptyState");
    expect(page).toContain("Create your first product");
    expect(page).toContain('href="#merchant-product-form"');
    expect(page).toContain('href="#merchant-payments-form"');
    expect(page).toContain('href="#merchant-inventory-form"');
    expect(page).toContain('id="merchant-onboarding-form"');
    expect(page).toContain('id="merchant-product-form"');
    expect(page).toContain('id="merchant-payments-form"');
    expect(page).toContain('id="merchant-inventory-form"');
  });
});
