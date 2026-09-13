import { z } from "zod";
import { TRPCError } from "@trpc/server";

import { router, workspaceReadProcedure } from "./trpc";
import {
  getCheckoutSummary,
  getConsumerMarketplaceSummary,
  getCourierHubSummary,
  getCourierTripRadarSummary,
  getExperimentConsoleSummary,
  getMerchantAdsSummary,
  getMerchantHubSummary,
  getTrustConsoleSummary,
} from "../db";

const listInput = z
  .object({ limit: z.number().min(1).max(25).optional() })
  .optional();

async function requireConsoleData<T>(
  consoleName: string,
  loader: () => Promise<T>,
) {
  try {
    return await loader();
  } catch (error) {
    console.warn(`[SwitchOS] ${consoleName} console unavailable:`, error);
    throw new TRPCError({
      code: "SERVICE_UNAVAILABLE",
      message: `${consoleName.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_DATA_UNAVAILABLE`,
      cause: error,
    });
  }
}

export const consolesRouter = router({
  merchantHub: workspaceReadProcedure
    .input(listInput)
    .query(({ input }) =>
      requireConsoleData("merchant_hub", () =>
        getMerchantHubSummary(input?.limit),
      ),
    ),

  checkoutSummary: workspaceReadProcedure
    .input(listInput)
    .query(({ input }) =>
      requireConsoleData("checkout", () => getCheckoutSummary(input?.limit)),
    ),

  courierTripRadar: workspaceReadProcedure
    .input(listInput)
    .query(({ input }) =>
      requireConsoleData("courier_trip_radar", () =>
        getCourierTripRadarSummary(input?.limit),
      ),
    ),

  trustConsole: workspaceReadProcedure
    .input(listInput)
    .query(({ input }) =>
      requireConsoleData("trust_console", () =>
        getTrustConsoleSummary(input?.limit),
      ),
    ),

  experimentConsole: workspaceReadProcedure.query(() =>
    requireConsoleData("experiment_console", () =>
      getExperimentConsoleSummary(),
    ),
  ),

  merchantAds: workspaceReadProcedure
    .input(listInput)
    .query(({ input }) =>
      requireConsoleData("merchant_ads", () =>
        getMerchantAdsSummary(input?.limit),
      ),
    ),

  consumerMarketplace: workspaceReadProcedure
    .input(listInput)
    .query(({ input }) =>
      requireConsoleData("consumer_marketplace", () =>
        getConsumerMarketplaceSummary(input?.limit),
      ),
    ),
});
