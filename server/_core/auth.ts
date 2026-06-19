import cookie from "cookie";
import { createRemoteJWKSet, jwtVerify, SignJWT } from "jose";

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

type DiscoveryDocument = {
  issuer?: string;
  jwks_uri?: string;
  end_session_endpoint?: string;
};

let remoteJwksPromise: Promise<ReturnType<typeof createRemoteJWKSet> | null> | null = null;
let discoveryDocumentPromise: Promise<DiscoveryDocument | null> | null = null;

function getSessionKey() {
  return encoder.encode(ENV.cookieSecret);
}

function normalizeScopes(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((scope): scope is string => typeof scope === "string" && scope.trim().length > 0);
  }
  if (typeof value === "string") {
    return value.split(" ").map((scope) => scope.trim()).filter(Boolean);
  }
  return [];
}

function normalizeRole(payload: Record<string, unknown>) {
  if (typeof payload.role === "string" && payload.role.trim()) return payload.role;

  const realmAccess = payload.realm_access;
  if (realmAccess && typeof realmAccess === "object" && Array.isArray((realmAccess as { roles?: unknown[] }).roles)) {
    const roles = (realmAccess as { roles?: unknown[] }).roles ?? [];
    const lowered = roles.map((role) => `${role}`.toLowerCase());
    if (lowered.includes("admin")) return "admin";
    if (lowered.includes("operator") || lowered.includes("ops")) return "operator";
    return lowered[0] ?? "viewer";
  }

  return "viewer";
}

function toSessionUser(payload: Record<string, unknown>): SessionUser | null {
  const subject = payload.sub;
  if (typeof subject !== "string" || subject.trim().length === 0) {
    return null;
  }

  const numericId = Number(subject);
  const fallbackId = Number.parseInt(subject.replace(/\D/g, "").slice(0, 9) || "0", 10);
  const resolvedId = Number.isFinite(numericId) && numericId > 0 ? numericId : fallbackId;
  if (!Number.isFinite(resolvedId) || resolvedId <= 0) {
    return null;
  }

  return {
    id: resolvedId,
    name: typeof payload.name === "string" && payload.name.trim().length > 0
      ? payload.name
      : typeof payload.preferred_username === "string" && payload.preferred_username.trim().length > 0
        ? payload.preferred_username
        : "Operator",
    email: typeof payload.email === "string" ? payload.email : null,
    role: normalizeRole(payload),
    openId: typeof payload.openId === "string"
      ? payload.openId
      : typeof payload.preferred_username === "string"
        ? payload.preferred_username
        : subject,
    tenantId: typeof payload.tenantId === "string"
      ? payload.tenantId
      : typeof payload.azp === "string"
        ? payload.azp
        : null,
    scopes: normalizeScopes(payload.scopes ?? payload.scope),
  };
}

async function getDiscoveryDocument(): Promise<DiscoveryDocument | null> {
  if (!ENV.enableExternalOidc || !ENV.oidcIssuerUrl) return null;
  if (!discoveryDocumentPromise) {
    discoveryDocumentPromise = (async () => {
      const discoveryUrl = ENV.oidcDiscoveryUrl || `${ENV.oidcIssuerUrl}/.well-known/openid-configuration`;
      const response = await fetch(discoveryUrl, { headers: { accept: "application/json" } });
      if (!response.ok) {
        throw new Error(`Failed to load OIDC discovery document: ${response.status}`);
      }
      return await response.json() as DiscoveryDocument;
    })().catch((error) => {
      console.error("[SwitchOS] OIDC discovery failed", error);
      return null;
    });
  }
  return discoveryDocumentPromise;
}

async function getRemoteJwks() {
  if (!ENV.enableExternalOidc || !ENV.oidcIssuerUrl) return null;
  if (!remoteJwksPromise) {
    remoteJwksPromise = (async () => {
      const discovery = await getDiscoveryDocument();
      const jwksUrl = discovery?.jwks_uri;
      if (!jwksUrl) return null;
      return createRemoteJWKSet(new URL(jwksUrl));
    })();
  }
  return remoteJwksPromise;
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

export async function verifyExternalAccessToken(token: string): Promise<SessionUser | null> {
  if (!ENV.enableExternalOidc || !ENV.oidcIssuerUrl) return null;
  try {
    const jwks = await getRemoteJwks();
    if (!jwks) return null;
    const discovery = await getDiscoveryDocument();
    const issuer = discovery?.issuer ?? ENV.oidcIssuerUrl;
    const { payload } = await jwtVerify(token, jwks, {
      issuer,
      audience: ENV.oidcAudience || ENV.oidcClientId,
    });
    return toSessionUser(payload as Record<string, unknown>);
  } catch (error) {
    console.warn("[SwitchOS] External access token verification failed", error);
    return null;
  }
}

export async function getSessionUserFromRequest(headers: Record<string, string | string[] | undefined>) {
  const authHeader = headers.authorization;
  const bearer = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";

  if (bearer) {
    const externalUser = await verifyExternalAccessToken(bearer);
    if (externalUser) return externalUser;

    const localUser = await verifySessionToken(bearer);
    if (localUser) return localUser;
  }

  const cookieHeader = typeof headers.cookie === "string" ? headers.cookie : undefined;
  if (!cookieHeader) return null;
  const parsed = cookie.parse(cookieHeader);
  const raw = parsed[COOKIE_NAME];
  if (!raw) return null;
  return verifySessionToken(raw);
}

export async function getOidcDiscoveryDocument() {
  return getDiscoveryDocument();
}
