/**
 * PowerSync token issuance + JWKS endpoints.
 *
 * Clients of the PowerSync service present short-lived JWTs minted here
 * (the SDK calls the connector's fetchCredentials(), which targets
 * GET/POST /api/powersync/token). The self-hosted service verifies tokens
 * against the JWKS served at GET /api/powersync/jwks.json
 * (client_auth.jwks_uri in deploy/powersync/service.yaml).
 *
 * Token contract (mirrored in deploy/powersync/sync-rules.yaml):
 *   sub                  = public.users.id (post session unification)
 *   aud                  = ENV.powerSyncJwtAudience (default 'powersync')
 *   role                 = 'consumer' | 'courier' | 'merchant' | 'operator',
 *                          derived from public.users.role plus driver/provider
 *                          row resolution (see resolvePowerSyncIdentity)
 *   driver_id/provider_id = present on courier/merchant tokens respectively
 *   exp - iat            = TTL, clamped to [60, 3600] seconds
 *
 * Fail-closed: when neither POWERSYNC_JWT_PRIVATE_KEY (RS256 PEM, production
 * path) nor POWERSYNC_JWT_SECRET (HS256, DEV ONLY — refused in production) is
 * set, every endpoint answers 503 `powersync_not_configured`. HS256 tokens
 * are NOT publishable to the JWKS endpoint; a JWKS fetch with no private key
 * configured answers 503 `powersync_jwks_unavailable`.
 *
 * No external JWT dependency: signing is node:crypto (RSASSA-PKCS1-v1_5 for
 * RS256, HMAC-SHA256 for HS256) over base64url segments.
 */
import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  sign as cryptoSign,
  type JsonWebKey,
} from "node:crypto";
import type express from "express";
import { getPool } from "../db";
import { ENV } from "./env";
import type { SessionUser } from "./trpc";

export type PowerSyncRole = "consumer" | "courier" | "merchant" | "operator";

export type PowerSyncIdentity = {
  role: PowerSyncRole;
  driverId?: number;
  providerId?: number;
};

export const POWERSYNC_TOKEN_MAX_TTL_SECONDS = 3600;
export const POWERSYNC_TOKEN_MIN_TTL_SECONDS = 60;
export const POWERSYNC_TOKEN_DEFAULT_TTL_SECONDS = 3600;

const POWERSYNC_NOT_CONFIGURED = "powersync_not_configured";

type AppRequest = express.Request & { user?: SessionUser | null };

export function isPowerSyncConfigured(): boolean {
  if (ENV.powerSyncJwtPrivateKeyPem) return true;
  // HS256 shared-secret fallback is a development escape hatch only.
  return !ENV.isProduction && Boolean(ENV.powerSyncJwtSecret);
}

export function isPowerSyncJwksAvailable(): boolean {
  return Boolean(ENV.powerSyncJwtPrivateKeyPem);
}

/** Clamp the requested TTL into the [60, 3600] envelope. */
export function clampPowerSyncTokenTtlSeconds(requested?: number): number {
  if (!Number.isFinite(requested)) return POWERSYNC_TOKEN_DEFAULT_TTL_SECONDS;
  return Math.min(
    POWERSYNC_TOKEN_MAX_TTL_SECONDS,
    Math.max(POWERSYNC_TOKEN_MIN_TTL_SECONDS, Math.trunc(requested as number)),
  );
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function powerSyncKeyId(publicKeyPem: string): string {
  return createHash("sha256").update(publicKeyPem).digest("base64url").slice(0, 24);
}

/**
 * Pure JWT builder — takes explicit key material so it is unit-testable
 * without touching process.env. Returns the compact JWS and its iat/exp.
 */
export function buildPowerSyncJwt(input: {
  subject: string;
  audience: string;
  role: PowerSyncRole;
  ttlSeconds: number;
  privateKeyPem?: string;
  hs256Secret?: string;
  driverId?: number;
  providerId?: number;
  issuedAtEpochSeconds?: number;
}): { token: string; issuedAt: number; expiresAt: number; kid: string | null } {
  const issuedAt = input.issuedAtEpochSeconds ?? Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + clampPowerSyncTokenTtlSeconds(input.ttlSeconds);

  const claims: Record<string, unknown> = {
    sub: input.subject,
    aud: input.audience,
    iat: issuedAt,
    exp: expiresAt,
    role: input.role,
  };
  if (input.driverId != null) claims.driver_id = input.driverId;
  if (input.providerId != null) claims.provider_id = input.providerId;

  let header: Record<string, unknown>;
  let signature: Buffer;
  let kid: string | null = null;

  if (input.privateKeyPem) {
    const publicKeyPem = createPublicKey(createPrivateKey(input.privateKeyPem))
      .export({ format: "pem", type: "spki" })
      .toString();
    kid = powerSyncKeyId(publicKeyPem);
    header = { alg: "RS256", typ: "JWT", kid };
    const data = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
    signature = cryptoSign("RSA-SHA256", Buffer.from(data), createPrivateKey(input.privateKeyPem));
    return { token: `${data}.${signature.toString("base64url")}`, issuedAt, expiresAt, kid };
  }

  if (!input.hs256Secret) {
    throw new Error(POWERSYNC_NOT_CONFIGURED);
  }
  header = { alg: "HS256", typ: "JWT" };
  const data = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  signature = createHmac("sha256", input.hs256Secret).update(data).digest();
  return { token: `${data}.${signature.toString("base64url")}`, issuedAt, expiresAt, kid };
}

/** Public JWK set derived from the configured RS256 private key. */
export function buildPowerSyncJwks(): { keys: JsonWebKey[] } {
  const jwk = createPublicKey(createPrivateKey(ENV.powerSyncJwtPrivateKeyPem)).export({
    format: "jwk",
  }) as JsonWebKey;
  const publicKeyPem = createPublicKey(createPrivateKey(ENV.powerSyncJwtPrivateKeyPem))
    .export({ format: "pem", type: "spki" })
    .toString();
  return {
    keys: [
      {
        ...jwk,
        kid: powerSyncKeyId(publicKeyPem),
        alg: "RS256",
        use: "sig",
      } as JsonWebKey,
    ],
  };
}

/**
 * Derive the PowerSync role claim from public.users.role plus domain rows:
 *   admin                     -> operator
 *   drivers row (open_id)     -> courier  (+ driver_id claim)
 *   service_providers (email) -> merchant (+ provider_id claim)
 *   otherwise                 -> consumer
 * Fails closed on DB errors: the caller maps them to 503.
 */
export async function resolvePowerSyncIdentity(
  user: SessionUser,
): Promise<PowerSyncIdentity> {
  if (user.role === "admin") return { role: "operator" };

  const pool = await getPool();
  if (user.openId) {
    const driver = await pool.query(
      `SELECT id FROM public.drivers WHERE open_id = $1 LIMIT 1`,
      [user.openId],
    );
    const driverId = Number(driver.rows[0]?.id);
    if (Number.isInteger(driverId) && driverId > 0) {
      return { role: "courier", driverId };
    }
  }
  if (user.email) {
    const provider = await pool.query(
      `SELECT id FROM public.service_providers WHERE lower(email) = lower($1) LIMIT 1`,
      [user.email],
    );
    const providerId = Number(provider.rows[0]?.id);
    if (Number.isInteger(providerId) && providerId > 0) {
      return { role: "merchant", providerId };
    }
  }
  return { role: "consumer" };
}

/**
 * GET/POST /api/powersync/token — session-authed (mounted after the session
 * middleware; 401 without a session), rate-limited 60/min/IP at the mount
 * site. Response shape matches the PowerSync connector contract:
 * { endpoint, token, expiresAt }.
 */
export async function powerSyncTokenHandler(
  req: express.Request,
  res: express.Response,
): Promise<void> {
  const user = (req as AppRequest).user;
  if (!user) {
    res.status(401).json({ error: "authentication_required" });
    return;
  }
  if (!isPowerSyncConfigured()) {
    res.status(503).json({ error: POWERSYNC_NOT_CONFIGURED });
    return;
  }

  const requestedTtl = Number.parseInt(
    `${(req.query.ttlSeconds ?? (req.body as { ttlSeconds?: unknown } | undefined)?.ttlSeconds) ?? ""}`,
    10,
  );
  const ttlSeconds = clampPowerSyncTokenTtlSeconds(
    Number.isFinite(requestedTtl) ? requestedTtl : undefined,
  );

  let identity: PowerSyncIdentity;
  try {
    identity = await resolvePowerSyncIdentity(user);
  } catch (error) {
    console.error("[SwitchOS] PowerSync identity resolution failed", error);
    res.status(503).json({ error: "powersync_identity_resolution_failed" });
    return;
  }

  const { token, expiresAt } = buildPowerSyncJwt({
    subject: String(user.id),
    audience: ENV.powerSyncJwtAudience,
    role: identity.role,
    ttlSeconds,
    privateKeyPem: ENV.powerSyncJwtPrivateKeyPem || undefined,
    hs256Secret: ENV.powerSyncJwtPrivateKeyPem ? undefined : ENV.powerSyncJwtSecret,
    driverId: identity.driverId,
    providerId: identity.providerId,
  });

  res.status(200).json({
    endpoint: ENV.powerSyncServiceUrl || null,
    token,
    expiresAt: new Date(expiresAt * 1000).toISOString(),
    expiresIn: ttlSeconds,
  });
}

/**
 * GET /api/powersync/jwks.json — PUBLIC (the PowerSync service fetches it
 * server-to-server; there is no session). Only available when the RS256
 * private key is configured.
 */
export function powerSyncJwksHandler(
  _req: express.Request,
  res: express.Response,
): void {
  if (!isPowerSyncJwksAvailable()) {
    res.status(503).json({ error: "powersync_jwks_unavailable" });
    return;
  }
  try {
    res.setHeader("Cache-Control", "public, max-age=300");
    res.status(200).json(buildPowerSyncJwks());
  } catch (error) {
    console.error("[SwitchOS] PowerSync JWKS derivation failed", error);
    res.status(503).json({ error: "powersync_jwks_unavailable" });
  }
}
