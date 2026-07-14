import { describe, expect, it, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";
import { IncomingMessage, ServerResponse } from "http";

const lakehouseMocks = vi.hoisted(() => ({
  syncLakehouseFromPostgres: vi.fn(),
  getLakehouseAnalyticsSummary: vi.fn(),
  getLakehouseOrderStats: vi.fn(),
  getLakehouseDriverStats: vi.fn(),
  getLakehouseMarketplaceOverview: vi.fn(),
}));

const workspaceMocks = vi.hoisted(() => ({
  getDriverMobilityWorkspace: vi.fn(),
  getMerchantChannelWorkspace: vi.fn(),
  getPhoneOrderingWorkspace: vi.fn(),
  getServiceRecoveryWorkspace: vi.fn(),
  getTablesideWorkspace: vi.fn(),
  getWhiteLabelAppsWorkspace: vi.fn(),
  getAnalyticsSummary: vi.fn(),
  getDriverStats: vi.fn(),
  getMarketplaceOverview: vi.fn(),
  getOrderStats: vi.fn(),
}));

const dbMocks = vi.hoisted(() => ({
  getFundsReconciliationSnapshot: vi.fn(),
}));

const longcatVoiceMocks = vi.hoisted(() => ({
  appendLongCatMessagingTurn: vi.fn(),
  appendLongCatVoiceTurn: vi.fn(),
  getLongCatCustomerMemory: vi.fn(),
  startLongCatMessagingSession: vi.fn(),
  startLongCatVoiceSession: vi.fn(),
}));

const longcatActionMocks = vi.hoisted(() => ({
  executeLongCatAction: vi.fn(),
}));

const localCommerceMocks = vi.hoisted(() => ({
  buildLocalCommerceLogisticsControlTower: vi.fn(),
  buildLocalCommerceSuperGatewayWorkspace: vi.fn(),
  planLocalCommerceConciergeIntent: vi.fn(),
}));

const supplyChainMocks = vi.hoisted(() => ({
  applyLoyaltyIntervention: vi.fn(),
  executeMerchantGrowthCampaign: vi.fn(),
  getSupplyChainGrowthControl: vi.fn(),
  queueReplenishmentWorkflow: vi.fn(),
}));

vi.mock("../server/lib/lakehouse", () => lakehouseMocks);
vi.mock("../server/lib/platformWorkspaces", () => workspaceMocks);
vi.mock("../server/db", () => dbMocks);
vi.mock("../server/_core/longcatVoice", () => longcatVoiceMocks);
vi.mock("../server/_core/longcatActions", () => longcatActionMocks);
vi.mock("../server/_core/localCommerceSuperGateway", () => localCommerceMocks);
vi.mock("../server/_core/supplyChainCommandCenter", () => supplyChainMocks);
vi.mock("../server/_core/systemRouter", async () => {
  const { router, publicProcedure } = await import("../server/_core/trpc");
  return {
    systemRouter: router({
      ping: publicProcedure.query(() => ({ ok: true })),
    }),
  };
});

import { appRouter } from "../server/routers";

function createContext(user: {
  id: number;
  name: string;
  email?: string | null;
  role?: string | null;
  openId?: string | null;
  tenantId?: string | null;
  scopes?: string[];
} | null) {
  if (!user) {
    return {
      req: new IncomingMessage(null as never),
      res: new ServerResponse({} as never),
      user: null,
    };
  }

  const normalizedRole = `${user.role ?? "viewer"}`.trim().toLowerCase();
  const defaultScopes = normalizedRole === "admin"
    ? ["platform:read", "platform:write", "analytics:read", "analytics:write"]
    : ["operator", "ops"].includes(normalizedRole)
      ? ["platform:read", "platform:write", "analytics:read"]
      : ["platform:read", "analytics:read"];

  return {
    req: new IncomingMessage(null as never),
    res: new ServerResponse({} as never),
    user: {
      ...user,
      scopes: user.scopes ?? defaultScopes,
    },
  };
}

describe("SwitchOS platform scenario workflows", () => {
  beforeEach(() => {
    vi.resetAllMocks();

    lakehouseMocks.syncLakehouseFromPostgres.mockResolvedValue(undefined);
    lakehouseMocks.getLakehouseAnalyticsSummary.mockResolvedValue({ source: "lakehouse", orders: 12 });
    lakehouseMocks.getLakehouseOrderStats.mockResolvedValue({ total: 12, completed: 10 });
    lakehouseMocks.getLakehouseDriverStats.mockResolvedValue({ total: 6, online: 4 });
    lakehouseMocks.getLakehouseMarketplaceOverview.mockResolvedValue({ open_orders: 3, hotspots: [] });

    workspaceMocks.getAnalyticsSummary.mockResolvedValue({ source: "workspace-fallback", orders: 7 });
    workspaceMocks.getOrderStats.mockResolvedValue({ total: 7, completed: 5 });
    workspaceMocks.getDriverStats.mockResolvedValue({ total: 4, online: 2 });
    workspaceMocks.getMarketplaceOverview.mockResolvedValue({ open_orders: 2, hotspots: [] });
    workspaceMocks.getDriverMobilityWorkspace.mockResolvedValue({ kpis: { openOrders: 5 } });
    workspaceMocks.getMerchantChannelWorkspace.mockResolvedValue({ merchants: [{ id: 101 }] });
    workspaceMocks.getPhoneOrderingWorkspace.mockResolvedValue({ calls: [{ id: 11 }] });
    workspaceMocks.getServiceRecoveryWorkspace.mockResolvedValue({ incidents: [{ id: 88 }] });
    workspaceMocks.getTablesideWorkspace.mockResolvedValue({ venues: [{ id: 22 }] });
    workspaceMocks.getWhiteLabelAppsWorkspace.mockResolvedValue({ apps: [{ id: 33 }] });

    dbMocks.getFundsReconciliationSnapshot.mockResolvedValue({ matched: 14, pending: 2, exceptions: [] });

    localCommerceMocks.buildLocalCommerceSuperGatewayWorkspace.mockResolvedValue({ city: "Lagos", queues: [{ id: "north" }] });
    localCommerceMocks.buildLocalCommerceLogisticsControlTower.mockResolvedValue({ city: "Lagos", demandAlerts: [{ zone: "Ikeja" }] });
    localCommerceMocks.planLocalCommerceConciergeIntent.mockResolvedValue({ planId: "plan-1", fulfillmentMode: "hybrid" });

    supplyChainMocks.getSupplyChainGrowthControl.mockResolvedValue({ city: "Lagos", skus: [{ sku: "rice-5kg" }] });
    supplyChainMocks.queueReplenishmentWorkflow.mockResolvedValue({ workflowId: "repl-1", status: "queued" });
    supplyChainMocks.applyLoyaltyIntervention.mockResolvedValue({ status: "applied", points: 400 });
    supplyChainMocks.executeMerchantGrowthCampaign.mockResolvedValue({ status: "sent", audienceSize: 1 });

    longcatVoiceMocks.getLongCatCustomerMemory.mockResolvedValue({ customerPhone: "+2348000000000", preferences: ["low_sodium"] });
    longcatVoiceMocks.startLongCatVoiceSession.mockResolvedValue({ sessionId: "voice-1", status: "started" });
    longcatVoiceMocks.startLongCatMessagingSession.mockResolvedValue({ sessionId: "msg-1", status: "started" });
    longcatVoiceMocks.appendLongCatVoiceTurn.mockResolvedValue({ sessionId: "voice-1", turns: 2 });
    longcatVoiceMocks.appendLongCatMessagingTurn.mockResolvedValue({ sessionId: "msg-1", turns: 3, dispatched: true });
    longcatActionMocks.executeLongCatAction.mockResolvedValue({ actionId: "act-1", status: "completed" });
  });

  it("returns the authenticated operator identity", async () => {
    const caller = appRouter.createCaller(createContext({ id: 1, name: "Ops", email: "ops@switchos.local", role: "admin" }));
    await expect(caller.auth.me()).resolves.toMatchObject({ email: "ops@switchos.local", role: "admin" });
  });

  it("rejects protected workflows without an authenticated operator", async () => {
    const caller = appRouter.createCaller(createContext(null));
    await expect(caller.analytics.summary()).rejects.toMatchObject<Partial<TRPCError>>({ code: "UNAUTHORIZED" });
  });

  it("rejects protected workflows for non-operator viewer roles", async () => {
    const caller = appRouter.createCaller(createContext({ id: 2, name: "Viewer", email: "viewer@switchos.local", role: "viewer" }));
    await expect(caller.driverMobility.summary()).rejects.toMatchObject<Partial<TRPCError>>({ code: "FORBIDDEN" });
  });

  it("rejects analytics workflows for operators missing analytics scope", async () => {
    const caller = appRouter.createCaller(
      createContext({
        id: 21,
        name: "Scoped Operator",
        email: "scoped-ops@switchos.local",
        role: "operator",
        scopes: ["platform:read"],
      }),
    );
    await expect(caller.analytics.summary()).rejects.toMatchObject<Partial<TRPCError>>({ code: "FORBIDDEN" });
  });

  it("rejects workspace workflows for operators missing platform read scope", async () => {
    const caller = appRouter.createCaller(
      createContext({
        id: 22,
        name: "Analytics Only",
        email: "analytics-only@switchos.local",
        role: "operator",
        scopes: ["analytics:read"],
      }),
    );
    await expect(caller.merchantChannels.workspace()).rejects.toMatchObject<Partial<TRPCError>>({ code: "FORBIDDEN" });
  });

  it("serves analytics from the lakehouse-backed path when synchronization succeeds", async () => {
    const caller = appRouter.createCaller(createContext({ id: 3, name: "Ops", email: "ops@switchos.local", role: "operator" }));
    await expect(caller.analytics.summary()).resolves.toEqual({ source: "lakehouse", orders: 12 });
    await expect(caller.analytics.orderStats()).resolves.toEqual({ total: 12, completed: 10 });
    await expect(caller.analytics.driverStats()).resolves.toEqual({ total: 6, online: 4 });
    await expect(caller.analytics.marketplaceOverview()).resolves.toEqual({ open_orders: 3, hotspots: [] });
    await expect(caller.analytics.fundsReconciliation()).resolves.toEqual({ matched: 14, pending: 2, exceptions: [] });
    expect(lakehouseMocks.syncLakehouseFromPostgres).toHaveBeenCalledTimes(4);
  });

  it("falls back to persisted workspace analytics when the lakehouse sync path fails", async () => {
    lakehouseMocks.syncLakehouseFromPostgres.mockRejectedValue(new Error("lakehouse unavailable"));
    const caller = appRouter.createCaller(createContext({ id: 4, name: "Ops", email: "ops@switchos.local", role: "admin" }));
    await expect(caller.analytics.summary()).resolves.toEqual({ source: "workspace-fallback", orders: 7 });
    await expect(caller.analytics.orderStats()).resolves.toEqual({ total: 7, completed: 5 });
    await expect(caller.analytics.driverStats()).resolves.toEqual({ total: 4, online: 2 });
    await expect(caller.analytics.marketplaceOverview()).resolves.toEqual({ open_orders: 2, hotspots: [] });
  });

  it("returns the core stakeholder workspaces for authenticated operators", async () => {
    const caller = appRouter.createCaller(createContext({ id: 5, name: "Merchant Ops", email: "merchant@switchos.local", role: "operator" }));
    await expect(caller.merchantChannels.workspace()).resolves.toEqual({ merchants: [{ id: 101 }] });
    await expect(caller.phoneOrdering.workspace()).resolves.toEqual({ calls: [{ id: 11 }] });
    await expect(caller.serviceRecovery.workspace()).resolves.toEqual({ incidents: [{ id: 88 }] });
    await expect(caller.tablesideOrdering.summary()).resolves.toEqual({ venues: [{ id: 22 }] });
    await expect(caller.whiteLabelApps.summary()).resolves.toEqual({ apps: [{ id: 33 }] });
    await expect(caller.driverMobility.summary({ limit: 10 })).resolves.toEqual({ kpis: { openOrders: 5 } });
    expect(workspaceMocks.getDriverMobilityWorkspace).toHaveBeenCalledWith(10);
  });

  it("returns the local commerce control and planning surfaces for authenticated operators", async () => {
    const caller = appRouter.createCaller(createContext({ id: 6, name: "City Ops", email: "city@switchos.local", role: "operator" }));
    await expect(caller.localCommerceSuperGateway.workspace()).resolves.toEqual({ city: "Lagos", queues: [{ id: "north" }] });
    await expect(caller.localCommerceSuperGateway.logisticsControlTower({ city: "Lagos", forceRefresh: true })).resolves.toEqual({ city: "Lagos", demandAlerts: [{ zone: "Ikeja" }] });
    await expect(caller.localCommerceSuperGateway.supplyChainGrowthControl({ city: "Lagos" })).resolves.toEqual({ city: "Lagos", skus: [{ sku: "rice-5kg" }] });
    await expect(caller.localCommerceSuperGateway.plan({
      city: "Lagos",
      request: "Plan tonight's grocery fulfillment",
      basket: [{ sku: "rice-5kg", quantity: 2 }],
    })).resolves.toEqual({ planId: "plan-1", fulfillmentMode: "hybrid" });
  });

  it("executes replenishment, loyalty, and merchant growth actions for operators", async () => {
    const caller = appRouter.createCaller(createContext({ id: 7, name: "Growth Ops", email: "growth@switchos.local", role: "operator" }));
    await expect(caller.localCommerceSuperGateway.queueReplenishment({
      city: "Lagos",
      skus: [{
        sku: "rice-5kg",
        warehouseId: 7,
        warehouseLabel: "Ikeja DC",
        currentAvailableUnits: 10,
        forecastUnits: 50,
        recommendedRestockUnits: 40,
        safetyStockUnits: 15,
        stockoutRisk: "high",
        supplier: {
          supplierId: "sup-1",
          supplierName: "Staples Supply",
          leadTimeHours: 24,
          fillRate: 0.97,
          spoilageRisk: 0.05,
          reliabilityBand: "trusted",
        },
      }],
    })).resolves.toEqual({ workflowId: "repl-1", status: "queued" });

    await expect(caller.localCommerceSuperGateway.loyaltyIntervention({
      userId: 91,
      points: 400,
      description: "Service recovery loyalty credit",
    })).resolves.toEqual({ status: "applied", points: 400 });

    await expect(caller.localCommerceSuperGateway.merchantGrowthCampaign({
      campaignName: "Winback",
      campaignType: "sms",
      targetAudience: "inactive_merchants",
      audienceMode: "single_user",
      userId: 91,
      channel: "sms",
      smsTemplate: "We miss you",
    })).resolves.toEqual({ status: "sent", audienceSize: 1 });
  });

  it("supports call-center and messaging workflows for customer support stakeholders", async () => {
    const caller = appRouter.createCaller(createContext({ id: 8, name: "Support Ops", email: "support@switchos.local", role: "ops" }));

    await expect(caller.phoneOrdering.customerMemory({ customerPhone: "+2348000000000" })).resolves.toEqual({
      customerPhone: "+2348000000000",
      preferences: ["low_sodium"],
    });

    await expect(caller.phoneOrdering.startVoiceSession({
      customerPhone: "+2348000000000",
      customerName: "Ada",
      triggerReason: "inbound-order",
    })).resolves.toEqual({ sessionId: "voice-1", status: "started" });

    await expect(caller.phoneOrdering.startMessagingSession({
      customerPhone: "+2348000000000",
      customerName: "Ada",
      triggerReason: "follow-up",
    })).resolves.toEqual({ sessionId: "msg-1", status: "started" });

    await expect(caller.phoneOrdering.appendVoiceTurn({
      sessionId: "2b5b4b77-8026-4d75-a2ee-071ec2fbd63a",
      speaker: "customer",
      utterance: "I want to reorder dinner",
    })).resolves.toEqual({ sessionId: "voice-1", turns: 2 });

    await expect(caller.phoneOrdering.appendMessagingTurn({
      sessionId: "2b5b4b77-8026-4d75-a2ee-071ec2fbd63a",
      speaker: "agent",
      utterance: "Your order is on the way",
      dispatchReply: true,
    })).resolves.toEqual({ sessionId: "msg-1", turns: 3, dispatched: true });

    await expect(caller.phoneOrdering.executeAction({
      customerPhone: "+2348000000000",
      customerName: "Ada",
      merchantName: "SwitchOS Kitchen",
      kind: "service_recovery_credit",
      reason: "Late order apology",
      compensation: {
        amount: 15,
        currency: "USD",
        incidentType: "delay",
      },
    })).resolves.toEqual({ actionId: "act-1", status: "completed" });
  });
});
