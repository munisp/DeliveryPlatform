import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");

describe("financial dead-letter remediation safeguards", () => {
  it("uses restricted-security PostgreSQL functions and explicitly qualified application relations", () => {
    const migration = readFileSync(
      resolve(root, "drizzle/0056_financial_dead_letter_remediation.sql"),
      "utf8",
    );
    expect(migration).toContain("SET search_path = pg_catalog");
    expect(migration).not.toContain("SET search_path = pg_catalog, public");
    expect(migration).toContain("public.mojaloop_funds_outbox%ROWTYPE");
    expect(migration).toContain("public.mojaloop_transfers%ROWTYPE");
    expect(migration).toContain("public.mojaloop_dead_letter_case%ROWTYPE");
    expect(migration).toContain("public.users");
    expect(migration).toContain("public.mojaloop_is_financial_administrator");
    expect(migration).toContain(
      "public.mojaloop_append_dead_letter_case_event",
    );
    expect(migration).toContain(
      "REVOKE ALL ON public.mojaloop_dead_letter_case FROM PUBLIC",
    );
    expect(migration).toContain(
      "REVOKE ALL ON public.mojaloop_dead_letter_case_event FROM PUBLIC",
    );
  });

  it("makes opening and remediation requests independently idempotent while preserving append-only evidence", () => {
    const migration = readFileSync(
      resolve(root, "drizzle/0056_financial_dead_letter_remediation.sql"),
      "utf8",
    );
    const validator = readFileSync(
      resolve(
        root,
        "scripts/testing/validate-financial-dead-letter-remediation.sh",
      ),
      "utf8",
    );
    expect(migration).toContain("opened_idempotency_key");
    expect(migration).toContain("request_idempotency_key");
    expect(migration).toContain("approval_idempotency_key");
    expect(migration).toContain(
      "financial dead-letter evidence is append only",
    );
    expect(migration).toContain(
      "a dead-letter case already exists for this outbox row",
    );
    expect(validator).toContain("dead_letter_case_open_idempotency=PASS");
    expect(validator).toContain("remediation_request_idempotency=PASS");
    expect(validator).toContain("runtime_direct_table_read_denied=PASS");
  });

  it("never requeues the terminal row and creates a distinct pending replacement only after a different administrator approves", () => {
    const migration = readFileSync(
      resolve(root, "drizzle/0056_financial_dead_letter_remediation.sql"),
      "utf8",
    );
    expect(migration).toContain(
      "approved_by_user_id IS DISTINCT FROM requested_by_user_id",
    );
    expect(migration).toContain(
      "only confirmed-not-committed transfers may request a replacement",
    );
    expect(migration).toContain("independent second approval required");
    expect(migration).toContain("replacement_intent_created");
    expect(migration).toContain("INSERT INTO public.mojaloop_transfers");
    expect(migration).toContain("'PENDING'");
    expect(migration).toContain("INSERT INTO public.mojaloop_funds_outbox");
    expect(migration).toContain("'pending'");
    expect(migration).not.toContain(
      "UPDATE public.mojaloop_funds_outbox\n     SET status = 'pending'",
    );
  });

  it("exposes only MFA-gated, bounded API routes that invoke database authority functions through the store", () => {
    const server = readFileSync(resolve(root, "server/_core/index.ts"), "utf8");
    const store = readFileSync(
      resolve(root, "server/_core/financialAdminStore.ts"),
      "utf8",
    );
    const page = readFileSync(
      resolve(root, "client/src/pages/FinancialAdministration.tsx"),
      "utf8",
    );
    const authorityCalls = store.slice(
      store.indexOf("export type FinancialDeadLetterCase"),
    );
    expect(server).toMatch(
      /app\.get\(\s*"\/api\/admin\/finance\/dead-letter-cases",\s*rateLimit\(30\),[\s\S]*?const user = requireFinancialAdministrator/,
    );
    expect(server).toMatch(
      /app\.post\(\s*"\/api\/admin\/finance\/dead-letter-cases",\s*rateLimit\(5\),[\s\S]*?const user = requireFinancialAdministrator/,
    );
    expect(server).toContain(
      '"/api/admin/finance/dead-letter-cases/:caseId/remediation-requests"',
    );
    expect(server).toContain(
      '"/api/admin/finance/dead-letter-cases/:caseId/approve"',
    );
    expect(server).toContain(
      '"/api/admin/finance/dead-letter-cases/:caseId/reject"',
    );
    expect(server).toContain("invalid_dead_letter_remediation_request");
    expect(server).toContain("invalid_dead_letter_approval");
    expect(server).toContain("invalid_dead_letter_rejection");
    expect(authorityCalls).toContain("mojaloop_open_dead_letter_case");
    expect(authorityCalls).toContain(
      "mojaloop_request_dead_letter_remediation",
    );
    expect(authorityCalls).toContain(
      "mojaloop_approve_dead_letter_remediation",
    );
    expect(authorityCalls).toContain("mojaloop_reject_dead_letter_remediation");
    expect(authorityCalls).not.toContain(
      "INSERT INTO mojaloop_dead_letter_case",
    );
    expect(authorityCalls).not.toContain("UPDATE mojaloop_funds_outbox");
    expect(page).toContain("TigerBeetle dead-letter remediation");
    expect(page).toMatch(
      /never retried,[\s\S]{0,100}reopened, or edited\s+here/,
    );
    expect(page).toMatch(/confirmed\s+not committed/);
    expect(page).toContain("Create new remediation intent");
  });
});
