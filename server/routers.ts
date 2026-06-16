import { z } from "zod";

import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
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
    summary: protectedProcedure.query(() => withLakehouseFallback(() => getLakehouseAnalyticsSummary(), () => getWorkspaceAnalyticsSummary())),
    orderStats: protectedProcedure.query(() => withLakehouseFallback(() => getLakehouseOrderStats(), () => getWorkspaceOrderStats())),
    driverStats: protectedProcedure.query(() => withLakehouseFallback(() => getLakehouseDriverStats(), () => getWorkspaceDriverStats())),
    marketplaceOverview: protectedProcedure.query(() => withLakehouseFallback(() => getLakehouseMarketplaceOverview(), () => getWorkspaceMarketplaceOverview())),
  }),

  driverMobility: router({
    summary: protectedProcedure.input(listInput).query(({ input }) => getDriverMobilityWorkspace(input?.limit)),
  }),

  tablesideOrdering: router({
    summary: protectedProcedure.input(listInput).query(({ input }) => getTablesideWorkspace(input?.limit)),
  }),

  whiteLabelApps: router({
    summary: protectedProcedure.input(listInput).query(({ input }) => getWhiteLabelAppsWorkspace(input?.limit)),
  }),

  merchantChannels: router({
    workspace: protectedProcedure.query(() => getMerchantChannelWorkspace()),
  }),

  serviceRecovery: router({
    workspace: protectedProcedure.query(() => getServiceRecoveryWorkspace()),
  }),

  phoneOrdering: router({
    workspace: protectedProcedure.query(() => getPhoneOrderingWorkspace()),
  }),
});

export type AppRouter = typeof appRouter;
