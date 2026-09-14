import cookieParser from "cookie-parser";
import express from "express";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { randomUUID } from "crypto";
import { fileURLToPath } from "url";
import path from "path";

import { appRouter } from "../routers";
import {
  appendLongCatTelephonyTranscript,
  closeLongCatTelephonyIngressSession,
  startLongCatTelephonyIngressSession,
} from "./longcatVoice";
import { COOKIE_NAME } from "../../shared/const";
import { ENV } from "./env";
import { tokensEqual } from "./security";
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
import {
  authenticateOperator,
  createOperatorSecuritySession,
  ensureExternalOperator,
  ensureOperatorAuthStore,
  isOperatorSecuritySessionActive,
  listOperatorSecurityLoginActivity,
  listOperatorSecuritySessions,
  revokeOperatorSecuritySession,
  revokeOtherOperatorSecuritySessions,
} from "./operatorAuthStore";
import { recordOperationalEvent } from "./operationalEvents";
import { consumeRateLimit, getRateLimiterStatus } from "./rateLimiter";
import {
  getFilteredFinancialAdminSnapshot,
  getFinancialAdminAlerts,
  getFinancialDatabaseEvidence,
  getFinancialAdminSettings,
  getFinancialDeadLetterHeadResolution,
  listFinancialAlertDeliveryReceipts,
  listFinancialDeadLetterCases,
  listFinancialDependencyHealthHistory,
  openFinancialDeadLetterCase,
  approveFinancialDeadLetterHeadResolution,
  approveFinancialDeadLetterRemediation,
  recordFinancialAdminAlertAction,
  rejectFinancialDeadLetterHeadResolution,
  rejectFinancialDeadLetterRemediation,
  requestFinancialDeadLetterHeadResolution,
  requestFinancialDeadLetterRemediation,
  recordFinancialAlertDeliveryReceipt,
  recordFinancialDependencyHealth,
  updateFinancialAdminSettings,
} from "./financialAdminStore";
import {
  getAlertActionHistory,
  getAlertEscalations,
} from "./financialAdminStore";
import { logStructuredEvent } from "./structuredLogger";
import {
  dispatchOneVehiclePreventNextStartCommand,
  ingestSignedVehicleTrackerEvent,
  VehicleTrackerIntegrationError,
} from "./vehicleTrackerIntegration";
import {
  dispatchOneVehicleTrackerProviderIngest,
  startVehicleTrackerProviderConsumers,
  VehicleTrackerProviderConsumerError,
} from "./vehicleTrackerProviderConsumers";
import {
  getFinancialTopology,
  getLatestDeliveryLocation,
  recordDeliveryLocation,
  recordProofOfDelivery,
} from "./deliveryTrackingStore";
import {
  createPublicFieldServiceWorkOrder,
  getPublicFieldServiceWorkOrder,
  isDeveloperApiError,
  listPublicFieldServiceWorkOrders,
} from "./developerApi";
import { startDeveloperWebhookDispatcher } from "./developerWebhookDispatcher";
import { developerOpenApi } from "./developerOpenApi";
import { ingestMedusaWebhook, MedusaCommerceError } from "./medusaCommerce";
import { ingestExternalCommerceWebhook } from "./commerceFulfillment";
import {
  handleRoleScopedTrackingSnapshot,
  handleRoleScopedTrackingStream,
} from "./realtimeTracking";
import {
  assertWorkOrderTenant,
  createGeofence,
  createServiceZone,
  createWebhookSubscription,
  createWorkflowDefinition,
  createWorkOrder,
  deliverDueOperationalWebhooks,
  listOperationsSnapshot,
  logisticsErrorStatus,
  publishWorkflowDefinition,
  recordGeofenceEventsForPosition,
  recordTrackingPosition,
  transitionWorkOrder,
} from "./logisticsOperationsStore";
import {
  ingestPartnerEvent,
  listPartnerClients,
  partnerErrorStatus,
  registerPartnerClient,
  revokePartnerCredential,
} from "./partnerIntegrationStore";
import {
  createInvoice,
  decideDispute,
  financialOperationsErrorStatus,
  generateDueReports,
  listFinancialOperations,
  openDispute,
  requestReport,
  transitionInvoice,
} from "./financialOperationsStore";
import coverageBaseline from "../../assurance/CODE_COVERAGE_BASELINE.json";
import coverageHistory from "../../assurance/CODE_COVERAGE_HISTORY.json";
import playwrightExecutions from "../../assurance/PLAYWRIGHT_EXECUTION_HISTORY.json";

import type { SessionUser } from "./trpc";

const OIDC_STATE_COOKIE = "switchos_oidc_state";
const OIDC_NONCE_COOKIE = "switchos_oidc_nonce";
const OIDC_VERIFIER_COOKIE = "switchos_oidc_verifier";
const OIDC_RETURN_TO_COOKIE = "switchos_oidc_return_to";

type AppRequest = express.Request & {
  user: SessionUser | null;
  rawBody?: Buffer;
  requestId?: string;
  resilienceRunId?: string;
};

const app = express();
// The application is reachable only through Caddy and APISIX in promoted deployments.
// Trust exactly that two-proxy chain so request throttles key on the original client IP.
app.set("trust proxy", 2);
const allowedOrigins = ENV.allowedOrigins
  .split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

function normalizeCorrelationId(value: unknown) {
  const candidate = `${value ?? ""}`.trim();
  return /^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$/.test(candidate) ? candidate : "";
}

function correlationHeaders(req: express.Request) {
  const request = req as AppRequest;
  return {
    "x-request-id": request.requestId ?? randomUUID(),
    ...(request.resilienceRunId
      ? { "x-resilience-run-id": request.resilienceRunId }
      : {}),
  };
}

function readOrigin(originHeader?: string) {
  if (!originHeader) return "";
  return originHeader.trim();
}

function isAllowedOrigin(origin: string) {
  if (!origin) return false;
  return allowedOrigins.includes(origin);
}

function getRequestOrigin(req: express.Request) {
  const forwardedProto =
    `${req.headers["x-forwarded-proto"] ?? req.protocol ?? "http"}`
      .split(",")[0]
      ?.trim() || "http";
  const forwardedHost =
    `${req.headers["x-forwarded-host"] ?? req.get("host") ?? "localhost:3005"}`
      .split(",")[0]
      ?.trim() || "localhost:3005";
  return `${forwardedProto}://${forwardedHost}`;
}

function sanitizeReturnTo(returnTo: string | undefined) {
  if (!returnTo) return "/dashboard";
  if (!returnTo.startsWith("/") || returnTo.startsWith("//"))
    return "/dashboard";
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
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(self)",
  );
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
  const isHashedStaticAsset =
    /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.(?:css|js|mjs|woff2?|svg|png|webp)$/.test(
      req.path,
    );

  if (req.path === "/sw.js") {
    res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("Service-Worker-Allowed", "/");
  } else if (isHashedStaticAsset) {
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  } else if (
    req.path === "/" ||
    req.path === "/index.html" ||
    acceptHeader.includes("text/html")
  ) {
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
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Requested-With, X-API-Key, Idempotency-Key",
    );
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    );
    res.setHeader("Vary", "Origin");
  }
}

function requireInternalServiceAccess(
  req: express.Request,
  res: express.Response,
) {
  const provided = `${req.header("X-Internal-Service-Token") ?? ""}`.trim();
  if (!provided || !tokensEqual(provided, ENV.internalServiceToken)) {
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
      res.setHeader(
        "X-RateLimit-Reset",
        String(Math.ceil(bucket.resetAt / 1000)),
      );
      res.setHeader("X-RateLimit-Backend", bucket.mode);

      if (!bucket.allowed) {
        const retryAfterSeconds = Math.max(
          1,
          Math.ceil((bucket.resetAt - Date.now()) / 1000),
        );
        res.setHeader("Retry-After", String(retryAfterSeconds));
        res
          .status(429)
          .json({ error: "rate_limit_exceeded", retryAfterSeconds });
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
  operator: {
    id: number;
    name: string;
    email: string;
    role: string;
    tenantId: string | null;
  },
  options: {
    authSource?: "managed" | "oidc" | "development";
    mfaAuthenticated?: boolean;
    assuranceLevel?: string | null;
  } = {},
) {
  const sessionId = randomUUID();
  const mfaAuthenticated = Boolean(options.mfaAuthenticated);
  // Derive the session identity from the authenticated credential itself.
  // Every session previously shared the static ENV.ownerOpenId subject, which
  // collapsed all operators into one identity for anything keyed on openId
  // (public.users, drivers). The shared ownerOpenId is kept ONLY as the
  // bootstrap-owner fallback when no credential identity exists.
  const credentialOpenId =
    Number.isFinite(operator.id) && operator.id > 0
      ? `operator:${operator.id}`
      : ENV.ownerOpenId;
  const token = await createSessionToken({
    sub: String(operator.id),
    name: operator.name,
    email: operator.email,
    role: operator.role,
    openId: credentialOpenId,
    tenantId: operator.tenantId,
    scopes:
      operator.role === "viewer"
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
  const request = req as AppRequest;
  request.requestId =
    normalizeCorrelationId(req.get("x-request-id")) || randomUUID();
  request.resilienceRunId = ENV.isProduction
    ? ""
    : normalizeCorrelationId(req.get("x-resilience-run-id"));
  res.setHeader("X-Request-Id", request.requestId);
  if (request.resilienceRunId)
    res.setHeader("X-Resilience-Run-Id", request.resilienceRunId);
  res.on("finish", () => {
    if (request.resilienceRunId) {
      logStructuredEvent("http.request.completed", {
        request_id: request.requestId ?? null,
        resilience_run_id: request.resilienceRunId,
        method: req.method,
        path: req.path,
        status: res.statusCode,
      });
    }
  });
  setSecurityHeaders(req, res);
  applyCors(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

app.post(
  "/api/internal/commerce/medusa-events",
  express.raw({ type: "application/json", limit: ENV.apiBodyLimit }),
  rateLimit(120),
  async (req, res) => {
    const storeId = `${req.header("X-Medusa-Store-Id") ?? ""}`.trim();
    const eventId = `${req.header("X-Medusa-Event-Id") ?? ""}`.trim();
    const eventType = `${req.header("X-Medusa-Event-Type") ?? ""}`.trim();
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    try {
      const event = await ingestMedusaWebhook({
        storeId,
        eventId,
        eventType,
        rawBody,
        signature: req.header("X-Medusa-Signature"),
      });
      await recordOperationalEvent({
        eventType: "commerce.medusa_event.received",
        route: req.path,
        outcome: "success",
        payload: { eventId, eventType, storeId, eventRecordId: event.id },
      });
      res.status(202).json({ accepted: true, eventId: event.id });
    } catch (error) {
      const reason =
        error instanceof Error
          ? error.message
          : "medusa_event_ingestion_failed";
      await recordOperationalEvent({
        eventType: "commerce.medusa_event.received",
        route: req.path,
        outcome: "failure",
        payload: { eventId, eventType, storeId, reason },
      });
      if (
        error instanceof MedusaCommerceError &&
        reason.includes("signature")
      ) {
        res.status(401).json({ error: "medusa_event_signature_invalid" });
        return;
      }
      if (
        error instanceof MedusaCommerceError &&
        (reason.includes("identity") ||
          reason.includes("type") ||
          reason.includes("json"))
      ) {
        res.status(400).json({ error: "medusa_event_invalid" });
        return;
      }
      if (error instanceof MedusaCommerceError && reason.includes("disabled")) {
        res.status(404).json({ error: "medusa_event_ingress_unavailable" });
        return;
      }
      res.status(503).json({ error: "medusa_event_unavailable" });
    }
  },
);

app.post(
  "/api/internal/commerce/platforms/:connectionKey/events",
  express.raw({ type: "application/json", limit: ENV.apiBodyLimit }),
  rateLimit(120),
  async (req, res) => {
    const eventId = `${req.header("X-Commerce-Event-Id") ?? ""}`.trim();
    const eventType = `${req.header("X-Commerce-Event-Type") ?? ""}`.trim();
    const rawBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    try {
      const event = await ingestExternalCommerceWebhook({
        connectionKey: req.params.connectionKey,
        externalEventId: eventId,
        eventType: eventType as "commerce.order.placed" | "commerce.order.cancelled" | "commerce.fulfillment.ready",
        signature: req.header("X-Commerce-Signature"),
        rawBody,
        parsedBody: rawBody.length ? JSON.parse(rawBody.toString("utf8")) : null,
      });
      await recordOperationalEvent({
        eventType: "commerce.external_platform_event.received",
        route: req.path,
        outcome: "success",
        payload: { connectionKey: req.params.connectionKey, eventId, eventType, eventRecordId: event.id },
      });
      res.status(202).json({ accepted: true, eventId: event.id });
    } catch (error) {
      const reason = error instanceof Error ? error.message : "external_commerce_event_ingestion_failed";
      await recordOperationalEvent({
        eventType: "commerce.external_platform_event.received",
        route: req.path,
        outcome: "failure",
        payload: { connectionKey: req.params.connectionKey, eventId, eventType, reason },
      });
      if (reason.includes("signature") || reason.includes("not_configured")) {
        res.status(401).json({ error: "external_commerce_signature_invalid" });
      } else if (reason.includes("identity") || reason.includes("payload") || reason.includes("input")) {
        res.status(400).json({ error: "external_commerce_event_invalid" });
      } else if (reason.includes("disabled") || reason.includes("not found") || reason.includes("required")) {
        res.status(404).json({ error: "external_commerce_connection_unavailable" });
      } else {
        res.status(503).json({ error: "external_commerce_event_unavailable" });
      }
    }
  },
);

app.use(
  express.json({
    limit: ENV.apiBodyLimit,
    verify: (req, _res, buffer) => {
      (req as AppRequest).rawBody = Buffer.from(buffer);
    },
  }),
);
app.use(express.urlencoded({ extended: true, limit: ENV.apiBodyLimit }));

app.get("/api/health", async (req, res) => {
  const discovery = ENV.enableExternalOidc
    ? await getOidcDiscoveryDocument()
    : null;
  const rateLimiter = await getRateLimiterStatus();
  await recordOperationalEvent({
    eventType: "system.health.checked",
    route: req.path,
    outcome: "info",
    payload: {
      externalOidcEnabled: ENV.enableExternalOidc,
      rateLimiterMode: rateLimiter.mode,
      medusaMerchantConfigured: ENV.medusaMerchantConfigured,
    },
  });
  res.json({
    ok: true,
    service: "switchos-operator-dashboard",
    timestamp: new Date().toISOString(),
    externalOidcEnabled: ENV.enableExternalOidc,
    oidcIssuer: (discovery?.issuer ?? ENV.oidcIssuerUrl) || null,
    rateLimiter,
    medusaMerchantConfigured: ENV.medusaMerchantConfigured,
  });
});

app.get("/api/auth/config", async (_req, res) => {
  const discovery = ENV.enableExternalOidc
    ? await getOidcDiscoveryDocument()
    : null;
  res.status(200).json({
    externalOidcEnabled: ENV.enableExternalOidc,
    oidcIssuer: (discovery?.issuer ?? ENV.oidcIssuerUrl) || null,
    oidcClientId: ENV.oidcClientId || null,
    oidcLogoutUrl:
      (discovery?.end_session_endpoint ?? ENV.oidcLogoutUrl) || null,
    oidcStartPath: ENV.enableExternalOidc ? "/api/auth/oidc/start" : null,
    fallbackLoginEnabled: !ENV.enableExternalOidc || !ENV.isProduction,
    selfServiceSignupEnabled: ENV.selfServiceSignupEnabled,
  });
});

function lifecycleErrorStatus(error: unknown) {
  const code =
    error instanceof Error ? error.message : "account_lifecycle_failed";
  if (code === "self_service_signup_disabled") return { status: 404, code };
  if (
    code === "lifecycle_email_delivery_failed" ||
    code === "notification_dispatcher_not_configured"
  )
    return { status: 503, code: "email_delivery_unavailable" };
  if (code.startsWith("invalid_or_expired_") || code === "invalid_email")
    return { status: 400, code };
  if (
    code.includes("required") ||
    code.includes("already") ||
    code.includes("invalid_") ||
    code.startsWith("password_")
  )
    return { status: 400, code };
  return { status: 500, code: "account_lifecycle_failed" };
}

app.post("/api/auth/signup", rateLimit(5), async (req, res) => {
  try {
    const result = await beginSignup({
      email: `${req.body?.email ?? ""}`,
      name: `${req.body?.name ?? ""}`,
      password: `${req.body?.password ?? ""}`,
    });
    await recordOperationalEvent({
      eventType: "auth.signup.requested",
      route: req.path,
      outcome: "info",
    });
    res.status(202).json(result);
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    await recordOperationalEvent({
      eventType: "auth.signup.requested",
      route: req.path,
      outcome: "failure",
      payload: { code: mapped.code },
    });
    res.status(mapped.status).json({ error: mapped.code });
  }
});

app.post(
  "/api/auth/email-verification/resend",
  rateLimit(5),
  async (req, res) => {
    try {
      await resendVerification(`${req.body?.email ?? ""}`);
    } catch (error) {
      console.warn("[SwitchOS] Verification resend request failed", error);
    }
    // Do not reveal whether an account exists or is already verified.
    res.status(202).json({ accepted: true });
  },
);

app.post(
  "/api/auth/email-verification/confirm",
  rateLimit(10),
  async (req, res) => {
    try {
      const operator = await confirmEmailVerification(
        `${req.body?.token ?? ""}`,
      );
      await issueOperatorSession(req, res, operator);
      await recordOperationalEvent({
        eventType: "auth.email_verified",
        actorId: `${operator.id}`,
        actorRole: operator.role,
        route: req.path,
        outcome: "success",
      });
      res
        .status(200)
        .json({ ok: true, user: operator, redirect: "/onboarding" });
    } catch (error) {
      const mapped = lifecycleErrorStatus(error);
      res.status(mapped.status).json({ error: mapped.code });
    }
  },
);

app.post("/api/auth/password-reset/request", rateLimit(5), async (req, res) => {
  try {
    await requestPasswordReset(`${req.body?.email ?? ""}`);
  } catch (error) {
    console.warn("[SwitchOS] Password reset request failed", error);
  }
  // Generic completion response prevents account enumeration.
  res.status(202).json({ accepted: true });
});

app.post(
  "/api/auth/password-reset/confirm",
  rateLimit(10),
  async (req, res) => {
    try {
      await confirmPasswordReset({
        token: `${req.body?.token ?? ""}`,
        password: `${req.body?.password ?? ""}`,
      });
      await recordOperationalEvent({
        eventType: "auth.password_reset",
        route: req.path,
        outcome: "success",
      });
      res.status(200).json({ ok: true, redirect: "/portal" });
    } catch (error) {
      const mapped = lifecycleErrorStatus(error);
      res.status(mapped.status).json({ error: mapped.code });
    }
  },
);

app.post("/api/auth/invitations/accept", rateLimit(10), async (req, res) => {
  try {
    const result = await acceptInvitation({
      token: `${req.body?.token ?? ""}`,
      name: `${req.body?.name ?? ""}`,
      password: `${req.body?.password ?? ""}`,
    });
    await issueOperatorSession(req, res, result.operator);
    await recordOperationalEvent({
      eventType: "auth.invitation_accepted",
      actorId: `${result.operator.id}`,
      actorRole: result.operator.role,
      tenantId: result.operator.tenantId,
      route: req.path,
      outcome: "success",
    });
    res
      .status(200)
      .json({ ok: true, user: result.operator, redirect: "/dashboard" });
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
    const returnTo = sanitizeReturnTo(
      typeof req.query.returnTo === "string" ? req.query.returnTo : undefined,
    );
    const origin = getRequestOrigin(req);
    const authorization = await buildOidcAuthorizationUrl(origin, returnTo);
    const transientCookieOptions = {
      ...getCookieOptions(),
      maxAge: 1000 * 60 * 10,
      sameSite: "lax" as const,
    };

    res.cookie(OIDC_STATE_COOKIE, authorization.state, transientCookieOptions);
    res.cookie(OIDC_NONCE_COOKIE, authorization.nonce, transientCookieOptions);
    res.cookie(
      OIDC_VERIFIER_COOKIE,
      authorization.verifier,
      transientCookieOptions,
    );
    res.cookie(
      OIDC_RETURN_TO_COOKIE,
      authorization.returnTo,
      transientCookieOptions,
    );
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

  if (
    !code ||
    !state ||
    !storedState ||
    !tokensEqual(state, storedState) ||
    !storedNonce ||
    !storedVerifier
  ) {
    clearOidcFlowCookies(res);
    res.status(400).json({ error: "invalid_oidc_callback_state" });
    return;
  }

  try {
    const origin = getRequestOrigin(req);
    const tokens = await exchangeAuthorizationCode(
      code,
      storedVerifier,
      origin,
    );
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
    if (
      request.user?.sessionId &&
      !(await isOperatorSecuritySessionActive(
        request.user.id,
        request.user.sessionId,
      ))
    ) {
      request.user = null;
    }
  } catch (error) {
    console.warn("[SwitchOS] Failed to resolve session user", error);
    request.user = null;
  }
  next();
});

function requireAuthenticatedOperator(
  req: express.Request,
  res: express.Response,
): SessionUser | null {
  const user = (req as AppRequest).user;
  if (!user) {
    res.status(401).json({ error: "authentication_required" });
    return null;
  }
  return user;
}

app.get("/api/auth/session-profile", rateLimit(60), (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  res.status(200).json({
    user: {
      id: user.id,
      name: user.name,
      role: user.role ?? null,
      tenantId: user.tenantId ?? null,
      scopes: user.scopes ?? [],
      mfaAuthenticated: Boolean(user.mfaAuthenticated),
      assuranceLevel: user.assuranceLevel ?? null,
    },
  });
});

function readDeveloperApiKey(req: express.Request, res: express.Response) {
  const apiKey = `${req.header("X-API-Key") ?? ""}`.trim();
  if (!apiKey) {
    res.status(401).json({ error: "developer_api_key_required" });
    return null;
  }
  return apiKey;
}

function parseDeveloperWorkOrder(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("developer_api_payload_invalid");
  const source = body as Record<string, unknown>;
  const text = (name: string, minimum: number, maximum: number) => {
    const value = typeof source[name] === "string" ? source[name].trim() : "";
    if (value.length < minimum || value.length > maximum)
      throw new Error("developer_api_payload_invalid");
    return value;
  };
  const positiveInteger = (name: string) => {
    const value = source[name];
    if (!Number.isInteger(value) || (value as number) <= 0)
      throw new Error("developer_api_payload_invalid");
    return value as number;
  };
  const nullableNumber = (name: string, minimum: number, maximum: number) => {
    const value = source[name];
    if (value === null || value === undefined) return null;
    if (
      typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < minimum ||
      value > maximum
    )
      throw new Error("developer_api_payload_invalid");
    return value;
  };
  const nullableTimestamp = (name: string) => {
    const value = source[name];
    if (value === null || value === undefined) return null;
    if (
      typeof value !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T/.test(value) ||
      Number.isNaN(Date.parse(value))
    )
      throw new Error("developer_api_payload_invalid");
    return value;
  };
  const priorityCandidate = source.priority ?? "normal";
  if (
    priorityCandidate !== "low" &&
    priorityCandidate !== "normal" &&
    priorityCandidate !== "high" &&
    priorityCandidate !== "urgent"
  )
    throw new Error("developer_api_payload_invalid");
  const serviceAreaId = text("serviceAreaId", 36, 36);
  if (!/^[0-9a-f-]{36}$/i.test(serviceAreaId))
    throw new Error("developer_api_payload_invalid");
  return {
    customerId: positiveInteger("customerId"),
    serviceAreaId,
    title: text("title", 3, 180),
    description: text("description", 3, 5000),
    serviceAddress: text("serviceAddress", 3, 500),
    latitude: nullableNumber("latitude", -90, 90),
    longitude: nullableNumber("longitude", -180, 180),
    priority: priorityCandidate as "low" | "normal" | "high" | "urgent",
    scheduledStartAt: nullableTimestamp("scheduledStartAt"),
    scheduledEndAt: nullableTimestamp("scheduledEndAt"),
    sourceOrderId:
      source.sourceOrderId === null || source.sourceOrderId === undefined
        ? null
        : positiveInteger("sourceOrderId"),
  };
}

function developerApiFailure(res: express.Response, error: unknown) {
  const message =
    error instanceof Error ? error.message : "developer_api_unavailable";
  if (
    message.includes("authentication") ||
    message.includes("key_malformed") ||
    message.includes("key_required")
  ) {
    res.status(401).json({ error: "developer_api_authentication_failed" });
    return;
  }
  if (
    message.includes("scope denied") ||
    message.includes("provider_scope_required")
  ) {
    res.status(403).json({ error: "developer_api_scope_denied" });
    return;
  }
  if (message.includes("not found")) {
    res.status(404).json({ error: "developer_resource_not_found" });
    return;
  }
  if (message.includes("idempotency key was reused")) {
    res.status(409).json({ error: "idempotency_key_conflict" });
    return;
  }
  if (message.includes("idempotent request is in progress")) {
    res.status(409).json({ error: "idempotency_request_in_progress" });
    return;
  }
  if (isDeveloperApiError(error)) {
    res.status(400).json({ error: "developer_api_request_invalid" });
    return;
  }
  res.status(503).json({ error: "developer_api_unavailable" });
}

function requireFinancialAdministrator(
  req: express.Request,
  res: express.Response,
): SessionUser | null {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return null;
  if (!user.mfaAuthenticated) {
    res.status(403).json({ error: "mfa_required_for_privileged_action" });
    return null;
  }
  if (
    !new Set(["admin", "platform_admin", "super_admin"]).has(
      `${user.role ?? ""}`.toLowerCase(),
    )
  ) {
    res.status(403).json({ error: "financial_admin_required" });
    return null;
  }
  return user;
}

function observabilityText(value: unknown, maximum: number) {
  return `${value ?? ""}`
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim()
    .slice(0, maximum);
}

function observabilityContext(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 12)
      .flatMap(([key, entry]) => {
        if (!/^[a-zA-Z0-9._-]{1,80}$/.test(key)) return [];
        if (typeof entry === "string")
          return [[key, observabilityText(entry, 250)]];
        if (
          typeof entry === "boolean" ||
          (typeof entry === "number" && Number.isFinite(entry)) ||
          entry === null
        )
          return [[key, entry]];
        return [];
      }),
  );
}

app.post("/api/telemetry/client-errors", rateLimit(30), async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  const event = observabilityText(req.body?.event, 80);
  const errorName = observabilityText(req.body?.errorName, 120) || "Error";
  const message = observabilityText(req.body?.message, 1000);
  const path = observabilityText(req.body?.path, 250);
  if (
    !/^[a-zA-Z0-9._-]{1,80}$/.test(event) ||
    !message ||
    (path && !path.startsWith("/"))
  ) {
    res.status(400).json({ error: "invalid_client_observability_event" });
    return;
  }
  try {
    await recordOperationalEvent({
      eventType: `client.${event}`,
      actorId: `${user.id}`,
      actorRole: user.role ?? null,
      tenantId: user.tenantId ?? null,
      route: path || req.path,
      outcome: "failure",
      payload: {
        errorName,
        message,
        context: observabilityContext(req.body?.context),
      },
    });
    res.status(202).json({ accepted: true });
  } catch {
    res.status(503).json({ error: "client_observability_unavailable" });
  }
});

function requireOperationsActor(req: express.Request, res: express.Response) {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return null;
  if (
    !new Set(["admin", "operator", "ops", "platform_admin", "super_admin"]).has(
      `${user.role ?? ""}`.toLowerCase(),
    )
  ) {
    res.status(403).json({ error: "operations_role_required" });
    return null;
  }
  if (!user.tenantId) {
    res.status(409).json({ error: "tenant_context_required" });
    return null;
  }
  return {
    id: Number(user.id),
    tenantId: user.tenantId,
    role: user.role ?? null,
  };
}

async function operationsRoute(
  req: express.Request,
  res: express.Response,
  operation: (actor: {
    id: number;
    tenantId: string;
    role: string | null;
  }) => Promise<unknown>,
) {
  const actor = requireOperationsActor(req, res);
  if (!actor) return;
  try {
    const result = await operation(actor);
    await recordOperationalEvent({
      eventType: "operations.api",
      actorId: `${actor.id}`,
      actorRole: actor.role,
      tenantId: actor.tenantId,
      route: req.path,
      outcome: "success",
    });
    res.status(200).json(result);
  } catch (error) {
    const mapped = logisticsErrorStatus(error);
    await recordOperationalEvent({
      eventType: "operations.api",
      actorId: `${actor.id}`,
      actorRole: actor.role,
      tenantId: actor.tenantId,
      route: req.path,
      outcome: "failure",
      payload: { code: mapped.code },
    });
    res.status(mapped.status).json({ error: mapped.code });
  }
}

app.get("/api/operations/snapshot", rateLimit(60), async (req, res) => {
  await operationsRoute(req, res, (actor) => listOperationsSnapshot(actor));
});
app.get("/api/tracking/live/:scope/snapshot", rateLimit(30), async (req, res) => {
  await handleRoleScopedTrackingSnapshot(req, res, getSessionUserFromRequest);
});

app.get("/api/tracking/live/:scope", rateLimit(12), async (req, res) => {
  await handleRoleScopedTrackingStream(req, res, getSessionUserFromRequest);
});
app.post("/api/operations/zones", rateLimit(20), async (req, res) => {
  await operationsRoute(req, res, (actor) =>
    createServiceZone(actor, {
      code: req.body?.code,
      displayName: req.body?.displayName,
      polygon: req.body?.polygon,
      metadata: req.body?.metadata,
    }),
  );
});
app.post("/api/operations/workflows", rateLimit(15), async (req, res) => {
  await operationsRoute(req, res, (actor) =>
    createWorkflowDefinition(actor, {
      workflowCode: req.body?.workflowCode,
      displayName: req.body?.displayName,
      transitions: req.body?.transitions,
      requiredStopKinds: req.body?.requiredStopKinds,
      inputSchema: req.body?.inputSchema,
      policyVersion: req.body?.policyVersion,
    }),
  );
});
app.post(
  "/api/operations/workflows/:id/publish",
  rateLimit(15),
  async (req, res) => {
    await operationsRoute(req, res, (actor) =>
      publishWorkflowDefinition(actor, {
        workflowId: req.params.id,
        idempotencyKey: req.body?.idempotencyKey,
      }),
    );
  },
);
app.post("/api/operations/geofences", rateLimit(20), async (req, res) => {
  await operationsRoute(req, res, (actor) =>
    createGeofence(actor, {
      code: req.body?.code,
      displayName: req.body?.displayName,
      polygon: req.body?.polygon,
      dwellThresholdSeconds: req.body?.dwellThresholdSeconds,
      metadata: req.body?.metadata,
    }),
  );
});
app.post("/api/operations/work-orders", rateLimit(30), async (req, res) => {
  await operationsRoute(req, res, (actor) =>
    createWorkOrder(actor, {
      externalReference: req.body?.externalReference,
      title: req.body?.title,
      priority: req.body?.priority,
      serviceZoneId: req.body?.serviceZoneId,
      scheduledFor: req.body?.scheduledFor,
      stops: req.body?.stops,
      metadata: req.body?.metadata,
    }),
  );
});
app.post(
  "/api/operations/work-orders/:id/transition",
  rateLimit(30),
  async (req, res) => {
    await operationsRoute(req, res, (actor) =>
      transitionWorkOrder(actor, {
        workOrderId: req.params.id,
        nextState: req.body?.nextState,
        idempotencyKey: req.body?.idempotencyKey,
        assigneeUserId: req.body?.assigneeUserId,
        payload: req.body?.payload,
      }),
    );
  },
);
app.post(
  "/api/operations/work-orders/:id/tracking",
  rateLimit(120),
  async (req, res) => {
    await operationsRoute(req, res, (actor) =>
      recordTrackingPosition(actor, {
        workOrderId: req.params.id,
        latitude: req.body?.latitude,
        longitude: req.body?.longitude,
        observedAt: req.body?.observedAt,
        accuracyM: req.body?.accuracyM,
        integrityScore: req.body?.integrityScore,
        source: req.body?.source,
      }),
    );
  },
);
app.post(
  "/api/operations/work-orders/:id/tracking/:positionId/geofence-events",
  rateLimit(60),
  async (req, res) => {
    await operationsRoute(req, res, (actor) =>
      recordGeofenceEventsForPosition(actor, {
        workOrderId: req.params.id,
        positionId: req.params.positionId,
        idempotencyKey: req.body?.idempotencyKey,
      }),
    );
  },
);
app.post(
  "/api/operations/work-orders/:id/route-plans",
  rateLimit(15),
  async (req, res) => {
    const actor = requireOperationsActor(req, res);
    if (!actor) return;
    try {
      const workOrderId = await assertWorkOrderTenant(actor, req.params.id);
      const response = await fetch(
        `${ENV.dispatchOptimizerUrl.replace(/\/$/, "")}/operations/route-plans`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-internal-service-token": ENV.internalServiceToken,
            ...correlationHeaders(req),
          },
          body: JSON.stringify({
            work_order_id: workOrderId,
            created_by: actor.id,
          }),
          signal: AbortSignal.timeout(8_000),
        },
      );
      const payload = await response
        .json()
        .catch(() => ({ error: "route_planner_invalid_response" }));
      if (!response.ok) {
        res.status(response.status >= 500 ? 503 : response.status).json({
          error: "route_planner_rejected",
          detail: payload?.error ?? payload?.message ?? null,
        });
        return;
      }
      await recordOperationalEvent({
        eventType: "operations.route_plan.created",
        actorId: `${actor.id}`,
        actorRole: actor.role,
        tenantId: actor.tenantId,
        route: req.path,
        outcome: "success",
        payload: { workOrderId },
      });
      res.status(201).json(payload);
    } catch (error) {
      const mapped = logisticsErrorStatus(error);
      res.status(mapped.status).json({ error: mapped.code });
    }
  },
);

async function complianceServiceRequest(
  req: express.Request,
  path: string,
  method: "POST",
  payload?: unknown,
  actorUserId?: number,
) {
  const response = await fetch(
    `${ENV.complianceReviewServiceUrl.replace(/\/$/, "")}${path}`,
    {
      method,
      headers: {
        "content-type": "application/json",
        "x-internal-service-token": ENV.internalServiceToken,
        ...(actorUserId ? { "x-actor-user-id": `${actorUserId}` } : {}),
        ...correlationHeaders(req),
      },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    },
  );
  const body = await response
    .json()
    .catch(() => ({ detail: "compliance_service_invalid_response" }));
  return { response, body };
}

function requireComplianceReviewer(
  req: express.Request,
  res: express.Response,
) {
  const actor = requireOperationsActor(req, res);
  if (!actor) return null;
  if (
    !new Set(["admin", "platform_admin", "super_admin"]).has(
      `${actor.role ?? ""}`.toLowerCase(),
    )
  ) {
    res.status(403).json({ error: "compliance_reviewer_role_required" });
    return null;
  }
  return actor;
}

app.post("/api/compliance/evidence", rateLimit(20), async (req, res) => {
  const actor = requireComplianceReviewer(req, res);
  if (!actor) return;
  try {
    const { response, body } = await complianceServiceRequest(
      req,
      "/evidence",
      "POST",
      req.body,
      actor.id,
    );
    res.status(response.status >= 500 ? 503 : response.status).json(body);
  } catch {
    res.status(503).json({ error: "compliance_service_unavailable" });
  }
});
app.post(
  "/api/compliance/evidence/:id/verify",
  rateLimit(15),
  async (req, res) => {
    const actor = requireComplianceReviewer(req, res);
    if (!actor) return;
    try {
      const { response, body } = await complianceServiceRequest(
        req,
        `/evidence/${encodeURIComponent(req.params.id)}/verify`,
        "POST",
      );
      await recordOperationalEvent({
        eventType: "compliance.evidence.verify",
        actorId: `${actor.id}`,
        actorRole: actor.role,
        tenantId: actor.tenantId,
        route: req.path,
        outcome: response.ok ? "success" : "failure",
      });
      res.status(response.status >= 500 ? 503 : response.status).json(body);
    } catch {
      res.status(503).json({ error: "compliance_service_unavailable" });
    }
  },
);
app.post(
  "/api/compliance/evidence/:id/approve",
  rateLimit(15),
  async (req, res) => {
    const actor = requireComplianceReviewer(req, res);
    if (!actor) return;
    try {
      const payload = {
        reviewer_user_id: actor.id,
        approved: req.body?.approved,
        reason: req.body?.reason,
      };
      const { response, body } = await complianceServiceRequest(
        req,
        `/evidence/${encodeURIComponent(req.params.id)}/approve`,
        "POST",
        payload,
      );
      await recordOperationalEvent({
        eventType: "compliance.evidence.decision",
        actorId: `${actor.id}`,
        actorRole: actor.role,
        tenantId: actor.tenantId,
        route: req.path,
        outcome: response.ok ? "success" : "failure",
      });
      res.status(response.status >= 500 ? 503 : response.status).json(body);
    } catch {
      res.status(503).json({ error: "compliance_service_unavailable" });
    }
  },
);
app.get(
  "/api/compliance/drivers/:id/eligibility",
  rateLimit(30),
  async (req, res) => {
    const actor = requireComplianceReviewer(req, res);
    if (!actor) return;
    const driverId = Number(req.params.id);
    if (!Number.isInteger(driverId) || driverId < 1) {
      res.status(400).json({ error: "invalid_driver_id" });
      return;
    }
    try {
      const response = await fetch(
        `${ENV.complianceReviewServiceUrl.replace(/\/$/, "")}/drivers/${driverId}/eligibility`,
        {
          headers: { "x-internal-service-token": ENV.internalServiceToken },
          signal: AbortSignal.timeout(5_000),
        },
      );
      const body = await response
        .json()
        .catch(() => ({ detail: "compliance_service_invalid_response" }));
      res.status(response.status >= 500 ? 503 : response.status).json(body);
    } catch {
      res.status(503).json({ error: "compliance_service_unavailable" });
    }
  },
);
app.post("/api/compliance/reconcile-expiry", rateLimit(5), async (req, res) => {
  const actor = requireComplianceReviewer(req, res);
  if (!actor) return;
  try {
    const { response, body } = await complianceServiceRequest(
      req,
      "/reconcile-expiry",
      "POST",
    );
    await recordOperationalEvent({
      eventType: "compliance.expiry.reconciled",
      actorId: `${actor.id}`,
      actorRole: actor.role,
      tenantId: actor.tenantId,
      route: req.path,
      outcome: response.ok ? "success" : "failure",
    });
    res.status(response.status >= 500 ? 503 : response.status).json(body);
  } catch {
    res.status(503).json({ error: "compliance_service_unavailable" });
  }
});
function requireIntegrationAdmin(req: express.Request, res: express.Response) {
  const actor = requireOperationsActor(req, res);
  if (!actor) return null;
  if (
    !new Set(["admin", "platform_admin", "super_admin"]).has(
      `${actor.role ?? ""}`.toLowerCase(),
    )
  ) {
    res.status(403).json({ error: "integration_admin_role_required" });
    return null;
  }
  return actor;
}

app.get("/api/integrations/clients", rateLimit(30), async (req, res) => {
  const actor = requireIntegrationAdmin(req, res);
  if (!actor) return;
  try {
    res.status(200).json(await listPartnerClients(actor));
  } catch (error) {
    const mapped = partnerErrorStatus(error);
    res.status(mapped.status).json({ error: mapped.code });
  }
});
app.post("/api/integrations/clients", rateLimit(8), async (req, res) => {
  const actor = requireIntegrationAdmin(req, res);
  if (!actor) return;
  try {
    const result = await registerPartnerClient(actor, {
      displayName: req.body?.displayName,
      scopes: req.body?.scopes,
      callbackSecretRef: req.body?.callbackSecretRef,
      expiresAt: req.body?.expiresAt,
    });
    await recordOperationalEvent({
      eventType: "integration.client.created",
      actorId: `${actor.id}`,
      actorRole: actor.role,
      tenantId: actor.tenantId,
      route: req.path,
      outcome: "success",
      payload: {
        clientId: result.client.id,
        credentialPrefix: result.credential.credential_prefix,
      },
    });
    res.status(201).json(result);
  } catch (error) {
    const mapped = partnerErrorStatus(error);
    res.status(mapped.status).json({ error: mapped.code });
  }
});
app.post(
  "/api/integrations/credentials/:id/revoke",
  rateLimit(8),
  async (req, res) => {
    const actor = requireIntegrationAdmin(req, res);
    if (!actor) return;
    try {
      const result = await revokePartnerCredential(actor, req.params.id);
      await recordOperationalEvent({
        eventType: "integration.credential.revoked",
        actorId: `${actor.id}`,
        actorRole: actor.role,
        tenantId: actor.tenantId,
        route: req.path,
        outcome: "success",
        payload: { credentialId: result.id },
      });
      res.status(200).json(result);
    } catch (error) {
      const mapped = partnerErrorStatus(error);
      res.status(mapped.status).json({ error: mapped.code });
    }
  },
);
app.post(
  "/api/vehicle-trackers/events/:integrationKey",
  rateLimit(300),
  async (req: AppRequest, res) => {
    const rawBody = req.rawBody;
    if (!rawBody || rawBody.length === 0) {
      res.status(400).json({ error: "vehicle_tracker_raw_body_required" });
      return;
    }
    try {
      const result = await ingestSignedVehicleTrackerEvent({
        integrationKey: req.params.integrationKey,
        rawBody,
        parsedBody: req.body,
        genericSignature: req.get("x-vehicle-tracker-signature") ?? undefined,
        samsaraSignature: req.get("x-samsara-signature") ?? undefined,
        samsaraTimestamp: req.get("x-samsara-timestamp") ?? undefined,
      });
      res.status(202).json(result);
    } catch (error) {
      const code =
        error instanceof VehicleTrackerIntegrationError
          ? error.code
          : "vehicle_tracker_payload_invalid";
      const status =
        code === "vehicle_tracker_signature_invalid"
          ? 401
          : code === "vehicle_tracker_ingress_disabled" ||
              code === "vehicle_tracker_webhook_secret_unavailable"
            ? 503
            : 400;
      res.status(status).json({ error: code });
    }
  },
);

app.post(
  "/internal/vehicle-trackers/providers/poll-once",
  rateLimit(10),
  async (req: AppRequest, res) => {
    if (!requireInternalServiceAccess(req, res)) return;
    const providerKind = req.body?.providerKind;
    if (providerKind !== "geotab_feed" && providerKind !== "traccar_rest") {
      res.status(400).json({ error: "vehicle_tracker_provider_kind_invalid" });
      return;
    }
    try {
      const result = await dispatchOneVehicleTrackerProviderIngest({
        providerKind,
        workerId: `vehicle-tracker-provider-${req.requestId ?? randomUUID()}`,
      });
      res.status(200).json(result);
    } catch (error) {
      const code =
        error instanceof VehicleTrackerProviderConsumerError
          ? error.code
          : "vehicle_tracker_provider_transport_failed";
      const status =
        code === "vehicle_tracker_provider_consumers_disabled" ||
        code === "vehicle_tracker_provider_credentials_unavailable"
          ? 503
          : code === "vehicle_tracker_provider_authentication_failed"
            ? 502
            : 400;
      res.status(status).json({ error: code });
    }
  },
);

app.post(
  "/internal/vehicle-trackers/commands/dispatch-once",
  rateLimit(10),
  async (req: AppRequest, res) => {
    if (!requireInternalServiceAccess(req, res)) return;
    try {
      const result = await dispatchOneVehiclePreventNextStartCommand({
        workerId: `vehicle-tracker-adapter-${req.requestId ?? randomUUID()}`,
      });
      res.status(200).json(result);
    } catch (error) {
      const code =
        error instanceof VehicleTrackerIntegrationError
          ? error.code
          : "vehicle_tracker_command_dispatch_failed";
      res.status(503).json({ error: code });
    }
  },
);

app.post(
  "/api/partner/events",
  rateLimit(120),
  async (req: AppRequest, res) => {
    try {
      const rawBody = req.rawBody;
      if (!rawBody || rawBody.length === 0) {
        res.status(400).json({ error: "partner_raw_body_required" });
        return;
      }
      const result = await ingestPartnerEvent({
        apiKey: req.get("x-operations-api-key"),
        eventType: req.get("x-operations-event-type"),
        externalEventId: req.get("x-operations-event-id"),
        signature: req.get("x-operations-signature"),
        rawBody,
        parsedBody: req.body,
      });
      res.status(result.idempotent ? 200 : 202).json(result);
    } catch (error) {
      const mapped = partnerErrorStatus(error);
      res.status(mapped.status).json({ error: mapped.code });
    }
  },
);

async function financialOperationsRoute(
  req: express.Request,
  res: express.Response,
  operation: (actor: {
    id: number;
    tenantId: string;
    role: string | null;
  }) => Promise<unknown>,
  status = 200,
) {
  const actor = requireOperationsActor(req, res);
  if (!actor) return;
  try {
    const result = await operation(actor);
    await recordOperationalEvent({
      eventType: "financial_operations.api",
      actorId: `${actor.id}`,
      actorRole: actor.role,
      tenantId: actor.tenantId,
      route: req.path,
      outcome: "success",
    });
    res.status(status).json(result);
  } catch (error) {
    const mapped = financialOperationsErrorStatus(error);
    await recordOperationalEvent({
      eventType: "financial_operations.api",
      actorId: `${actor.id}`,
      actorRole: actor.role,
      tenantId: actor.tenantId,
      route: req.path,
      outcome: "failure",
      payload: { code: mapped.code },
    });
    res.status(mapped.status).json({ error: mapped.code });
  }
}
app.get(
  "/api/financial-operations/snapshot",
  rateLimit(30),
  async (req, res) => {
    await financialOperationsRoute(req, res, (actor) =>
      listFinancialOperations(actor),
    );
  },
);
app.post(
  "/api/financial-operations/invoices",
  rateLimit(15),
  async (req, res) => {
    await financialOperationsRoute(
      req,
      res,
      (actor) =>
        createInvoice(actor, {
          invoiceNumber: req.body?.invoiceNumber,
          customerReference: req.body?.customerReference,
          currency: req.body?.currency,
          taxMinor: req.body?.taxMinor,
          dueAt: req.body?.dueAt,
          lines: req.body?.lines,
        }),
      201,
    );
  },
);
app.post(
  "/api/financial-operations/invoices/:id/transition",
  rateLimit(15),
  async (req, res) => {
    await financialOperationsRoute(req, res, (actor) =>
      transitionInvoice(actor, {
        invoiceId: req.params.id,
        nextState: req.body?.nextState,
      }),
    );
  },
);
app.post(
  "/api/financial-operations/disputes",
  rateLimit(15),
  async (req, res) => {
    await financialOperationsRoute(
      req,
      res,
      (actor) =>
        openDispute(actor, {
          invoiceId: req.body?.invoiceId,
          paymentReference: req.body?.paymentReference,
          disputeType: req.body?.disputeType,
          amountMinor: req.body?.amountMinor,
          currency: req.body?.currency,
          reason: req.body?.reason,
          evidenceRefs: req.body?.evidenceRefs,
        }),
      201,
    );
  },
);
app.post(
  "/api/financial-operations/disputes/:id/decision",
  rateLimit(15),
  async (req, res) => {
    await financialOperationsRoute(req, res, (actor) =>
      decideDispute(actor, {
        disputeId: req.params.id,
        nextState: req.body?.nextState,
        outcomeNote: req.body?.outcomeNote,
      }),
    );
  },
);
app.post(
  "/api/financial-operations/reports",
  rateLimit(10),
  async (req, res) => {
    await financialOperationsRoute(
      req,
      res,
      (actor) =>
        requestReport(actor, {
          reportKind: req.body?.reportKind,
          filterSpec: req.body?.filterSpec,
        }),
      202,
    );
  },
);
app.post(
  "/api/internal/financial-operations/reports/generate",
  rateLimit(10),
  async (req, res) => {
    if (!requireInternalServiceAccess(req, res)) return;
    try {
      res
        .status(200)
        .json(await generateDueReports(Number(req.body?.limit ?? 20)));
    } catch {
      res
        .status(503)
        .json({ error: "financial_report_generation_unavailable" });
    }
  },
);

app.post(
  "/api/operations/webhook-subscriptions",
  rateLimit(10),
  async (req, res) => {
    await operationsRoute(req, res, (actor) =>
      createWebhookSubscription(actor, {
        displayName: req.body?.displayName,
        endpointUrl: req.body?.endpointUrl,
        secretRef: req.body?.secretRef,
        eventTypes: req.body?.eventTypes,
      }),
    );
  },
);
app.post(
  "/api/internal/operations/webhook-deliveries",
  rateLimit(20),
  async (req, res) => {
    if (!requireInternalServiceAccess(req, res)) return;
    try {
      const limit = Number(req.body?.limit ?? 25);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
        res.status(400).json({ error: "invalid_delivery_limit" });
        return;
      }
      const result = await deliverDueOperationalWebhooks(limit);
      res.status(200).json(result);
    } catch (error) {
      res
        .status(503)
        .json({ error: "operations_webhook_delivery_unavailable" });
    }
  },
);

async function dependencyHealth(name: string, baseUrl: string | undefined) {
  const checkedAt = new Date().toISOString();
  if (!baseUrl)
    return {
      name,
      status: "unconfigured" as const,
      checkedAt,
      latencyMs: null,
      detail: "No health endpoint is configured for this dependency.",
    };
  const startedAt = Date.now();
  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, "")}/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    return {
      name,
      status: response.ok ? ("reachable" as const) : ("unhealthy" as const),
      checkedAt,
      latencyMs: Date.now() - startedAt,
      detail: response.ok
        ? null
        : `Health endpoint returned HTTP ${response.status}.`,
    };
  } catch (error) {
    const detail =
      error instanceof Error && error.name === "TimeoutError"
        ? "Health request exceeded the two-second timeout."
        : "Health endpoint could not be reached over the configured connection.";
    return {
      name,
      status: "unreachable" as const,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      detail,
    };
  }
}

const permittedFinancialSimulationScenarios = new Set([
  "database-partition",
  "broker-failure",
  "temporal-recovery",
]);
function financialSimulationConfiguration() {
  const executorUrl =
    `${process.env.FINANCIAL_SIMULATION_EXECUTOR_URL ?? ""}`.trim();
  const token =
    `${process.env.FINANCIAL_SIMULATION_EXECUTOR_TOKEN ?? ""}`.trim();
  const enabled =
    !ENV.isProduction &&
    process.env.FINANCIAL_SIMULATION_MODE === "isolated" &&
    Boolean(executorUrl && token);
  return { enabled, executorUrl, token };
}

function financialAdminDate(value: unknown, endOfDay = false) {
  const normalized = `${value ?? ""}`.trim();
  if (!normalized) return undefined;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized))
    throw new Error("invalid_financial_admin_date");
  const parsed = new Date(
    `${normalized}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}Z`,
  );
  if (Number.isNaN(parsed.getTime()))
    throw new Error("invalid_financial_admin_date");
  return parsed;
}

app.get("/api/admin/finance/overview", rateLimit(30), async (req, res) => {
  const user = requireFinancialAdministrator(req, res);
  if (!user) return;
  try {
    const sort = `${req.query.sort ?? "updated_desc"}`;
    if (
      !new Set([
        "updated_desc",
        "updated_asc",
        "created_desc",
        "created_asc",
      ]).has(sort)
    ) {
      res.status(400).json({ error: "invalid_financial_admin_sort" });
      return;
    }
    const snapshot = await getFilteredFinancialAdminSnapshot({
      query: `${req.query.query ?? ""}`,
      startDate: financialAdminDate(req.query.startDate),
      endDate: financialAdminDate(req.query.endDate, true),
      sort: sort as
        | "updated_desc"
        | "updated_asc"
        | "created_desc"
        | "created_asc",
    });
    res.status(200).json({
      ...snapshot,
      immutableIdentityEnforced: true,
      retrievedAt: new Date().toISOString(),
    });
  } catch (error) {
    if (
      error instanceof Error &&
      error.message === "invalid_financial_admin_date"
    ) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error(
      "[SwitchOS] Unable to load financial administration snapshot",
      error,
    );
    res.status(503).json({ error: "financial_admin_data_unavailable" });
  }
});

app.get("/api/admin/finance/health", rateLimit(30), async (req, res) => {
  const user = requireFinancialAdministrator(req, res);
  if (!user) return;
  const temporalBridgeUrl =
    `${process.env.TEMPORAL_BRIDGE_URL ?? ""}`.trim() || undefined;
  const dependencies = await Promise.all([
    dependencyHealth("TigerBeetle adapter", ENV.tigerbeetleServiceUrl),
    dependencyHealth("Temporal bridge", temporalBridgeUrl),
  ]);
  try {
    await Promise.all([
      recordFinancialDependencyHealth({
        dependency: "tigerbeetle",
        status: dependencies[0].status,
        latencyMs: dependencies[0].latencyMs,
        detail: dependencies[0].detail,
        observedAt: dependencies[0].checkedAt,
      }),
      recordFinancialDependencyHealth({
        dependency: "temporal",
        status: dependencies[1].status,
        latencyMs: dependencies[1].latencyMs,
        detail: dependencies[1].detail,
        observedAt: dependencies[1].checkedAt,
      }),
    ]);
    res.status(200).json({
      dependencies,
      history: await listFinancialDependencyHealthHistory(),
      database: await getFinancialDatabaseEvidence(),
      retrievedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error(
      "[SwitchOS] Unable to persist financial dependency health",
      error,
    );
    res.status(503).json({ error: "financial_health_history_unavailable" });
  }
});

app.get("/api/admin/quality/coverage", rateLimit(30), (req, res) => {
  const user = requireFinancialAdministrator(req, res);
  if (!user) return;
  res.status(200).json({
    ...coverageBaseline,
    history: coverageHistory.history,
    executionLog: playwrightExecutions.executions,
    retrievedAt: new Date().toISOString(),
  });
});

app.post(
  "/api/admin/quality/playwright/run",
  rateLimit(2),
  async (req, res) => {
    const user = requireFinancialAdministrator(req, res);
    if (!user) return;
    const executorUrl = `${process.env.PLAYWRIGHT_EXECUTOR_URL ?? ""}`
      .trim()
      .replace(/\/$/, "");
    const token = `${process.env.PLAYWRIGHT_EXECUTOR_TOKEN ?? ""}`.trim();
    if (ENV.isProduction || !executorUrl || !token) {
      res.status(409).json({
        error: "playwright_execution_unavailable",
        detail:
          "Only an explicitly configured isolated non-production executor can run browser workflows.",
      });
      return;
    }
    try {
      const response = await fetch(`${executorUrl}/playwright/run`, {
        method: "POST",
        headers: { "X-Internal-Service-Token": token },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error("executor_unavailable");
      await recordOperationalEvent({
        eventType: "quality.playwright.requested",
        actorId: `${user.id}`,
        actorRole: user.role ?? null,
        tenantId: user.tenantId ?? null,
        route: req.path,
        outcome: "success",
        payload: {},
      });
      res.status(202).json({ status: "submitted" });
    } catch {
      res.status(503).json({ error: "playwright_executor_unavailable" });
    }
  },
);

app.get(
  "/api/admin/finance/dead-letter-cases",
  rateLimit(30),
  async (req, res) => {
    const user = requireFinancialAdministrator(req, res);
    if (!user) return;
    const limit = Number(req.query.limit ?? 50);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      res.status(400).json({ error: "invalid_dead_letter_case_limit" });
      return;
    }
    try {
      res.status(200).json({
        cases: await listFinancialDeadLetterCases(Number(user.id), limit),
        retrievedAt: new Date().toISOString(),
      });
    } catch (error) {
      console.error(
        "[SwitchOS] Unable to list financial dead-letter cases",
        error,
      );
      res
        .status(503)
        .json({ error: "financial_dead_letter_cases_unavailable" });
    }
  },
);

app.post(
  "/api/admin/finance/dead-letter-cases",
  rateLimit(5),
  async (req, res) => {
    const user = requireFinancialAdministrator(req, res);
    if (!user) return;
    const outboxId = `${req.body?.outboxId ?? ""}`.trim();
    const reason = `${req.body?.reason ?? ""}`.trim();
    const investigationDigestHex =
      `${req.body?.investigationDigestHex ?? ""}`.trim();
    const idempotencyKey = `${req.body?.idempotencyKey ?? ""}`.trim();
    if (
      !/^[1-9][0-9]{0,18}$/.test(outboxId) ||
      reason.length < 3 ||
      reason.length > 1000 ||
      !/^[a-f0-9]{64}$/.test(investigationDigestHex) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)
    ) {
      res.status(400).json({ error: "invalid_dead_letter_case_request" });
      return;
    }
    try {
      const result = await openFinancialDeadLetterCase({
        actorId: Number(user.id),
        outboxId,
        reason,
        investigationDigestHex,
        idempotencyKey,
      });
      await recordOperationalEvent({
        eventType: "finance.dead_letter.case.opened",
        actorId: `${user.id}`,
        actorRole: user.role ?? null,
        tenantId: user.tenantId ?? null,
        route: req.path,
        outcome: "success",
        payload: { outboxId, caseId: result.caseId },
      });
      res.status(201).json(result);
    } catch (error) {
      console.error(
        "[SwitchOS] Unable to open financial dead-letter case",
        error,
      );
      res
        .status(409)
        .json({ error: "financial_dead_letter_case_open_rejected" });
    }
  },
);

app.post(
  "/api/admin/finance/dead-letter-cases/:caseId/remediation-requests",
  rateLimit(5),
  async (req, res) => {
    const user = requireFinancialAdministrator(req, res);
    if (!user) return;
    const caseId = `${req.params.caseId ?? ""}`.trim();
    const reason = `${req.body?.reason ?? ""}`.trim();
    const ledgerDisposition = `${req.body?.ledgerDisposition ?? ""}`.trim();
    const reconciliationReference =
      `${req.body?.reconciliationReference ?? ""}`.trim();
    const reconciliationDigestHex =
      `${req.body?.reconciliationDigestHex ?? ""}`.trim();
    const replacementTransferId =
      `${req.body?.replacementTransferId ?? ""}`.trim();
    const replacementIlpPacket =
      `${req.body?.replacementIlpPacket ?? ""}`.trim();
    const replacementCondition =
      `${req.body?.replacementCondition ?? ""}`.trim();
    const replacementExpiration =
      `${req.body?.replacementExpiration ?? ""}`.trim();
    const idempotencyKey = `${req.body?.idempotencyKey ?? ""}`.trim();
    if (
      !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(caseId) ||
      reason.length < 3 ||
      reason.length > 1000 ||
      ![
        "confirmed_not_committed",
        "committed",
        "uncertain",
        "unavailable",
      ].includes(ledgerDisposition) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/.-]{2,199}$/.test(reconciliationReference) ||
      !/^[a-f0-9]{64}$/.test(reconciliationDigestHex) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/.test(replacementTransferId) ||
      replacementIlpPacket.length < 3 ||
      replacementIlpPacket.length > 16384 ||
      !/^[A-Za-z0-9_-]{16,255}$/.test(replacementCondition) ||
      Number.isNaN(Date.parse(replacementExpiration)) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)
    ) {
      res
        .status(400)
        .json({ error: "invalid_dead_letter_remediation_request" });
      return;
    }
    try {
      const result = await requestFinancialDeadLetterRemediation({
        actorId: Number(user.id),
        caseId,
        reason,
        ledgerDisposition: ledgerDisposition as
          | "confirmed_not_committed"
          | "committed"
          | "uncertain"
          | "unavailable",
        reconciliationReference,
        reconciliationDigestHex,
        replacementTransferId,
        replacementIlpPacket,
        replacementCondition,
        replacementExpiration,
        idempotencyKey,
      });
      await recordOperationalEvent({
        eventType: "finance.dead_letter.remediation.requested",
        actorId: `${user.id}`,
        actorRole: user.role ?? null,
        tenantId: user.tenantId ?? null,
        route: req.path,
        outcome: "success",
        payload: { caseId, ledgerDisposition, replacementTransferId },
      });
      res.status(202).json(result);
    } catch (error) {
      console.error(
        "[SwitchOS] Unable to request financial remediation",
        error,
      );
      res
        .status(409)
        .json({ error: "financial_dead_letter_remediation_rejected" });
    }
  },
);

app.post(
  "/api/admin/finance/dead-letter-cases/:caseId/approve",
  rateLimit(5),
  async (req, res) => {
    const user = requireFinancialAdministrator(req, res);
    if (!user) return;
    const caseId = `${req.params.caseId ?? ""}`.trim();
    const approvalReason = `${req.body?.approvalReason ?? ""}`.trim();
    const idempotencyKey = `${req.body?.idempotencyKey ?? ""}`.trim();
    if (
      !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(caseId) ||
      approvalReason.length < 3 ||
      approvalReason.length > 1000 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)
    ) {
      res.status(400).json({ error: "invalid_dead_letter_approval" });
      return;
    }
    try {
      const result = await approveFinancialDeadLetterRemediation({
        actorId: Number(user.id),
        caseId,
        approvalReason,
        idempotencyKey,
      });
      await recordOperationalEvent({
        eventType: "finance.dead_letter.remediation.approved",
        actorId: `${user.id}`,
        actorRole: user.role ?? null,
        tenantId: user.tenantId ?? null,
        route: req.path,
        outcome: "success",
        payload: {
          caseId,
          remediationOutboxId: result.remediationOutboxId,
          replacementTransferId: result.replacementTransferId,
        },
      });
      res.status(201).json(result);
    } catch (error) {
      console.error(
        "[SwitchOS] Unable to approve financial remediation",
        error,
      );
      res
        .status(409)
        .json({ error: "financial_dead_letter_independent_approval_required" });
    }
  },
);

app.get(
  "/api/admin/finance/dead-letter-cases/:caseId/head-resolution",
  rateLimit(10),
  async (req, res) => {
    const user = requireFinancialAdministrator(req, res);
    if (!user) return;
    const caseId = `${req.params.caseId ?? ""}`.trim();
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(caseId)) {
      res.status(400).json({ error: "invalid_dead_letter_case_id" });
      return;
    }
    try {
      const resolution = await getFinancialDeadLetterHeadResolution({
        actorId: Number(user.id),
        caseId,
      });
      if (!resolution) {
        res.status(404).json({ error: "financial_dead_letter_head_resolution_not_found" });
        return;
      }
      res.status(200).json({ resolution, retrievedAt: new Date().toISOString() });
    } catch (error) {
      console.error("[SwitchOS] Unable to get financial dead-letter head resolution", error);
      res.status(503).json({ error: "financial_dead_letter_head_resolution_unavailable" });
    }
  },
);

app.post(
  "/api/admin/finance/dead-letter-cases/:caseId/head-resolution-requests",
  rateLimit(5),
  async (req, res) => {
    const user = requireFinancialAdministrator(req, res);
    if (!user) return;
    const caseId = `${req.params.caseId ?? ""}`.trim();
    const resolutionDisposition = `${req.body?.resolutionDisposition ?? ""}`.trim();
    const reason = `${req.body?.reason ?? ""}`.trim();
    const reconciliationReference = `${req.body?.reconciliationReference ?? ""}`.trim();
    const reconciliationDigestHex = `${req.body?.reconciliationDigestHex ?? ""}`.trim();
    const idempotencyKey = `${req.body?.idempotencyKey ?? ""}`.trim();
    if (
      !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(caseId) ||
      ![
        "original_confirmed_committed_resolved",
        "original_confirmed_not_committed_superseded",
      ].includes(resolutionDisposition) ||
      reason.length < 3 ||
      reason.length > 1000 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/.-]{2,199}$/.test(reconciliationReference) ||
      !/^[a-f0-9]{64}$/.test(reconciliationDigestHex) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)
    ) {
      res.status(400).json({ error: "invalid_dead_letter_head_resolution_request" });
      return;
    }
    try {
      const result = await requestFinancialDeadLetterHeadResolution({
        actorId: Number(user.id),
        caseId,
        resolutionDisposition: resolutionDisposition as
          | "original_confirmed_committed_resolved"
          | "original_confirmed_not_committed_superseded",
        reason,
        reconciliationReference,
        reconciliationDigestHex,
        idempotencyKey,
      });
      await recordOperationalEvent({
        eventType: "finance.dead_letter.head_resolution.requested",
        actorId: `${user.id}`,
        actorRole: user.role ?? null,
        tenantId: user.tenantId ?? null,
        route: req.path,
        outcome: "success",
        payload: { caseId, resolutionDisposition, resolutionId: result.resolutionId },
      });
      res.status(202).json(result);
    } catch (error) {
      console.error("[SwitchOS] Unable to request financial dead-letter head resolution", error);
      res.status(409).json({ error: "financial_dead_letter_head_resolution_request_rejected" });
    }
  },
);

app.post(
  "/api/admin/finance/dead-letter-cases/:caseId/head-resolution-approve",
  rateLimit(5),
  async (req, res) => {
    const user = requireFinancialAdministrator(req, res);
    if (!user) return;
    const caseId = `${req.params.caseId ?? ""}`.trim();
    const reason = `${req.body?.reason ?? ""}`.trim();
    const idempotencyKey = `${req.body?.idempotencyKey ?? ""}`.trim();
    if (
      !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(caseId) ||
      reason.length < 3 ||
      reason.length > 1000 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)
    ) {
      res.status(400).json({ error: "invalid_dead_letter_head_resolution_approval" });
      return;
    }
    try {
      const result = await approveFinancialDeadLetterHeadResolution({
        actorId: Number(user.id),
        caseId,
        reason,
        idempotencyKey,
      });
      await recordOperationalEvent({
        eventType: "finance.dead_letter.head_resolution.approved",
        actorId: `${user.id}`,
        actorRole: user.role ?? null,
        tenantId: user.tenantId ?? null,
        route: req.path,
        outcome: "success",
        payload: {
          caseId,
          resolutionId: result.resolutionId,
          resolutionDisposition: result.resolutionDisposition,
        },
      });
      res.status(201).json(result);
    } catch (error) {
      console.error("[SwitchOS] Unable to approve financial dead-letter head resolution", error);
      res.status(409).json({ error: "financial_dead_letter_head_resolution_independent_approval_required" });
    }
  },
);

app.post(
  "/api/admin/finance/dead-letter-cases/:caseId/head-resolution-reject",
  rateLimit(5),
  async (req, res) => {
    const user = requireFinancialAdministrator(req, res);
    if (!user) return;
    const caseId = `${req.params.caseId ?? ""}`.trim();
    const reason = `${req.body?.reason ?? ""}`.trim();
    const idempotencyKey = `${req.body?.idempotencyKey ?? ""}`.trim();
    if (
      !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(caseId) ||
      reason.length < 3 ||
      reason.length > 1000 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)
    ) {
      res.status(400).json({ error: "invalid_dead_letter_head_resolution_rejection" });
      return;
    }
    try {
      const result = await rejectFinancialDeadLetterHeadResolution({
        actorId: Number(user.id),
        caseId,
        reason,
        idempotencyKey,
      });
      await recordOperationalEvent({
        eventType: "finance.dead_letter.head_resolution.rejected",
        actorId: `${user.id}`,
        actorRole: user.role ?? null,
        tenantId: user.tenantId ?? null,
        route: req.path,
        outcome: "success",
        payload: { caseId, resolutionId: result.resolutionId },
      });
      res.status(200).json(result);
    } catch (error) {
      console.error("[SwitchOS] Unable to reject financial dead-letter head resolution", error);
      res.status(409).json({ error: "financial_dead_letter_head_resolution_rejection_rejected" });
    }
  },
);

app.post(
  "/api/admin/finance/dead-letter-cases/:caseId/reject",
  rateLimit(5),
  async (req, res) => {
    const user = requireFinancialAdministrator(req, res);
    if (!user) return;
    const caseId = `${req.params.caseId ?? ""}`.trim();
    const reason = `${req.body?.reason ?? ""}`.trim();
    const idempotencyKey = `${req.body?.idempotencyKey ?? ""}`.trim();
    if (
      !/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(caseId) ||
      reason.length < 3 ||
      reason.length > 1000 ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)
    ) {
      res.status(400).json({ error: "invalid_dead_letter_rejection" });
      return;
    }
    try {
      const result = await rejectFinancialDeadLetterRemediation({
        actorId: Number(user.id),
        caseId,
        reason,
        idempotencyKey,
      });
      await recordOperationalEvent({
        eventType: "finance.dead_letter.remediation.rejected",
        actorId: `${user.id}`,
        actorRole: user.role ?? null,
        tenantId: user.tenantId ?? null,
        route: req.path,
        outcome: "success",
        payload: { caseId },
      });
      res.status(200).json(result);
    } catch (error) {
      console.error("[SwitchOS] Unable to reject financial remediation", error);
      res
        .status(409)
        .json({ error: "financial_dead_letter_rejection_rejected" });
    }
  },
);

app.get("/api/admin/finance/alerts", rateLimit(30), async (req, res) => {
  const user = requireFinancialAdministrator(req, res);
  if (!user) return;
  try {
    res.status(200).json({
      alerts: await getFinancialAdminAlerts(),
      retrievedAt: new Date().toISOString(),
    });
  } catch (error) {
    console.error(
      "[SwitchOS] Unable to load financial administration alerts",
      error,
    );
    res.status(503).json({ error: "financial_admin_alerts_unavailable" });
  }
});

app.get("/api/admin/finance/settings", rateLimit(30), async (req, res) => {
  const user = requireFinancialAdministrator(req, res);
  if (!user) return;
  try {
    res.status(200).json({ settings: await getFinancialAdminSettings() });
  } catch {
    res.status(503).json({ error: "financial_admin_settings_unavailable" });
  }
});

app.post("/api/admin/finance/settings", rateLimit(5), async (req, res) => {
  const user = requireFinancialAdministrator(req, res);
  if (!user) return;
  const autoEscalationEnabled = Boolean(req.body?.autoEscalationEnabled);
  const autoEscalationMinutes = Number(req.body?.autoEscalationMinutes);
  const healthRetentionDays = Number(req.body?.healthRetentionDays);
  const onCallWebhooks = Array.isArray(req.body?.onCallWebhooks)
    ? req.body.onCallWebhooks
        .filter((item: unknown) => typeof item === "string")
        .map((item: string) => item.trim())
        .filter(Boolean)
        .slice(0, 5)
    : [];
  const approvedWebhookHosts = Array.isArray(req.body?.approvedWebhookHosts)
    ? req.body.approvedWebhookHosts
        .filter((item: unknown) => typeof item === "string")
        .map((item: string) => item.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 20)
    : [];
  const safeHost = (host: string) =>
    /^[a-z0-9.-]+$/.test(host) &&
    !host.includes("..") &&
    !host.startsWith(".") &&
    !host.endsWith(".");
  const validWebhooks = onCallWebhooks.every((value: string) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" && approvedWebhookHosts.includes(url.hostname)
      );
    } catch {
      return false;
    }
  });
  if (
    !Number.isInteger(autoEscalationMinutes) ||
    autoEscalationMinutes < 5 ||
    autoEscalationMinutes > 10080 ||
    !Number.isInteger(healthRetentionDays) ||
    healthRetentionDays < 1 ||
    healthRetentionDays > 365 ||
    !approvedWebhookHosts.every(safeHost) ||
    !validWebhooks
  ) {
    res.status(400).json({ error: "invalid_financial_admin_settings" });
    return;
  }
  try {
    const settings = await updateFinancialAdminSettings({
      autoEscalationEnabled,
      autoEscalationMinutes,
      onCallWebhooks,
      approvedWebhookHosts,
      healthRetentionDays,
      actorId: Number(user.id),
    });
    await recordOperationalEvent({
      eventType: "finance.admin.settings.updated",
      actorId: `${user.id}`,
      actorRole: user.role ?? null,
      tenantId: user.tenantId ?? null,
      route: req.path,
      outcome: "success",
      payload: {
        autoEscalationEnabled,
        autoEscalationMinutes,
        webhookCount: onCallWebhooks.length,
        approvedHostCount: approvedWebhookHosts.length,
        healthRetentionDays,
      },
    });
    res.status(200).json({ settings });
  } catch {
    res.status(503).json({ error: "financial_admin_settings_unavailable" });
  }
});

app.get(
  "/api/admin/finance/alert-delivery-receipts",
  rateLimit(30),
  async (req, res) => {
    const user = requireFinancialAdministrator(req, res);
    if (!user) return;
    try {
      res.status(200).json({
        receipts: await listFinancialAlertDeliveryReceipts(),
        retrievedAt: new Date().toISOString(),
      });
    } catch {
      res.status(503).json({ error: "financial_alert_receipts_unavailable" });
    }
  },
);

app.post(
  "/api/internal/finance/alert-delivery-receipts",
  rateLimit(60),
  async (req, res) => {
    const expectedToken =
      `${process.env.FINANCE_ROUTING_RECEIPT_TOKEN ?? ""}`.trim();
    const providedToken =
      `${req.header("X-Internal-Service-Token") ?? ""}`.trim();
    if (!expectedToken || !tokensEqual(providedToken, expectedToken)) {
      res.status(401).json({ error: "unauthorized_receipt_source" });
      return;
    }
    const alertId = `${req.body?.alertId ?? ""}`.trim();
    const webhookHost = `${req.body?.webhookHost ?? ""}`.trim().toLowerCase();
    const status = `${req.body?.status ?? ""}`.trim();
    const detail = `${req.body?.detail ?? ""}`.trim().slice(0, 500) || null;
    const retryAttempt = Number(req.body?.retryAttempt ?? 0);
    if (
      !/^(reconciliation-\d+|dependency-(tigerbeetle|temporal)|database-tls|migration-age)$/.test(
        alertId,
      ) ||
      !/^[a-z0-9.-]+$/.test(webhookHost) ||
      !["queued", "delivered", "failed"].includes(status) ||
      !Number.isInteger(retryAttempt) ||
      retryAttempt < 0 ||
      retryAttempt > 10
    ) {
      res.status(400).json({ error: "invalid_delivery_receipt" });
      return;
    }
    try {
      res.status(202).json(
        await recordFinancialAlertDeliveryReceipt({
          alertId,
          webhookHost,
          status: status as "queued" | "delivered" | "failed",
          detail,
          retryAttempt,
        }),
      );
    } catch {
      res.status(503).json({ error: "receipt_persistence_unavailable" });
    }
  },
);

app.post(
  "/api/admin/finance/alerts/:id/actions",
  rateLimit(10),
  async (req, res) => {
    const user = requireFinancialAdministrator(req, res);
    if (!user) return;
    const alertId = `${req.params.id ?? ""}`.trim();
    const action = `${req.body?.action ?? ""}`.trim();
    const note = `${req.body?.note ?? ""}`.trim();
    if (
      !/^(reconciliation-\d+|dependency-(tigerbeetle|temporal)|database-tls|migration-age)$/.test(
        alertId,
      ) ||
      !["acknowledge", "dismiss", "note", "assign"].includes(action) ||
      note.length > 500 ||
      (action === "note" && !note)
    ) {
      res.status(400).json({ error: "invalid_financial_alert_action" });
      return;
    }
    try {
      await recordFinancialAdminAlertAction({
        alertId,
        action: action as "acknowledge" | "dismiss" | "note",
        note: note || null,
        actorId: Number(user.id),
      });
      if (action === "assign") {
        const { assignAlertOwnership } = await import("./financialAdminStore");
        const assignedTo = parseInt(String(req.body.assignedTo), 10);
        const escalationDeadline =
          typeof req.body.escalationDeadline === "string" &&
          req.body.escalationDeadline
            ? req.body.escalationDeadline
            : null;
        if (!Number.isFinite(assignedTo) || assignedTo <= 0) {
          res
            .status(400)
            .json({ error: "Valid assignedTo operator ID required." });
          return;
        }
        await assignAlertOwnership({
          alertId,
          assignedTo,
          escalationDeadline,
          actorId: Number(user.id),
        });
        await recordOperationalEvent({
          eventType: "finance.alert.assign",
          actorId: `${user.id}`,
          actorRole: user.role ?? null,
          tenantId: user.tenantId ?? null,
          route: req.path,
          outcome: "success",
          payload: {
            alertId,
            action: "assign",
            assignedTo,
            escalationDeadline,
          },
        });
        res.status(200).json({
          ok: true,
          alertId,
          action: "assign",
          assignedTo,
          escalationDeadline,
        });
        return;
      }
      await recordOperationalEvent({
        eventType: "finance.alert.action",
        actorId: `${user.id}`,
        actorRole: user.role ?? null,
        tenantId: user.tenantId ?? null,
        route: req.path,
        outcome: "success",
        payload: { alertId, action },
      });
      res.status(200).json({ ok: true });
    } catch (error) {
      console.error(
        "[SwitchOS] Unable to persist financial alert action",
        error,
      );
      res.status(503).json({ error: "financial_alert_action_unavailable" });
    }
  },
);

app.get(
  "/api/admin/finance/alert-actions/history.csv",
  rateLimit(10),
  async (req, res) => {
    const user = requireFinancialAdministrator(req, res);
    if (!user) return;
    try {
      const rows = await getAlertActionHistory();
      const safe = (v: string | null) =>
        v
          ? `"${String(v)
              .replace(/"/g, '""')
              .replace(/[\r\n]+/g, " ")
              .replace(/^[=+\-@\t\r]/g, "'$&")}"`
          : "";
      const header =
        "alert_id,action,note,actor_id,assigned_to,escalation_deadline,created_at";
      const csv = [
        header,
        ...rows.map((r) =>
          [
            safe(r.alertId),
            safe(r.action),
            safe(r.note),
            r.actorId,
            r.assignedTo ?? "",
            r.escalationDeadline ? safe(r.escalationDeadline) : "",
            safe(r.createdAt),
          ].join(","),
        ),
      ].join("\n");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="alert-action-history-${new Date().toISOString().slice(0, 10)}.csv"`,
      );
      res.setHeader("X-Row-Count", String(rows.length));
      res.status(200).send(csv);
    } catch (error) {
      console.error("[SwitchOS] Unable to export alert-action history", error);
      res.status(503).json({ error: "alert_action_export_unavailable" });
    }
  },
);

app.get(
  "/api/admin/finance/alert-escalations",
  rateLimit(30),
  async (req, res) => {
    const user = requireFinancialAdministrator(req, res);
    if (!user) return;
    try {
      const escalations = await getAlertEscalations();
      res
        .status(200)
        .json({ escalations, retrievedAt: new Date().toISOString() });
    } catch (error) {
      console.error("[SwitchOS] Unable to retrieve alert escalations", error);
      res.status(503).json({ error: "alert_escalations_unavailable" });
    }
  },
);

function financialCsvCell(value: string | number | null | undefined) {
  const normalized = `${value ?? ""}`.replace(/\r?\n/g, " ");
  const formulaSafe = /^[=+\-@]/.test(normalized)
    ? `'${normalized}`
    : normalized;
  return `"${formulaSafe.replace(/"/g, '""')}"`;
}

app.get("/api/admin/finance/report.csv", rateLimit(10), async (req, res) => {
  const user = requireFinancialAdministrator(req, res);
  if (!user) return;
  try {
    const sort = `${req.query.sort ?? "updated_desc"}`;
    if (
      !new Set([
        "updated_desc",
        "updated_asc",
        "created_desc",
        "created_asc",
      ]).has(sort)
    )
      throw new Error("invalid_financial_admin_sort");
    const snapshot = await getFilteredFinancialAdminSnapshot({
      query: `${req.query.query ?? ""}`,
      startDate: financialAdminDate(req.query.startDate),
      endDate: financialAdminDate(req.query.endDate, true),
      sort: sort as
        | "updated_desc"
        | "updated_asc"
        | "created_desc"
        | "created_asc",
    });
    const rows = [
      [
        "record_type",
        "record_id",
        "payer_fsp",
        "payee_fsp",
        "amount_minor",
        "currency",
        "state",
        "refunded_minor",
        "net_settled_minor",
        "recorded_at",
      ]
        .map(financialCsvCell)
        .join(","),
      ...snapshot.immutableTransfers.map((item) =>
        [
          "transfer",
          item.transferId,
          item.payerFsp,
          item.payeeFsp,
          item.amountMinor,
          item.currency,
          item.state,
          "",
          "",
          item.updatedAt,
        ]
          .map(financialCsvCell)
          .join(","),
      ),
      ...snapshot.inconsistentReconciliations.map((item) =>
        [
          "reconciliation",
          item.transferId,
          "",
          "",
          "",
          "",
          item.transferState,
          item.platformRefundedMinor,
          item.platformNetSettledMinor,
          item.createdAt,
        ]
          .map(financialCsvCell)
          .join(","),
      ),
    ];
    await recordOperationalEvent({
      eventType: "finance.report.exported",
      actorId: `${user.id}`,
      actorRole: user.role ?? null,
      tenantId: user.tenantId ?? null,
      route: req.path,
      outcome: "success",
      payload: { rowCount: rows.length - 1 },
    });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      'attachment; filename="financial-administration-report.csv"',
    );
    res.setHeader("X-Exported-Row-Count", `${rows.length - 1}`);
    res.status(200).send(rows.join("\n"));
  } catch (error) {
    const code =
      error instanceof Error &&
      ["invalid_financial_admin_date", "invalid_financial_admin_sort"].includes(
        error.message,
      )
        ? error.message
        : "financial_report_export_unavailable";
    res.status(code.startsWith("invalid_") ? 400 : 503).json({ error: code });
  }
});

app.get("/api/admin/finance/simulations", rateLimit(30), (req, res) => {
  const user = requireFinancialAdministrator(req, res);
  if (!user) return;
  const configuration = financialSimulationConfiguration();
  res.status(200).json({
    enabled: configuration.enabled,
    scenarios: [...permittedFinancialSimulationScenarios],
    productionBlocked: ENV.isProduction,
  });
});

app.post(
  "/api/admin/finance/simulations/:scenario",
  rateLimit(3),
  async (req, res) => {
    const user = requireFinancialAdministrator(req, res);
    if (!user) return;
    const scenario = `${req.params.scenario ?? ""}`.trim();
    if (!permittedFinancialSimulationScenarios.has(scenario)) {
      res.status(400).json({ error: "unsupported_financial_simulation" });
      return;
    }
    const configuration = financialSimulationConfiguration();
    if (!configuration.enabled) {
      res.status(409).json({
        error: "financial_simulation_unavailable",
        detail:
          "Only an explicitly configured isolated non-production executor can run scenarios.",
      });
      return;
    }
    try {
      const response = await fetch(
        `${configuration.executorUrl.replace(/\/$/, "")}/scenarios/${scenario}`,
        {
          method: "POST",
          headers: { "X-Internal-Service-Token": configuration.token },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (!response.ok) throw new Error(`executor returned ${response.status}`);
      await recordOperationalEvent({
        eventType: "finance.simulation.requested",
        actorId: `${user.id}`,
        actorRole: user.role ?? null,
        tenantId: user.tenantId ?? null,
        route: req.path,
        outcome: "success",
        payload: { scenario },
      });
      res.status(202).json({ scenario, status: "submitted" });
    } catch (error) {
      console.error(
        "[SwitchOS] Financial simulation executor unavailable",
        error,
      );
      res
        .status(503)
        .json({ error: "financial_simulation_executor_unavailable" });
    }
  },
);

app.get("/api/admin/finance/topology", rateLimit(30), async (req, res) => {
  const user = requireFinancialAdministrator(req, res);
  if (!user) return;
  try {
    res.status(200).json({
      edges: await getFinancialTopology(),
      retrievedAt: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({ error: "financial_topology_unavailable" });
  }
});

app.get("/api/v1/openapi.json", rateLimit(30), (_req, res) => {
  res.status(200).json(developerOpenApi);
});

app.post(
  "/api/v1/field-service/work-orders",
  rateLimit(60),
  async (req, res) => {
    const rawApiKey = readDeveloperApiKey(req, res);
    if (!rawApiKey) return;
    const idempotencyKey = `${req.header("Idempotency-Key") ?? ""}`.trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/.test(idempotencyKey)) {
      res.status(400).json({ error: "idempotency_key_required" });
      return;
    }
    try {
      const outcome = await createPublicFieldServiceWorkOrder({
        rawApiKey,
        idempotencyKey,
        ...parseDeveloperWorkOrder(req.body),
      });
      await recordOperationalEvent({
        eventType: "developer.field_service.work_order.created",
        route: req.path,
        outcome: "success",
        payload: { workOrderId: outcome.body.id, status: outcome.status },
      });
      res.status(outcome.status).json(outcome.body);
    } catch (error) {
      await recordOperationalEvent({
        eventType: "developer.field_service.work_order.created",
        route: req.path,
        outcome: "failure",
        payload: {
          error: error instanceof Error ? error.message : "unknown_error",
        },
      });
      developerApiFailure(res, error);
    }
  },
);

app.get(
  "/api/v1/field-service/work-orders",
  rateLimit(120),
  async (req, res) => {
    const rawApiKey = readDeveloperApiKey(req, res);
    if (!rawApiKey) return;
    const rawLimit = `${req.query.limit ?? "50"}`;
    const limit = Number(rawLimit);
    const updatedBefore =
      req.query.updatedBefore === undefined
        ? null
        : `${req.query.updatedBefore}`.trim();
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 100 ||
      (updatedBefore !== null && Number.isNaN(Date.parse(updatedBefore)))
    ) {
      res.status(400).json({ error: "invalid_work_order_collection_query" });
      return;
    }
    try {
      const workOrders = await listPublicFieldServiceWorkOrders({
        rawApiKey,
        limit,
        updatedBefore,
      });
      await recordOperationalEvent({
        eventType: "developer.field_service.work_order.list",
        route: req.path,
        outcome: "success",
        payload: { count: workOrders.length },
      });
      res.status(200).json({ workOrders });
    } catch (error) {
      await recordOperationalEvent({
        eventType: "developer.field_service.work_order.list",
        route: req.path,
        outcome: "failure",
        payload: {
          error: error instanceof Error ? error.message : "unknown_error",
        },
      });
      developerApiFailure(res, error);
    }
  },
);

app.get(
  "/api/v1/field-service/work-orders/:id",
  rateLimit(120),
  async (req, res) => {
    const rawApiKey = readDeveloperApiKey(req, res);
    if (!rawApiKey) return;
    const workOrderId = `${req.params.id ?? ""}`.trim();
    if (!/^[0-9a-f-]{36}$/i.test(workOrderId)) {
      res.status(400).json({ error: "invalid_work_order_id" });
      return;
    }
    try {
      const workOrder = await getPublicFieldServiceWorkOrder({
        rawApiKey,
        workOrderId,
      });
      await recordOperationalEvent({
        eventType: "developer.field_service.work_order.read",
        route: req.path,
        outcome: "success",
        payload: { workOrderId },
      });
      res.status(200).json(workOrder);
    } catch (error) {
      await recordOperationalEvent({
        eventType: "developer.field_service.work_order.read",
        route: req.path,
        outcome: "failure",
        payload: {
          workOrderId,
          error: error instanceof Error ? error.message : "unknown_error",
        },
      });
      developerApiFailure(res, error);
    }
  },
);

app.get("/api/deliveries/:id/tracking", rateLimit(60), async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user || !user.tenantId) return;
  try {
    const location = await getLatestDeliveryLocation({
      deliveryId: `${req.params.id ?? ""}`.trim(),
      tenantId: Number(user.tenantId),
    });
    res.status(200).json({ location, retrievedAt: new Date().toISOString() });
  } catch {
    res.status(503).json({ error: "delivery_tracking_unavailable" });
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
        setupUrl:
          ENV.enableExternalOidc && ENV.oidcIssuerUrl
            ? `${ENV.oidcIssuerUrl}/account/#/security/signingin`
            : null,
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

app.delete(
  "/api/auth/security/sessions/:id",
  rateLimit(10),
  async (req, res) => {
    const user = requireAuthenticatedOperator(req, res);
    if (!user) return;
    const sessionId = `${req.params.id ?? ""}`.trim();
    if (!/^[0-9a-f-]{36}$/i.test(sessionId)) {
      res.status(400).json({ error: "invalid_session_id" });
      return;
    }
    try {
      const revoked = await revokeOperatorSecuritySession(
        Number(user.id),
        sessionId,
      );
      if (!revoked) {
        res.status(404).json({ error: "session_not_found" });
        return;
      }
      if (user.sessionId === sessionId)
        res.clearCookie(COOKIE_NAME, getCookieOptions());
      await recordOperationalEvent({
        eventType: "auth.security.session_revoked",
        actorId: `${user.id}`,
        actorRole: user.role ?? null,
        tenantId: user.tenantId ?? null,
        route: req.path,
        outcome: "success",
      });
      res.status(200).json({
        ok: true,
        currentSessionRevoked: user.sessionId === sessionId,
      });
    } catch (error) {
      console.error("[SwitchOS] Unable to revoke security session", error);
      res.status(503).json({ error: "security_session_revoke_failed" });
    }
  },
);

function securityCsvCell(value: string | number | boolean | null | undefined) {
  const normalized = `${value ?? ""}`.replace(/\r?\n/g, " ");
  const formulaSafe = /^[=+\-@]/.test(normalized)
    ? `'${normalized}`
    : normalized;
  return `"${formulaSafe.replace(/"/g, '""')}"`;
}

app.get(
  "/api/auth/security/login-activity.csv",
  rateLimit(10),
  async (req, res) => {
    const user = requireAuthenticatedOperator(req, res);
    if (!user) return;
    try {
      const activity = await listOperatorSecurityLoginActivity(Number(user.id));
      const csv = [
        [
          "auth_source",
          "mfa_verified",
          "assurance_level",
          "created_at",
          "last_seen_at",
          "status",
          "browser",
        ]
          .map(securityCsvCell)
          .join(","),
        ...activity.map((entry) =>
          [
            entry.auth_source,
            entry.mfa_authenticated ? "yes" : "no",
            entry.assurance_level,
            entry.created_at,
            entry.last_seen_at,
            entry.revoked_at ? "revoked" : "active",
            entry.user_agent,
          ]
            .map(securityCsvCell)
            .join(","),
        ),
      ].join("\n");
      await recordOperationalEvent({
        eventType: "auth.security.login_activity_exported",
        actorId: `${user.id}`,
        actorRole: user.role ?? null,
        tenantId: user.tenantId ?? null,
        route: req.path,
        outcome: "success",
        payload: { rowCount: activity.length },
      });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="security-login-activity.csv"',
      );
      res.setHeader("X-Exported-Row-Count", `${activity.length}`);
      res.status(200).send(csv);
    } catch (error) {
      console.error("[SwitchOS] Unable to export login activity", error);
      res.status(503).json({ error: "security_login_activity_export_failed" });
    }
  },
);

app.post(
  "/api/auth/security/sessions/revoke-others",
  rateLimit(5),
  async (req, res) => {
    const user = requireAuthenticatedOperator(req, res);
    if (!user) return;
    if (!user.sessionId) {
      res.status(409).json({ error: "security_session_registry_required" });
      return;
    }
    try {
      const revokedSessions = await revokeOtherOperatorSecuritySessions(
        Number(user.id),
        user.sessionId,
      );
      await recordOperationalEvent({
        eventType: "auth.security.other_sessions_revoked",
        actorId: `${user.id}`,
        actorRole: user.role ?? null,
        tenantId: user.tenantId ?? null,
        route: req.path,
        outcome: "success",
        payload: { revokedSessions },
      });
      res.status(200).json({ ok: true, revokedSessions });
    } catch (error) {
      console.error(
        "[SwitchOS] Unable to revoke other security sessions",
        error,
      );
      res.status(503).json({ error: "security_other_sessions_revoke_failed" });
    }
  },
);

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
  const requiresStepUp = privilegedTenantMutationPrefixes.some(
    (prefix) => req.path === prefix || req.path.startsWith(`${prefix}/`),
  );
  if (
    !ENV.requireMfaForPrivilegedActions ||
    !isMutation ||
    !requiresStepUp ||
    !request.user
  ) {
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

app.post(
  "/api/auth/onboarding/organization",
  rateLimit(10),
  async (req, res) => {
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
      await recordOperationalEvent({
        eventType: "auth.organization_created",
        actorId: `${user.id}`,
        actorRole: user.role,
        tenantId: result.tenantId,
        route: req.path,
        outcome: "success",
      });
      res
        .status(201)
        .json({ ok: true, ...result, redirect: "/onboarding?step=branding" });
    } catch (error) {
      const mapped = lifecycleErrorStatus(error);
      res.status(mapped.status).json({ error: mapped.code });
    }
  },
);

app.post("/api/auth/invitations", rateLimit(20), async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    const result = await createInvitation({
      inviterId: Number(user.id),
      email: `${req.body?.email ?? ""}`,
      role: `${req.body?.role ?? "operator"}` as
        | "admin"
        | "operator"
        | "viewer",
    });
    await recordOperationalEvent({
      eventType: "auth.invitation_created",
      actorId: `${user.id}`,
      actorRole: user.role,
      tenantId: user.tenantId,
      route: req.path,
      outcome: "success",
    });
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
    res
      .status(200)
      .json({ invitations: await listInvitationStatuses(Number(user.id)) });
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res
      .status(mapped.code === "tenant_admin_required" ? 403 : mapped.status)
      .json({ error: mapped.code });
  }
});

app.get(
  "/api/auth/invitations/activity.csv",
  rateLimit(10),
  async (req, res) => {
    const user = requireAuthenticatedOperator(req, res);
    if (!user) return;
    try {
      const status =
        typeof req.query.status === "string" ? req.query.status : null;
      const startDate =
        typeof req.query.startDate === "string" ? req.query.startDate : null;
      const endDate =
        typeof req.query.endDate === "string" ? req.query.endDate : null;
      const columns =
        typeof req.query.columns === "string"
          ? req.query.columns.split(",")
          : [];
      const exported = await exportInvitationActivityCsv({
        operatorId: Number(user.id),
        status,
        startDate,
        endDate,
        columns,
      });
      await recordOperationalEvent({
        eventType: "auth.invitation_activity_exported",
        actorId: `${user.id}`,
        actorRole: user.role,
        tenantId: user.tenantId,
        route: req.path,
        outcome: "success",
        payload: {
          status,
          startDate,
          endDate,
          columns,
          rowCount: exported.rowCount,
        },
      });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="invitation-activity.csv"',
      );
      res.setHeader("X-Exported-Row-Count", `${exported.rowCount}`);
      res.status(200).send(exported.csv);
    } catch (error) {
      const mapped = lifecycleErrorStatus(error);
      res
        .status(mapped.code === "tenant_admin_required" ? 403 : mapped.status)
        .json({ error: mapped.code });
    }
  },
);

app.post(
  "/api/auth/invitations/:id/resend",
  rateLimit(10),
  async (req, res) => {
    const user = requireAuthenticatedOperator(req, res);
    if (!user) return;
    try {
      const result = await resendInvitation({
        inviterId: Number(user.id),
        invitationId: `${req.params.id ?? ""}`,
      });
      await recordOperationalEvent({
        eventType: "auth.invitation_resent",
        actorId: `${user.id}`,
        actorRole: user.role,
        tenantId: user.tenantId,
        route: req.path,
        outcome: "success",
      });
      res.status(202).json(result);
    } catch (error) {
      const mapped = lifecycleErrorStatus(error);
      res
        .status(mapped.code === "tenant_admin_required" ? 403 : mapped.status)
        .json({ error: mapped.code });
    }
  },
);

app.post(
  "/api/auth/invitations/:id/revoke",
  rateLimit(10),
  async (req, res) => {
    const user = requireAuthenticatedOperator(req, res);
    if (!user) return;
    try {
      const result = await revokeInvitation({
        inviterId: Number(user.id),
        invitationId: `${req.params.id ?? ""}`,
      });
      await recordOperationalEvent({
        eventType: "auth.invitation_revoked",
        actorId: `${user.id}`,
        actorRole: user.role,
        tenantId: user.tenantId,
        route: req.path,
        outcome: "success",
      });
      res.status(200).json(result);
    } catch (error) {
      const mapped = lifecycleErrorStatus(error);
      res
        .status(mapped.code === "tenant_admin_required" ? 403 : mapped.status)
        .json({ error: mapped.code });
    }
  },
);

app.post(
  "/api/auth/invitations/actions/bulk/resend",
  rateLimit(3),
  async (req, res) => {
    const user = requireAuthenticatedOperator(req, res);
    if (!user) return;
    try {
      const result = await bulkResendInvitations({
        inviterId: Number(user.id),
        invitationIds: Array.isArray(req.body?.invitationIds)
          ? req.body.invitationIds.filter(
              (id: unknown): id is string => typeof id === "string",
            )
          : [],
      });
      await recordOperationalEvent({
        eventType: "auth.invitations_bulk_resent",
        actorId: `${user.id}`,
        actorRole: user.role,
        tenantId: user.tenantId,
        route: req.path,
        outcome: result.failed.length ? "failure" : "success",
        payload: {
          requested: result.requested,
          succeeded: result.succeeded.length,
          failed: result.failed.length,
        },
      });
      res.status(202).json(result);
    } catch (error) {
      const mapped = lifecycleErrorStatus(error);
      res
        .status(mapped.code === "tenant_admin_required" ? 403 : mapped.status)
        .json({ error: mapped.code });
    }
  },
);

app.post(
  "/api/auth/invitations/actions/bulk/revoke",
  rateLimit(3),
  async (req, res) => {
    const user = requireAuthenticatedOperator(req, res);
    if (!user) return;
    try {
      const result = await bulkRevokeInvitations({
        inviterId: Number(user.id),
        invitationIds: Array.isArray(req.body?.invitationIds)
          ? req.body.invitationIds.filter(
              (id: unknown): id is string => typeof id === "string",
            )
          : [],
      });
      await recordOperationalEvent({
        eventType: "auth.invitations_bulk_revoked",
        actorId: `${user.id}`,
        actorRole: user.role,
        tenantId: user.tenantId,
        route: req.path,
        outcome: result.failed.length ? "failure" : "success",
        payload: {
          requested: result.requested,
          succeeded: result.succeeded.length,
          failed: result.failed.length,
        },
      });
      res.status(200).json(result);
    } catch (error) {
      const mapped = lifecycleErrorStatus(error);
      res
        .status(mapped.code === "tenant_admin_required" ? 403 : mapped.status)
        .json({ error: mapped.code });
    }
  },
);

app.post(
  "/api/auth/members/actions/bulk/role",
  rateLimit(3),
  async (req, res) => {
    const user = requireAuthenticatedOperator(req, res);
    if (!user) return;
    try {
      const memberIds = Array.isArray(req.body?.memberIds)
        ? req.body.memberIds.filter(
            (id: unknown): id is number => typeof id === "number",
          )
        : [];
      const result = await bulkChangeMemberRoles({
        operatorId: Number(user.id),
        memberIds,
        role: `${req.body?.role ?? ""}` as "admin" | "operator" | "viewer",
      });
      await recordOperationalEvent({
        eventType: "auth.members_bulk_role_changed",
        actorId: `${user.id}`,
        actorRole: user.role,
        tenantId: user.tenantId,
        route: req.path,
        outcome: "success",
        payload: result,
      });
      res.status(200).json(result);
    } catch (error) {
      const mapped = lifecycleErrorStatus(error);
      res
        .status(mapped.code === "tenant_admin_required" ? 403 : mapped.status)
        .json({ error: mapped.code });
    }
  },
);

app.get("/api/auth/members", async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    res.status(200).json({ members: await listTenantMembers(Number(user.id)) });
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res
      .status(mapped.code === "tenant_admin_required" ? 403 : mapped.status)
      .json({ error: mapped.code });
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
    res
      .status(200)
      .json({ presets: await listTenantBrandingPresets(Number(user.id)) });
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res
      .status(mapped.code === "tenant_admin_required" ? 403 : mapped.status)
      .json({ error: mapped.code });
  }
});

app.get("/api/auth/tenant-branding/presets/shared", async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    res.status(200).json({
      presets: await listOrganizationSharedBrandingPresets(Number(user.id)),
    });
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res
      .status(mapped.code === "tenant_admin_required" ? 403 : mapped.status)
      .json({ error: mapped.code });
  }
});

app.get("/api/auth/tenant-branding/presets/audit-history", async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    const startDate =
      typeof req.query.startDate === "string" ? req.query.startDate : null;
    const endDate =
      typeof req.query.endDate === "string" ? req.query.endDate : null;
    res.status(200).json({
      history: await listTenantBrandingPresetOwnershipAudit({
        operatorId: Number(user.id),
        startDate,
        endDate,
      }),
    });
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res
      .status(mapped.code === "tenant_admin_required" ? 403 : mapped.status)
      .json({ error: mapped.code });
  }
});

app.get("/api/auth/tenant/notification-preferences", async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    res
      .status(200)
      .json(await getTenantAdminNotificationPreferences(Number(user.id)));
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res
      .status(mapped.code === "tenant_admin_required" ? 403 : mapped.status)
      .json({ error: mapped.code });
  }
});

app.get("/api/auth/tenant/notification-delivery-history", async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    const status =
      typeof req.query.status === "string" ? req.query.status : null;
    const startDate =
      typeof req.query.startDate === "string" ? req.query.startDate : null;
    const endDate =
      typeof req.query.endDate === "string" ? req.query.endDate : null;
    res.status(200).json({
      history: await listTenantAdminNotificationDeliveryHistory({
        operatorId: Number(user.id),
        status,
        startDate,
        endDate,
      }),
    });
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res
      .status(mapped.code === "tenant_admin_required" ? 403 : mapped.status)
      .json({ error: mapped.code });
  }
});

app.get(
  "/api/auth/tenant/notification-delivery-history.csv",
  rateLimit(10),
  async (req, res) => {
    const user = requireAuthenticatedOperator(req, res);
    if (!user) return;
    try {
      const status =
        typeof req.query.status === "string" ? req.query.status : null;
      const startDate =
        typeof req.query.startDate === "string" ? req.query.startDate : null;
      const endDate =
        typeof req.query.endDate === "string" ? req.query.endDate : null;
      const exported = await exportTenantAdminNotificationDeliveryHistoryCsv({
        operatorId: Number(user.id),
        status,
        startDate,
        endDate,
      });
      await recordOperationalEvent({
        eventType: "auth.notification_delivery_history_exported",
        actorId: `${user.id}`,
        actorRole: user.role,
        tenantId: user.tenantId,
        route: req.path,
        outcome: "success",
        payload: { status, startDate, endDate, rowCount: exported.rowCount },
      });
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        'attachment; filename="notification-delivery-history.csv"',
      );
      res.setHeader("X-Exported-Row-Count", `${exported.rowCount}`);
      res.status(200).send(exported.csv);
    } catch (error) {
      const mapped = lifecycleErrorStatus(error);
      res
        .status(mapped.code === "tenant_admin_required" ? 403 : mapped.status)
        .json({ error: mapped.code });
    }
  },
);

app.get(
  "/api/auth/tenant/notification-delivery-retention",
  async (req, res) => {
    const user = requireAuthenticatedOperator(req, res);
    if (!user) return;
    try {
      res
        .status(200)
        .json(
          await getTenantAdminNotificationDeliveryRetention(Number(user.id)),
        );
    } catch (error) {
      const mapped = lifecycleErrorStatus(error);
      res
        .status(mapped.code === "tenant_admin_required" ? 403 : mapped.status)
        .json({ error: mapped.code });
    }
  },
);

app.post(
  "/api/auth/tenant/notification-delivery-retention",
  rateLimit(20),
  async (req, res) => {
    const user = requireAuthenticatedOperator(req, res);
    if (!user) return;
    try {
      const retention = await updateTenantAdminNotificationDeliveryRetention({
        operatorId: Number(user.id),
        retentionDays: Number(req.body?.retentionDays),
      });
      await recordOperationalEvent({
        eventType: "auth.notification_delivery_retention_updated",
        actorId: `${user.id}`,
        actorRole: user.role,
        tenantId: user.tenantId,
        route: req.path,
        outcome: "success",
        payload: {
          retentionDays: retention.retentionDays,
          pruned: retention.pruned,
        },
      });
      res.status(200).json(retention);
    } catch (error) {
      const mapped = lifecycleErrorStatus(error);
      res
        .status(mapped.code === "tenant_admin_required" ? 403 : mapped.status)
        .json({ error: mapped.code });
    }
  },
);

app.post(
  "/api/auth/tenant/notification-preferences",
  rateLimit(20),
  async (req, res) => {
    const user = requireAuthenticatedOperator(req, res);
    if (!user) return;
    try {
      const preferences = await updateTenantAdminNotificationPreferences({
        operatorId: Number(user.id),
        roleUpdateEmail: Boolean(req.body?.roleUpdateEmail),
        presetOwnershipTransferEmail: Boolean(
          req.body?.presetOwnershipTransferEmail,
        ),
      });
      await recordOperationalEvent({
        eventType: "auth.tenant_admin_notification_preferences_updated",
        actorId: `${user.id}`,
        actorRole: user.role,
        tenantId: user.tenantId,
        route: req.path,
        outcome: "success",
      });
      res.status(200).json(preferences);
    } catch (error) {
      const mapped = lifecycleErrorStatus(error);
      res
        .status(mapped.code === "tenant_admin_required" ? 403 : mapped.status)
        .json({ error: mapped.code });
    }
  },
);

app.post(
  "/api/auth/tenant-branding/presets",
  rateLimit(20),
  async (req, res) => {
    const user = requireAuthenticatedOperator(req, res);
    if (!user) return;
    try {
      const preset = await saveTenantBrandingPreset({
        operatorId: Number(user.id),
        name: `${req.body?.name ?? ""}`,
        logoDataUrl:
          typeof req.body?.logoDataUrl === "string"
            ? req.body.logoDataUrl
            : null,
        primaryColor: `${req.body?.primaryColor ?? ""}`,
        accentColor: `${req.body?.accentColor ?? ""}`,
      });
      res.status(201).json(preset);
    } catch (error) {
      const mapped = lifecycleErrorStatus(error);
      res
        .status(mapped.code === "tenant_admin_required" ? 403 : mapped.status)
        .json({ error: mapped.code });
    }
  },
);

app.post(
  "/api/auth/tenant-branding/presets/:id/apply",
  rateLimit(20),
  async (req, res) => {
    const user = requireAuthenticatedOperator(req, res);
    if (!user) return;
    try {
      res.status(200).json(
        await applyTenantBrandingPreset({
          operatorId: Number(user.id),
          presetId: `${req.params.id ?? ""}`,
        }),
      );
    } catch (error) {
      const mapped = lifecycleErrorStatus(error);
      res
        .status(mapped.code === "tenant_admin_required" ? 403 : mapped.status)
        .json({ error: mapped.code });
    }
  },
);

app.post(
  "/api/auth/tenant-branding/presets/:id/apply-shared",
  rateLimit(20),
  async (req, res) => {
    const user = requireAuthenticatedOperator(req, res);
    if (!user) return;
    try {
      res.status(200).json(
        await applyOrganizationSharedBrandingPreset({
          operatorId: Number(user.id),
          presetId: `${req.params.id ?? ""}`,
        }),
      );
    } catch (error) {
      const mapped = lifecycleErrorStatus(error);
      res
        .status(mapped.code === "tenant_admin_required" ? 403 : mapped.status)
        .json({ error: mapped.code });
    }
  },
);

app.post(
  "/api/auth/tenant-branding/presets/:id/share",
  rateLimit(20),
  async (req, res) => {
    const user = requireAuthenticatedOperator(req, res);
    if (!user) return;
    try {
      const result = await setTenantBrandingPresetOrganizationSharing({
        operatorId: Number(user.id),
        presetId: `${req.params.id ?? ""}`,
        shared: Boolean(req.body?.shared),
      });
      await recordOperationalEvent({
        eventType: result.organizationShared
          ? "auth.tenant_branding_preset_shared"
          : "auth.tenant_branding_preset_unshared",
        actorId: `${user.id}`,
        actorRole: user.role,
        tenantId: user.tenantId,
        route: req.path,
        outcome: "success",
      });
      res.status(200).json(result);
    } catch (error) {
      const mapped = lifecycleErrorStatus(error);
      res
        .status(mapped.code === "tenant_admin_required" ? 403 : mapped.status)
        .json({ error: mapped.code });
    }
  },
);

app.post(
  "/api/auth/tenant-branding/presets/:id/transfer-ownership",
  rateLimit(10),
  async (req, res) => {
    const user = requireAuthenticatedOperator(req, res);
    if (!user) return;
    try {
      const result = await transferTenantBrandingPresetOwnership({
        operatorId: Number(user.id),
        presetId: `${req.params.id ?? ""}`,
        recipientEmail: `${req.body?.recipientEmail ?? ""}`,
      });
      await recordOperationalEvent({
        eventType: "auth.tenant_branding_preset_ownership_transferred",
        actorId: `${user.id}`,
        actorRole: user.role,
        tenantId: user.tenantId,
        route: req.path,
        outcome: "success",
        payload: {
          presetId: result.id,
          ownerOperatorId: result.ownerOperatorId,
        },
      });
      res.status(200).json(result);
    } catch (error) {
      const mapped = lifecycleErrorStatus(error);
      res
        .status(mapped.code === "tenant_admin_required" ? 403 : mapped.status)
        .json({ error: mapped.code });
    }
  },
);

app.delete(
  "/api/auth/tenant-branding/presets/:id",
  rateLimit(20),
  async (req, res) => {
    const user = requireAuthenticatedOperator(req, res);
    if (!user) return;
    try {
      res.status(200).json(
        await deleteTenantBrandingPreset({
          operatorId: Number(user.id),
          presetId: `${req.params.id ?? ""}`,
        }),
      );
    } catch (error) {
      const mapped = lifecycleErrorStatus(error);
      res
        .status(mapped.code === "tenant_admin_required" ? 403 : mapped.status)
        .json({ error: mapped.code });
    }
  },
);

app.post("/api/auth/tenant-branding", rateLimit(20), async (req, res) => {
  const user = requireAuthenticatedOperator(req, res);
  if (!user) return;
  try {
    const branding = await updateTenantBranding({
      operatorId: Number(user.id),
      logoDataUrl:
        typeof req.body?.logoDataUrl === "string" ? req.body.logoDataUrl : null,
      primaryColor: `${req.body?.primaryColor ?? ""}`,
      accentColor: `${req.body?.accentColor ?? ""}`,
    });
    await recordOperationalEvent({
      eventType: "auth.tenant_branding_updated",
      actorId: `${user.id}`,
      actorRole: user.role,
      tenantId: user.tenantId,
      route: req.path,
      outcome: "success",
    });
    res.status(200).json(branding);
  } catch (error) {
    const mapped = lifecycleErrorStatus(error);
    res
      .status(mapped.code === "tenant_admin_required" ? 403 : mapped.status)
      .json({ error: mapped.code });
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
      console.error(
        `[SwitchOS] tRPC error on ${path ?? "unknown_path"}`,
        error,
      );
    },
  }),
);

app.post(
  "/api/internal/longcat/voice/bootstrap",
  rateLimit(60),
  async (req, res) => {
    if (!requireInternalServiceAccess(req, res)) return;
    try {
      const payload = await startLongCatTelephonyIngressSession({
        userId: typeof req.body?.userId === "number" ? req.body.userId : null,
        customerPhone:
          typeof req.body?.customerPhone === "string"
            ? req.body.customerPhone
            : null,
        customerName:
          typeof req.body?.customerName === "string"
            ? req.body.customerName
            : null,
        voiceChannel:
          typeof req.body?.voiceChannel === "string"
            ? req.body.voiceChannel
            : null,
        accessibilityFlags: Array.isArray(req.body?.accessibilityFlags)
          ? req.body.accessibilityFlags.filter(
              (value: unknown) => typeof value === "string",
            )
          : [],
        idempotencyKey:
          typeof req.body?.idempotencyKey === "string"
            ? req.body.idempotencyKey
            : null,
        triggerReason:
          typeof req.body?.triggerReason === "string"
            ? req.body.triggerReason
            : null,
        externalCallId: `${req.body?.externalCallId ?? ""}`.trim(),
        telephonyProvider:
          typeof req.body?.telephonyProvider === "string"
            ? req.body.telephonyProvider
            : null,
        transport:
          typeof req.body?.transport === "string" ? req.body.transport : null,
        sampleRateHz:
          typeof req.body?.sampleRateHz === "number"
            ? req.body.sampleRateHz
            : null,
      });
      res.status(200).json(payload);
    } catch (error) {
      console.error(
        "[SwitchOS] Failed to bootstrap LongCat telephony session",
        error,
      );
      res.status(500).json({
        error:
          error instanceof Error ? error.message : "longcat_bootstrap_failed",
      });
    }
  },
);

app.post(
  "/api/internal/longcat/voice/transcript",
  rateLimit(120),
  async (req, res) => {
    if (!requireInternalServiceAccess(req, res)) return;
    try {
      const payload = await appendLongCatTelephonyTranscript({
        sessionId: `${req.body?.sessionId ?? ""}`.trim(),
        externalCallId: `${req.body?.externalCallId ?? ""}`.trim(),
        telephonyProvider:
          typeof req.body?.telephonyProvider === "string"
            ? req.body.telephonyProvider
            : null,
        transport:
          typeof req.body?.transport === "string" ? req.body.transport : null,
        speaker:
          req.body?.speaker === "agent" || req.body?.speaker === "system"
            ? req.body.speaker
            : "customer",
        transcript: `${req.body?.transcript ?? ""}`.trim(),
        finalSegment: Boolean(req.body?.finalSegment ?? true),
        metadata:
          req.body?.metadata && typeof req.body.metadata === "object"
            ? req.body.metadata
            : undefined,
      });
      res.status(200).json(payload);
    } catch (error) {
      console.error(
        "[SwitchOS] Failed to append LongCat telephony transcript",
        error,
      );
      const message =
        error instanceof Error ? error.message : "longcat_transcript_failed";
      const status = /already closed/i.test(message) ? 409 : 500;
      res.status(status).json({ error: message });
    }
  },
);

app.post(
  "/api/internal/longcat/voice/close",
  rateLimit(60),
  async (req, res) => {
    if (!requireInternalServiceAccess(req, res)) return;
    try {
      const payload = await closeLongCatTelephonyIngressSession({
        sessionId: `${req.body?.sessionId ?? ""}`.trim(),
        externalCallId: `${req.body?.externalCallId ?? ""}`.trim(),
        status:
          req.body?.status === "failed" || req.body?.status === "abandoned"
            ? req.body.status
            : "completed",
        reason: typeof req.body?.reason === "string" ? req.body.reason : null,
        metadata:
          req.body?.metadata && typeof req.body.metadata === "object"
            ? req.body.metadata
            : undefined,
      });
      res.status(200).json(payload);
    } catch (error) {
      console.error(
        "[SwitchOS] Failed to close LongCat telephony session",
        error,
      );
      res.status(500).json({
        error: error instanceof Error ? error.message : "longcat_close_failed",
      });
    }
  },
);

const stopDeveloperWebhookDispatcher = startDeveloperWebhookDispatcher();
const stopVehicleTrackerProviderConsumers = ENV.vehicleTrackerConsumerEmbedded
  ? startVehicleTrackerProviderConsumers({ workerIdPrefix: "central-app" })
  : () => undefined;
process.once("SIGTERM", () => {
  stopDeveloperWebhookDispatcher();
  stopVehicleTrackerProviderConsumers();
});
process.once("SIGINT", () => {
  stopDeveloperWebhookDispatcher();
  stopVehicleTrackerProviderConsumers();
});

if (ENV.isProduction) {
  const staticRoot = path.dirname(fileURLToPath(import.meta.url));

  app.use(
    express.static(staticRoot, {
      etag: true,
      cacheControl: false,
      setHeaders(res, filePath) {
        if (filePath.endsWith("/sw.js")) {
          res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
          res.setHeader("Pragma", "no-cache");
          res.setHeader("Expires", "0");
          res.setHeader("Service-Worker-Allowed", "/");
          return;
        }
        if (filePath.endsWith("/index.html")) {
          res.setHeader("Cache-Control", ENV.cacheControlIndexHtml);
          res.setHeader("Pragma", "no-cache");
          res.setHeader("Expires", "0");
          return;
        }
        if (/\/assets\/.+-[A-Za-z0-9_-]{8,}\.(?:css|js|mjs|woff2?|svg|png|webp)$/.test(filePath)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        }
      },
    }),
  );

  app.get(/.*/, (req, res, next) => {
    if (req.path.startsWith("/api/") || !req.accepts("html")) {
      next();
      return;
    }
    res.sendFile(path.join(staticRoot, "index.html"));
  });
}

app.listen(ENV.port, ENV.bindHost, () => {
  console.log(
    `[SwitchOS] Operator edge listening on http://${ENV.bindHost}:${ENV.port}`,
  );
});
