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

vi.mock("../server/lib/lakehouse", () => lakehouseMocks);
vi.mock("../server/lib/platformWorkspaces", () => workspaceMocks);
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
    expect(lakehouseMocks.syncLakehouseFromPostgres).toHaveBeenCalledTimes(1);
    expect(lakehouseMocks.getLakehouseAnalyticsSummary).toHaveBeenCalledTimes(1);
  });

  it("falls back to persisted workspace analytics when the lakehouse sync path fails", async () => {
    lakehouseMocks.syncLakehouseFromPostgres.mockRejectedValueOnce(new Error("lakehouse unavailable"));
    const caller = appRouter.createCaller(createContext({ id: 4, name: "Ops", email: "ops@switchos.local", role: "admin" }));
    await expect(caller.analytics.summary()).resolves.toEqual({ source: "workspace-fallback", orders: 7 });
    expect(workspaceMocks.getAnalyticsSummary).toHaveBeenCalledTimes(1);
  });

  it("returns the merchant channel workspace for authenticated operators", async () => {
    const caller = appRouter.createCaller(createContext({ id: 5, name: "Merchant Ops", email: "merchant@switchos.local", role: "operator" }));
    await expect(caller.merchantChannels.workspace()).resolves.toEqual({ merchants: [{ id: 101 }] });
  });

  it("returns the phone ordering workspace for authenticated operators", async () => {
    const caller = appRouter.createCaller(createContext({ id: 6, name: "Call Center", email: "call@switchos.local", role: "ops" }));
    await expect(caller.phoneOrdering.workspace()).resolves.toEqual({ calls: [{ id: 11 }] });
  });

  it("returns the service recovery workspace for authenticated operators", async () => {
    const caller = appRouter.createCaller(createContext({ id: 7, name: "Recovery", email: "recovery@switchos.local", role: "admin" }));
    await expect(caller.serviceRecovery.workspace()).resolves.toEqual({ incidents: [{ id: 88 }] });
  });

  it("returns the tableside and white-label workspaces for authenticated operators", async () => {
    const caller = appRouter.createCaller(createContext({ id: 8, name: "Growth Ops", email: "growth@switchos.local", role: "operator" }));
    await expect(caller.tablesideOrdering.summary()).resolves.toEqual({ venues: [{ id: 22 }] });
    await expect(caller.whiteLabelApps.summary()).resolves.toEqual({ apps: [{ id: 33 }] });
  });

  it("returns the driver mobility workspace with a caller-provided limit", async () => {
    const caller = appRouter.createCaller(createContext({ id: 9, name: "Dispatch", email: "dispatch@switchos.local", role: "operator" }));
    await expect(caller.driverMobility.summary({ limit: 10 })).resolves.toEqual({ kpis: { openOrders: 5 } });
    expect(workspaceMocks.getDriverMobilityWorkspace).toHaveBeenCalledWith(10);
  });
});
