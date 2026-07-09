import { z } from "zod";

import { COOKIE_NAME } from "../shared/const.js";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { runSmartSearch } from "./smart-search";

const searchRecordSchema = z.object({
  id: z.string(),
  title: z.string(),
  subtitle: z.string(),
  severity: z.enum(["stable", "watch", "critical"]),
  region: z.string().optional(),
  note: z.string().optional(),
  actionHint: z.string().optional(),
});

export const appRouter = router({
  // if you need to use socket.io, read and register route in server/_core/index.ts, all api should start with '/api/' so that the gateway can route correctly
  system: systemRouter,
  auth: router({
    me: publicProcedure.query((opts) => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),
  smartSearch: router({
    query: publicProcedure
      .input(
        z.object({
          query: z.string().min(1).max(280),
          region: z.string().optional(),
          limit: z.number().int().min(1).max(10).optional(),
          inventory: z.array(searchRecordSchema).max(80),
          dispatch: z.array(searchRecordSchema).max(80),
        }),
      )
      .mutation(async ({ input }) => {
        const results = await runSmartSearch(input);
        return { results } as const;
      }),
  }),

  // TODO: add feature routers here, e.g.
  // todo: router({
  //   list: protectedProcedure.query(({ ctx }) =>
  //     db.getUserTodos(ctx.user.id)
  //   ),
  // }),
});

export type AppRouter = typeof appRouter;
