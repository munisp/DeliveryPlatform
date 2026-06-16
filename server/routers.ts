import { z } from "zod";
import { publicProcedure, protectedProcedure, router } from "./_core/trpc";
import { systemRouter } from "./_core/systemRouter";
import {
  getAnalyticsSummary,
  getDriverMobilityWorkspace,
  getDriverStats,
  getMarketplaceOverview,
  getMerchantChannelWorkspace,
  getOrderStats,
  getPhoneOrderingWorkspace,
  getServiceRecoveryWorkspace,
  getTablesideWorkspace,
  getWhiteLabelAppsWorkspace,
} from "./lib/platformWorkspaces";

const listInput = z.object({ limit: z.number().min(1).max(25).optional() }).optional();

export const appRouter = router({
  system: systemRouter,

  auth: router({
    me: publicProcedure.query(({ ctx }) => ctx.user),
  }),

  analytics: router({
    summary: protectedProcedure.query(() => getAnalyticsSummary()),
    orderStats: protectedProcedure.query(() => getOrderStats()),
    driverStats: protectedProcedure.query(() => getDriverStats()),
    marketplaceOverview: protectedProcedure.query(() => getMarketplaceOverview()),
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
