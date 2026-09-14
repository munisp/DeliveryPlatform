import { initTRPC, TRPCError } from "@trpc/server";
import { IncomingMessage, ServerResponse } from "http";
import superjson from "superjson";
import { UNAUTHED_ERR_MSG } from "../../shared/const";
import { ENV } from "./env";
import { checkPolicy } from "./policy";

export type SessionUser = {
  /**
   * Unified domain subject: the caller's `public.users.id` once the session
   * has passed through the session-load path (unifySessionUser). May be 0
   * on a freshly verified but not-yet-unified external token.
   */
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
  sessionId?: string | null;
  /** public.users.id carried on the signed session token (post-unification). */
  publicUserId?: number | null;
  /** operator_credentials.id for operator-scoped stores and audit/attribution. */
  operatorCredentialId?: number | null;
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

export const authenticatedProcedure = t.procedure.use(requireUser);
export const protectedProcedure = authenticatedProcedure.use(requireOperator);
export const platformReadProcedure = protectedProcedure.use(requirePolicy("read_platform", "tenant"));
export const analyticsReadProcedure = protectedProcedure.use(requirePolicy("read_analytics", "tenant"));
export const workspaceReadProcedure = protectedProcedure.use(requirePolicy("read", "workspace", () => "switchos-operator-workspaces"));

/**
 * Privileged policy keys available to operator-side mutating procedures.
 * Both keys are classified as privileged by requirePolicy, so every
 * operatorMutationProcedure enforces a fresh MFA assertion in addition to
 * the operator-role check and the policy grant.
 */
export type OperatorMutationPolicyKey = "operate" | "write_platform";

/**
 * Tier for operator-side sensitive mutations (vehicle immobilizer/tracker
 * safety controls, rental contract operator transitions, fulfillment/order
 * admin, settlement/payout/finance admin, trust/experiment console actions).
 *
 * Composition: protectedProcedure (authenticated operator role)
 *   + requirePolicy(policyKey) which adds the MFA assertion for privileged
 *     permissions and the Permify/OPA (or scope-fallback) policy grant.
 *
 * - "operate"        -> workspace-scoped operational mutations
 * - "write_platform" -> tenant/platform-wide admin and financial mutations
 */
export function operatorMutationProcedure(policyKey: OperatorMutationPolicyKey) {
  if (policyKey === "write_platform") {
    return protectedProcedure.use(requirePolicy("write_platform", "tenant"));
  }
  return protectedProcedure.use(
    requirePolicy("operate", "workspace", () => "switchos-operator-workspaces"),
  );
}
