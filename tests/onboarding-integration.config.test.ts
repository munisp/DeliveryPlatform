import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("onboarding integration migration (drizzle/0092)", () => {
  const sql = read("drizzle/0092_onboarding_integration.sql");

  it("adds the 'appealed' case state and the verification_appeals due-process table", () => {
    expect(sql).toContain(
      "ALTER TYPE verification.case_state ADD VALUE IF NOT EXISTS 'appealed'",
    );
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.verification_appeals");
    expect(sql).toContain("appellant_user_id bigint NOT NULL REFERENCES public.users(id)");
    expect(sql).toContain("CHECK (status IN ('filed', 'in_review', 'decided'))");
    expect(sql).toContain("decision IN ('upheld', 'overturned')");
    expect(sql).toContain("reviewer_id bigint REFERENCES public.users(id)");
    expect(sql).toContain("sla_due_at timestamptz NOT NULL");
  });

  it("marks the verification outbox consumable and stores merchant rejection reasons", () => {
    expect(sql).toContain("ALTER TABLE verification.outbox_event");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS consumed_at timestamptz");
    expect(sql).toContain("ALTER TABLE commerce.merchant_portal");
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS rejection_reason text");
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS public.market_economics_reports");
  });

  it("gates fleet provider activation on a verified bound case (signature-identical create_provider)", () => {
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION vehicle_access.create_provider(p_actor integer,p_display text,p_legal text,p_now timestamptz DEFAULT clock_timestamp())",
    );
    // Providers now start pending instead of instantly active (P1-5).
    expect(sql).toContain("VALUES(p_display,p_legal,'pending',p_actor,p_now,p_now)");
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION vehicle_access.activate_provider(p_actor integer,p_provider uuid,p_verification_case uuid,p_now timestamptz DEFAULT clock_timestamp())",
    );
    expect(sql).toContain("subject_type='fleet_provider'::verification.subject_type");
    expect(sql).toContain("subject_key='fleet-provider:'||p_provider::text");
    expect(sql).toContain(
      "verified fleet provider verification case bound to this provider required",
    );
  });

  it("gates technician activation and worker eligibility on verified cases (signature-identical)", () => {
    expect(sql).toContain(
      "p_actor_user_id integer, p_user_id integer, p_provider_id integer, p_display_name text, p_employee_reference text, p_skills jsonb, p_state field_service.technician_state, p_now timestamptz DEFAULT clock_timestamp()",
    );
    expect(sql).toContain(
      "verified field technician verification case required for activation",
    );
    expect(sql).toContain(
      "CREATE OR REPLACE FUNCTION vehicle_access.upsert_worker_eligibility(p_actor integer,p_worker integer,p_categories jsonb,p_expires timestamptz,p_now timestamptz DEFAULT clock_timestamp())",
    );
    expect(sql).toContain(
      "verified driver verification case required for worker eligibility",
    );
    expect(sql).toContain("ADD COLUMN IF NOT EXISTS verification_case_id uuid");
  });

  it("restates grants in role-guarded DO blocks", () => {
    expect(sql).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='vehicle_access_service')");
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION vehicle_access.activate_provider(integer,uuid,uuid,timestamptz) TO vehicle_access_service",
    );
    expect(sql).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'field_service_api')");
    expect(sql).toContain(
      "GRANT EXECUTE ON FUNCTION field_service.upsert_technician(integer,integer,integer,text,text,jsonb,field_service.technician_state,timestamp with time zone) TO field_service_api",
    );
  });
});

describe("onboarding integration server wiring", () => {
  it("registers the verification appeal router additively", () => {
    const routers = read("server/routers.ts");
    expect(routers).toContain(
      'import { verificationRouter } from "./_core/verificationRouter";',
    );
    expect(routers).toContain("verification: verificationRouter,");
    expect(routers).toContain("rejectionReason: z.string().trim().min(3).max(1000).optional()");
    const router = read("server/_core/verificationRouter.ts");
    expect(router).toContain('operatorMutationProcedure("write_platform")');
    const appeals = read("server/_core/verificationAppeals.ts");
    expect(appeals).toContain("reviewer_must_differ_from_decider");
    expect(appeals).toContain("VERIFICATION_APPEAL_SLA_DAYS = 14");
  });

  it("dispatches notifications in every onboarding/verification/governance decision path", () => {
    for (const module of [
      "server/_core/deactivationDueProcess.ts",
      "server/_core/stakeholderVerification.ts",
      "server/_core/merchantCommerce.ts",
      "server/_core/workerCouncil.ts",
      "server/_core/driverOnboarding.ts",
    ]) {
      expect(read(module)).toContain('from "./notificationGateway"');
    }
    // The deactivation notice is honest: stamped only after dispatch.
    const deactivation = read("server/_core/deactivationDueProcess.ts");
    expect(deactivation).toContain("SET notice_sent_at = now()");
    expect(deactivation).toContain("deactivation.notice");
  });

  it("consumes the verification outbox and escalates manual-review SLA breaches", () => {
    const jobs = read("server/_core/scheduledJobs.ts");
    expect(jobs).toContain("verificationOutboxSweepJob");
    expect(jobs).toContain("verificationSlaSweepJob");
    expect(jobs).toContain("consumed_at = now()");
    expect(jobs).toContain("FOR UPDATE SKIP LOCKED");
    expect(jobs).toContain("dispatchDeveloperWebhooks");
    expect(jobs).toContain("verification.case.sla_escalated");
    expect(jobs).toContain("VERIFICATION_MANUAL_REVIEW_SLA_HOURS = 72");
    expect(jobs).toContain("verificationOutboxSweep: verificationOutboxSweepJob");
    expect(jobs).toContain("verificationSlaSweep: verificationSlaSweepJob");
  });

  it("wires the orphan safety-engine and market-economics services fail-open", () => {
    const env = read("server/_core/env.ts");
    expect(env).toContain('SAFETY_ENGINE_URL ?? "http://127.0.0.1:8107"');
    expect(env).toContain('MARKET_ECONOMICS_URL ?? "http://127.0.0.1:8110"');
    const tripSafety = read("server/_core/tripSafety.ts");
    expect(tripSafety).toContain("ENV.safetyEngineUrl");
    expect(tripSafety).toContain("/risk");
    expect(tripSafety).toContain("trip_risk_scored");
    const economics = read("server/_core/economicsPolicy.ts");
    expect(economics).toContain("ENV.marketEconomicsUrl");
    expect(economics).toContain("/reports/generate");
    expect(economics).toContain("public.market_economics_reports");
    const economicsRouter = read("server/_core/economicsRouter.ts");
    expect(economicsRouter).toContain("generateMarketReport");
  });
});
