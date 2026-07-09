import { z } from "zod";

import { analyticsReadProcedure, protectedProcedure, publicProcedure, router, workspaceReadProcedure } from "./_core/trpc";
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
import { getFundsReconciliationSnapshot } from "./db";
import { appendLongCatVoiceTurn, getLongCatCustomerMemory, startLongCatVoiceSession } from "./_core/longcatVoice";

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
    fundsReconciliation: analyticsReadProcedure.query(async () => getFundsReconciliationSnapshot()),
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
    customerMemory: workspaceReadProcedure
      .input(z.object({
        userId: z.number().int().positive().optional(),
        customerPhone: z.string().trim().min(5).max(64).optional(),
        customerName: z.string().trim().min(1).max(255).optional(),
        accessibilityFlags: z.array(z.string().trim().min(1).max(64)).max(8).optional(),
      }).optional())
      .query(({ input }) => getLongCatCustomerMemory({
        userId: input?.userId ?? null,
        customerPhone: input?.customerPhone ?? null,
        customerName: input?.customerName ?? null,
        accessibilityFlags: input?.accessibilityFlags ?? [],
      })),
    startVoiceSession: protectedProcedure
      .input(z.object({
        userId: z.number().int().positive().optional(),
        customerPhone: z.string().trim().min(5).max(64).optional(),
        customerName: z.string().trim().min(1).max(255).optional(),
        voiceChannel: z.string().trim().min(2).max(64).optional(),
        accessibilityFlags: z.array(z.string().trim().min(1).max(64)).max(8).optional(),
        idempotencyKey: z.string().trim().min(4).max(255).optional(),
        triggerReason: z.string().trim().min(2).max(255).optional(),
      }))
      .mutation(({ input }) => startLongCatVoiceSession({
        userId: input.userId ?? null,
        customerPhone: input.customerPhone ?? null,
        customerName: input.customerName ?? null,
        voiceChannel: input.voiceChannel ?? null,
        accessibilityFlags: input.accessibilityFlags ?? [],
        idempotencyKey: input.idempotencyKey ?? null,
        triggerReason: input.triggerReason ?? null,
      })),
    appendVoiceTurn: protectedProcedure
      .input(z.object({
        sessionId: z.string().uuid(),
        speaker: z.enum(["customer", "agent", "system"]),
        utterance: z.string().trim().min(1).max(4_000),
        channel: z.string().trim().min(2).max(64).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      }))
      .mutation(({ input }) => appendLongCatVoiceTurn({
        sessionId: input.sessionId,
        speaker: input.speaker,
        utterance: input.utterance,
        channel: input.channel,
        metadata: input.metadata,
      })),
  }),
});

export type AppRouter = typeof appRouter;
