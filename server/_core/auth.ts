import cookie from "cookie";
import { SignJWT, jwtVerify } from "jose";

import { COOKIE_NAME } from "../../shared/const";
import { ENV } from "./env";
import type { SessionUser } from "./trpc";

const encoder = new TextEncoder();
const SESSION_TTL_SECONDS = 60 * 60 * 12;

type SessionClaims = {
  sub: string;
  name: string;
  email?: string | null;
  role?: string | null;
  openId?: string | null;
  tenantId?: string | null;
  scopes?: string[];
};

function getSessionKey() {
  return encoder.encode(ENV.cookieSecret);
}

function normalizeScopes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((scope): scope is string => typeof scope === "string" && scope.trim().length > 0);
}

function toSessionUser(payload: Record<string, unknown>): SessionUser | null {
  const subject = payload.sub;
  if (typeof subject !== "string" || subject.trim().length === 0) {
    return null;
  }

  const numericId = Number(subject);
  if (!Number.isFinite(numericId) || numericId <= 0) {
    return null;
  }

  return {
    id: numericId,
    name: typeof payload.name === "string" && payload.name.trim().length > 0 ? payload.name : "Operator",
    email: typeof payload.email === "string" ? payload.email : null,
    role: typeof payload.role === "string" ? payload.role : "viewer",
    openId: typeof payload.openId === "string" ? payload.openId : null,
    tenantId: typeof payload.tenantId === "string" ? payload.tenantId : null,
    scopes: normalizeScopes(payload.scopes),
  };
}

export async function createSessionToken(user: SessionClaims) {
  const subject = user.sub.trim();
  return new SignJWT({
    name: user.name,
    email: user.email ?? null,
    role: user.role ?? "viewer",
    openId: user.openId ?? null,
    tenantId: user.tenantId ?? null,
    scopes: user.scopes ?? [],
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ENV.sessionIssuer)
    .setAudience(ENV.sessionAudience)
    .setSubject(subject)
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSessionKey());
}

export async function verifySessionToken(token: string): Promise<SessionUser | null> {
  try {
    const { payload } = await jwtVerify(token, getSessionKey(), {
      issuer: ENV.sessionIssuer,
      audience: ENV.sessionAudience,
    });
    return toSessionUser(payload as Record<string, unknown>);
  } catch {
    return null;
  }
}

export async function getSessionUserFromRequest(headers: Record<string, string | string[] | undefined>) {
  const authHeader = headers.authorization;
  const bearer = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";

  if (bearer) {
    const user = await verifySessionToken(bearer);
    if (user) return user;
  }

  const cookieHeader = typeof headers.cookie === "string" ? headers.cookie : undefined;
  if (!cookieHeader) return null;
  const parsed = cookie.parse(cookieHeader);
  const raw = parsed[COOKIE_NAME];
  if (!raw) return null;
  return verifySessionToken(raw);
}
