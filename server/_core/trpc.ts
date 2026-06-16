import type { IncomingMessage, ServerResponse } from "http";
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import { UNAUTHED_ERR_MSG } from "../../shared/const";

export type SessionUser = {
  id: number;
  name: string;
  email?: string | null;
  role?: string | null;
  openId?: string | null;
};

export type TrpcContext = {
  req: IncomingMessage & { headers: IncomingMessage["headers"] };
  res: ServerResponse;
  user: SessionUser | null;
};

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: UNAUTHED_ERR_MSG,
    });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireUser);
