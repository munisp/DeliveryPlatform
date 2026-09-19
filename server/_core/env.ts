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
  "https://tiles.openfreemap.org",
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
      throw new Error(
        "JWT_SECRET must be rotated before running in production",
      );
    }
    return configured;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("JWT_SECRET is required in production");
  }

  return "switchos-local-development-secret-change-before-production";
}

function getInternalServiceToken() {
  const configured = process.env.INTERNAL_SERVICE_TOKEN?.trim();
  const insecurePlaceholder =
    "switchos-internal-dev-token-change-before-production";

  if (configured) {
    if (
      process.env.NODE_ENV === "production" &&
      configured === insecurePlaceholder
    ) {
      throw new Error(
        "INTERNAL_SERVICE_TOKEN must be rotated before running in production",
      );
    }
    return configured;
  }

  if (process.env.NODE_ENV === "production") {
    throw new Error("INTERNAL_SERVICE_TOKEN is required in production");
  }

  // An empty local value is deliberately fail-closed: protected endpoints reject empty headers.
  return "";
}

function getBootstrapOperatorPassword() {
  const configured = process.env.BOOTSTRAP_OPERATOR_PASSWORD?.trim();
  if (configured) {
    if (
      process.env.NODE_ENV === "production" &&
      ["ChangeMe123!", "switchos-admin", "admin123"].includes(configured)
    ) {
      throw new Error(
        "BOOTSTRAP_OPERATOR_PASSWORD must be rotated before running in production",
      );
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

function getRequiredOptionalUrl(name: string) {
  const value = normalizeOptionalUrl(name);
  if (process.env.NODE_ENV === "production" && value === "") {
    throw new Error(`${name} is required in production`);
  }
  return value;
}

function getRequiredServiceCredential(name: string) {
  const value = process.env[name]?.trim() ?? "";
  if (process.env.NODE_ENV === "production" && value === "") {
    throw new Error(`${name} is required in production`);
  }
  return value;
}

// The Medusa merchant gateway is an optional dependency: merchant commerce
// endpoints already fail closed with a domain error when it is unconfigured,
// so boot must degrade explicitly (loud warning + health signal) instead of
// crashing the whole app. A partially configured gateway is a misconfiguration
// and fails fast naming every missing variable.
function getMedusaMerchantConfig() {
  const url = normalizeOptionalUrl("MEDUSA_MERCHANT_API_URL");
  const token = process.env.MEDUSA_MERCHANT_API_TOKEN?.trim() ?? "";
  const missing = [
    ...(url ? [] : ["MEDUSA_MERCHANT_API_URL"]),
    ...(token ? [] : ["MEDUSA_MERCHANT_API_TOKEN"]),
  ];
  if (missing.length === 0) {
    return { url, token, configured: true };
  }
  if (url || token) {
    throw new Error(
      `Incomplete Medusa merchant gateway configuration; missing environment variables: ${missing.join(", ")}`,
    );
  }
  if (process.env.NODE_ENV === "production") {
    console.error(
      "[SwitchOS] MEDUSA_MERCHANT_API_URL and MEDUSA_MERCHANT_API_TOKEN are not set; " +
        "merchant commerce gateway is disabled (degraded mode). " +
        "Merchant commerce endpoints will return medusa_merchant_gateway_unconfigured.",
    );
  }
  return { url: "", token: "", configured: false };
}

const medusaMerchantConfig = getMedusaMerchantConfig();

function parseBoolean(value: string | undefined, fallback: boolean) {
  if (value == null || value.trim() === "") return fallback;
  return value.trim().toLowerCase() === "true";
}

function parseInteger(value: string | undefined, fallback: number) {
  if (value == null || value.trim() === "") return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseBoundedInteger(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
) {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(
      `${name} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return parsed;
}

function parseKubernetesNamespace(name: string, fallback: string) {
  const value = (process.env[name] ?? fallback).trim().toLowerCase();
  if (!/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/.test(value)) {
    throw new Error(`${name} must be a valid Kubernetes namespace label`);
  }
  return value;
}

function getDatabaseSslCa() {
  const configured = process.env.DATABASE_SSL_CA?.trim() ?? "";
  return configured ? configured.replace(/\\n/g, "\n") : "";
}

// Explicit development-only escape hatch for local databases with
// self-signed certificates. Refused outright in production.
function getDatabaseTlsSkipVerify() {
  const enabled = parseBoolean(process.env.DATABASE_TLS_SKIP_VERIFY, false);
  if (enabled && process.env.NODE_ENV === "production") {
    throw new Error(
      "DATABASE_TLS_SKIP_VERIFY disables TLS certificate verification and must never be enabled in production",
    );
  }
  return enabled;
}

function normalizeRequiredPublicOrigin() {
  const configured = normalizeOptionalUrl("PUBLIC_APP_ORIGIN");
  if (process.env.NODE_ENV === "production" && configured === "") {
    throw new Error(
      "PUBLIC_APP_ORIGIN is required in production for account lifecycle links",
    );
  }
  return configured || "http://localhost:3000";
}

function getLifecycleNotificationDispatcherUrl(selfServiceEnabled: boolean) {
  const configured = normalizeOptionalUrl("NOTIFICATION_DISPATCHER_URL");
  if (
    process.env.NODE_ENV === "production" &&
    selfServiceEnabled &&
    configured === ""
  ) {
    throw new Error(
      "NOTIFICATION_DISPATCHER_URL is required in production when self-service signup is enabled",
    );
  }
  return configured || "http://127.0.0.1:8099";
}

const selfServiceSignupEnabled = parseBoolean(
  process.env.ENABLE_SELF_SERVICE_SIGNUP,
  false,
);
const externalCommerceIngressEnabled = parseBoolean(
  process.env.ENABLE_EXTERNAL_COMMERCE_INGRESS,
  false,
);
const externalCommerceWebhookSecretsJson =
  process.env.EXTERNAL_COMMERCE_WEBHOOK_SECRETS_JSON?.trim() ?? "";
if (
  process.env.NODE_ENV === "production" &&
  externalCommerceIngressEnabled &&
  externalCommerceWebhookSecretsJson === ""
) {
  throw new Error(
    "EXTERNAL_COMMERCE_WEBHOOK_SECRETS_JSON is required when external commerce ingress is enabled",
  );
}

export const ENV = {
  appId: getRequiredEnv("VITE_APP_ID", "switchos-operator-dashboard"),
  cookieSecret: getCookieSecret(),
  databaseUrl: getRequiredEnv(
    "DATABASE_URL",
    "postgresql://ubuntu:ubuntu@127.0.0.1:5432/switchos",
  ),
  databaseSslCa: getDatabaseSslCa(),
  databaseTlsSkipVerify: getDatabaseTlsSkipVerify(),
  vehicleTrackerDatabasePoolMax: parseBoundedInteger(
    "VEHICLE_TRACKER_DATABASE_POOL_MAX",
    4,
    4,
    8,
  ),
  oAuthServerUrl: normalizeOAuthServerUrl(),
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "switchos-owner",
  isProduction: process.env.NODE_ENV === "production",
  selfServiceSignupEnabled,
  publicAppOrigin: normalizeRequiredPublicOrigin(),
  lifecycleVerificationTtlMinutes: parseInteger(
    process.env.LIFECYCLE_VERIFICATION_TTL_MINUTES,
    60 * 24,
  ),
  lifecyclePasswordResetTtlMinutes: parseInteger(
    process.env.LIFECYCLE_PASSWORD_RESET_TTL_MINUTES,
    60,
  ),
  lifecycleInvitationTtlMinutes: parseInteger(
    process.env.LIFECYCLE_INVITATION_TTL_MINUTES,
    60 * 24 * 7,
  ),
  ollamaUrl: normalizeOptionalUrl("OLLAMA_URL") || "http://127.0.0.1:11434",
  ollamaModel: (process.env.OLLAMA_MODEL ?? "qwen2.5:3b").trim(),
  // Tiered fallback model routing configuration
  ollamaFallbackModel: (
    process.env.OLLAMA_FALLBACK_MODEL ?? "qwen2.5:0.5b"
  ).trim(),
  ollamaPrimaryTimeoutMs: Number.parseInt(
    process.env.OLLAMA_PRIMARY_TIMEOUT_MS ?? "15000",
    10,
  ),
  ollamaFallbackTimeoutMs: Number.parseInt(
    process.env.OLLAMA_FALLBACK_TIMEOUT_MS ?? "30000",
    10,
  ),
  ollamaCacheTtlMs: Number.parseInt(
    process.env.OLLAMA_CACHE_TTL_MS ?? "300000",
    10,
  ), // 5 min
  allowedOrigins: process.env.ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS,
  cspConnectSrc: process.env.CSP_CONNECT_SRC ?? DEFAULT_CSP_CONNECT_SRC,
  apiBodyLimit: process.env.API_BODY_LIMIT ?? "10mb",
  bootstrapOperatorEmail: (
    process.env.BOOTSTRAP_OPERATOR_EMAIL ?? "admin@switchos.local"
  )
    .trim()
    .toLowerCase(),
  bootstrapOperatorName:
    process.env.BOOTSTRAP_OPERATOR_NAME ?? "SwitchOS Operator Admin",
  bootstrapOperatorRole: process.env.BOOTSTRAP_OPERATOR_ROLE ?? "admin",
  bootstrapOperatorPassword: getBootstrapOperatorPassword(),
  bootstrapTenantId: process.env.BOOTSTRAP_TENANT_ID ?? "switchos-core",
  sessionIssuer: process.env.SESSION_ISSUER ?? "switchos.local",
  sessionAudience:
    process.env.SESSION_AUDIENCE ?? "switchos-operator-dashboard",
  internalServiceToken: getInternalServiceToken(),
  port: Number.parseInt(process.env.PORT ?? "3005", 10) || 3005,
  bindHost: process.env.BIND_HOST ?? "127.0.0.1",
  apisixAdminUrl: process.env.APISIX_ADMIN_URL ?? "http://127.0.0.1:9180",
  apisixAdminKey: process.env.APISIX_ADMIN_KEY ?? "",
  apisixControlUrl: process.env.APISIX_CONTROL_URL ?? "http://127.0.0.1:8006",
  permifyEndpoint: getRequiredOptionalUrl("PERMIFY_ENDPOINT"),
  permifyAuthToken: getRequiredServiceCredential("PERMIFY_AUTH_TOKEN"),
  permifySchemaVersion: process.env.PERMIFY_SCHEMA_VERSION ?? "switchos-v1",
  opaEndpoint: getRequiredOptionalUrl("OPA_ENDPOINT"),
  opaAuthToken: getRequiredServiceCredential("OPA_AUTH_TOKEN"),
  requireMfaForPrivilegedActions: parseBoolean(
    process.env.REQUIRE_MFA_FOR_PRIVILEGED_ACTIONS,
    process.env.NODE_ENV === "production",
  ),
  redisUrl: process.env.REDIS_URL ?? "",
  kafkaBrokers:
    process.env.KAFKA_BROKERS ?? process.env.KAFKA_BOOTSTRAP_SERVERS ?? "",
  kafkaOperationalEventsTopic:
    process.env.KAFKA_OPERATIONAL_EVENTS_TOPIC ?? "operational-events",
  kafkaClientId: process.env.KAFKA_CLIENT_ID ?? "switchos-operator-dashboard",
  openAppSecUrl: normalizeOptionalUrl("OPENAPPSEC_URL"),
  openAppSecPolicyPath: (process.env.OPENAPPSEC_POLICY_PATH ?? "").trim(),
  daprHttpPort: process.env.DAPR_HTTP_PORT ?? "",
  daprPubsubName: process.env.DAPR_PUBSUB_NAME ?? "switchos-bus",
  daprOperationalEventsTopic:
    process.env.DAPR_OPERATIONAL_EVENTS_TOPIC ?? "operational-events",
  opensearchUrl: process.env.OPENSEARCH_URL ?? "",
  opensearchUsername: process.env.OPENSEARCH_USERNAME ?? "",
  opensearchPassword: process.env.OPENSEARCH_PASSWORD ?? "",
  opensearchOperationalEventsIndex:
    process.env.OPENSEARCH_OPERATIONAL_EVENTS_INDEX ??
    "switchos-operational-events",
  fluvioServiceUrl: process.env.FLUVIO_SERVICE_URL ?? "127.0.0.1:50055",
  mojaloopServiceUrl:
    process.env.MOJALOOP_SERVICE_URL ?? "http://127.0.0.1:8086",
  tigerbeetleServiceUrl:
    process.env.TIGERBEETLE_SERVICE_URL ?? "http://127.0.0.1:8087",
  lakehouseServiceUrl:
    process.env.LAKEHOUSE_SERVICE_URL ?? "http://127.0.0.1:8007",
  lakehousePath: process.env.LAKEHOUSE_PATH ?? "/tmp/switchos-lakehouse",
  dispatchOptimizerUrl:
    process.env.DISPATCH_OPTIMIZER_URL ?? "http://127.0.0.1:8090",
  notificationDispatcherUrl: getLifecycleNotificationDispatcherUrl(
    selfServiceSignupEnabled,
  ),
  longcatVoiceGatewayUrl:
    process.env.LONGCAT_VOICE_GATEWAY_URL ?? "http://127.0.0.1:8104",
  longcatSpeechServiceUrl:
    process.env.LONGCAT_SPEECH_SERVICE_URL ?? "http://127.0.0.1:8105",
  verificationIntelligenceUrl:
    process.env.VERIFICATION_INTELLIGENCE_URL ?? "http://127.0.0.1:8106",
  safetyEngineUrl: process.env.SAFETY_ENGINE_URL ?? "http://127.0.0.1:8107",
  marketEconomicsUrl:
    process.env.MARKET_ECONOMICS_URL ?? "http://127.0.0.1:8110",
  incentivesWorkerUrl:
    process.env.INCENTIVES_WORKER_URL ?? "http://127.0.0.1:8108",
  workRecordSignerUrl:
    process.env.WORK_RECORD_SIGNER_URL ?? "http://127.0.0.1:8109",
  localCommerceGatewayUrl:
    process.env.LOCAL_COMMERCE_GATEWAY_URL ?? "http://127.0.0.1:8114",
  retailForecastServiceUrl:
    process.env.RETAIL_FORECAST_SERVICE_URL ?? "http://127.0.0.1:8115",
  procurementPlannerServiceUrl:
    process.env.PROCUREMENT_PLANNER_SERVICE_URL ?? "http://127.0.0.1:8116",
  inventoryControlServiceUrl:
    process.env.INVENTORY_CONTROL_SERVICE_URL ?? "http://127.0.0.1:8117",
  complianceReviewServiceUrl:
    process.env.COMPLIANCE_REVIEW_SERVICE_URL ?? "http://127.0.0.1:8125",
  localCommerceWorkspaceCacheTtlMs: parseInteger(
    process.env.LOCAL_COMMERCE_WORKSPACE_CACHE_TTL_MS,
    15000,
  ),
  localCommercePlanCacheTtlMs: parseInteger(
    process.env.LOCAL_COMMERCE_PLAN_CACHE_TTL_MS,
    5000,
  ),
  localCommerceEnableAsyncEnrichment: parseBoolean(
    process.env.LOCAL_COMMERCE_ENABLE_ASYNC_ENRICHMENT,
    true,
  ),
  localCommerceEnableTracing: parseBoolean(
    process.env.LOCAL_COMMERCE_ENABLE_TRACING,
    true,
  ),
  developerWebhookDispatchEnabled: parseBoolean(
    process.env.ENABLE_DEVELOPER_WEBHOOK_DISPATCH,
    false,
  ),
  developerWebhookSecretRefsJson:
    process.env.DEVELOPER_WEBHOOK_SECRET_REFS_JSON?.trim() ?? "",
  medusaMerchantApiUrl: medusaMerchantConfig.url,
  medusaMerchantApiToken: medusaMerchantConfig.token,
  medusaMerchantConfigured: medusaMerchantConfig.configured,
  externalCommerceIngressEnabled,
  externalCommerceWebhookSecretsJson,
  medusaEventIngressEnabled: parseBoolean(
    process.env.ENABLE_MEDUSA_EVENT_INGRESS,
    false,
  ),
  medusaStoreWebhookSecretsJson:
    process.env.MEDUSA_STORE_WEBHOOK_SECRETS_JSON?.trim() ?? "",
  vehicleTrackerIngressEnabled: parseBoolean(
    process.env.ENABLE_VEHICLE_TRACKER_INGRESS,
    false,
  ),
  vehicleTrackerWebhookSecretsJson:
    process.env.VEHICLE_TRACKER_WEBHOOK_SECRETS_JSON?.trim() ?? "",
  vehicleTrackerCommandDispatchEnabled: parseBoolean(
    process.env.ENABLE_VEHICLE_TRACKER_COMMAND_DISPATCH,
    false,
  ),
  vehicleTrackerCommandAdapterUrl: normalizeOptionalUrl(
    "VEHICLE_TRACKER_COMMAND_ADAPTER_URL",
  ),
  vehicleTrackerCommandAdapterToken:
    process.env.VEHICLE_TRACKER_COMMAND_ADAPTER_TOKEN?.trim() ?? "",
  vehicleTrackerProviderConsumersEnabled: parseBoolean(
    process.env.ENABLE_VEHICLE_TRACKER_PROVIDER_CONSUMERS,
    false,
  ),
  vehicleTrackerConsumerEmbedded: parseBoolean(
    process.env.ENABLE_VEHICLE_TRACKER_CONSUMER_EMBEDDED,
    false,
  ),
  vehicleTrackerWorkerMetricsPort: parseBoundedInteger(
    "VEHICLE_TRACKER_WORKER_METRICS_PORT",
    9464,
    1024,
    65535,
  ),
  vehicleTrackerProviderPollIntervalMs: parseInteger(
    process.env.VEHICLE_TRACKER_PROVIDER_POLL_INTERVAL_MS,
    60_000,
  ),
  vehicleTrackerMetricsNamespace: parseKubernetesNamespace(
    "VEHICLE_TRACKER_METRICS_NAMESPACE",
    "switchos",
  ),
  vehicleTrackerGeotabCredentialsJson:
    process.env.VEHICLE_TRACKER_GEOTAB_CREDENTIALS_JSON?.trim() ?? "",
  vehicleTrackerTraccarCredentialsJson:
    process.env.VEHICLE_TRACKER_TRACCAR_CREDENTIALS_JSON?.trim() ?? "",
  localCommerceTraceSampleRate: parseInteger(
    process.env.LOCAL_COMMERCE_TRACE_SAMPLE_RATE,
    100,
  ),
  longcatTelephonyMode: (
    process.env.LONGCAT_TELEPHONY_MODE ?? "asterisk-audiosocket"
  ).trim(),
  longcatSpeechSttEngine: (
    process.env.LONGCAT_SPEECH_STT_ENGINE ?? "faster-whisper"
  ).trim(),
  longcatSpeechTtsEngine: (
    process.env.LONGCAT_SPEECH_TTS_ENGINE ?? "piper"
  ).trim(),
  longcatVoiceWebhookSecret: (
    process.env.LONGCAT_VOICE_WEBHOOK_SECRET ??
    "switchos-longcat-voice-dev-secret"
  ).trim(),
  longcatMemoryCacheTtlSeconds:
    Number.parseInt(
      process.env.LONGCAT_MEMORY_CACHE_TTL_SECONDS ?? "300",
      10,
    ) || 300,
  verticalProvisioningUrl:
    process.env.VERTICAL_PROVISIONING_URL ?? "http://127.0.0.1:8112",
  intakeOrchestratorUrl:
    process.env.INTAKE_ORCHESTRATOR_URL ?? "http://127.0.0.1:8113",
  oidcIssuerUrl: normalizeOptionalUrl("OIDC_ISSUER_URL"),
  oidcAudience: (
    process.env.OIDC_AUDIENCE ?? "switchos-operator-dashboard"
  ).trim(),
  oidcClientId: (
    process.env.OIDC_CLIENT_ID ?? "switchos-operator-dashboard"
  ).trim(),
  oidcClientSecret: process.env.OIDC_CLIENT_SECRET?.trim() ?? "",
  oidcScope: (
    process.env.OIDC_SCOPE ?? "openid profile email offline_access"
  ).trim(),
  oidcLogoutUrl: normalizeOptionalUrl("OIDC_LOGOUT_URL"),
  oidcDiscoveryUrl: normalizeOptionalUrl("OIDC_DISCOVERY_URL"),
  oidcRedirectPath: process.env.OIDC_REDIRECT_PATH ?? "/api/auth/oidc/callback",
  oidcPostLogoutPath: process.env.OIDC_POST_LOGOUT_PATH ?? "/portal",
  enableExternalOidc: parseBoolean(process.env.ENABLE_EXTERNAL_OIDC, false),
  cacheControlIndexHtml:
    process.env.CACHE_CONTROL_INDEX_HTML ??
    "no-cache, no-store, must-revalidate",
};
