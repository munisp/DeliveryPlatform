const DEFAULT_ALLOWED_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  "http://localhost:5173",
  "http://127.0.0.1:5173",
];

function csv(value?: string | null): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
}

function mergeCsvEnv(...values: Array<string | undefined | null>): string[] {
  const out = new Set<string>();
  values.flatMap((value) => csv(value)).forEach((value) => out.add(value));
  return Array.from(out);
}

function boolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value == null || value.trim() === "") return fallback;
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

const nodeEnv = process.env.NODE_ENV ?? "development";
const isProd = nodeEnv === "production";

const allowedOrigins = mergeCsvEnv(process.env.ALLOWED_ORIGINS, process.env.CORS_ALLOWED_ORIGINS);
const trustProxy = process.env.TRUST_PROXY?.trim() || (isProd ? "1" : "false");
const redisUrl = process.env.REDIS_URL?.trim() || undefined;
const redisKeyPrefix = process.env.REDIS_KEY_PREFIX?.trim() || "axlon:ratelimit";
const redisCommandTimeoutMs = Math.max(50, Number(process.env.REDIS_COMMAND_TIMEOUT_MS ?? "1200"));
const bodyLimit = process.env.BODY_LIMIT?.trim() || "2mb";
const rateLimitWindowMs = Math.max(1_000, Number(process.env.RATE_LIMIT_WINDOW_MS ?? "60000"));
const rateLimitMax = Math.max(1, Number(process.env.RATE_LIMIT_MAX ?? "600"));
const isVerbose = process.env.VERBOSE_LOGS === "true";
const isPerfNoise = process.env.LOG_PERF_NOISE === "true";

export const ENV = {
  appId: process.env.VITE_APP_ID ?? "",
  nodeEnv,
  isProd,
  cookieSecret: process.env.JWT_SECRET ?? "dev-only-secret",
  databaseUrl: process.env.DATABASE_URL ?? "",
  oAuthServerUrl: process.env.OAUTH_SERVER_URL ?? "",
  ownerOpenId: process.env.OWNER_OPEN_ID ?? "",
  forgeApiUrl: process.env.BUILT_IN_FORGE_API_URL ?? "",
  forgeApiKey: process.env.BUILT_IN_FORGE_API_KEY ?? "",
  longcatApiUrl: process.env.LONGCAT_API_URL ?? "",
  longcatApiKey: process.env.LONGCAT_API_KEY ?? "",
  allowedOrigins: allowedOrigins.length > 0 ? allowedOrigins : DEFAULT_ALLOWED_ORIGINS,
  trustProxy,
  redisUrl,
  redisKeyPrefix,
  redisCommandTimeoutMs,
  bodyLimit,
  rateLimitWindowMs,
  rateLimitMax,
  requestTimeoutMs: Math.max(1_000, Number(process.env.REQUEST_TIMEOUT_MS ?? "30000")),
  memoryAlertRssMb: Math.max(128, Number(process.env.MEMORY_ALERT_RSS_MB ?? "1024")),
  // mTLS configs for Payment & Finance
  mtlsCertPath: process.env.MTLS_CERT_PATH ?? "",
  mtlsKeyPath: process.env.MTLS_KEY_PATH ?? "",
  mtlsCaPath: process.env.MTLS_CA_PATH ?? "",
  mtlsClientId: process.env.MTLS_CLIENT_ID ?? "",
  paymentsMtlsRequired: boolEnv(process.env.PAYMENTS_MTLS_REQUIRED, isProd),
  csrfEnabled: boolEnv(process.env.CSRF_ENABLED, true),
  isVerbose,
  isPerfNoise,
};
