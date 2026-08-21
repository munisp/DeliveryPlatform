import cookieParser from "cookie-parser";
import express from "express";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { randomUUID } from "crypto";

import { appRouter } from "../routers";
import { appendLongCatTelephonyTranscript, closeLongCatTelephonyIngressSession, startLongCatTelephonyIngressSession } from "./longcatVoice";
import { COOKIE_NAME } from "../../shared/const";
import { ENV } from "./env";
import { getCookieOptions } from "./cookies";
import {
  buildOidcAuthorizationUrl,
  createSessionToken,
  exchangeAuthorizationCode,
  getOidcDiscoveryDocument,
  getSessionUserFromRequest,
  resolveUserFromExternalTokens,
} from "./auth";
import {
  acceptInvitation,
  applyOrganizationSharedBrandingPreset,
  applyTenantBrandingPreset,
  beginSignup,
  bulkChangeMemberRoles,
  bulkResendInvitations,
  bulkRevokeInvitations,
  confirmEmailVerification,
  confirmPasswordReset,
  createInvitation,
  createOrganizationAndTenant,
  deleteTenantBrandingPreset,
  ensureAccountLifecycleStore,
  exportTenantAdminNotificationDeliveryHistoryCsv,
  exportInvitationActivityCsv,
  getTenantAdminNotificationDeliveryRetention,
  listTenantAdminNotificationDeliveryHistory,
  getTenantAdminNotificationPreferences,
  getTenantBranding,
  getOnboardingState,
  listInvitationStatuses,
  listOrganizationSharedBrandingPresets,
  listTenantMembers,
  listTenantBrandingPresetOwnershipAudit,
  listTenantBrandingPresets,
  requestPasswordReset,
  resendInvitation,
  resendVerification,
  revokeInvitation,
  saveTenantBrandingPreset,
  setTenantBrandingPresetOrganizationSharing,
  transferTenantBrandingPresetOwnership,
  updateTenantAdminNotificationDeliveryRetention,
  updateTenantAdminNotificationPreferences,
  updateTenantBranding,
} from "./accountLifecycleStore";
import { authenticateOperator, createOperatorSecuritySession, ensureExternalOperator, ensureOperatorAuthStore, isOperatorSecuritySessionActive, listOperatorSecurityLoginActivity, listOperatorSecuritySessions, revokeOperatorSecuritySession, revokeOtherOperatorSecuritySessions } from "./operatorAuthStore";
import { recordOperationalEvent } from "./operationalEvents";
import { consumeRateLimit, getRateLimiterStatus } from "./rateLimiter";
import { getFinancialAdminSnapshot } from "../db";
import type { SessionUser } from "./trpc";

const OIDC_STATE_COOKIE = "switchos_oidc_state";
const OIDC_NONCE_COOKIE = "switchos_oidc_nonce";
const OIDC_VERIFIER_COOKIE = "switchos_oidc_verifier";
const OIDC_RETURN_TO_COOKIE = "switchos_oidc_return_to";

type AppRequest = express.Request & { user: SessionUser | null };

const app = express();
// The application is reachable only through Caddy and APISIX in promoted deployments.
// Trust exactly that two-proxy chain so request throttles key on the original client IP.
app.set("trust proxy", 2);
const allowedOrigins = ENV.allowedOrigins
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function readOrigin(originHeader?: string) {
  if (!originHeader) return "";
  return originHeader.trim();
}

function isAllowedOrigin(origin: string) {
  if (!origin) return false;
  return allowedOrigins.includes(origin);
}

function getRequestOrigin(req: express.Request) {
  const forwardedProto = `${req.headers["x-forwarded-proto"] ?? req.protocol ?? "http"}`.split(",")[0]?.trim() || "http";
  const forwardedHost = `${req.headers["x-forwarded-host"] ?? req.get("host") ?? "localhost:3005"}`.split(",")[0]?.trim() || "localhost:3005";
  return `${forwardedProto}://${forwardedHost}`;
}

function sanitizeReturnTo(returnTo: string | undefined) {
  if (!returnTo) return "/dashboard";
  if (!returnTo.startsWith("/") || returnTo.startsWith("//")) return "/dashboard";
  return returnTo;
}

function clearOidcFlowCookies(res: express.Response) {
  const options = { ...getCookieOptions(), maxAge: 0 };
  res.clearCookie(OIDC_STATE_COOKIE, options);
  res.clearCookie(OIDC_NONCE_COOKIE, options);
  res.clearCookie(OIDC_VERIFIER_COOKIE, options);
  res.clearCookie(OIDC_RETURN_TO_COOKIE, options);
}

function setSecurityHeaders(req: express.Request, res: express.Response) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(self)");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "img-src 'self' data: https:",
      "font-src 'self' https://fonts.gstatic.com",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      `connect-src 'self' ${ENV.cspConnectSrc.split(",").join(" ")}`,
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "object-src 'none'",
      "upgrade-insecure-requests",
    ].join("; "),
  );

  const acceptHeader = `${req.headers.accept ?? ""}`;
  if (req.path === "/" || acceptHeader.includes("text/html")) {
    res.setHeader("Cache-Control", ENV.cacheControlIndexHtml);
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
  } else if (req.path.startsWith("/api/")) {
    res.setHeader("Cache-Control", "no-store");
  }
}

function applyCors(req: express.Request, res: express.Response) {
  const origin = readOrigin(req.headers.origin);
  if (origin && isAllowedOrigin(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Vary", "Origin");
  }
}

function requireInternalServiceAccess(req: express.Request, res: express.Response) {
  const provided = `${req.header("X-Internal-Service-Token") ?? ""}`.trim();
  if (!provided || provided !== ENV.internalServiceToken) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

function rateLimit(limit: number): express.RequestHandler {
  return async (req, res, next) => {
    try {
      const key = `${req.ip}:${req.path}`;
      const bucket = await consumeRateLimit(key, limit);
      res.setHeader("X-RateLimit-Limit", String(limit));
      res.setHeader("X-RateLimit-Remaining", String(bucket.remaining));
      res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));
      res.setHeader("X-RateLimit-Backend", bucket.mode);

      if (!bucket.allowed) {
        const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000));
        res.setHeader("Retry-After", String(retryAfterSeconds));
        res.status(429).json({ error: "rate_limit_exceeded", retryAfterSeconds });
        return;
      }

      next();
    } catch (error) {
      console.error("[SwitchOS] Rate limiter failure", error);
      res.status(500).json({ error: "rate_limiter_unavailable" });
    }
  };
}

async function issueOperatorSession(
  req: express.Request,
  res: express.Response,
  operator: { id: number; name: string; email: string; role: string; tenantId: string | null },
  options: { authSource?: "managed" | "oidc" | "development"; mfaAuthenticated?: boolean; assuranceLevel?: string | null } = {},
) {
  const sessionId = randomUUID();
  const mfaAuthenticated = Boolean(options.mfaAuthenticated);
  const token = await createSessionToken({
    sub: String(operator.id),
    name: operator.name,
    email: operator.email,
    role: operator.role,
    openId: ENV.ownerOpenId,
    tenantId: operator.tenantId,
    scopes: operator.role === "viewer"
      ? ["platform:read", "analytics:read"]
      : ["platform:read", "platform:write", "analytics:read"],
    sessionId,
    mfaAuthenticated,
    assuranceLevel: options.assuranceLevel ?? null,
  });

  await createOperatorSecuritySession({
    sessionId,
    operatorId: operator.id,
    authSource: options.authSource ?? "managed",
    mfaAuthenticated,
    assuranceLevel: options.assuranceLevel ?? null,
    userAgent: req.get("user-agent") ?? null,
    clientIp: req.ip,
    expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
  });

  res.cookie(COOKIE_NAME, token, getCookieOptions());
}

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use(cookieParser());

app.use((req, res, next) => {
  res.setHeader("X-Request-Id", randomUUID());
  setSecurityHeaders(req, res);
  applyCors(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

app.use(express.json({ limit: ENV.apiBodyLimit }));
app.use(express.urlencoded({ extended: true, limit: ENV.apiBodyLimit }));

app.get("/api/health", async (req, res) => {
  const discovery = ENV.enableExternalOidc ? await getOidcDiscoveryDocument() : null;
  const rateLimiter = await getRateLimiterStatus();
  await recordOperationalEvent({
    eventType: "system.health.checked",
    route: req.path,
    outcome: "info",
    payload: {
      externalOidcEnabled: ENV.enableExternalOidc,
      rateLimiterMode: rateLimiter.mode,
    },
  });
  res.json({
    ok: true,
    service: "switchos-operator-dashboard",
    timestamp: new Date().toISOString(),
    externalOidcEnabled: ENV.enableExternalOidc,
    oidcIssuer: (discovery?.issuer ?? ENV.oidcIssuerUrl) || null,
    rateLimiter,
  });
});

app.get("/api/auth/config", async (_req, res) => {
  const discovery = ENV.enableExternalOidc ? await getOidcDiscoveryDocument() : null;
  res.status(200).json({
    externalOidcEnabled: ENV.enableExternalOidc,
    oidcIssuer: (discovery?.issuer ?? ENV.oidcIssuerUrl) || null,
    oidcClientId: ENV.oidcClientId || null,
    oidcLogoutUrl: (discovery?.end_session_endpoint ?? ENV.oidcLogoutUrl) || null,
    oidcStartPath: ENV.enableExternalOidc ? "/api/auth/oidc/start" : null,
    fallbackLoginEnabled: !ENV.enableExternalOidc || !ENV.isProduction,
    selfServiceSignupEnabled: ENV.selfServiceSignupEnabled,
  });
});

function lifecycleErrorStatus(error: unknown) {
  const code = error instanceof Error ? error.message : "account_lifecycle_failed";
  if (code === "self_service_signup_disabled") return { status: 404, code };
  if (code === "lifecycle_email_delivery_failed" || code === "notification_dispatcher_not_configured") return { status: 503, code: "email_delivery_unavailable" };
  if (code.startsWith("invalid_or_expired_") || code === "invalid_email") return { status: 400, code };
  if (code.includes("required") || code.includes("already") || code.includes("invalid_") || code.startsWith("password_")) return { status: 400, code };
  return { status: 500, code: "account_lifecycle_failed" };
}

app.post("/api/auth/signup", rateLimit(5), async (req, res) => {
  try {
    const result = await beginSignup({
      email: `${req.body?.email ?? ""}`,
      name: `${req.body?.name ?? ""}`,
      password: `${req.body?.password ?? ""}`,
    });
    await recordOperationalEvent({ eventType: "auth.signup.requested", route: req.path, outcome: "info" });
    res.status(202).json(result);
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    await recordOperationalEvent({ eventType: "auth.signup.requested", route: req.path, outcome: "failure", payload: { code: mapped.code } });
    res.status(mapped.status).json({ error: mapped.code });
  }
});

app.post("/api/auth/email-verification/resend", rateLimit(5), async (req, res) => {
  try {
    await resendVerification(`${req.body?.email ?? ""}`);
  } catch (error) {
    console.warn("[SwitchOS] Verification resend request failed", error);
  }
  // Do not reveal whether an account exists or is already verified.
  res.status(202).json({ accepted: true });
});

app.post("/api/auth/email-verification/confirm", rateLimit(10), async (req, res) => {
  try {
    const operator = await confirmEmailVerification(`${req.body?.token ?? ""}`);
    await issueOperatorSession(req, res, operator);
    await recordOperationalEvent({ eventType: "auth.email_verified", actorId: `${operator.id}`, actorRole: operator.role, route: req.path, outcome: "success" });
    res.status(200).json({ ok: true, user: operator, redirect: "/onboarding" });
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.status).json({ error: mapped.code });
  }
});

app.post("/api/auth/password-reset/request", rateLimit(5), async (req, res) => {
  try {
    await requestPasswordReset(`${req.body?.email ?? ""}`);
  } catch (error) {
    console.warn("[SwitchOS] Password reset request failed", error);
  }
  // Generic completion response prevents account enumeration.
  res.status(202).json({ accepted: true });
});

app.post("/api/auth/password-reset/confirm", rateLimit(10), async (req, res) => {
  try {
    await confirmPasswordReset({ token: `${req.body?.token ?? ""}`, password: `${req.body?.password ?? ""}` });
    await recordOperationalEvent({ eventType: "auth.password_reset", route: req.path, outcome: "success" });
    res.status(200).json({ ok: true, redirect: "/portal" });
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.status).json({ error: mapped.code });
  }
});

app.post("/api/auth/invitations/accept", rateLimit(10), async (req, res) => {
  try {
    const result = await acceptInvitation({
      token: `${req.body?.token ?? ""}`,
      name: `${req.body?.name ?? ""}`,
      password: `${req.body?.password ?? ""}`,
    });
    await issueOperatorSession(req, res, result.operator);
    await recordOperationalEvent({ eventType: "auth.invitation_accepted", actorId: `${result.operator.id}`, actorRole: result.operator.role, tenantId: result.operator.tenantId, route: req.path, outcome: "success" });
    res.status(200).json({ ok: true, user: result.operator, redirect: "/dashboard" });
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.status).json({ error: mapped.code });
  }
});

app.get("/api/auth/oidc/start", rateLimit(20), async (req, res) => {
  if (!ENV.enableExternalOidc) {
    res.status(404).json({ error: "external_oidc_disabled" });
    return;
  }

  try {
    const returnTo = sanitizeReturnTo(typeof req.query.returnTo === "string" ? req.query.returnTo : undefined);
    const origin = getRequestOrigin(req);
    const authorization = await buildOidcAuthorizationUrl(origin, returnTo);
    const transientCookieOptions = {
      ...getCookieOptions(),
      maxAge: 1000 * 60 * 10,
      sameSite: "lax" as const,
    };

    res.cookie(OIDC_STATE_COOKIE, authorization.state, transientCookieOptions);
    res.cookie(OIDC_NONCE_COOKIE, authorization.nonce, transientCookieOptions);
    res.cookie(OIDC_VERIFIER_COOKIE, authorization.verifier, transientCookieOptions);
    res.cookie(OIDC_RETURN_TO_COOKIE, authorization.returnTo, transientCookieOptions);
    await recordOperationalEvent({
      eventType: "auth.oidc.start",
      route: req.path,
      outcome: "info",
      payload: {
        returnTo,
      },
    });
    res.redirect(302, authorization.authorizationUrl);
  } catch (error) {
    console.error("[SwitchOS] Failed to start OIDC login", error);
    await recordOperationalEvent({
      eventType: "auth.oidc.start",
      route: req.path,
      outcome: "failure",
      payload: {
        error: error instanceof Error ? error.message : "unknown_error",
      },
    });
    res.status(500).json({ error: "oidc_start_failed" });
  }
});

app.get("/api/auth/oidc/callback", rateLimit(30), async (req, res) => {
  if (!ENV.enableExternalOidc) {
    res.status(404).json({ error: "external_oidc_disabled" });
    return;
  }

  const state = typeof req.query.state === "string" ? req.query.state : "";
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const storedState = req.cookies?.[OIDC_STATE_COOKIE];
  const storedNonce = req.cookies?.[OIDC_NONCE_COOKIE];
  const storedVerifier = req.cookies?.[OIDC_VERIFIER_COOKIE];
  const returnTo = sanitizeReturnTo(req.cookies?.[OIDC_RETURN_TO_COOKIE]);

  if (!code || !state || !storedState || state !== storedState || !storedNonce || !storedVerifier) {
    clearOidcFlowCookies(res);
    res.status(400).json({ error: "invalid_oidc_callback_state" });
    return;
  }

  try {
    const origin = getRequestOrigin(req);
    const tokens = await exchangeAuthorizationCode(code, storedVerifier, origin);
    const identity = await resolveUserFromExternalTokens(tokens, storedNonce);

    if (!identity?.email) {
      clearOidcFlowCookies(res);
      await recordOperationalEvent({
        eventType: "auth.oidc.callback",
        route: req.path,
        outcome: "failure",
        payload: {
          reason: "identity_missing_email",
        },
      });
      res.status(403).json({ error: "oidc_identity_missing_email" });
      return;
    }

    await ensureAccountLifecycleStore();
    const operator = await ensureExternalOperator({
      email: identity.email,
      name: identity.name,
      tenantId: identity.tenantId,
    });
    await issueOperatorSession(req, res, operator, {
      authSource: "oidc",
      mfaAuthenticated: Boolean(identity.mfaAuthenticated),
      assuranceLevel: identity.assuranceLevel ?? null,
    });
    await recordOperationalEvent({
      eventType: "auth.oidc.callback",
      actorId: `${operator.id}`,
      actorRole: operator.role,
      tenantId: operator.tenantId,
      route: req.path,
      outcome: "success",
      payload: {
        email: operator.email,
      },
    });
    clearOidcFlowCookies(res);
    res.redirect(302, returnTo);
  } catch (error) {
    console.error("[SwitchOS] Failed to complete OIDC callback", error);
    await recordOperationalEvent({
      eventType: "auth.oidc.callback",
      route: req.path,
      outcome: "failure",
      payload: {
        error: error instanceof Error ? error.message : "unknown_error",
      },
    });
    clearOidcFlowCookies(res);
    res.status(500).json({ error: "oidc_callback_failed" });
  }
});

app.post("/api/auth/login", rateLimit(15), async (req, res) => {
  try {
    await ensureOperatorAuthStore();
    const email = `${req.body?.email ?? ""}`.trim().toLowerCase();
    const password = `${req.body?.password ?? ""}`;

    if (!email || !password) {
      res.status(400).json({ error: "email_and_password_required" });
      return;
    }

    const operator = await authenticateOperator(email, password);
    if (!operator) {
      await recordOperationalEvent({
        eventType: "auth.local.login",
        route: req.path,
        outcome: "failure",
        payload: {
          email,
          reason: "invalid_credentials",
        },
      });
      res.status(401).json({ error: "invalid_credentials" });
      return;
    }

    await issueOperatorSession(req, res, operator);
    await recordOperationalEvent({
      eventType: "auth.local.login",
      actorId: `${operator.id}`,
      actorRole: operator.role,
      tenantId: operator.tenantId,
      route: req.path,
      outcome: "success",
      payload: {
        email: operator.email,
      },
    });
    res.status(200).json({ ok: true, user: operator });
  } catch (error) {
    console.error("[SwitchOS] Operator login failed", error);
    await recordOperationalEvent({
      eventType: "auth.local.login",
      route: req.path,
      outcome: "failure",
      payload: {
        error: error instanceof Error ? error.message : "unknown_error",
      },
    });
    res.status(500).json({ error: "login_failed" });
  }
});

app.post("/api/auth/logout", rateLimit(20), async (req, res) => {
  const request = req as AppRequest;
  await recordOperationalEvent({
    eventType: "auth.logout",
    actorId: request.user ? `${request.user.id}` : null,
    actorRole: request.user?.role ?? null,
    tenantId: request.user?.tenantId ?? null,
    route: req.path,
    outcome: "info",
  });
  clearOidcFlowCookies(res);
  res.clearCookie(COOKIE_NAME, getCookieOptions());
  res.status(200).json({ ok: true });
});

app.use(async (req, _res, next) => {
  const request = req as AppRequest;
	try {
		request.user = await getSessionUserFromRequest(req.headers);
		if (request.user?.sessionId && !await isOperatorSecuritySessionActive(request.user.id, request.user.sessionId)) {
			request.user = null;
		}
  } catch (error) {
    console.warn("[SwitchOS] Failed to resolve session user", error);
    request.user = null;
  }
  next();
});

function requireAuthenticatedOperator(req: express.Request, res: express.Response): SessionUser | null {
  const user = (req as AppRequest).user;
  if (!user) {
    res.status(401).json({ error: "authentication_required" });
    return null;
  }
  return user;
}

function requireFinancialAdministrator(req: express.Request, res: express.Response): SessionUser | null {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return null;
  if (!user.mfaAuthenticated) {
    res.status(403).json({ error: "mfa_required_for_privileged_action" });
    return null;
  }
  if (!new Set(["admin", "platform_admin", "super_admin"]).has(`${user.role ?? ""}`.toLowerCase())) {
    res.status(403).json({ error: "financial_admin_required" });
    return null;
  }
  return user;
}

async function dependencyHealth(name: string, baseUrl: string | undefined) {
  const checkedAt = new Date().toISOString();
  if (!baseUrl) return { name, status: "unconfigured" as const, checkedAt, latencyMs: null };
  const startedAt = Date.now();
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/health`, { signal: AbortSignal.timeout(2_000) });
    return { name, status: response.ok ? "reachable" as const : "unhealthy" as const, checkedAt, latencyMs: Date.now() - startedAt };
  } catch {
    return { name, status: "unreachable" as const, checkedAt, latencyMs: Date.now() - startedAt };
  }
}

const permittedFinancialSimulationScenarios = new Set(["database-partition", "broker-failure", "temporal-recovery"]);
function financialSimulationConfiguration() {
  const executorUrl = `${process.env.FINANCIAL_SIMULATION_EXECUTOR_URL ?? ""}`.trim();
  const token = `${process.env.FINANCIAL_SIMULATION_EXECUTOR_TOKEN ?? ""}`.trim();
  const enabled = !ENV.isProduction && process.env.FINANCIAL_SIMULATION_MODE === "isolated" && Boolean(executorUrl && token);
  return { enabled, executorUrl, token };
}

app.get("/api/admin/finance/overview", rateLimit(30), async (req, res) => {
  const user = requireFinancialAdministrator(req, res);
  if (!user) return;
  try {
    const snapshot = await getFinancialAdminSnapshot();
    res.status(200).json({ ...snapshot, immutableIdentityEnforced: true, retrievedAt: new Date().toISOString() });
  } catch (error) {
    console.error("[SwitchOS] Unable to load financial administration snapshot", error);
    res.status(503).json({ error: "financial_admin_data_unavailable" });
  }
});

app.get("/api/admin/finance/health", rateLimit(30), async (req, res) => {
  const user = requireFinancialAdministrator(req, res);
  if (!user) return;
  const temporalBridgeUrl = `${process.env.TEMPORAL_BRIDGE_URL ?? ""}`.trim() || undefined;
  const dependencies = await Promise.all([
    dependencyHealth("TigerBeetle adapter", ENV.tigerbeetleServiceUrl),
    dependencyHealth("Temporal bridge", temporalBridgeUrl),
  ]);
  res.status(200).json({ dependencies, retrievedAt: new Date().toISOString() });
});

app.get("/api/admin/finance/simulations", rateLimit(30), (req, res) => {
  const user = requireFinancialAdministrator(req, res);
  if (!user) return;
  const configuration = financialSimulationConfiguration();
  res.status(200).json({ enabled: configuration.enabled, scenarios: [...permittedFinancialSimulationScenarios], productionBlocked: ENV.isProduction });
});

app.post("/api/admin/finance/simulations/:scenario", rateLimit(3), async (req, res) => {
  const user = requireFinancialAdministrator(req, res);
  if (!user) return;
  const scenario = `${req.params.scenario ?? ""}`.trim();
  if (!permittedFinancialSimulationScenarios.has(scenario)) {
    res.status(400).json({ error: "unsupported_financial_simulation" });
    return;
  }
  const configuration = financialSimulationConfiguration();
  if (!configuration.enabled) {
    res.status(409).json({ error: "financial_simulation_unavailable", detail: "Only an explicitly configured isolated non-production executor can run scenarios." });
    return;
  }
  try {
    const response = await fetch(`${configuration.executorUrl.replace(/\/$/, "")}/scenarios/${scenario}`, {
      method: "POST", headers: { "X-Internal-Service-Token": configuration.token }, signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error(`executor returned ${response.status}`);
    await recordOperationalEvent({ eventType: "finance.simulation.requested", actorId: `${user.id}`, actorRole: user.role ?? null, tenantId: user.tenantId ?? null, route: req.path, outcome: "success", payload: { scenario } });
    res.status(202).json({ scenario, status: "submitted" });
  } catch (error) {
    console.error("[SwitchOS] Financial simulation executor unavailable", error);
    res.status(503).json({ error: "financial_simulation_executor_unavailable" });
  }
});

app.get("/api/auth/security", async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    const [sessions, recentLoginActivity] = await Promise.all([
      listOperatorSecuritySessions(Number(user.id)),
      listOperatorSecurityLoginActivity(Number(user.id)),
    ]);
    res.status(200).json({
      mfa: {
        requiredForPrivilegedActions: ENV.requireMfaForPrivilegedActions,
        authenticatedForCurrentSession: Boolean(user.mfaAuthenticated),
        assuranceLevel: user.assuranceLevel ?? null,
        setupUrl: ENV.enableExternalOidc && ENV.oidcIssuerUrl ? `${ENV.oidcIssuerUrl}/account/#/security/signingin` : null,
      },
      currentSessionId: user.sessionId ?? null,
      sessions,
      recentLoginActivity,
    });
  } catch (error) {
    console.error("[SwitchOS] Unable to load security profile", error);
    res.status(503).json({ error: "security_profile_unavailable" });
  }
});

app.delete("/api/auth/security/sessions/:id", rateLimit(10), async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  const sessionId = `${req.params.id ?? ""}`.trim();
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
    res.status(400).json({ error: "invalid_session_id" });
    return;
  }
  try {
    const revoked = await revokeOperatorSecuritySession(Number(user.id), sessionId);
    if (!revoked) {
      res.status(404).json({ error: "session_not_found" });
      return;
    }
    if (user.sessionId === sessionId) res.clearCookie(COOKIE_NAME, getCookieOptions());
    await recordOperationalEvent({ eventType: "auth.security.session_revoked", actorId: `${user.id}`, actorRole: user.role ?? null, tenantId: user.tenantId ?? null, route: req.path, outcome: "success" });
    res.status(200).json({ ok: true, currentSessionRevoked: user.sessionId === sessionId });
  } catch (error) {
    console.error("[SwitchOS] Unable to revoke security session", error);
    res.status(503).json({ error: "security_session_revoke_failed" });
  }
});

function securityCsvCell(value: string | number | boolean | null | undefined) {
  const normalized = `${value ?? ""}`.replace(/\r?\n/g, " ");
  const formulaSafe = /^[=+\-@]/.test(normalized) ? `'${normalized}` : normalized;
  return `"${formulaSafe.replace(/"/g, '""')}"`;
}

app.get("/api/auth/security/login-activity.csv", rateLimit(10), async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    const activity = await listOperatorSecurityLoginActivity(Number(user.id));
    const csv = [
      ["auth_source", "mfa_verified", "assurance_level", "created_at", "last_seen_at", "status", "browser"].map(securityCsvCell).join(","),
      ...activity.map((entry) => [
        entry.auth_source,
        entry.mfa_authenticated ? "yes" : "no",
        entry.assurance_level,
        entry.created_at,
        entry.last_seen_at,
        entry.revoked_at ? "revoked" : "active",
        entry.user_agent,
      ].map(securityCsvCell).join(",")),
    ].join("\n");
    await recordOperationalEvent({ eventType: "auth.security.login_activity_exported", actorId: `${user.id}`, actorRole: user.role ?? null, tenantId: user.tenantId ?? null, route: req.path, outcome: "success", payload: { rowCount: activity.length } });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="security-login-activity.csv"');
    res.setHeader("X-Exported-Row-Count", `${activity.length}`);
    res.status(200).send(csv);
  } catch (error) {
    console.error("[SwitchOS] Unable to export login activity", error);
    res.status(503).json({ error: "security_login_activity_export_failed" });
  }
});

app.post("/api/auth/security/sessions/revoke-others", rateLimit(5), async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  if (!user.sessionId) {
    res.status(409).json({ error: "security_session_registry_required" });
    return;
  }
  try {
    const revokedSessions = await revokeOtherOperatorSecuritySessions(Number(user.id), user.sessionId);
    await recordOperationalEvent({ eventType: "auth.security.other_sessions_revoked", actorId: `${user.id}`, actorRole: user.role ?? null, tenantId: user.tenantId ?? null, route: req.path, outcome: "success", payload: { revokedSessions } });
    res.status(200).json({ ok: true, revokedSessions });
  } catch (error) {
    console.error("[SwitchOS] Unable to revoke other security sessions", error);
    res.status(503).json({ error: "security_other_sessions_revoke_failed" });
  }
});

const privilegedTenantMutationPrefixes = [
  "/api/auth/invitations",
  "/api/auth/members/actions/bulk/role",
  "/api/auth/tenant-branding",
  "/api/auth/tenant/notification-preferences",
  "/api/auth/tenant/notification-delivery-history",
];

app.use((req, res, next) => {
  const request = req as AppRequest;
  const isMutation = !["GET", "HEAD", "OPTIONS"].includes(req.method);
  const requiresStepUp = privilegedTenantMutationPrefixes.some((prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`));
  if (!ENV.requireMfaForPrivilegedActions || !isMutation || !requiresStepUp || !request.user) {
    next();
    return;
  }
  if (!request.user.mfaAuthenticated) {
    res.status(403).json({ error: "mfa_required_for_privileged_action" });
    return;
  }
  next();
});

app.get("/api/auth/onboarding", async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    const state = await getOnboardingState(Number(user.id));
    res.status(200).json(state);
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.status).json({ error: mapped.code });
  }
});

app.post("/api/auth/onboarding/organization", rateLimit(10), async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    const result = await createOrganizationAndTenant({
      operatorId: Number(user.id),
      organizationName: `${req.body?.organizationName ?? ""}`,
      organizationSlug: `${req.body?.organizationSlug ?? ""}`,
      tenantName: `${req.body?.tenantName ?? ""}`,
    });
    const state = await getOnboardingState(Number(user.id));
    await issueOperatorSession(req, res, state.operator, {
      authSource: "managed",
      mfaAuthenticated: Boolean(user.mfaAuthenticated),
      assuranceLevel: user.assuranceLevel ?? null,
    });
    await recordOperationalEvent({ eventType: "auth.organization_created", actorId: `${user.id}`, actorRole: user.role, tenantId: result.tenantId, route: req.path, outcome: "success" });
    res.status(201).json({ ok: true, ...result, redirect: "/onboarding?step=branding" });
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.status).json({ error: mapped.code });
  }
});

app.post("/api/auth/invitations", rateLimit(20), async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    const result = await createInvitation({
      inviterId: Number(user.id),
      email: `${req.body?.email ?? ""}`,
      role: `${req.body?.role ?? "operator"}` as "admin" | "operator" | "viewer",
    });
    await recordOperationalEvent({ eventType: "auth.invitation_created", actorId: `${user.id}`, actorRole: user.role, tenantId: user.tenantId, route: req.path, outcome: "success" });
    res.status(202).json(result);
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.status).json({ error: mapped.code });
  }
});

app.get("/api/auth/invitations/status", async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    res.status(200).json({ invitations: await listInvitationStatuses(Number(user.id)) });
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.code === "tenant_admin_required" ? 403 : mapped.status).json({ error: mapped.code });
  }
});

app.get("/api/auth/invitations/activity.csv", rateLimit(10), async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const startDate = typeof req.query.startDate === "string" ? req.query.startDate : null;
    const endDate = typeof req.query.endDate === "string" ? req.query.endDate : null;
    const columns = typeof req.query.columns === "string" ? req.query.columns.split(",") : [];
    const exported = await exportInvitationActivityCsv({ operatorId: Number(user.id), status, startDate, endDate, columns });
    await recordOperationalEvent({ eventType: "auth.invitation_activity_exported", actorId: `${user.id}`, actorRole: user.role, tenantId: user.tenantId, route: req.path, outcome: "success", payload: { status, startDate, endDate, columns, rowCount: exported.rowCount } });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="invitation-activity.csv"');
    res.setHeader("X-Exported-Row-Count", `${exported.rowCount}`);
    res.status(200).send(exported.csv);
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.code === "tenant_admin_required" ? 403 : mapped.status).json({ error: mapped.code });
  }
});

app.post("/api/auth/invitations/:id/resend", rateLimit(10), async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    const result = await resendInvitation({ inviterId: Number(user.id), invitationId: `${req.params.id ?? ""}` });
    await recordOperationalEvent({ eventType: "auth.invitation_resent", actorId: `${user.id}`, actorRole: user.role, tenantId: user.tenantId, route: req.path, outcome: "success" });
    res.status(202).json(result);
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.code === "tenant_admin_required" ? 403 : mapped.status).json({ error: mapped.code });
  }
});

app.post("/api/auth/invitations/:id/revoke", rateLimit(10), async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    const result = await revokeInvitation({ inviterId: Number(user.id), invitationId: `${req.params.id ?? ""}` });
    await recordOperationalEvent({ eventType: "auth.invitation_revoked", actorId: `${user.id}`, actorRole: user.role, tenantId: user.tenantId, route: req.path, outcome: "success" });
    res.status(200).json(result);
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.code === "tenant_admin_required" ? 403 : mapped.status).json({ error: mapped.code });
  }
});

app.post("/api/auth/invitations/actions/bulk/resend", rateLimit(3), async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    const result = await bulkResendInvitations({ inviterId: Number(user.id), invitationIds: Array.isArray(req.body?.invitationIds) ? req.body.invitationIds.filter((id: unknown): id is string => typeof id === "string") : [] });
    await recordOperationalEvent({ eventType: "auth.invitations_bulk_resent", actorId: `${user.id}`, actorRole: user.role, tenantId: user.tenantId, route: req.path, outcome: result.failed.length ? "failure" : "success", payload: { requested: result.requested, succeeded: result.succeeded.length, failed: result.failed.length } });
    res.status(202).json(result);
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.code === "tenant_admin_required" ? 403 : mapped.status).json({ error: mapped.code });
  }
});

app.post("/api/auth/invitations/actions/bulk/revoke", rateLimit(3), async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    const result = await bulkRevokeInvitations({ inviterId: Number(user.id), invitationIds: Array.isArray(req.body?.invitationIds) ? req.body.invitationIds.filter((id: unknown): id is string => typeof id === "string") : [] });
    await recordOperationalEvent({ eventType: "auth.invitations_bulk_revoked", actorId: `${user.id}`, actorRole: user.role, tenantId: user.tenantId, route: req.path, outcome: result.failed.length ? "failure" : "success", payload: { requested: result.requested, succeeded: result.succeeded.length, failed: result.failed.length } });
    res.status(200).json(result);
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.code === "tenant_admin_required" ? 403 : mapped.status).json({ error: mapped.code });
  }
});

app.post("/api/auth/members/actions/bulk/role", rateLimit(3), async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    const memberIds = Array.isArray(req.body?.memberIds) ? req.body.memberIds.filter((id: unknown): id is number => typeof id === "number") : [];
    const result = await bulkChangeMemberRoles({ operatorId: Number(user.id), memberIds, role: `${req.body?.role ?? ""}` as "admin" | "operator" | "viewer" });
    await recordOperationalEvent({ eventType: "auth.members_bulk_role_changed", actorId: `${user.id}`, actorRole: user.role, tenantId: user.tenantId, route: req.path, outcome: "success", payload: result });
    res.status(200).json(result);
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.code === "tenant_admin_required" ? 403 : mapped.status).json({ error: mapped.code });
  }
});

app.get("/api/auth/members", async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    res.status(200).json({ members: await listTenantMembers(Number(user.id)) });
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.code === "tenant_admin_required" ? 403 : mapped.status).json({ error: mapped.code });
  }
});

app.get("/api/auth/tenant-branding", async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    res.status(200).json(await getTenantBranding(Number(user.id)));
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.status).json({ error: mapped.code });
  }
});

app.get("/api/auth/tenant-branding/presets", async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    res.status(200).json({ presets: await listTenantBrandingPresets(Number(user.id)) });
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.code === "tenant_admin_required" ? 403 : mapped.status).json({ error: mapped.code });
  }
});

app.get("/api/auth/tenant-branding/presets/shared", async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    res.status(200).json({ presets: await listOrganizationSharedBrandingPresets(Number(user.id)) });
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.code === "tenant_admin_required" ? 403 : mapped.status).json({ error: mapped.code });
  }
});

app.get("/api/auth/tenant-branding/presets/audit-history", async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    const startDate = typeof req.query.startDate === "string" ? req.query.startDate : null;
    const endDate = typeof req.query.endDate === "string" ? req.query.endDate : null;
    res.status(200).json({ history: await listTenantBrandingPresetOwnershipAudit({ operatorId: Number(user.id), startDate, endDate }) });
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.code === "tenant_admin_required" ? 403 : mapped.status).json({ error: mapped.code });
  }
});

app.get("/api/auth/tenant/notification-preferences", async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    res.status(200).json(await getTenantAdminNotificationPreferences(Number(user.id)));
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.code === "tenant_admin_required" ? 403 : mapped.status).json({ error: mapped.code });
  }
});

app.get("/api/auth/tenant/notification-delivery-history", async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const startDate = typeof req.query.startDate === "string" ? req.query.startDate : null;
    const endDate = typeof req.query.endDate === "string" ? req.query.endDate : null;
    res.status(200).json({ history: await listTenantAdminNotificationDeliveryHistory({ operatorId: Number(user.id), status, startDate, endDate }) });
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.code === "tenant_admin_required" ? 403 : mapped.status).json({ error: mapped.code });
  }
});

app.get("/api/auth/tenant/notification-delivery-history.csv", rateLimit(10), async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    const status = typeof req.query.status === "string" ? req.query.status : null;
    const startDate = typeof req.query.startDate === "string" ? req.query.startDate : null;
    const endDate = typeof req.query.endDate === "string" ? req.query.endDate : null;
    const exported = await exportTenantAdminNotificationDeliveryHistoryCsv({ operatorId: Number(user.id), status, startDate, endDate });
    await recordOperationalEvent({ eventType: "auth.notification_delivery_history_exported", actorId: `${user.id}`, actorRole: user.role, tenantId: user.tenantId, route: req.path, outcome: "success", payload: { status, startDate, endDate, rowCount: exported.rowCount } });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", 'attachment; filename="notification-delivery-history.csv"');
    res.setHeader("X-Exported-Row-Count", `${exported.rowCount}`);
    res.status(200).send(exported.csv);
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.code === "tenant_admin_required" ? 403 : mapped.status).json({ error: mapped.code });
  }
});

app.get("/api/auth/tenant/notification-delivery-retention", async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    res.status(200).json(await getTenantAdminNotificationDeliveryRetention(Number(user.id)));
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.code === "tenant_admin_required" ? 403 : mapped.status).json({ error: mapped.code });
  }
});

app.post("/api/auth/tenant/notification-delivery-retention", rateLimit(20), async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    const retention = await updateTenantAdminNotificationDeliveryRetention({ operatorId: Number(user.id), retentionDays: Number(req.body?.retentionDays) });
    await recordOperationalEvent({ eventType: "auth.notification_delivery_retention_updated", actorId: `${user.id}`, actorRole: user.role, tenantId: user.tenantId, route: req.path, outcome: "success", payload: { retentionDays: retention.retentionDays, pruned: retention.pruned } });
    res.status(200).json(retention);
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.code === "tenant_admin_required" ? 403 : mapped.status).json({ error: mapped.code });
  }
});

app.post("/api/auth/tenant/notification-preferences", rateLimit(20), async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    const preferences = await updateTenantAdminNotificationPreferences({ operatorId: Number(user.id), roleUpdateEmail: Boolean(req.body?.roleUpdateEmail), presetOwnershipTransferEmail: Boolean(req.body?.presetOwnershipTransferEmail) });
    await recordOperationalEvent({ eventType: "auth.tenant_admin_notification_preferences_updated", actorId: `${user.id}`, actorRole: user.role, tenantId: user.tenantId, route: req.path, outcome: "success" });
    res.status(200).json(preferences);
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.code === "tenant_admin_required" ? 403 : mapped.status).json({ error: mapped.code });
  }
});

app.post("/api/auth/tenant-branding/presets", rateLimit(20), async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    const preset = await saveTenantBrandingPreset({ operatorId: Number(user.id), name: `${req.body?.name ?? ""}`, logoDataUrl: typeof req.body?.logoDataUrl === "string" ? req.body.logoDataUrl : null, primaryColor: `${req.body?.primaryColor ?? ""}`, accentColor: `${req.body?.accentColor ?? ""}` });
    res.status(201).json(preset);
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.code === "tenant_admin_required" ? 403 : mapped.status).json({ error: mapped.code });
  }
});

app.post("/api/auth/tenant-branding/presets/:id/apply", rateLimit(20), async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    res.status(200).json(await applyTenantBrandingPreset({ operatorId: Number(user.id), presetId: `${req.params.id ?? ""}` }));
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.code === "tenant_admin_required" ? 403 : mapped.status).json({ error: mapped.code });
  }
});

app.post("/api/auth/tenant-branding/presets/:id/apply-shared", rateLimit(20), async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    res.status(200).json(await applyOrganizationSharedBrandingPreset({ operatorId: Number(user.id), presetId: `${req.params.id ?? ""}` }));
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.code === "tenant_admin_required" ? 403 : mapped.status).json({ error: mapped.code });
  }
});

app.post("/api/auth/tenant-branding/presets/:id/share", rateLimit(20), async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    const result = await setTenantBrandingPresetOrganizationSharing({ operatorId: Number(user.id), presetId: `${req.params.id ?? ""}`, shared: Boolean(req.body?.shared) });
    await recordOperationalEvent({ eventType: result.organizationShared ? "auth.tenant_branding_preset_shared" : "auth.tenant_branding_preset_unshared", actorId: `${user.id}`, actorRole: user.role, tenantId: user.tenantId, route: req.path, outcome: "success" });
    res.status(200).json(result);
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.code === "tenant_admin_required" ? 403 : mapped.status).json({ error: mapped.code });
  }
});

app.post("/api/auth/tenant-branding/presets/:id/transfer-ownership", rateLimit(10), async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    const result = await transferTenantBrandingPresetOwnership({ operatorId: Number(user.id), presetId: `${req.params.id ?? ""}`, recipientEmail: `${req.body?.recipientEmail ?? ""}` });
    await recordOperationalEvent({ eventType: "auth.tenant_branding_preset_ownership_transferred", actorId: `${user.id}`, actorRole: user.role, tenantId: user.tenantId, route: req.path, outcome: "success", payload: { presetId: result.id, ownerOperatorId: result.ownerOperatorId } });
    res.status(200).json(result);
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.code === "tenant_admin_required" ? 403 : mapped.status).json({ error: mapped.code });
  }
});

app.delete("/api/auth/tenant-branding/presets/:id", rateLimit(20), async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    res.status(200).json(await deleteTenantBrandingPreset({ operatorId: Number(user.id), presetId: `${req.params.id ?? ""}` }));
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.code === "tenant_admin_required" ? 403 : mapped.status).json({ error: mapped.code });
  }
});

app.post("/api/auth/tenant-branding", rateLimit(20), async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    const branding = await updateTenantBranding({
      operatorId: Number(user.id),
      logoDataUrl: typeof req.body?.logoDataUrl === "string" ? req.body.logoDataUrl : null,
      primaryColor: `${req.body?.primaryColor ?? ""}`,
      accentColor: `${req.body?.accentColor ?? ""}`,
    });
    await recordOperationalEvent({ eventType: "auth.tenant_branding_updated", actorId: `${user.id}`, actorRole: user.role, tenantId: user.tenantId, route: req.path, outcome: "success" });
    res.status(200).json(branding);
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res.status(mapped.code === "tenant_admin_required" ? 403 : mapped.status).json({ error: mapped.code });
  }
});

app.use(
  "/api/trpc",
  createHTTPHandler({
    router: appRouter,
    createContext({ req, res }) {
      const request = req as typeof req & { user?: SessionUser | null };
      return {
        req,
        res,
        user: request.user ?? null,
      };
    },
    onError({ error, path }) {
      console.error(`[SwitchOS] tRPC error on ${path ?? "unknown_path"}`, error);
    },
  }),
);

app.post("/api/internal/longcat/voice/bootstrap", rateLimit(60), async (req, res) => {
  if (!requireInternalServiceAccess(req, res)) return;
  try {
    const payload = await startLongCatTelephonyIngressSession({
      userId: typeof req.body?.userId === "number" ? req.body.userId : null,
      customerPhone: typeof req.body?.customerPhone === "string" ? req.body.customerPhone : null,
      customerName: typeof req.body?.customerName === "string" ? req.body.customerName : null,
      voiceChannel: typeof req.body?.voiceChannel === "string" ? req.body.voiceChannel : null,
      accessibilityFlags: Array.isArray(req.body?.accessibilityFlags) ? req.body.accessibilityFlags.filter((value: unknown) => typeof value === "string") : [],
      idempotencyKey: typeof req.body?.idempotencyKey === "string" ? req.body.idempotencyKey : null,
      triggerReason: typeof req.body?.triggerReason === "string" ? req.body.triggerReason : null,
      externalCallId: `${req.body?.externalCallId ?? ""}`.trim(),
      telephonyProvider: typeof req.body?.telephonyProvider === "string" ? req.body.telephonyProvider : null,
      transport: typeof req.body?.transport === "string" ? req.body.transport : null,
      sampleRateHz: typeof req.body?.sampleRateHz === "number" ? req.body.sampleRateHz : null,
    });
    res.status(200).json(payload);
  } catch (error) {
    console.error("[SwitchOS] Failed to bootstrap LongCat telephony session", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "longcat_bootstrap_failed" });
  }
});

app.post("/api/internal/longcat/voice/transcript", rateLimit(120), async (req, res) => {
  if (!requireInternalServiceAccess(req, res)) return;
  try {
    const payload = await appendLongCatTelephonyTranscript({
      sessionId: `${req.body?.sessionId ?? ""}`.trim(),
      externalCallId: `${req.body?.externalCallId ?? ""}`.trim(),
      telephonyProvider: typeof req.body?.telephonyProvider === "string" ? req.body.telephonyProvider : null,
      transport: typeof req.body?.transport === "string" ? req.body.transport : null,
      speaker: req.body?.speaker === "agent" || req.body?.speaker === "system" ? req.body.speaker : "customer",
      transcript: `${req.body?.transcript ?? ""}`.trim(),
      finalSegment: Boolean(req.body?.finalSegment ?? true),
      metadata: req.body?.metadata && typeof req.body.metadata === "object" ? req.body.metadata : undefined,
    });
    res.status(200).json(payload);
  } catch (error) {
    console.error("[SwitchOS] Failed to append LongCat telephony transcript", error);
    const message = error instanceof Error ? error.message : "longcat_transcript_failed";
    const status = /already closed/i.test(message) ? 409 : 500;
    res.status(status).json({ error: message });
  }
});

app.post("/api/internal/longcat/voice/close", rateLimit(60), async (req, res) => {
  if (!requireInternalServiceAccess(req, res)) return;
  try {
    const payload = await closeLongCatTelephonyIngressSession({
      sessionId: `${req.body?.sessionId ?? ""}`.trim(),
      externalCallId: `${req.body?.externalCallId ?? ""}`.trim(),
      status: req.body?.status === "failed" || req.body?.status === "abandoned" ? req.body.status : "completed",
      reason: typeof req.body?.reason === "string" ? req.body.reason : null,
      metadata: req.body?.metadata && typeof req.body.metadata === "object" ? req.body.metadata : undefined,
    });
    res.status(200).json(payload);
  } catch (error) {
    console.error("[SwitchOS] Failed to close LongCat telephony session", error);
    res.status(500).json({ error: error instanceof Error ? error.message : "longcat_close_failed" });
  }
});

app.listen(ENV.port, ENV.bindHost, () => {
  console.log(`[SwitchOS] Operator edge listening on http://${ENV.bindHost}:${ENV.port}`);
});
