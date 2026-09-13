import { z } from "zod";

import { router, workspaceReadProcedure } from "./trpc";
import {
  getVerticalComplianceSummary,
  listCompliancePacks,
} from "./compliancePacks";

export const compliancePacksRouter = router({
  list: workspaceReadProcedure
    .input(
      z
        .object({
          vertical: z.string().trim().min(1).max(100).optional(),
        })
        .optional(),
    )
    .query(({ input }) => listCompliancePacks(input?.vertical)),

  summary: workspaceReadProcedure.query(() => getVerticalComplianceSummary()),
});
