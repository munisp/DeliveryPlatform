import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("vertical compliance packs", () => {
  it("stores packs as an additive table with jsonb requirement descriptors", () => {
    const migration = source("drizzle/0076_vertical_compliance_packs.sql");
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS public.vertical_compliance_packs",
    );
    expect(migration).toContain("required_documents JSONB NOT NULL");
    expect(migration).toContain("handling_requirements JSONB NOT NULL");
    expect(migration).toContain("age_restriction JSONB");
    expect(migration).toContain("active BOOLEAN NOT NULL DEFAULT true");
    expect(migration).toContain(
      "REFERENCES public.service_verticals(id) ON DELETE SET NULL",
    );
    expect(migration).toContain("jsonb_typeof(required_documents) = 'array'");
    expect(migration).toContain("jsonb_typeof(handling_requirements) = 'array'");
    // Additive only: no destructive statements.
    expect(migration).not.toMatch(/DROP TABLE/i);
    expect(migration).not.toMatch(/ALTER TABLE/i);
  });

  it("seeds realistic baseline packs for pharmacy, alcohol, healthcare, and grocery", () => {
    const migration = source("drizzle/0076_vertical_compliance_packs.sql");
    // Idempotent seeds linked to service_verticals by slug.
    expect(migration.match(/WHERE NOT EXISTS/g)?.length).toBeGreaterThanOrEqual(4);
    for (const slug of ["pharmacy", "alcohol", "healthcare", "grocery"]) {
      expect(migration).toContain(`'${slug}'`);
      expect(migration).toContain(`v.slug = '${slug}'`);
    }
    // Pharmacy: prescription verification, licensed pharmacist, controlled-substance log.
    expect(migration).toContain("prescription_verification");
    expect(migration).toContain("pharmacist_license");
    expect(migration).toContain("controlled_substance_log");
    // Alcohol: ID scan + 21+ age restriction + delivery signature.
    expect(migration).toContain("id_scan_record");
    expect(migration).toContain('"minimum_age":21');
    expect(migration).toContain("adult_signature_required");
    // Healthcare: HIPAA-style handling + patient consent.
    expect(migration).toContain("patient_consent_record");
    expect(migration).toContain("business_associate_agreement");
    expect(migration).toContain("minimum_necessary_phi");
    // Grocery: temperature log + expiry handling.
    expect(migration).toContain("temperature_log");
    expect(migration).toContain("expiry_fefo_handling");
  });

  it("exposes typed query functions backed by the shared postgres pool", () => {
    const module = source("server/_core/compliancePacks.ts");
    expect(module).toContain('import { getPool } from "../db"');
    expect(module).toContain("export async function listCompliancePacks(");
    expect(module).toContain(
      "export async function getVerticalComplianceSummary(",
    );
    expect(module).toContain("FROM public.vertical_compliance_packs p");
    expect(module).toContain(
      "LEFT JOIN public.service_verticals v ON v.id = p.vertical_id",
    );
  });

  it("registers a workspace-read tRPC router with list and summary procedures", () => {
    const router = source("server/_core/compliancePacksRouter.ts");
    expect(router).toContain("export const compliancePacksRouter = router({");
    expect(router).toContain("list: workspaceReadProcedure");
    expect(router).toContain("summary: workspaceReadProcedure");
    const app = source("server/routers.ts");
    expect(app).toContain(
      'import { compliancePacksRouter } from "./_core/compliancePacksRouter";',
    );
    expect(app).toContain("compliancePacks: compliancePacksRouter,");
  });

  it("renders the compliance console page on a wired route", () => {
    const page = source("client/src/pages/VerticalCompliance.tsx");
    expect(page).toContain("trpc.compliancePacks.summary.useQuery()");
    expect(page).toContain("Vertical Compliance Packs");
    expect(page).toContain("Required documents");
    expect(page).toContain("Handling requirements");
    expect(page).toContain("Verticals without a compliance pack");
    expect(page).toContain("Age restriction:");
    const app = source("client/src/App.tsx");
    expect(app).toContain('import("@/pages/VerticalCompliance")');
    expect(app).toContain('path="/compliance/vertical-packs"');
  });
});
