import { readFileSync } from "fs";
import { IncomingMessage, ServerResponse } from "http";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = [
  "REQUIRE_MFA_FOR_PRIVILEGED_ACTIONS",
  "PERMIFY_ENDPOINT",
  "PERMIFY_AUTH_TOKEN",
  "OPA_ENDPOINT",
  "OPA_AUTH_TOKEN",
  "REDIS_URL",
] as const;

async function loadHardenedRouter() {
  vi.resetModules();
  const {
    analyticsReadProcedure,
    authenticatedProcedure,
    operatorMutationProcedure,
    router,
    workspaceReadProcedure,
  } = await import("../server/_core/trpc");

  return router({
    operate: operatorMutationProcedure("operate").mutation(() => ({
      ok: "operate",
    })),
    writePlatform: operatorMutationProcedure("write_platform").mutation(() => ({
      ok: "write_platform",
    })),
    selfserveMutation: authenticatedProcedure.mutation(() => ({
      ok: "selfserve",
    })),
    workspaceRead: workspaceReadProcedure.query(() => ({ ok: "read" })),
    analyticsRead: analyticsReadProcedure.query(() => ({ ok: "analytics" })),
  });
}

function createContext(user: {
  id: number;
  name: string;
  role?: string | null;
  openId?: string | null;
  tenantId?: string | null;
  scopes?: string[];
  mfaAuthenticated?: boolean;
} | null) {
  return {
    req: new IncomingMessage(null as never),
    res: new ServerResponse({} as never),
    user,
  };
}

const operatorWithMfa = {
  id: 42,
  name: "Ops",
  role: "operator",
  openId: "operator:42",
  tenantId: "switchos-core",
  scopes: ["platform:read", "platform:write"],
  mfaAuthenticated: true,
};

describe("operatorMutationProcedure hardening", () => {
  const originalEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      originalEnv[key] = process.env[key];
    }
    process.env.REQUIRE_MFA_FOR_PRIVILEGED_ACTIONS = "true";
    process.env.PERMIFY_ENDPOINT = "";
    process.env.PERMIFY_AUTH_TOKEN = "";
    process.env.OPA_ENDPOINT = "";
    process.env.OPA_AUTH_TOKEN = "";
    process.env.REDIS_URL = "";
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (originalEnv[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
  });

  it("rejects unauthenticated callers", async () => {
    const testRouter = await loadHardenedRouter();
    const caller = testRouter.createCaller(createContext(null));
    await expect(caller.operate()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("rejects authenticated non-operator roles", async () => {
    const testRouter = await loadHardenedRouter();
    const caller = testRouter.createCaller(
      createContext({
        id: 7,
        name: "Courier",
        role: "driver",
        scopes: ["platform:read", "platform:write"],
        mfaAuthenticated: true,
      }),
    );
    await expect(caller.operate()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "OPERATOR_ROLE_REQUIRED",
    });
  });

  it("rejects operator mutations without a fresh MFA assertion", async () => {
    const testRouter = await loadHardenedRouter();
    const caller = testRouter.createCaller(
      createContext({ ...operatorWithMfa, mfaAuthenticated: false }),
    );
    await expect(caller.operate()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "MFA_REQUIRED_FOR_PRIVILEGED_ACTION",
    });
    await expect(caller.writePlatform()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "MFA_REQUIRED_FOR_PRIVILEGED_ACTION",
    });
  });

  it("rejects operator mutations when the policy grant is missing", async () => {
    const testRouter = await loadHardenedRouter();
    const caller = testRouter.createCaller(
      createContext({ ...operatorWithMfa, scopes: ["platform:read"] }),
    );
    await expect(caller.operate()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "POLICY_DENIED:operate",
    });
    await expect(caller.writePlatform()).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "POLICY_DENIED:write_platform",
    });
  });

  it("allows operator mutations with MFA and a policy grant", async () => {
    const testRouter = await loadHardenedRouter();
    const caller = testRouter.createCaller(createContext(operatorWithMfa));
    await expect(caller.operate()).resolves.toEqual({ ok: "operate" });
    await expect(caller.writePlatform()).resolves.toEqual({
      ok: "write_platform",
    });
  });

  it("leaves self-serve authenticated mutations unaffected by MFA/policy step-up", async () => {
    const testRouter = await loadHardenedRouter();
    const caller = testRouter.createCaller(
      createContext({
        id: 9,
        name: "Courier",
        role: "driver",
        scopes: [],
        mfaAuthenticated: false,
      }),
    );
    await expect(caller.selfserveMutation()).resolves.toEqual({
      ok: "selfserve",
    });
  });

  it("leaves operator read procedures unaffected by the MFA step-up", async () => {
    const testRouter = await loadHardenedRouter();
    const caller = testRouter.createCaller(
      createContext({
        ...operatorWithMfa,
        scopes: ["platform:read", "analytics:read"],
        mfaAuthenticated: false,
      }),
    );
    await expect(caller.workspaceRead()).resolves.toEqual({ ok: "read" });
    await expect(caller.analyticsRead()).resolves.toEqual({ ok: "analytics" });
  });
});

describe("operator-side sensitive mutation tier assignments", () => {
  const routerSource = readFileSync(
    join(__dirname, "..", "server", "routers.ts"),
    "utf8",
  );

  const operateTier = [
    "queueReplenishment",
    "upsertServiceArea",
    "upsertTechnician",
    "setTechnicianServiceArea",
    "createWorkOrder",
    "scheduleWorkOrder",
    "assignWorkOrder",
    "cancelWorkOrder",
    "recordProviderCheck",
    "decideCase",
    "createProvider",
    "verifyWorkerEligibility",
    "registerAsset",
    "recordAssetEvidence",
    "activateAsset",
    "createOffer",
    "createProviderLocation",
    "assignAssetLocation",
    "createAvailabilityBlock",
    "cancelAvailabilityBlock",
    "createRentalAddOn",
    "decideExtension",
    "createTrackerProvider",
    "registerAssetTracker",
    "createRentalAssetGeofence",
    "recordRentalPaymentTrackingSignal",
    "requestPreventNextStart",
    "authorizePreventNextStart",
    "cancelPreventNextStart",
    "operateTransition",
    "decideOnboarding",
    "transition",
    "assignDriver",
    "registerExternalPlatform",
    "upsertMedusaStore",
  ];

  const writePlatformTier = [
    "loyaltyIntervention",
    "merchantGrowthCampaign",
    "setEconomicsPolicy",
    "setPolicy",
    "createClient",
    "createKey",
    "revokeKey",
    "createWebhookEndpoint",
    "executeAction",
  ];

  it("elevates every operator-side sensitive mutation to the hardened tier", () => {
    for (const name of operateTier) {
      expect(routerSource).toContain(
        `${name}: operatorMutationProcedure("operate")`,
      );
    }
    for (const name of writePlatformTier) {
      expect(routerSource).toContain(
        `${name}: operatorMutationProcedure("write_platform")`,
      );
    }
  });

  it("keeps worker self-serve and read procedures on their existing tiers", () => {
    for (const name of [
      "requestContract: authenticatedProcedure",
      "requestContractWithAddOns: authenticatedProcedure",
      "acceptAgreement: authenticatedProcedure",
      "requestExtension: authenticatedProcedure",
      "recordInspection: authenticatedProcedure",
      "transition: authenticatedProcedure",
      "recordTrackerControlConsent: authenticatedProcedure",
      "advanceWorkOrder: authenticatedProcedure",
      "recordWorkOrderProof: authenticatedProcedure",
      "completeWorkOrder: authenticatedProcedure",
      "declineOffer: authenticatedProcedure",
      "list: protectedProcedure",
      "listClients: protectedProcedure",
    ]) {
      expect(routerSource).toContain(name);
    }
  });

  it("keeps the courier self-serve router free of operator-only tiers", () => {
    const selfserveSource = readFileSync(
      join(__dirname, "..", "server", "_core", "selfserveRouter.ts"),
      "utf8",
    );
    expect(selfserveSource).not.toContain("operatorMutationProcedure");
    expect(selfserveSource).not.toContain("protectedProcedure");
  });
});
