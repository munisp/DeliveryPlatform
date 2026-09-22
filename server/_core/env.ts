import dotenv from "dotenv";
import crypto from "node:crypto";

dotenv.config();

// Cache environment variables for performance
const isProduction = process.env.NODE_ENV === "production";

function resolveSessionSecret(): string {
  const secret = process.env.SESSION_SECRET?.trim();
  if (secret && secret.length >= 32) {
    return secret;
  }
  if (isProduction) {
    throw new Error(
      "SESSION_SECRET must be set to a stable value of at least 32 characters in production.",
    );
  }
  console.warn(
    "[SECURITY] SESSION_SECRET is not set (or is shorter than 32 characters). " +
      "Generating an ephemeral development secret: all sessions are invalidated on every restart. " +
      "Set SESSION_SECRET in .env for stable local sessions.",
  );
  return crypto.randomBytes(32).toString("hex");
}

function requireProductionEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (value) {
    return value;
  }
  if (isProduction) {
    throw new Error(`${name} must be set in production.`);
  }
  return "";
}

const defaultOwnerOpenId = "dev-owner";
if (isProduction && !process.env.OWNER_OPEN_ID?.trim()) {
  throw new Error("OWNER_OPEN_ID must be set in production.");
}

export function parseCorsOrigins(envValue: string | undefined): string[] {
  return (envValue ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

const defaultCorsOrigins = "http://localhost:5173,http://127.0.0.1:5173";
const resolvedCorsOrigins = parseCorsOrigins(process.env.CORS_ORIGINS);
if (isProduction && resolvedCorsOrigins.length === 0) {
  throw new Error("CORS_ORIGINS must list at least one origin in production.");
}

const defaultCspConnectSrc = "'self'";
const resolvedCspConnectSrc = parseCorsOrigins(process.env.CSP_CONNECT_SRC);
if (isProduction && resolvedCspConnectSrc.length === 0) {
  throw new Error("CSP_CONNECT_SRC must list at least one source in production.");
}

function parseCsvList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function resolveInternalServiceToken(): string {
  const token = process.env.INTERNAL_SERVICE_TOKEN?.trim();
  if (token && token.length >= 32) {
    return token;
  }
  if (isProduction) {
    throw new Error(
      "INTERNAL_SERVICE_TOKEN must be set to a stable value of at least 32 characters in production.",
    );
  }
  console.warn(
    "[SECURITY] INTERNAL_SERVICE_TOKEN is not set (or is shorter than 32 characters). " +
      "Generating an ephemeral development token: internal service calls will fail across restarts. " +
      "Set INTERNAL_SERVICE_TOKEN in .env for stable local development.",
  );
  return crypto.randomBytes(32).toString("hex");
}

export const ENV = {
  isProduction,
  port: Number.parseInt(process.env.PORT || "3005", 10),
  bindHost: process.env.BIND_HOST?.trim() || "0.0.0.0",
  databaseUrl: process.env.DATABASE_URL ?? "",
  // TLS certificate verification for the database connection can only be
  // disabled via this development-only escape hatch; it is unconditionally
  // rejected in production regardless of the flag's value.
  databaseTlsSkipVerify:
    !isProduction && process.env.DATABASE_TLS_SKIP_VERIFY === "true",
  databaseSslCa: process.env.DATABASE_SSL_CA?.trim() || "",
  redisUrl: process.env.REDIS_URL?.trim() || "",
  sessionSecret: resolveSessionSecret(),
  internalServiceToken: resolveInternalServiceToken(),
  ownerOpenId: process.env.OWNER_OPEN_ID?.trim() || defaultOwnerOpenId,
  oidcIssuerUrl: process.env.OIDC_ISSUER_URL?.trim() || "",
  oidcClientId: process.env.OIDC_CLIENT_ID?.trim() || "",
  oidcClientSecret: process.env.OIDC_CLIENT_SECRET?.trim() || "",
  oidcLogoutUrl: process.env.OIDC_LOGOUT_URL?.trim() || "",
  enableExternalOidc: process.env.ENABLE_EXTERNAL_OIDC === "true",
  allowedOrigins: process.env.CORS_ORIGINS || defaultCorsOrigins,
  cspConnectSrc: process.env.CSP_CONNECT_SRC || defaultCspConnectSrc,
  cacheControlIndexHtml:
    process.env.CACHE_CONTROL_INDEX_HTML || "no-cache, no-store, must-revalidate",
  apiBodyLimit: process.env.API_BODY_LIMIT || "10mb",
  selfServiceSignupEnabled: process.env.SELF_SERVICE_SIGNUP_ENABLED !== "false",
  requireMfaForPrivilegedActions:
    process.env.REQUIRE_MFA_FOR_PRIVILEGED_ACTIONS !== "false",
  dispatchOptimizerUrl: process.env.DISPATCH_OPTIMIZER_URL || "http://127.0.0.1:8001",
  complianceReviewServiceUrl:
    process.env.COMPLIANCE_REVIEW_SERVICE_URL || "http://127.0.0.1:8002",
  lakehouseServiceUrl: process.env.LAKEHOUSE_SERVICE_URL || "http://127.0.0.1:8007",
  lakehousePath: process.env.LAKEHOUSE_PATH ?? "/tmp/switchos-lakehouse",
  // Background Postgres→lakehouse sync cadence (ops-tunable). Reads no longer
  // sync inline (perf finding 1); this is the only freshness lever.
  lakehouseSyncIntervalMs: parsePositiveInteger(
    process.env.LAKEHOUSE_SYNC_INTERVAL_MS,
    45_000,
  ),
  tigerbeetleServiceUrl: process.env.TIGERBEETLE_SERVICE_URL?.trim() || "",
  medusaMerchantConfigured: Boolean(
    process.env.MEDUSA_ADMIN_URL?.trim() && process.env.MEDUSA_ADMIN_API_KEY?.trim(),
  ),
  kafkaBrokers: process.env.KAFKA_BROKERS ?? "",
  kafkaClientId: process.env.KAFKA_CLIENT_ID || "switchos-operator-dashboard",
  kafkaOperationalEventsTopic:
    process.env.KAFKA_OPERATIONAL_EVENTS_TOPIC || "switchos.operational.events",
  daprHttpPort: process.env.DAPR_HTTP_PORT?.trim() || "",
  daprPubsubName: process.env.DAPR_PUBSUB_NAME?.trim() || "switchos-pubsub",
  daprOperationalEventsTopic:
    process.env.DAPR_OPERATIONAL_EVENTS_TOPIC || "switchos.operational.events",
  opensearchUrl: process.env.OPENSEARCH_URL?.trim() || "",
  opensearchUsername: process.env.OPENSEARCH_USERNAME?.trim() || "",
  opensearchPassword: process.env.OPENSEARCH_PASSWORD?.trim() || "",
  opensearchOperationalEventsIndex:
    process.env.OPENSEARCH_OPERATIONAL_EVENTS_INDEX || "switchos-operational-events",
  vehicleTrackerConsumerEmbedded:
    process.env.VEHICLE_TRACKER_CONSUMER_EMBEDDED === "true",
  vehicleTrackerDatabasePoolMax: Math.min(
    Math.max(
      parsePositiveInteger(process.env.VEHICLE_TRACKER_DATABASE_POOL_MAX, 4),
      4,
    ),
    8,
  ),
  cookieDomain: process.env.COOKIE_DOMAIN?.trim() || "",
  sentryDsn: process.env.SENTRY_DSN?.trim() || "",
  metricsToken: process.env.METRICS_TOKEN?.trim() || "",
  logLevel: process.env.LOG_LEVEL?.trim() || (isProduction ? "info" : "debug"),
  tracingEnabled: process.env.OTEL_TRACING_ENABLED === "true",
  otlpEndpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT?.trim() || "",
  riderVerificationRequired:
    process.env.RIDER_VERIFICATION_REQUIRED !== "false",
  riderVerificationProvider:
    process.env.RIDER_VERIFICATION_PROVIDER?.trim() || "mock",
  riderVerificationProviderUrl:
    process.env.RIDER_VERIFICATION_PROVIDER_URL?.trim() || "",
  riderVerificationMaxAttempts: parsePositiveInteger(
    process.env.RIDER_VERIFICATION_MAX_ATTEMPTS,
    3,
  ),
  verificationCacheTtlMs: parsePositiveInteger(
    process.env.VERIFICATION_CACHE_TTL_MS,
    30_000,
  ),
  dispatchFairnessMaxAcceptsPerWindow: parsePositiveInteger(
    process.env.DISPATCH_FAIRNESS_MAX_ACCEPTS_PER_WINDOW,
    4,
  ),
  dispatchFairnessWindowSeconds: parsePositiveInteger(
    process.env.DISPATCH_FAIRNESS_WINDOW_SECONDS,
    120,
  ),
  longcatVoiceMaxConcurrentSessions: parsePositiveInteger(
    process.env.LONGCAT_VOICE_MAX_CONCURRENT_SESSIONS,
    25,
  ),
  longcatVoiceSessionIdleTimeoutMs: parsePositiveInteger(
    process.env.LONGCAT_VOICE_SESSION_IDLE_TIMEOUT_MS,
    60_000,
  ),
};

export type Env = typeof ENV;

export function assertInternalServiceTokenConfigured() {
  if (!ENV.internalServiceToken) {
    throw new Error("INTERNAL_SERVICE_TOKEN must be configured for internal service calls.");
  }
}

export function listEnvValidationWarnings(): string[] {
  const warnings: string[] = [];
  if (!ENV.databaseUrl) warnings.push("DATABASE_URL is not configured.");
  if (ENV.isProduction && !ENV.redisUrl)
    warnings.push("REDIS_URL is not configured in production; rate limiting falls back to in-memory.");
  return warnings;
}
