import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("stakeholder verification cross-language contracts", () => {
  it("keeps consent, SHA-256 evidence, claim fencing, provider checks, and human decisions authoritative in PostgreSQL", () => {
    const sql = read("drizzle/0053_stakeholder_verification_engine.sql");
    expect(sql).toContain(
      "CREATE TABLE IF NOT EXISTS verification.consent_receipt",
    );
    expect(sql).toContain("sha256_hex ~ '^[a-f0-9]{64}$'");
    expect(sql).toContain("active consent required");
    expect(sql).toContain("verification.withdraw_consent");
    expect(sql).toContain("WHEN v_case.state='verified' THEN 'suspended'");
    expect(sql).toContain("FOR UPDATE SKIP LOCKED");
    expect(sql).toContain("stale verification processor claim");
    expect(sql).toContain("required verification checks incomplete");
    expect(sql).toContain("verification evidence is append only");
  });

  it("binds external callbacks to HMAC authentication and keeps VLM/document/liveness outputs manual-review only", () => {
    const go = read("services/go/verification-orchestrator/main.go");
    const python = read("services/python/verification-intelligence/main.py");
    const rust = read("services/rust/verification-policy/src/main.rs");
    expect(go).toContain("verifyProviderSignature");
    expect(go).toContain("hmac.Equal");
    expect(go).toContain("VERIFICATION_ALLOW_SYNTHETIC_OBJECTS");
    expect(python).toContain("PaddleOCR");
    expect(python).toContain("DocumentConverter");
    expect(python).toContain("manual_review_required");
    expect(python).toContain("image_forensics_artifacts");
    expect(python).toContain("validate_td3_mrz");
    expect(rust).toContain("validate_td3_mrz");
    expect(rust).toContain("/v1/forensics/mrz");
    expect(rust).toContain("all_checks_present_manual_review_required");
    expect(rust).toContain("manual_review_required: true");
  });

  it("wires authenticated users and protected reviewers through typed API and routed operations UI", () => {
    const router = read("server/routers.ts");
    const service = read("server/_core/stakeholderVerification.ts");
    const app = read("client/src/App.tsx");
    const page = read("client/src/pages/StakeholderVerification.tsx");
    expect(router).toContain("stakeholderVerification: router");
    expect(router).toContain("startCase: authenticatedProcedure");
    expect(router).toContain("recordProviderCheck: operatorMutationProcedure(\"operate\")");
    expect(router).toContain('"document_forensics"');
    expect(router).toContain("decideCase: operatorMutationProcedure(\"operate\")");
    expect(service).toContain("verification.record_evidence");
    expect(service).toContain("verification.decide_case");
    expect(app).toContain('path="/verification"');
    expect(page).toContain("Consented verification operations");
  });
});
