import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { decideRiderVerificationOutcome } from "../server/_core/riderVerification";

const root = resolve(import.meta.dirname, "..");
const source = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("migration 0091 — driver applications + onboarding bindings", () => {
  const migration = source("drizzle/0091_driver_onboarding.sql");

  it("ships driver_applications with the full status lifecycle and KYC case link", () => {
    expect(migration).toContain(
      "CREATE TABLE IF NOT EXISTS public.driver_applications",
    );
    expect(migration).toContain(
      "user_id bigint NOT NULL REFERENCES public.users(id)",
    );
    expect(migration).toContain(
      "CHECK (status IN ('submitted', 'in_review', 'approved', 'rejected', 'withdrawn'))",
    );
    expect(migration).toContain("verification_case_id uuid");
    expect(migration).toContain("full_name text NOT NULL");
    expect(migration).toContain("vehicle jsonb NOT NULL DEFAULT '{}'::jsonb");
    expect(migration).toContain("rejection_reason text");
  });

  it("enforces one active application per user via a partial unique index", () => {
    expect(migration).toContain(
      "CREATE UNIQUE INDEX IF NOT EXISTS driver_applications_one_active_per_user_idx",
    );
    expect(migration).toContain(
      "WHERE status IN ('submitted', 'in_review')",
    );
  });

  it("adds rider consent receipt columns idempotently", () => {
    expect(migration).toContain(
      "ADD COLUMN IF NOT EXISTS consent_captured_at timestamptz",
    );
    expect(migration).toContain(
      "ADD COLUMN IF NOT EXISTS consent_version text",
    );
  });

  it("is additive and idempotent (no destructive DDL)", () => {
    expect(migration).not.toMatch(/\bDROP TABLE\b/i);
    expect(migration).not.toMatch(/\bTRUNCATE\b/i);
    expect(migration).toContain("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  });

  it("binds merchant claims to a merchant-scoped verification case before verification_pending", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION commerce.begin_merchant_onboarding(",
    );
    expect(migration).toContain("verification.start_case(");
    expect(migration).toContain("'merchant'::verification.subject_type");
    expect(migration).toContain("'provider:' || p_provider_id::text");
    expect(migration).toContain("'merchant_onboarding'");
    // the bound case id is persisted on the portal row
    expect(migration).toContain("verification_case_id,created_at,updated_at");
    expect(migration).toContain(
      "verification_case_id=EXCLUDED.verification_case_id",
    );
    // audit trail records the bound case
    expect(migration).toContain(
      "jsonb_build_object('medusa_store_id',p_medusa_store_id,'verification_case_id',v_case_id)",
    );
  });

  it("keeps the 0064 begin signature identical so existing grants carry over", () => {
    expect(migration).toContain(
      "p_actor_user_id integer, p_provider_id integer, p_legal_name text, p_display_name text,",
    );
    expect(migration).toContain(
      "p_medusa_store_id text, p_idempotency_key text, p_now timestamptz DEFAULT clock_timestamp()",
    );
  });

  it("closes the any-verified-case activation hole (subject_type + subject binding)", () => {
    expect(migration).toContain(
      "CREATE OR REPLACE FUNCTION commerce.decide_merchant_onboarding(",
    );
    expect(migration).toContain(
      "AND state = 'verified'::verification.case_state",
    );
    expect(migration).toContain(
      "AND subject_type = 'merchant'::verification.subject_type",
    );
    expect(migration).toContain(
      "AND subject_key = 'provider:' || p_provider_id::text",
    );
    expect(migration).toContain(
      "verified merchant verification case bound to this provider required",
    );
    expect(migration).not.toContain(
      "'verified merchant verification case required'",
    );
  });
});

describe("driverOnboarding module — gated driver application flow", () => {
  const service = source("server/_core/driverOnboarding.ts");

  it("exports the full lifecycle surface", () => {
    for (const name of [
      "applyDriver",
      "getMyDriverApplication",
      "withdrawMyDriverApplication",
      "listDriverApplications",
      "decideDriverApplication",
      "getVerifiedDriverAccess",
    ]) {
      expect(service).toContain(`export async function ${name}`);
    }
  });

  it("opens a driver KYC case through the stakeholder verification engine on apply", () => {
    expect(service).toContain(
      'import { startVerificationCase } from "./stakeholderVerification";',
    );
    expect(service).toContain('subjectType: "driver"');
    expect(service).toContain('purpose: "driver_onboarding"');
    expect(service).toContain("verification_case_id = $2");
  });

  it("is idempotent per user and race-safe on the one-active constraint", () => {
    expect(service).toContain("a.status IN ('submitted', 'in_review')");
    expect(service).toContain('"23505"');
  });

  it("requires the bound case to be verified before approval", () => {
    expect(service).toContain('application.verification_case_state !== "verified"');
    expect(service).toContain("driver_case_not_verified");
    expect(service).toContain('"PRECONDITION_FAILED"');
  });

  it("requires a rejection reason", () => {
    expect(service).toContain("driver_rejection_reason_required");
    expect(service).toContain("rejection_reason = $2");
  });

  it("creates/binds the drivers row on approval via open_id conflict upsert", () => {
    expect(service).toContain("INSERT INTO public.drivers");
    expect(service).toContain("ON CONFLICT (open_id) DO UPDATE");
    expect(service).toContain("FROM public.users WHERE id = $1");
  });

  it("defines the shared verified-access rule as approved application + verified case", () => {
    expect(service).toContain("a.status = 'approved'");
    expect(service).toContain("c.state = 'verified'");
    expect(service).toContain("ON c.id = a.verification_case_id");
  });

  it("treats repeat decisions as no-ops returning current state", () => {
    expect(service).toContain(
      'application.status === "approved" || application.status === "rejected"',
    );
  });
});

describe("driverOnboardingRouter — procedure tiers and registration", () => {
  const routerFile = source("server/_core/driverOnboardingRouter.ts");
  const routers = source("server/routers.ts");

  it("scopes self-serve procedures to the caller's public.users identity", () => {
    // `apply` is a reserved word in tRPC routers, hence submitApplication.
    expect(routerFile).toContain("submitApplication: authenticatedProcedure");
    expect(routerFile).toContain("getMyApplication: authenticatedProcedure");
    expect(routerFile).toContain("withdraw: authenticatedProcedure");
    expect(routerFile).toContain("resolvePublicUser(ctx.user)");
    expect(routerFile).not.toContain("userId: ctx.user.id");
  });

  it("gates operator list/decide behind write_platform (MFA + policy)", () => {
    expect(routerFile).toContain(
      'listApplications: operatorMutationProcedure("write_platform")',
    );
    expect(routerFile).toContain(
      'decideApplication: operatorMutationProcedure("write_platform")',
    );
  });

  it("is registered on the app router", () => {
    expect(routers).toContain(
      'import { driverOnboardingRouter } from "./_core/driverOnboardingRouter";',
    );
    expect(routers).toContain("driverOnboarding: driverOnboardingRouter,");
  });
});

describe("selfserve driver surface — silent linkage no longer grants access", () => {
  const routerFile = source("server/_core/selfserveRouter.ts");

  it("keeps the legacy open_id/email driver resolution (read path)", () => {
    expect(routerFile).toContain("export async function resolveDriverForUser");
    expect(routerFile).toContain("d.open_id = $1");
    expect(routerFile).toContain("lower(d.email) = lower($2)");
  });

  it("requires verified onboarding access for earnings/settlements/performance paths", () => {
    expect(routerFile).toContain(
      'import { getVerifiedDriverAccess } from "./driverOnboarding";',
    );
    expect(routerFile).toContain("driver_verification_required");
    expect(routerFile).toContain('"FORBIDDEN"');
    for (const name of [
      "myIncentives",
      "mySettlements",
      "myPerformance",
      "myMarketplaceProfile",
    ]) {
      expect(routerFile).toContain(`${name}: authenticatedProcedure`);
    }
    expect(routerFile).toContain("await requireLinkedDriver(ctx.user)");
  });

  it("marks the legacy profile read with verifiedAccess instead of granting access", () => {
    expect(routerFile).toContain("myDriverProfile: authenticatedProcedure");
    expect(routerFile).toContain("verifiedAccess: access !== null");
  });
});

describe("dispatch fairness — fail-closed offer stream", () => {
  const fairness = source("server/_core/driverDispatchFairness.ts");

  it("excludes drivers without verified status from the offer stream", () => {
    expect(fairness).toContain(
      'import { getVerifiedDriverAccess } from "./driverOnboarding";',
    );
    expect(fairness).toContain("getVerifiedDriverAccess(driverUserId)");
    expect(fairness).toContain("if (!access) return [];");
  });
});

describe("rider verification — fail-closed auto-decision with consent", () => {
  const service = source("server/_core/riderVerification.ts");
  const routerFile = source("server/_core/riderVerificationRouter.ts");

  it("removed the fail-open outage behavior", () => {
    expect(service).not.toContain("failing open");
    expect(service).toContain("failing closed");
    expect(service).toContain("unavailable: true");
    expect(service).not.toContain("plausible: true,\n    });");
  });

  it("stamps the consent receipt columns on submission", () => {
    expect(service).toContain("consent_captured_at");
    expect(service).toContain("consent_version = COALESCE($4, consent_version)");
  });

  it("accepts consentVersion on the wire (optional, but required to verify)", () => {
    expect(routerFile).toContain(
      "consentVersion: z.string().trim().min(1).max(64).optional()",
    );
    expect(routerFile).toContain("consentVersion: input.consentVersion ?? null");
  });

  it("unit: auto-verifies only when format valid AND screen passes AND consent captured", () => {
    expect(
      decideRiderVerificationOutcome({
        formatValid: true,
        screening: { plausible: true, unavailable: false },
        consentCaptured: true,
      }),
    ).toBe("verified");
  });

  it("unit: screening outage leaves the rider pending (never verified)", () => {
    expect(
      decideRiderVerificationOutcome({
        formatValid: true,
        screening: { plausible: false, unavailable: true },
        consentCaptured: true,
      }),
    ).toBe("pending");
  });

  it("unit: screening flags leave the rider pending (never verified)", () => {
    expect(
      decideRiderVerificationOutcome({
        formatValid: true,
        screening: { plausible: false, unavailable: false },
        consentCaptured: true,
      }),
    ).toBe("pending");
  });

  it("unit: missing consent leaves the rider pending even when everything passes", () => {
    expect(
      decideRiderVerificationOutcome({
        formatValid: true,
        screening: { plausible: true, unavailable: false },
        consentCaptured: false,
      }),
    ).toBe("pending");
  });

  it("unit: deterministically invalid ID format is the only auto-reject", () => {
    expect(
      decideRiderVerificationOutcome({
        formatValid: false,
        screening: { plausible: true, unavailable: false },
        consentCaptured: true,
      }),
    ).toBe("rejected");
    expect(
      decideRiderVerificationOutcome({
        formatValid: false,
        screening: { plausible: false, unavailable: true },
        consentCaptured: false,
      }),
    ).toBe("rejected");
  });
});

describe("operator provisioning — external OIDC gated behind approval", () => {
  const store = source("server/_core/operatorAuthStore.ts");
  const index = source("server/_core/index.ts");
  const routers = source("server/routers.ts");

  it("provisions external operators inactive with no email_verified_at", () => {
    const ensureBody = store.slice(
      store.indexOf("export async function ensureExternalOperator"),
      store.indexOf("export async function approveExternalOperator"),
    );
    expect(ensureBody).toContain("VALUES ($1, $2, 'operator', $3, $4, false)");
    expect(ensureBody).not.toContain("is_active = true");
    expect(ensureBody).not.toContain("email_verified_at =");
    expect(ensureBody).toContain("isActive: operator.is_active");
  });

  it("approves via an explicit operator action that activates + verifies", () => {
    expect(store).toContain("export async function approveExternalOperator");
    expect(store).toContain("SET is_active = true");
    expect(store).toContain(
      "email_verified_at = COALESCE(email_verified_at, NOW())",
    );
  });

  it("refuses OIDC session issuance while the account is pending approval", () => {
    expect(index).toContain("if (!operator.isActive) {");
    expect(index).toContain("operator_pending_approval");
  });

  it("exposes approval behind write_platform operator mutation", () => {
    expect(routers).toContain("operatorOnboarding: router({");
    expect(routers).toContain(
      'approveExternalOperator: operatorMutationProcedure("write_platform")',
    );
    expect(routers).toContain(
      'import { approveExternalOperator } from "./_core/operatorAuthStore";',
    );
    expect(routers).toContain("operator_not_found");
  });
});
