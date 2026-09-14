import cookie from "cookie";
import { createHash, randomBytes, randomUUID } from "crypto";
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
  authenticationMethods?: string[];
  assuranceLevel?: string | null;
  mfaAuthenticated?: boolean;
  sessionId?: string | null;
  publicUserId?: number | null;
  operatorCredentialId?: number | null;
};

type DiscoveryDocument = {
  issuer?: string;
  authorization_endpoint?: string;
  token_endpoint?: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
  end_session_endpoint?: string;
};

type OidcTokens = {
  access_token?: string;
  id_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
  scope?: string;
};

let remoteJwksPromise: Promise<ReturnType<typeof createRemoteJWKSet> | null> | null = null;
let discoveryDocumentPromise: Promise<DiscoveryDocument | null> | null = null;

function getSessionKey() {
  return encoder.encode(ENV.cookieSecret);
}

function inferDefaultScopes(role: string) {
  const normalizedRole = role.trim().toLowerCase();
  if (normalizedRole === "admin") {
    return ["platform:read", "platform:write", "analytics:read", "analytics:write"];
  }
  if (["operator", "ops"].includes(normalizedRole)) {
    return ["platform:read", "platform:write", "analytics:read"];
  }
  return ["platform:read", "analytics:read"];
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

function normalizeAuthenticationMethods(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((method): method is string => typeof method === "string" && method.trim().length > 0)
    .map((method) => method.trim().toLowerCase());
}

function isMfaAuthenticated(authenticationMethods: string[], assuranceLevel: string | null) {
  return authenticationMethods.some((method) => ["mfa", "otp", "webauthn", "hwk", "passkey"].includes(method))
    || ["2", "urn:ietf:params:oauth:acr:2", "urn:mace:incommon:iap:silver"].includes(`${assuranceLevel ?? ""}`.toLowerCase());
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

function toPositiveInteger(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const num = typeof value === "string" ? Number(value.trim()) : value;
  return Number.isSafeInteger(num) && num > 0 ? num : null;
}

function parseOperatorCredentialOpenId(openId: string | null): number | null {
  if (!openId) return null;
  const match = /^operator:(\d{1,15})$/.exec(openId.trim());
  return match ? toPositiveInteger(match[1]) : null;
}

function toSessionUser(payload: Record<string, unknown>): SessionUser | null {
  const subject = payload.sub;
  if (typeof subject !== "string" || subject.trim().length === 0) {
    return null;
  }

  const role = normalizeRole(payload);
  const explicitScopes = normalizeScopes(payload.scopes ?? payload.scope);
  const authenticationMethods = normalizeAuthenticationMethods(payload.amr);
  const assuranceLevel = typeof payload.acr === "string" ? payload.acr.trim() || null : null;
  const openId = typeof payload.openId === "string"
    ? payload.openId
    : typeof payload.preferred_username === "string"
      ? payload.preferred_username
      : subject;

  // H-4: never derive a numeric identity by stripping digits out of the OIDC
  // sub — distinct subjects ("user-1a2b", "user-12ab") collapsed onto the
  // same munged id. Numeric identity comes only from claims that are
  // collision-free by construction:
  //   1. the signed publicUserId / operatorCredentialId claims we mint,
  //   2. a fully numeric sub (legacy local session tokens: sub = credential
  //      id), or the `operator:<id>` openId namespace.
  // Anything else keeps the FULL sub string as openId and gets id 0 as an
  // unresolved placeholder until the session-load path resolves the
  // public.users row keyed on that openId (lookup is always by the original
  // open_id string, never by a derived number), so pre-existing users keep
  // logging in.
  const operatorCredentialId =
    toPositiveInteger(payload.operatorCredentialId) ??
    (/^\d{1,15}$/.test(subject.trim()) ? toPositiveInteger(subject) : null) ??
    parseOperatorCredentialOpenId(openId);
  const publicUserId = toPositiveInteger(payload.publicUserId);
  const resolvedId = publicUserId ?? operatorCredentialId ?? 0;

  return {
    id: resolvedId,
    publicUserId,
    operatorCredentialId,
    name: typeof payload.name === "string" && payload.name.trim().length > 0
      ? payload.name
      : typeof payload.preferred_username === "string" && payload.preferred_username.trim().length > 0
        ? payload.preferred_username
        : "Operator",
    email: typeof payload.email === "string" ? payload.email : null,
    role,
    openId,
    tenantId: typeof payload.tenantId === "string"
      ? payload.tenantId
      : typeof payload.azp === "string"
        ? payload.azp
        : null,
    scopes: explicitScopes.length > 0 ? explicitScopes : inferDefaultScopes(role),
    authenticationMethods,
    assuranceLevel,
    mfaAuthenticated: isMfaAuthenticated(authenticationMethods, assuranceLevel),
    sessionId: typeof payload.jti === "string" ? payload.jti : null,
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

function randomUrlSafe(length = 32) {
  return randomBytes(length).toString("base64url");
}

function sha256Base64Url(value: string) {
  return createHash("sha256").update(value).digest("base64url");
}

export function buildOidcFlowState() {
  const verifier = randomUrlSafe(48);
  const state = randomUrlSafe(24);
  const nonce = randomUrlSafe(24);
  const challenge = sha256Base64Url(verifier);
  return { verifier, state, nonce, challenge };
}

export function getOidcRedirectUri(origin: string) {
  return `${origin.replace(/\/$/, "")}${ENV.oidcRedirectPath}`;
}

export async function buildOidcAuthorizationUrl(origin: string, returnTo = "/dashboard") {
  const discovery = await getDiscoveryDocument();
  const authorizationEndpoint = discovery?.authorization_endpoint;
  if (!authorizationEndpoint) {
    throw new Error("OIDC authorization endpoint is not available");
  }

  const flow = buildOidcFlowState();
  const url = new URL(authorizationEndpoint);
  url.searchParams.set("client_id", ENV.oidcClientId);
  url.searchParams.set("redirect_uri", getOidcRedirectUri(origin));
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", ENV.oidcScope);
  url.searchParams.set("state", flow.state);
  url.searchParams.set("nonce", flow.nonce);
  url.searchParams.set("code_challenge", flow.challenge);
  url.searchParams.set("code_challenge_method", "S256");

  return {
    authorizationUrl: url.toString(),
    state: flow.state,
    nonce: flow.nonce,
    verifier: flow.verifier,
    returnTo,
  };
}

async function verifyExternalJwt(token: string, expectedNonce?: string): Promise<SessionUser | null> {
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

    if (expectedNonce && payload.nonce !== expectedNonce) {
      return null;
    }
    return toSessionUser(payload as Record<string, unknown>);
  } catch (error) {
    console.warn("[SwitchOS] External JWT verification failed", error);
    return null;
  }
}

export async function exchangeAuthorizationCode(code: string, verifier: string, origin: string): Promise<OidcTokens> {
  const discovery = await getDiscoveryDocument();
  const tokenEndpoint = discovery?.token_endpoint;
  if (!tokenEndpoint) {
    throw new Error("OIDC token endpoint is not available");
  }

  const body = new URLSearchParams();
  body.set("grant_type", "authorization_code");
  body.set("client_id", ENV.oidcClientId);
  if (ENV.oidcClientSecret) {
    body.set("client_secret", ENV.oidcClientSecret);
  }
  body.set("code", code);
  body.set("code_verifier", verifier);
  body.set("redirect_uri", getOidcRedirectUri(origin));

  const response = await fetch(tokenEndpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body: body.toString(),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OIDC token exchange failed: ${response.status} ${text}`);
  }

  return await response.json() as OidcTokens;
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
    authenticationMethods: user.authenticationMethods ?? [],
    assuranceLevel: user.assuranceLevel ?? null,
    mfaAuthenticated: Boolean(user.mfaAuthenticated),
    publicUserId:
      user.publicUserId && user.publicUserId > 0 ? user.publicUserId : null,
    operatorCredentialId:
      user.operatorCredentialId && user.operatorCredentialId > 0
        ? user.operatorCredentialId
        : null,
  })
    .setProtectedHeader({ alg: "HS256", typ: "JWT" })
    .setIssuer(ENV.sessionIssuer)
    .setAudience(ENV.sessionAudience)
    .setSubject(subject)
    .setJti(user.sessionId ?? randomUUID())
    .setIssuedAt()
    .setExpirationTime(`${SESSION_TTL_SECONDS}s`)
    .sign(getSessionKey());
}

export type VerifiedSession = {
  user: SessionUser;
  sessionId: string | null;
  expiresAt: Date | null;
};

function toVerifiedSession(payload: Record<string, unknown>): VerifiedSession | null {
  const user = toSessionUser(payload);
  if (!user) return null;
  return {
    user,
    sessionId: typeof payload.jti === "string" ? payload.jti : null,
    expiresAt:
      typeof payload.exp === "number" && Number.isFinite(payload.exp)
        ? new Date(payload.exp * 1000)
        : null,
  };
}

export async function verifySessionToken(token: string): Promise<SessionUser | null> {
  const session = await verifySessionTokenWithClaims(token);
  return session?.user ?? null;
}

export async function verifySessionTokenWithClaims(token: string): Promise<VerifiedSession | null> {
  try {
    const { payload } = await jwtVerify(token, getSessionKey(), {
      issuer: ENV.sessionIssuer,
      audience: ENV.sessionAudience,
    });
    return toVerifiedSession(payload as Record<string, unknown>);
  } catch {
    return null;
  }
}

export async function verifyExternalAccessToken(token: string): Promise<SessionUser | null> {
  return verifyExternalJwt(token);
}

export async function verifyExternalIdToken(token: string, expectedNonce?: string): Promise<SessionUser | null> {
  return verifyExternalJwt(token, expectedNonce);
}

export async function resolveUserFromExternalTokens(tokens: OidcTokens, expectedNonce?: string): Promise<SessionUser | null> {
  if (tokens.id_token) {
    const fromIdToken = await verifyExternalIdToken(tokens.id_token, expectedNonce);
    if (fromIdToken) return fromIdToken;
  }
  if (tokens.access_token) {
    const fromAccessToken = await verifyExternalAccessToken(tokens.access_token);
    if (fromAccessToken) return fromAccessToken;
  }
  return null;
}

export async function getSessionUserFromRequest(headers: Record<string, string | string[] | undefined>) {
  const session = await getSessionFromRequest(headers);
  return session?.user ?? null;
}

/**
 * Verify the request's session credential (external bearer JWT, local
 * session bearer, or session cookie) and return the session user together
 * with the token's jti/expiry so callers can enforce server-side
 * revocation. The returned user is NOT yet unified onto public.users —
 * callers must run it through the session-load path (unifySessionUser).
 */
export async function getSessionFromRequest(
  headers: Record<string, string | string[] | undefined>,
): Promise<VerifiedSession | null> {
  const authHeader = headers.authorization;
  const bearer = typeof authHeader === "string" && authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";

  if (bearer) {
    const externalUser = await verifyExternalAccessToken(bearer);
    if (externalUser) {
      return {
        user: externalUser,
        sessionId: externalUser.sessionId ?? null,
        expiresAt: null,
      };
    }

    const localSession = await verifySessionTokenWithClaims(bearer);
    if (localSession) return localSession;
  }

  const cookieHeader = typeof headers.cookie === "string" ? headers.cookie : undefined;
  if (!cookieHeader) return null;
  const parsed = cookie.parse(cookieHeader);
  const raw = parsed[COOKIE_NAME];
  if (!raw) return null;
  return verifySessionTokenWithClaims(raw);
}

export async function getOidcDiscoveryDocument() {
  return getDiscoveryDocument();
}
