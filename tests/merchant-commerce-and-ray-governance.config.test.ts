import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "..");
const read = (relative: string) => readFileSync(resolve(root, relative), "utf8");

describe("merchant commerce portal governance", () => {
  it("keeps merchant onboarding, verification activation, membership, payment configuration, and audit evidence in PostgreSQL authority functions", () => {
    const sql = read("drizzle/0064_merchant_commerce_portal.sql");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS commerce.merchant_portal");
    expect(sql).toContain("commerce.merchant_user_access");
    expect(sql).toContain("merchant_portal_audit_append_only");
    expect(sql).toContain("ERRCODE = '55000'");
    expect(sql).toContain("verified merchant verification case required");
    expect(sql).toContain("commerce.authorize_merchant_portal");
    expect(sql).toContain("commerce.configure_merchant_payment");
    expect(sql).toContain("REVOKE ALL ON ALL TABLES IN SCHEMA commerce FROM PUBLIC");
  });

  it("routes merchant catalog and stock updates through bounded server-side Medusa calls after PostgreSQL authorization", () => {
    const server = read("server/_core/merchantCommerce.ts");
    const router = read("server/routers.ts");
    const page = read("client/src/pages/MerchantCommercePortal.tsx");
    expect(server).toContain("commerce.authorize_merchant_portal");
    expect(server).toContain('Authorization: `Basic ${ENV.medusaMerchantApiToken}`');
    expect(server).toContain("/admin/products");
    expect(server).toContain("/admin/inventory-items/");
    expect(server).toContain("AbortSignal.timeout(10_000)");
    expect(router).toContain("merchantCommerce: router");
    expect(router).toContain("createProduct: authenticatedProcedure");
    expect(router).toContain("configurePayments: authenticatedProcedure");
    expect(router).toContain("updateInventory: authenticatedProcedure");
    expect(page).toContain("This registers an encrypted-reference settlement destination");
    expect(page).toContain("does not capture customer money or automatically settle funds");
  });

});
