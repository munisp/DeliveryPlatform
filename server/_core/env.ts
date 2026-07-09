const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
].join(",");

const DEFAULT_CSP_CONNECT_SRC = [
  "https://fonts.googleapis.com",
  "https://fonts.gstatic.com",
  "https://api.maptiler.com",
  "https://*.tile.openstreetmap.org",
  "https://tile.openstreetmap.org",
  "https://events.mapbox.com",
  "ws:",
  "wss:",
].join(",");

function getRequiredEnv(name: string, fallback = "") {
  const value = process.env[name] ?? fallback;

  if (process.env.NODE_ENV === "production" && value.trim().length === 0) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getCookieSecret() {
  const configured = process.env.JWT_SECRET?.trim();
  if (configured) {
    if (
      process.env.NODE_ENV === "production" &&
      ["your-secret-key", "change-me", "default-secret"].includes(configured)
    ) {
      throw new Error("JWT_SECRET must be rotated before running in production");
    }
    return configured;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET is required in production");
  }

  return "switchos-local-development-secret-change-before-production";
}

function getBootstrapOperatorPassword() {
  const configured = process.env.BOOTSTRAP_OPERATOR_PASSWORD?.trim();
  if (configured) {
    if (
      process.env.NODE_ENV === "production" &&
      ["ChangeMe123!", "switchos-admin", "admin123"].includes(configured)
    ) {
      throw new Error("BOOTSTRAP_OPERATOR_PASSWORD must be rotated before running in production");
    }
    return configured;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("BOOTSTRAP_OPERATOR_PASSWORD is required in production");
  }

  return "ChangeMe123!";
}

function normalizeOAuthServerUrl() {
  const raw = process.env.OAUTH_SERVER_URL?.trim();
  if (raw) {
    return raw;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("OAUTH_SERVER_URL is required in production");
  }

  return "http://localhost:3010";
}

function normalizeOptionalUrl(name: string) {
  const raw = process.env[name]?.trim();
  if (!raw) return "";
  return raw.replace(/\/$/, "");
}

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (value == null || value.trim() === "") return fallback;
  return value.trim().toLowerCase() === "true";
}

export const ENV = {
  appId: getRequiredEnv("VITE_APP_ID", "switchos-operator-dashboard"),
  cookieSecret: getCookieSecret(),
  databaseUrl: getRequiredEnv("DATABASE_URL", "postgresql://ubuntu:ubuntu@127.0.0.1:5432/switchos"),
  oAuthServerUrl: normalizeOAuthServerUrl(),
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "switchos-owner",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  ollamaUrl: normalizeOptionalUrl("OLLAMA_URL") || "http://127.0.0.1:11434",
  ollamaModel: (process.env.OLLAMA_MODEL ?? "qwen2.5:3b").trim(),
  allowedOrigins: process.env.ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS,
  cspConnectSrc: process.env.CSP_CONNECT_SRC ?? DEFAULT_CSP_CONNECT_SRC,
  apiBodyLimit: process.env.API_BODY_LIMIT ?? "10mb",
  bootstrapOperatorEmail: (process.env.BOOTSTRAP_OPERATOR_EMAIL ?? "admin@switchos.local").trim().toLowerCase(),
  bootstrapOperatorName: process.env.BOOTSTRAP_OPERATOR_NAME ?? "SwitchOS Operator Admin",
  bootstrapOperatorRole: process.env.BOOTSTRAP_OPERATOR_ROLE ?? "admin",
  bootstrapOperatorPassword: getBootstrapOperatorPassword(),
  bootstrapTenantId: process.env.BOOTSTRAP_TENANT_ID ?? "switchos-core",
  sessionIssuer: process.env.SESSION_ISSUER ?? "switchos.local",
  sessionAudience: process.env.SESSION_AUDIENCE ?? "switchos-operator-dashboard",
  internalServiceToken: process.env.INTERNAL_SERVICE_TOKEN ?? "switchos-internal-dev-token-change-before-production",
  bindHost: process.env.BIND_HOST ?? "127.0.0.1",
  apisixAdminUrl: process.env.APISIX_ADMIN_URL ?? "http://127.0.0.1:9180",
  apisixControlUrl: process.env.APISIX_CONTROL_URL ?? "http://127.0.0.1:8006",
  permifyEndpoint: process.env.PERMIFY_ENDPOINT ?? "",
  permifySchemaVersion: process.env.PERMIFY_SCHEMA_VERSION ?? "switchos-v1",
  redisUrl: process.env.REDIS_URL ?? "",
  daprHttpPort: process.env.DAPR_HTTP_PORT ?? "",
  daprPubsubName: process.env.DAPR_PUBSUB_NAME ?? "switchos-bus",
  daprOperationalEventsTopic: process.env.DAPR_OPERATIONAL_EVENTS_TOPIC ?? "operational-events",
  opensearchUrl: process.env.OPENSEARCH_URL ?? "",
  opensearchUsername: process.env.OPENSEARCH_USERNAME ?? "",
  opensearchPassword: process.env.OPENSEARCH_PASSWORD ?? "",
  opensearchOperationalEventsIndex: process.env.OPENSEARCH_OPERATIONAL_EVENTS_INDEX ?? "switchos-operational-events",
  fluvioServiceUrl: process.env.FLUVIO_SERVICE_URL ?? "127.0.0.1:50055",
  mojaloopServiceUrl: process.env.MOJALOOP_SERVICE_URL ?? "http://127.0.0.1:8086",
  tigerbeetleServiceUrl: process.env.TIGERBEETLE_SERVICE_URL ?? "http://127.0.0.1:8087",
  lakehouseServiceUrl: process.env.LAKEHOUSE_SERVICE_URL ?? "http://127.0.0.1:8007",
  lakehousePath: process.env.LAKEHOUSE_PATH ?? "/tmp/switchos-lakehouse",
  verticalProvisioningUrl: process.env.VERTICAL_PROVISIONING_URL ?? "http://127.0.0.1:8112",
  intakeOrchestratorUrl: process.env.INTAKE_ORCHESTRATOR_URL ?? "http://127.0.0.1:8113",
  oidcIssuerUrl: normalizeOptionalUrl("OIDC_ISSUER_URL"),
  oidcAudience: (process.env.OIDC_AUDIENCE ?? "switchos-operator-dashboard").trim(),
  oidcClientId: (process.env.OIDC_CLIENT_ID ?? "switchos-operator-dashboard").trim(),
  oidcClientSecret: process.env.OIDC_CLIENT_SECRET?.trim() ?? "",
  oidcScope: (process.env.OIDC_SCOPE ?? "openid profile email offline_access").trim(),
  oidcLogoutUrl: normalizeOptionalUrl("OIDC_LOGOUT_URL"),
  oidcDiscoveryUrl: normalizeOptionalUrl("OIDC_DISCOVERY_URL"),
  oidcRedirectPath: process.env.OIDC_REDIRECT_PATH ?? "/api/auth/oidc/callback",
  oidcPostLogoutPath: process.env.OIDC_POST_LOGOUT_PATH ?? "/portal",
  enableExternalOidc: parseBoolean(process.env.ENABLE_EXTERNAL_OIDC, false),
  cacheControlIndexHtml: process.env.CACHE_CONTROL_INDEX_HTML ?? "no-cache, no-store, must-revalidate",
};
