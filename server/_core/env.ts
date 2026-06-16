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

export const ENV = {
  appId: getRequiredEnv("VITE_APP_ID", "switchos-operator-dashboard"),
  cookieSecret: getCookieSecret(),
  databaseUrl: getRequiredEnv("DATABASE_URL", "postgresql://ubuntu:ubuntu@127.0.0.1:5432/switchos"),
  oAuthServerUrl: normalizeOAuthServerUrl(),
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "switchos-owner",
  isProduction: process.env.NODE_ENV === "production",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  allowedOrigins: process.env.ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS,
  cspConnectSrc: process.env.CSP_CONNECT_SRC ?? DEFAULT_CSP_CONNECT_SRC,
  apiBodyLimit: process.env.API_BODY_LIMIT ?? "10mb",
  sessionIssuer: process.env.SESSION_ISSUER ?? "switchos.local",
  sessionAudience: process.env.SESSION_AUDIENCE ?? "switchos-operator-dashboard",
  internalServiceToken: process.env.INTERNAL_SERVICE_TOKEN ?? "switchos-internal-dev-token-change-before-production",
  bindHost: process.env.BIND_HOST ?? "127.0.0.1",
  apisixAdminUrl: process.env.APISIX_ADMIN_URL ?? "http://127.0.0.1:9180",
  apisixControlUrl: process.env.APISIX_CONTROL_URL ?? "http://127.0.0.1:8006",
  fluvioServiceUrl: process.env.FLUVIO_SERVICE_URL ?? "127.0.0.1:50055",
  mojaloopServiceUrl: process.env.MOJALOOP_SERVICE_URL ?? "http://127.0.0.1:8086",
  tigerbeetleServiceUrl: process.env.TIGERBEETLE_SERVICE_URL ?? "http://127.0.0.1:8087",
  lakehouseServiceUrl: process.env.LAKEHOUSE_SERVICE_URL ?? "http://127.0.0.1:8007",
  lakehousePath: process.env.LAKEHOUSE_PATH ?? "/tmp/switchos-lakehouse",
  verticalProvisioningUrl: process.env.VERTICAL_PROVISIONING_URL ?? "http://127.0.0.1:8112",
  intakeOrchestratorUrl: process.env.INTAKE_ORCHESTRATOR_URL ?? "http://127.0.0.1:8113",
};
