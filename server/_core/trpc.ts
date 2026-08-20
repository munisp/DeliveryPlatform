import { initTRPC, TRPCError } from "@trpc/server";
import { IncomingMessage, ServerResponse } from "http";
import superjson from "superjson";
import { UNAUTHED_ERR_MSG } from "../../shared/const";
import { ENV } from "./env";
import { checkPolicy } from "./policy";

export type SessionUser = {
  id: number;
  name: string;
  email?: string | null;
  role?: string | null;
  openId?: string | null;
  tenantId?: string | null;
  scopes?: string[];
  authenticationMethods?: string[];
  assuranceLevel?: string | null;
  mfaAuthenticated?: boolean;
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

const OPERATOR_ROLES = new Set(["admin", "operator", "ops"]);

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

const requireOperator = t.middleware(({ ctx, next }) => {
  if (!ctx.user) {
    throw new TRPCError({
      code: "UNAUTHORIZED",
      message: UNAUTHED_ERR_MSG,
    });
  }

  const normalizedRole = `${ctx.user.role ?? ""}`.trim().toLowerCase();
  if (!OPERATOR_ROLES.has(normalizedRole)) {
    throw new TRPCError({
      code: "FORBIDDEN",
      message: "OPERATOR_ROLE_REQUIRED",
    });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

function requirePolicy(
  permission: "read_platform" | "write_platform" | "read_analytics" | "write_analytics" | "read" | "operate" | "analytics",
  resourceType: "tenant" | "workspace",
  resourceResolver?: (ctx: TrpcContext) => string,
) {
  return t.middleware(async ({ ctx, next }) => {
    if (!ctx.user) {
      throw new TRPCError({
        code: "UNAUTHORIZED",
        message: UNAUTHED_ERR_MSG,
      });
    }

    const privilegedPermission = permission === "write_platform" || permission === "write_analytics" || permission === "operate";
    if (ENV.requireMfaForPrivilegedActions && privilegedPermission && !ctx.user.mfaAuthenticated) {
      throw new TRPCError({
        code: "FORBIDDEN",
        message: "MFA_REQUIRED_FOR_PRIVILEGED_ACTION",
      });
    }

    const resourceId = resourceResolver?.(ctx) ?? (ctx.user.tenantId || "switchos-core");

    try {
      const allowed = await checkPolicy({
        subject: ctx.user,
        permission,
        resource: {
          type: resourceType,
          id: resourceId,
        },
      });

      if (!allowed) {
        throw new TRPCError({
          code: "FORBIDDEN",
          message: `POLICY_DENIED:${permission}`,
        });
      }
    } catch (error) {
      if (error instanceof TRPCError) {
        throw error;
      }
      throw new TRPCError({
        code: "INTERNAL_SERVER_ERROR",
        message: `POLICY_CHECK_FAILED:${permission}`,
        cause: error,
      });
    }

    return next({
      ctx: {
        ...ctx,
        user: ctx.user,
      },
    });
  });
}

export const protectedProcedure = t.procedure.use(requireUser).use(requireOperator);
export const platformReadProcedure = protectedProcedure.use(requirePolicy("read_platform", "tenant"));
export const analyticsReadProcedure = protectedProcedure.use(requirePolicy("read_analytics", "tenant"));
export const workspaceReadProcedure = protectedProcedure.use(requirePolicy("read", "workspace", () => "switchos-operator-workspaces"));
