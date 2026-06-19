import cookieParser from "cookie-parser";
import express from "express";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { randomUUID } from "crypto";

import { appRouter } from "../routers";
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

const OIDC_STATE_COOKIE = "switchos_oidc_state";
const OIDC_NONCE_COOKIE = "switchos_oidc_nonce";
const OIDC_VERIFIER_COOKIE = "switchos_oidc_verifier";
const OIDC_RETURN_TO_COOKIE = "switchos_oidc_return_to";

const app = express();
const rateWindowMs = 60_000;
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();
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

function consumeRateLimitBucket(key: string, limit: number) {
  const now = Date.now();
  const existing = rateLimitBuckets.get(key);
  if (!existing || existing.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + rateWindowMs });
    return { allowed: true, remaining: limit - 1, resetAt: now + rateWindowMs };
  }

  existing.count += 1;
  rateLimitBuckets.set(key, existing);
  return {
    allowed: existing.count <= limit,
    remaining: Math.max(0, limit - existing.count),
    resetAt: existing.resetAt,
  };
}

function rateLimit(limit: number): express.RequestHandler {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const bucket = consumeRateLimitBucket(key, limit);
    res.setHeader("X-RateLimit-Limit", String(limit));
    res.setHeader("X-RateLimit-Remaining", String(bucket.remaining));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

    if (!bucket.allowed) {
      res.status(429).json({ error: "rate_limit_exceeded" });
      return;
    }

    next();
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

app.get("/api/health", async (_req, res) => {
  const discovery = ENV.enableExternalOidc ? await getOidcDiscoveryDocument() : null;
  res.json({
    ok: true,
    service: "switchos-operator-dashboard",
    timestamp: new Date().toISOString(),
    externalOidcEnabled: ENV.enableExternalOidc,
    oidcIssuer: (discovery?.issuer ?? ENV.oidcIssuerUrl) || null,
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
    res.redirect(302, authorization.authorizationUrl);
  } catch (error) {
    console.error("[SwitchOS] Failed to start OIDC login", error);
    res.status(500).json({ error: "oidc_start_failed" });
  }
});

app.get("/api/auth/oidc/callback", rateLimit(20), async (req, res) => {
  if (!ENV.enableExternalOidc) {
    res.status(404).json({ error: "external_oidc_disabled" });
    return;
  }

  const state = typeof req.query.state === "string" ? req.query.state : "";
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const cookieState = `${req.cookies?.[OIDC_STATE_COOKIE] ?? ""}`;
  const cookieNonce = `${req.cookies?.[OIDC_NONCE_COOKIE] ?? ""}`;
  const cookieVerifier = `${req.cookies?.[OIDC_VERIFIER_COOKIE] ?? ""}`;
  const returnTo = sanitizeReturnTo(`${req.cookies?.[OIDC_RETURN_TO_COOKIE] ?? "/dashboard"}`);

  if (!state || !code || !cookieState || state !== cookieState || !cookieVerifier) {
    clearOidcFlowCookies(res);
    res.redirect(302, `/portal?error=${encodeURIComponent("oidc_state_mismatch")}`);
    return;
  }

  try {
    const origin = getRequestOrigin(req);
    const tokens = await resolveUserFromExternalTokens(
      await import("./auth").then(({ exchangeAuthorizationCode }) => exchangeAuthorizationCode(code, cookieVerifier, origin)),
      cookieNonce,
    );

    if (!tokens) {
      clearOidcFlowCookies(res);
      res.redirect(302, `/portal?error=${encodeURIComponent("invalid_external_token")}`);
      return;
    }

    await issueOperatorSession(res, {
      id: tokens.id,
      name: tokens.name,
      email: tokens.email ?? `${tokens.openId ?? tokens.id}@switchos.local`,
      role: tokens.role ?? "viewer",
      tenantId: tokens.tenantId,
    });
    clearOidcFlowCookies(res);
    res.redirect(302, returnTo);
  } catch (error) {
    console.error("[SwitchOS] OIDC callback failed", error);
    clearOidcFlowCookies(res);
    res.redirect(302, `/portal?error=${encodeURIComponent("oidc_callback_failed")}`);
  }
});

app.post("/api/auth/login", rateLimit(20), async (req, res) => {
  if (ENV.enableExternalOidc && ENV.isProduction) {
    res.status(403).json({ error: "local_login_disabled" });
    return;
  }

  const email = `${req.body?.email ?? ""}`.trim().toLowerCase();
  const password = `${req.body?.password ?? ""}`;

  if (!email || !password) {
    res.status(400).json({ error: "missing_credentials" });
    return;
  }

  try {
    const operator = await authenticateOperator(email, password);
    if (!operator) {
      res.status(401).json({ error: "invalid_credentials" });
      return;
    }

    await issueOperatorSession(res, operator);
    res.status(200).json({ ok: true, redirect: "/dashboard", operator: { email: operator.email, role: operator.role } });
  } catch (error) {
    console.error("[SwitchOS] Login failed", error);
    res.status(500).json({ error: "login_failed" });
  }
});

app.post("/api/auth/dev-session", rateLimit(10), async (req, res) => {
  if (ENV.isProduction || ENV.enableExternalOidc) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const requestedRole = `${req.body?.role ?? "admin"}`.trim().toLowerCase();
  const role = ["admin", "operator", "ops"].includes(requestedRole) ? requestedRole : "operator";
  await issueOperatorSession(res, {
    id: 1,
    name: ENV.bootstrapOperatorName,
    email: ENV.bootstrapOperatorEmail,
    role,
    tenantId: ENV.bootstrapTenantId,
  });

  res.status(200).json({ ok: true, role, redirect: "/dashboard" });
});

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie(COOKIE_NAME, getCookieOptions());
  clearOidcFlowCookies(res);
  res.setHeader("Cache-Control", "no-store");
  res.status(200).json({ ok: true, logoutUrl: ENV.oidcLogoutUrl || null });
});

app.use(
  "/api/trpc",
  rateLimit(120),
  createHTTPHandler({
    router: appRouter,
    async createContext({ req, res }) {
      return {
        req,
        res,
        user: await getSessionUserFromRequest(req.headers),
      };
    },
  }),
);

app.get("*", (_req, res) => {
  res.setHeader("Cache-Control", ENV.cacheControlIndexHtml);
  res.setHeader("Pragma", "no-cache");
  res.setHeader("Expires", "0");
  res.status(200).send("SwitchOS API is running.");
});

const port = Number(process.env.PORT || 3005);

ensureOperatorAuthStore()
  .then(() => {
    app.listen(port, ENV.bindHost, () => {
      console.log(`[SwitchOS] API listening on http://${ENV.bindHost}:${port}`);
    });
  })
  .catch((error) => {
    console.error("[SwitchOS] Failed to initialize operator auth store", error);
    process.exit(1);
  });
