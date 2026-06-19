import { z } from "zod";

import { analyticsReadProcedure, publicProcedure, router, workspaceReadProcedure } from "./_core/trpc";
import { systemRouter } from "./_core/systemRouter";
import {
  getDriverMobilityWorkspace,
  getMerchantChannelWorkspace,
  getPhoneOrderingWorkspace,
  getServiceRecoveryWorkspace,
  getTablesideWorkspace,
  getWhiteLabelAppsWorkspace,
  getAnalyticsSummary as getWorkspaceAnalyticsSummary,
  getDriverStats as getWorkspaceDriverStats,
  getMarketplaceOverview as getWorkspaceMarketplaceOverview,
  getOrderStats as getWorkspaceOrderStats,
} from "./lib/platformWorkspaces";
import {
  getLakehouseAnalyticsSummary,
  getLakehouseDriverStats,
  getLakehouseMarketplaceOverview,
  getLakehouseOrderStats,
  syncLakehouseFromPostgres,
} from "./lib/lakehouse";

const listInput = z.object({ limit: z.number().min(1).max(25).optional() }).optional();

async function withLakehouseFallback<T>(loader: () => Promise<T>, fallback: () => T | Promise<T>) {
  try {
    await syncLakehouseFromPostgres();
    return await loader();
  } catch (error) {
    console.warn("[SwitchOS] Falling back from lakehouse-backed analytics:", error);
    return fallback();
  }
}

export const appRouter = router({
  system: systemRouter,

  auth: router({
    me: publicProcedure.query(({ ctx }) => ctx.user),
  }),

  analytics: router({
    summary: analyticsReadProcedure.query(() => withLakehouseFallback(() => getLakehouseAnalyticsSummary(), () => getWorkspaceAnalyticsSummary())),
    orderStats: analyticsReadProcedure.query(() => withLakehouseFallback(() => getLakehouseOrderStats(), () => getWorkspaceOrderStats())),
    driverStats: analyticsReadProcedure.query(() => withLakehouseFallback(() => getLakehouseDriverStats(), () => getWorkspaceDriverStats())),
    marketplaceOverview: analyticsReadProcedure.query(() => withLakehouseFallback(() => getLakehouseMarketplaceOverview(), () => getWorkspaceMarketplaceOverview())),
  }),

  driverMobility: router({
    summary: workspaceReadProcedure.input(listInput).query(({ input }) => getDriverMobilityWorkspace(input?.limit)),
  }),

  tablesideOrdering: router({
    summary: workspaceReadProcedure.input(listInput).query(({ input }) => getTablesideWorkspace(input?.limit)),
  }),

  whiteLabelApps: router({
    summary: workspaceReadProcedure.input(listInput).query(({ input }) => getWhiteLabelAppsWorkspace(input?.limit)),
  }),

  merchantChannels: router({
    workspace: workspaceReadProcedure.query(() => getMerchantChannelWorkspace()),
  }),

  serviceRecovery: router({
    workspace: workspaceReadProcedure.query(() => getServiceRecoveryWorkspace()),
  }),

  phoneOrdering: router({
    workspace: workspaceReadProcedure.query(() => getPhoneOrderingWorkspace()),
  }),
});

export type AppRouter = typeof appRouter;
