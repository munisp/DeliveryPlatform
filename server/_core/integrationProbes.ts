import { access } from "node:fs/promises";
import { Socket } from "node:net";

import { ENV } from "./env";

type ProbeStatus = "configured" | "healthy" | "degraded" | "unconfigured";

type ProbeResult = {
  status: ProbeStatus;
  target: string | null;
  details?: Record<string, unknown>;
  error?: string | null;
};

function ok(
  target: string | null,
  details: Record<string, unknown> = {},
): ProbeResult {
  return { status: "healthy", target, details, error: null };
}

function configured(
  target: string | null,
  details: Record<string, unknown> = {},
): ProbeResult {
  return { status: "configured", target, details, error: null };
}

function degraded(
  target: string | null,
  error: unknown,
  details: Record<string, unknown> = {},
): ProbeResult {
  return {
    status: "degraded",
    target,
    details,
    error: error instanceof Error ? error.message : String(error),
  };
}

function unconfigured(target: string | null): ProbeResult {
  return { status: "unconfigured", target, details: {}, error: null };
}

async function fetchJson(url: string, init?: RequestInit) {
  const response = await fetch(url, {
    ...init,
    headers: {
      accept: "application/json",
      ...(init?.headers || {}),
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status}${body ? ` ${body}` : ""}`.trim());
  }

  const contentType = response.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    return response.json();
  }

  return response.text();
}

async function probeUrl(
  url: string | null | undefined,
  path = "/health",
): Promise<ProbeResult> {
  if (!url || !url.trim()) return unconfigured(url || null);
  try {
    const base = url.replace(/\/$/, "");
    const target = path.startsWith("http") ? path : `${base}${path}`;
    const payload = await fetchJson(target);
    return ok(target, { response: payload });
  } catch (error) {
    return degraded(url, error);
  }
}

function normalizeBoolean(value: unknown, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "1", "yes", "y", "ready"].includes(normalized)) return true;
    if (["false", "0", "no", "n", "not_ready"].includes(normalized))
      return false;
  }
  return fallback;
}

function parseBrokerTargets(raw: string) {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

async function probeTcpSocket(
  address: string,
  defaultPort: number,
): Promise<ProbeResult> {
  const normalized = address.includes("://")
    ? new URL(address)
    : new URL(`http://${address}`);
  const host = normalized.hostname;
  const port = Number.parseInt(normalized.port || `${defaultPort}`, 10);

  if (!host || Number.isNaN(port)) {
    return degraded(address, new Error("invalid socket address"));
  }

  await new Promise<void>((resolve, reject) => {
    const socket = new Socket();

    const cleanup = () => {
      socket.removeAllListeners();
      socket.destroy();
    };

    socket.setTimeout(3000);
    socket.once("connect", () => {
      cleanup();
      resolve();
    });
    socket.once("timeout", () => {
      cleanup();
      reject(new Error(`connection to ${host}:${port} timed out`));
    });
    socket.once("error", (error) => {
      cleanup();
      reject(error);
    });
    socket.connect(port, host);
  });

  return ok(`${host}:${port}`, { protocol: "tcp" });
}

export async function probeExternalOidc(): Promise<ProbeResult> {
  if (!ENV.enableExternalOidc || !ENV.oidcIssuerUrl) {
    return unconfigured(ENV.oidcIssuerUrl || null);
  }
  try {
    const discoveryUrl =
      ENV.oidcDiscoveryUrl ||
      `${ENV.oidcIssuerUrl.replace(/\/$/, "")}/.well-known/openid-configuration`;
    const discovery = await fetchJson(discoveryUrl);
    return ok(discoveryUrl, {
      issuer: (discovery as Record<string, unknown>).issuer || null,
      authorization_endpoint:
        (discovery as Record<string, unknown>).authorization_endpoint || null,
      token_endpoint:
        (discovery as Record<string, unknown>).token_endpoint || null,
      jwks_uri: (discovery as Record<string, unknown>).jwks_uri || null,
    });
  } catch (error) {
    return degraded(ENV.oidcIssuerUrl, error);
  }
}

export async function probeApisix(): Promise<ProbeResult> {
  if (!ENV.apisixControlUrl && !ENV.apisixAdminUrl) {
    return unconfigured(null);
  }

  const controlTarget = ENV.apisixControlUrl?.trim()
    ? `${ENV.apisixControlUrl.replace(/\/$/, "")}/v1/schema`
    : null;
  if (controlTarget) {
    try {
      const response = await fetchJson(controlTarget);
      return ok(controlTarget, { source: "control", response });
    } catch (error) {
      if (!ENV.apisixAdminUrl?.trim()) {
        return degraded(controlTarget, error);
      }
    }
  }

  try {
    const adminTarget = `${ENV.apisixAdminUrl.replace(/\/$/, "")}/apisix/admin/routes`;
    const response = await fetchJson(adminTarget, {
      headers: {
        ...(ENV.apisixAdminKey ? { "X-API-KEY": ENV.apisixAdminKey } : {}),
      },
    });
    return ok(adminTarget, { source: "admin", response });
  } catch (error) {
    return degraded(ENV.apisixAdminUrl, error);
  }
}

export async function probeOpenAppSec(): Promise<ProbeResult> {
  if (!ENV.openAppSecUrl && !ENV.openAppSecPolicyPath) {
    return unconfigured(null);
  }

  if (ENV.openAppSecUrl) {
    const healthResult = await probeUrl(ENV.openAppSecUrl, "/health");
    if (healthResult.status !== "degraded") {
      return healthResult;
    }
    return degraded(
      ENV.openAppSecUrl,
      healthResult.error ?? "unknown Open AppSec probe failure",
      {
        ...healthResult.details,
        mode: "http",
        policy_path: ENV.openAppSecPolicyPath || null,
      },
    );
  }

  try {
    await access(ENV.openAppSecPolicyPath);
    return configured(ENV.openAppSecPolicyPath, {
      mode: "policy_path",
      policy_path: ENV.openAppSecPolicyPath,
    });
  } catch (error) {
    return degraded(ENV.openAppSecPolicyPath, error, { mode: "policy_path" });
  }
}

export async function probePermify(): Promise<ProbeResult> {
  if (!ENV.permifyEndpoint?.trim())
    return unconfigured(ENV.permifyEndpoint || null);
  return probeUrl(ENV.permifyEndpoint, "/healthz");
}

export async function probeKafka(): Promise<ProbeResult> {
  const brokers = parseBrokerTargets(ENV.kafkaBrokers);
  if (brokers.length === 0) return unconfigured(null);

  const target = brokers[0];
  try {
    const result = await probeTcpSocket(target, 9092);
    return {
      ...result,
      details: {
        ...(result.details || {}),
        checked_broker: target,
        brokers,
        topic: ENV.kafkaOperationalEventsTopic || null,
      },
    };
  } catch (error) {
    return degraded(target, error, {
      brokers,
      topic: ENV.kafkaOperationalEventsTopic || null,
    });
  }
}

export async function probeDapr(): Promise<ProbeResult> {
  if (!ENV.daprHttpPort?.trim()) return unconfigured(null);
  return probeUrl(`http://127.0.0.1:${ENV.daprHttpPort}`, "/v1.0/metadata");
}

export async function probeOpenSearch(): Promise<ProbeResult> {
  if (!ENV.opensearchUrl?.trim())
    return unconfigured(ENV.opensearchUrl || null);
  try {
    const baseUrl = ENV.opensearchUrl.replace(/\/$/, "");
    const response = await fetchJson(`${baseUrl}/_cluster/health`, {
      headers: {
        ...(ENV.opensearchUsername && ENV.opensearchPassword
          ? {
              Authorization: `Basic ${Buffer.from(`${ENV.opensearchUsername}:${ENV.opensearchPassword}`).toString("base64")}`,
            }
          : {}),
      },
    });
    return ok(baseUrl, { response });
  } catch (error) {
    return degraded(ENV.opensearchUrl, error);
  }
}

export async function probeRedis(): Promise<ProbeResult> {
  if (!ENV.redisUrl?.trim()) return unconfigured(ENV.redisUrl || null);
  try {
    const { createClient } = await import("redis");
    const client = createClient({ url: ENV.redisUrl });
    await client.connect();
    const pong = await client.ping();
    await client.disconnect();
    return ok(ENV.redisUrl, { ping: pong });
  } catch (error) {
    return degraded(ENV.redisUrl, error);
  }
}

export async function probeTemporal(): Promise<ProbeResult> {
  const address = process.env.TEMPORAL_ADDRESS || "";
  if (!address.trim()) return unconfigured(null);

  try {
    return await probeTcpSocket(address, 7233);
  } catch (error) {
    return degraded(address, error);
  }
}

export async function probeFluvio(): Promise<ProbeResult> {
  if (!ENV.fluvioServiceUrl?.trim())
    return unconfigured(ENV.fluvioServiceUrl || null);
  const normalized =
    ENV.fluvioServiceUrl.startsWith("http://") ||
    ENV.fluvioServiceUrl.startsWith("https://")
      ? ENV.fluvioServiceUrl
      : `http://${ENV.fluvioServiceUrl}`;
  return probeUrl(normalized, "/health");
}

export async function probeLongCatVoiceGateway(): Promise<ProbeResult> {
  if (!ENV.longcatVoiceGatewayUrl?.trim())
    return unconfigured(ENV.longcatVoiceGatewayUrl || null);
  try {
    const target = `${ENV.longcatVoiceGatewayUrl.replace(/\/$/, "")}/health`;
    const payload = (await fetchJson(target)) as Record<string, unknown>;
    const status = `${payload.status ?? "ok"}`.toLowerCase();
    if (status !== "ok" && status !== "healthy") {
      return degraded(target, new Error(`gateway reported status ${status}`), {
        response: payload,
      });
    }
    return ok(target, {
      service: payload.service ?? null,
      telephony_mode: payload.telephony_mode ?? null,
      audio_socket_addr: payload.audio_socket_addr ?? null,
      speech_service_url: payload.speech_service_url ?? null,
      response: payload,
    });
  } catch (error) {
    return degraded(ENV.longcatVoiceGatewayUrl, error);
  }
}

export async function probeLongCatSpeechRuntime(): Promise<ProbeResult> {
  if (!ENV.longcatSpeechServiceUrl?.trim())
    return unconfigured(ENV.longcatSpeechServiceUrl || null);
  try {
    const target = `${ENV.longcatSpeechServiceUrl.replace(/\/$/, "")}/health`;
    const payload = (await fetchJson(target)) as Record<string, unknown>;
    const status = `${payload.status ?? "healthy"}`.toLowerCase();
    const sttReady = normalizeBoolean(payload.stt_ready, false);
    const ttsReady = normalizeBoolean(payload.tts_ready, false);
    if (status !== "healthy" || (!sttReady && !ttsReady)) {
      return degraded(
        target,
        new Error(`speech runtime reported status ${status}`),
        {
          response: payload,
          stt_ready: sttReady,
          tts_ready: ttsReady,
        },
      );
    }
    return ok(target, {
      service: payload.service ?? null,
      stt_engine: payload.stt_engine ?? null,
      tts_engine: payload.tts_engine ?? null,
      stt_ready: sttReady,
      tts_ready: ttsReady,
      response: payload,
    });
  } catch (error) {
    return degraded(ENV.longcatSpeechServiceUrl, error);
  }
}

export async function probeLocalCommerceGateway(): Promise<ProbeResult> {
  if (!ENV.localCommerceGatewayUrl?.trim())
    return unconfigured(ENV.localCommerceGatewayUrl || null);
  return probeUrl(ENV.localCommerceGatewayUrl, "/health");
}

export async function probeRetailForecastService(): Promise<ProbeResult> {
  if (!ENV.retailForecastServiceUrl?.trim())
    return unconfigured(ENV.retailForecastServiceUrl || null);
  return probeUrl(ENV.retailForecastServiceUrl, "/health");
}

export async function probeDispatchOptimizer(): Promise<ProbeResult> {
  if (!ENV.dispatchOptimizerUrl?.trim())
    return unconfigured(ENV.dispatchOptimizerUrl || null);
  return probeUrl(ENV.dispatchOptimizerUrl, "/health");
}

export async function probeProcurementPlanner(): Promise<ProbeResult> {
  if (!ENV.procurementPlannerServiceUrl?.trim())
    return unconfigured(ENV.procurementPlannerServiceUrl || null);
  return probeUrl(ENV.procurementPlannerServiceUrl, "/health");
}

export async function probeInventoryControl(): Promise<ProbeResult> {
  if (!ENV.inventoryControlServiceUrl?.trim())
    return unconfigured(ENV.inventoryControlServiceUrl || null);
  return probeUrl(ENV.inventoryControlServiceUrl, "/health");
}

export async function probeServices() {
  const [
    mojaloop,
    tigerbeetle,
    lakehouse,
    verticalProvisioning,
    intakeOrchestrator,
    longcatVoiceGateway,
    longcatSpeechRuntime,
    localCommerceGateway,
    retailForecastService,
    dispatchOptimizer,
    procurementPlanner,
    inventoryControl,
  ] = await Promise.all([
    probeUrl(ENV.mojaloopServiceUrl),
    probeUrl(ENV.tigerbeetleServiceUrl),
    probeUrl(ENV.lakehouseServiceUrl),
    probeUrl(ENV.verticalProvisioningUrl),
    probeUrl(ENV.intakeOrchestratorUrl),
    probeLongCatVoiceGateway(),
    probeLongCatSpeechRuntime(),
    probeLocalCommerceGateway(),
    probeRetailForecastService(),
    probeDispatchOptimizer(),
    probeProcurementPlanner(),
    probeInventoryControl(),
  ]);

  return {
    mojaloop,
    tigerbeetle,
    lakehouse,
    verticalProvisioning,
    intakeOrchestrator,
    longcatVoiceGateway,
    longcatSpeechRuntime,
    localCommerceGateway,
    retailForecastService,
    dispatchOptimizer,
    procurementPlanner,
    inventoryControl,
  };
}

export async function getLiveIntegrationStatus() {
  const [
    apisix,
    openAppSec,
    oidc,
    permify,
    kafka,
    redis,
    dapr,
    openSearch,
    temporal,
    fluvio,
    services,
  ] = await Promise.all([
    probeApisix(),
    probeOpenAppSec(),
    probeExternalOidc(),
    probePermify(),
    probeKafka(),
    probeRedis(),
    probeDapr(),
    probeOpenSearch(),
    probeTemporal(),
    probeFluvio(),
    probeServices(),
  ]);

  return {
    timestamp: new Date().toISOString(),
    edge: { apisix, openAppSec },
    identity: { oidc, permify },
    messaging: { kafka, redis, dapr, openSearch, temporal, fluvio },
    services,
  };
}
