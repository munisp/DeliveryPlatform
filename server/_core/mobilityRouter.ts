import { z } from "zod";

import { router, workspaceReadProcedure } from "./trpc";
import {
  getBusinessTravelSummary,
  getDriverMobilitySummary,
  getFreightSummary,
  getHealthcareTransportSummary,
  getMobilityOverviewSummary,
  getRiderAppSummary,
} from "./mobilityQueries";

const limitInput = z
  .object({ limit: z.number().int().min(1).max(50).optional() })
  .optional();

export const mobilityRouter = router({
  overview: workspaceReadProcedure
    .input(limitInput)
    .query(({ input }) => getMobilityOverviewSummary(input?.limit)),
  riderApp: workspaceReadProcedure
    .input(limitInput)
    .query(({ input }) => getRiderAppSummary(input?.limit)),
  driverMobility: workspaceReadProcedure
    .input(limitInput)
    .query(({ input }) => getDriverMobilitySummary(input?.limit)),
  businessTravel: workspaceReadProcedure
    .input(limitInput)
    .query(({ input }) => getBusinessTravelSummary(input?.limit)),
  freight: workspaceReadProcedure
    .input(limitInput)
    .query(({ input }) => getFreightSummary(input?.limit)),
  healthcare: workspaceReadProcedure
    .input(limitInput)
    .query(({ input }) => getHealthcareTransportSummary(input?.limit)),
});
