import express from "express";
import { createHTTPHandler } from "@trpc/server/adapters/standalone";
import { randomUUID } from "crypto";

import { appRouter } from "../routers";
import { COOKIE_NAME } from "../../shared/const";
import { ENV } from "./env";
import { getCookieOptions } from "./cookies";
import { createSessionToken, getSessionUserFromRequest } from "./auth";

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

function setSecurityHeaders(res: express.Response) {
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

app.disable("x-powered-by");
app.set("trust proxy", 1);

app.use((req, res, next) => {
  res.setHeader("X-Request-Id", randomUUID());
  setSecurityHeaders(res);
  applyCors(req, res);
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

app.use(express.json({ limit: ENV.apiBodyLimit }));
app.use(express.urlencoded({ extended: true, limit: ENV.apiBodyLimit }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "switchos-operator-dashboard", timestamp: new Date().toISOString() });
});

app.post("/api/auth/dev-session", rateLimit(10), async (req, res) => {
  if (ENV.isProduction) {
    res.status(404).json({ error: "not_found" });
    return;
  }

  const requestedRole = `${req.body?.role ?? "admin"}`.trim().toLowerCase();
  const role = ["admin", "operator", "ops"].includes(requestedRole) ? requestedRole : "operator";
  const token = await createSessionToken({
    sub: "1",
    name: "SwitchOS Dev Operator",
    email: "dev-operator@switchos.local",
    role,
    openId: ENV.ownerOpenId,
    tenantId: "switchos-dev",
    scopes: ["platform:read", "platform:write", "analytics:read"],
  });

  res.cookie(COOKIE_NAME, token, getCookieOptions());
  res.status(200).json({ ok: true, role, redirect: "/dashboard" });
});

app.post("/api/auth/logout", (_req, res) => {
  res.clearCookie(COOKIE_NAME, getCookieOptions());
  res.status(200).json({ ok: true });
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
  res.status(200).send("SwitchOS API is running.");
});

const port = Number(process.env.PORT || 3005);
app.listen(port, ENV.bindHost, () => {
  console.log(`[SwitchOS] API listening on http://${ENV.bindHost}:${port}`);
});
