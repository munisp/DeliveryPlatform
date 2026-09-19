import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { randomUUID } from "crypto";
import { parse } from "url";
import path from "path";
import { fileURLToPath } from "url";
import fs from "fs";

import { createExpressMiddleware } from "@trpc/server/adapters/express";
import { and, eq } from "drizzle-orm";
import express from "express";
import { rateLimit } from "express-rate-limit";
import slowDown from "express-slow-down";
import helmet from "helmet";
import { cors } from "./_core/cors";
import { appRouter } from "../routers";
import { createContext } from "./_core/context";
import { serveStatic, setupVite } from "./_core/vite";
import { ENV } from "./_core/env";
import { COOKIE_NAME, ONE_YEAR_MS } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { sdk } from "./_core/sdk";
import { getDb } from "../db";
import { sql } from "drizzle-orm";
import {
  authenticateOperator,
  ensureExternalOperator,
  ensureOperatorAuthStore,
} from "./_core/operatorAuthStore";
import { recordOperationalEvent } from "./_core/operationalTelemetry";
import { applySecurityHeaders, csrfProtection, enforceJsonContentType } from "./_core/securityHeaders";
import {
  clearOidcFlowCookies,
  consumeOidcState,
  createOidcState,
  discoverOidcConfiguration,
  exchangeOidcCode,
  getOidcClientConfig,
  setOidcFlowCookies,
  verifyOidcIdToken,
} from "./_core/oidc";
import {
  generateRegistrationOptions,
  generateAuthenticationOptions,
  verifyRegistrationResponse,
  verifyAuthenticationResponse,
} from "@simplewebauthn/server";
import {
  bootstrapPasskeySchema,
  ensurePasskeyStore,
  findCredentialById,
  getBootstrapCredentialId,
  listPasskeysForOperator,
  registerBootstrapPasskey,
  savePasskey,
  updateCredentialCounter,
} from "./_core/passkeyStore";
import {
  attachTwoFactorChallenge,
  clearTwoFactorChallengeCookie,
  createTwoFactorChallenge,
  ensureTwoFactorStore,
  getTwoFactorStatus,
  readTwoFactorChallengeCookie,
  recordFailedTwoFactorAttempt,
  registerTwoFactorStart,
  setTwoFactorChallengeCookie,
  verifyTwoFactorLogin,
} from "./_core/twofactor";
import {
  completeEmailVerification,
  ensureAccountLifecycleStore,
  finalizeManagedSignup,
  finalizePasswordReset,
  getManagedSessionState,
  startEmailVerification,
  startManagedSignup,
  startPasswordReset,
} from "./_core/accountLifecycle";
import { registerDeliveryPlatformRoutes } from "./_core/deliveryPlatform";
import { registerPaymentRoutes } from "./_core/paymentRoutes";
import { registerPublicDeliveryRoutes } from "./_core/publicDelivery";
import { registerFieldServiceOpsRoutes } from "./_core/fieldServiceOpsRoutes";
import { registerWebhookRoutes } from "./_core/webhookRoutes";
import { registerMobilityWebhookRoutes } from "./_core/mobilityWebhooks";
import { registerTelemetryRoutes } from "./_core/telemetryRoutes";
import { runMigrations } from "./_core/migrate";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

function parseCookies(req: IncomingMessage) {
  const header = req.headers.cookie;
  const cookies: Record<string, string> = {};
  if (!header) return cookies;

  const pairs = header.split(/;\s*/);
  for (const pair of pairs) {
    const idx = pair.indexOf("=");
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const value = pair.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function readSessionToken(req: IncomingMessage) {
  const cookies = parseCookies(req);
  return cookies[COOKIE_NAME] ?? null;
}

function getAllowedOrigins() {
  return (process.env.APP_ORIGIN ?? "")
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function isOriginAllowed(origin?: string | null) {
  if (!origin) return false;
  return getAllowedOrigins().includes(origin);
}

function applyCors(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (isOriginAllowed(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin as string);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader(
      "Access-Control-Allow-Headers",
      "Content-Type, Authorization, X-Requested-With",
    );
    res.setHeader(
      "Access-Control-Allow-Methods",
      "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    );
  }
}

function handlePreflight(req: IncomingMessage, res: ServerResponse) {
  if (req.method === "OPTIONS") {
    applyCors(req, res);
    res.statusCode = 204;
    res.end();
    return true;
  }
  return false;
}

function json(res: ServerResponse, status: number, payload: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJson(req: IncomingMessage) {
  const raw = await readBody(req);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

async function getSessionUser(req: IncomingMessage) {
  const sessionToken = readSessionToken(req);
  if (!sessionToken) return null;
  try {
    const session = await sdk.verifySession(sessionToken);
    if (!session) return null;
    return session;
  } catch {
    return null;
  }
}

async function ensureUserFromSession(session: { openId?: string; name?: string; email?: string | null }) {
  if (!session.openId) return;
  await sdk.upsertUser({
    openId: session.openId,
    name: session.name ?? "Unknown",
    email: session.email ?? null,
    lastSignedIn: new Date(),
  });
}

async function handleAuthLogin(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (!isOriginAllowed(origin)) {
    return json(res, 403, { error: "origin_not_allowed" });
  }
  const { openId, name, email } = await readJson(req);
  if (!openId || typeof openId !== "string") {
    return json(res, 400, { error: "open_id_required" });
  }
  const safeName = typeof name === "string" && name.trim() ? name.trim() : "Operator";
  const safeEmail = typeof email === "string" && email.trim() ? email.trim() : null;
  await sdk.upsertUser({
    openId,
    name: safeName,
    email: safeEmail,
    lastSignedIn: new Date(),
  });
  const sessionToken = await sdk.createSessionToken(openId, {
    name: safeName,
    expiresInMs: ONE_YEAR_MS,
  });
  const cookieOptions = getSessionCookieOptions(req);
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(sessionToken)}`,
    "Path=/",
    `Max-Age=${Math.floor(ONE_YEAR_MS / 1000)}`,
    `SameSite=${cookieOptions.sameSite}`,
  ];
  if (cookieOptions.secure) parts.push("Secure");
  parts.push("HttpOnly");
  res.setHeader("Set-Cookie", parts.join("; "));
  return json(res, 200, { ok: true });
}

async function handleAuthLogout(req: IncomingMessage, res: ServerResponse) {
  const cookieOptions = getSessionCookieOptions(req);
  const parts = [
    `${COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    `SameSite=${cookieOptions.sameSite}`,
  ];
  if (cookieOptions.secure) parts.push("Secure");
  parts.push("HttpOnly");
  res.setHeader("Set-Cookie", parts.join("; "));
  return json(res, 200, { ok: true });
}

async function handleAuthMe(req: IncomingMessage, res: ServerResponse) {
  const user = await getSessionUser(req);
  return json(res, 200, user);
}

async function handleOperatorLogin(req: IncomingMessage, res: ServerResponse) {
  const origin = req.headers.origin;
  if (!isOriginAllowed(origin)) {
    return json(res, 403, { error: "origin_not_allowed" });
  }
  const { email, password } = await readJson(req);
  if (typeof email !== "string" || typeof password !== "string") {
    return json(res, 400, { error: "invalid_login_payload" });
  }
  await ensureOperatorAuthStore();
  const operator = await authenticateOperator(email, password);
  if (!operator) {
    await recordOperationalEvent({
      eventType: "auth.operator.login",
      outcome: "failure",
      payload: { email },
    });
    return json(res, 401, { error: "invalid_credentials" });
  }
  const sessionToken = await sdk.createSessionToken(`operator:${operator.id}`, {
    name: operator.name,
    expiresInMs: ONE_YEAR_MS,
  });
  const cookieOptions = getSessionCookieOptions(req);
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(sessionToken)}`,
    "Path=/",
    `Max-Age=${Math.floor(ONE_YEAR_MS / 1000)}`,
    `SameSite=${cookieOptions.sameSite}`,
  ];
  if (cookieOptions.secure) parts.push("Secure");
  parts.push("HttpOnly");
  res.setHeader("Set-Cookie", parts.join("; "));
  await recordOperationalEvent({
    eventType: "auth.operator.login",
    actorId: `${operator.id}`,
    actorRole: operator.role,
    tenantId: operator.tenantId,
    outcome: "success",
    payload: { email: operator.email },
  });
  return json(res, 200, { ok: true, operator });
}

function buildAuthorizeUrl(config: Awaited<ReturnType<typeof getOidcClientConfig>>, state: string, nonce: string, codeChallenge: string | null) {
  const authorizationEndpoint = config.authorizationEndpoint;
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: "code",
    scope: config.scopes.join(" "),
    state,
    nonce,
  });
  if (codeChallenge) {
    params.set("code_challenge", codeChallenge);
    params.set("code_challenge_method", "S256");
  }
  return `${authorizationEndpoint}?${params.toString()}`;
}

async function handleOidcAuthorize(req: IncomingMessage, res: ServerResponse) {
  try {
    const config = await getOidcClientConfig();
    const flow = createOidcState();
    setOidcFlowCookies(res, req, flow);
    const authorizeUrl = buildAuthorizeUrl(config, flow.state, flow.nonce, flow.codeChallenge);
    res.statusCode = 302;
    res.setHeader("Location", authorizeUrl);
    res.end();
  } catch (error) {
    console.error("[OIDC] authorize failed", error);
    json(res, 500, { error: "oidc_not_configured" });
  }
}

async function handleOidcCallback(req: IncomingMessage, res: ServerResponse) {
  const url = parse(req.url ?? "", true);
  const { code, state, error } = url.query;
  if (error) {
    return json(res, 400, { error: `oidc_error:${error}` });
  }
  if (typeof code !== "string" || typeof state !== "string") {
    return json(res, 400, { error: "invalid_oidc_callback" });
  }
  try {
    const flow = consumeOidcState(req, state);
    if (!flow) {
      return json(res, 400, { error: "oidc_state_mismatch" });
    }
    const config = await getOidcClientConfig();
    const tokenResponse = await exchangeOidcCode(config, code, flow.codeVerifier);
    const discovery = await discoverOidcConfiguration(config.issuer);
    const identity = await verifyOidcIdToken(config, discovery, tokenResponse.id_token, flow.nonce);
    await ensureAccountLifecycleStore();
    const operator = await ensureExternalOperator({
      email: identity.email,
      name: identity.name,
      tenantId: identity.tenantId,
    });
    // External OIDC identities are provisioned INACTIVE (Audit A P0-3): no
    // session is issued until an existing operator approves the account via
    // operatorOnboarding.approveExternalOperator.
    if (!operator.isActive) {
      await recordOperationalEvent({
        eventType: "auth.oidc.callback",
        actorId: `${operator.id}`,
        actorRole: operator.role,
        tenantId: operator.tenantId,
        route: req.path,
        outcome: "failure",
        payload: {
          email: operator.email,
          reason: "operator_pending_approval",
        },
      });
      clearOidcFlowCookies(res);
      res.status(403).json({ error: "operator_pending_approval" });
      return;
    }
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
      payload: { email: operator.email },
    });
    clearOidcFlowCookies(res);
    res.statusCode = 302;
    res.setHeader("Location", "/");
    res.end();
  } catch (err) {
    console.error("[OIDC] callback failed", err);
    await recordOperationalEvent({
      eventType: "auth.oidc.callback",
      route: req.path,
      outcome: "failure",
      payload: { reason: err instanceof Error ? err.message : "unknown" },
    });
    json(res, 500, { error: "oidc_callback_failed" });
  }
}

async function issueOperatorSession(
  req: IncomingMessage,
  res: ServerResponse,
  operator: { id: number; name: string; role: string; tenantId: string | null },
  options: {
    authSource: "managed" | "oidc" | "development";
    mfaAuthenticated: boolean;
    assuranceLevel?: string | null;
  },
) {
  const openId = `operator:${operator.id}`;
  const expiresInMs = ONE_YEAR_MS;
  const sessionToken = await sdk.createSessionToken(openId, {
    name: operator.name,
    expiresInMs,
  });
  const cookieOptions = getSessionCookieOptions(req);
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(sessionToken)}`,
    "Path=/",
    `Max-Age=${Math.floor(expiresInMs / 1000)}`,
    `SameSite=${cookieOptions.sameSite}`,
  ];
  if (cookieOptions.secure) parts.push("Secure");
  parts.push("HttpOnly");
  res.setHeader("Set-Cookie", parts.join("; "));
  await sdk.upsertUser({
    openId,
    name: operator.name,
    lastSignedIn: new Date(),
  });
  const { createOperatorSecuritySession } = await import("./_core/operatorAuthStore");
  const sessionId = randomUUID();
  await createOperatorSecuritySession({
    sessionId,
    operatorId: operator.id,
    authSource: options.authSource,
    mfaAuthenticated: options.mfaAuthenticated,
    assuranceLevel: options.assuranceLevel ?? null,
    userAgent: req.headers["user-agent"] ?? null,
    clientIp: (req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0]?.trim() ?? req.socket.remoteAddress ?? null,
    expiresAt: new Date(Date.now() + expiresInMs),
  });
}

async function startServer() {
  await runMigrations();
  const app = express();
  const server = createServer(app);

  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(applySecurityHeaders);
  app.use(cors({
    origin: (origin, callback) => {
      if (!origin || isOriginAllowed(origin)) return callback(null, true);
      return callback(new Error("origin_not_allowed"));
    },
    credentials: true,
  }));

  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  });
  const authSlowDown = slowDown({
    windowMs: 15 * 60 * 1000,
    delayAfter: 20,
    delayMs: 500,
  });

  app.use("/api/auth", authLimiter, authSlowDown);
  app.use("/api/operator", authLimiter, authSlowDown);

  app.use(express.json({ limit: "5mb" }));
  app.use(express.urlencoded({ extended: true, limit: "5mb" }));

  app.get("/api/auth/login", (req, res) => handleAuthLogin(req, res));
  app.post("/api/auth/login", (req, res) => handleAuthLogin(req, res));
  app.post("/api/auth/logout", (req, res) => handleAuthLogout(req, res));
  app.get("/api/auth/me", (req, res) => handleAuthMe(req, res));
  app.post("/api/operator/login", (req, res) => handleOperatorLogin(req, res));
  app.get("/api/oidc/authorize", (req, res) => handleOidcAuthorize(req, res));
  app.get("/api/oidc/callback", (req, res) => handleOidcCallback(req, res));

  app.use(
    "/api/trpc",
    createExpressMiddleware({
      router: appRouter,
      createContext,
    }),
  );

  registerDeliveryPlatformRoutes(app);
  registerPaymentRoutes(app);
  registerPublicDeliveryRoutes(app);
  registerFieldServiceOpsRoutes(app);
  registerWebhookRoutes(app);
  registerMobilityWebhookRoutes(app);
  registerTelemetryRoutes(app);

  if (ENV.isProduction) {
    serveStatic(app);
  } else {
    await setupVite(app, server);
  }

  const port = ENV.port;
  server.listen(port, () => {
    log(`serving on port ${port}`);
  });
}

startServer().catch((error) => {
  console.error("Fatal server error:", error);
  process.exit(1);
});
