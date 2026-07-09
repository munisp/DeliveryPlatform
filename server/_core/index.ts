import cookieParser from "cookie-parser";
import express from "express";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { randomUUID } from "crypto";

import { appRouter } from "../routers";
import { appendLongCatTelephonyTranscript, startLongCatTelephonyIngressSession } from "./longcatVoice";
import { COOKIE_NAME } from "../../shared/const";
import { ENV } from "./env";
import { getCookieOptions } from "./cookies";
import {
  buildOidcAuthorizationUrl,
  createSessionToken,
  getOidcDiscoveryDocument,
  getSessionUserFromRequest,
  resolveUserFromExternalTokens,
} from "./auth";
import { authenticateOperator, ensureOperatorAuthStore } from "./operatorAuthStore";
import { recordOperationalEvent } from "./operationalEvents";
import { consumeRateLimit, getRateLimiterStatus } from "./rateLimiter";

const OIDC_STATE_COOKIE = "switchos_oidc_state";
const OIDC_NONCE_COOKIE = "switchos_oidc_nonce";
const OIDC_VERIFIER_COOKIE = "switchos_oidc_verifier";
const OIDC_RETURN_TO_COOKIE = "switchos_oidc_return_to";

const app = express();
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
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With, X-Internal-Service-Token");
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
        res.status(429).json({ error: "rate_limit_exceeded" });
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
  res: express.Response,
  operator: { id: number; name: string; email: string; role: string; tenantId: string | null },
) {
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
  });
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
    const identity = await resolveUserFromExternalTokens({
      code,
      nonce: storedNonce,
      codeVerifier: storedVerifier,
      origin,
    });

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

    await issueOperatorSession(res, {
      id: Number(identity.id),
      name: identity.name,
      email: identity.email,
      role: identity.role,
      tenantId: identity.tenantId,
    });
    await recordOperationalEvent({
      eventType: "auth.oidc.callback",
      actorId: `${identity.id}`,
      actorRole: identity.role,
      tenantId: identity.tenantId,
      route: req.path,
      outcome: "success",
      payload: {
        email: identity.email,
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

    await issueOperatorSession(res, operator);
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
  await recordOperationalEvent({
    eventType: "auth.logout",
    actorId: req.user ? `${req.user.id}` : null,
    actorRole: req.user?.role ?? null,
    tenantId: req.user?.tenantId ?? null,
    route: req.path,
    outcome: "info",
  });
  clearOidcFlowCookies(res);
  res.clearCookie(COOKIE_NAME, getCookieOptions());
  res.status(200).json({ ok: true });
});

app.use(async (req, _res, next) => {
  try {
    req.user = await getSessionUserFromRequest(req);
  } catch (error) {
    console.warn("[SwitchOS] Failed to resolve session user", error);
    req.user = null;
  }
  next();
});

app.use(
  "/api/trpc",
  createHTTPHandler({
    router: appRouter,
    createContext({ req, res }) {
      return {
        req,
        res,
        user: req.user ?? null,
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
    res.status(500).json({ error: error instanceof Error ? error.message : "longcat_transcript_failed" });
  }
});

app.listen(ENV.port, ENV.bindHost, () => {
  console.log(`[SwitchOS] Operator edge listening on http://${ENV.bindHost}:${ENV.port}`);
});
