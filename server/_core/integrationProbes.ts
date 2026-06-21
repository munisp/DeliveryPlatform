import { Socket } from "node:net";

import { ENV } from "./env";

type ProbeStatus = "configured" | "healthy" | "degraded" | "unconfigured";

type ProbeResult = {
  status: ProbeStatus;
  target: string | null;
  details?: Record<string, unknown>;
  error?: string | null;
};

function ok(target: string | null, details: Record<string, unknown> = {}): ProbeResult {
  return { status: "healthy", target, details, error: null };
}

function degraded(target: string | null, error: unknown, details: Record<string, unknown> = {}): ProbeResult {
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

async function probeUrl(url: string | null | undefined, path = "/health"): Promise<ProbeResult> {
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

async function probeTcpSocket(address: string, defaultPort: number): Promise<ProbeResult> {
  const normalized = address.includes("://") ? new URL(address) : new URL(`http://${address}`);
  const host = normalized.hostname;
  const port = Number.parseInt(normalized.port || `${defaultPort}`, 10);

  if (!host || Number.isNaN(port)) {
    return degraded(address, new Error("invalid Temporal address"));
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
    const discoveryUrl = ENV.oidcDiscoveryUrl || `${ENV.oidcIssuerUrl.replace(/\/$/, "")}/.well-known/openid-configuration`;
    const discovery = await fetchJson(discoveryUrl);
    return ok(discoveryUrl, {
      issuer: (discovery as Record<string, unknown>).issuer || null,
      authorization_endpoint: (discovery as Record<string, unknown>).authorization_endpoint || null,
      token_endpoint: (discovery as Record<string, unknown>).token_endpoint || null,
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

  const controlTarget = ENV.apisixControlUrl?.trim() ? `${ENV.apisixControlUrl.replace(/\/$/, "")}/v1/schema` : null;
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

export async function probePermify(): Promise<ProbeResult> {
  if (!ENV.permifyEndpoint?.trim()) return unconfigured(ENV.permifyEndpoint || null);
  return probeUrl(ENV.permifyEndpoint, "/healthz");
}

export async function probeDapr(): Promise<ProbeResult> {
  if (!ENV.daprHttpPort?.trim()) return unconfigured(null);
  return probeUrl(`http://127.0.0.1:${ENV.daprHttpPort}`, "/v1.0/metadata");
}

export async function probeOpenSearch(): Promise<ProbeResult> {
  if (!ENV.opensearchUrl?.trim()) return unconfigured(ENV.opensearchUrl || null);
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
  if (!ENV.fluvioServiceUrl?.trim()) return unconfigured(ENV.fluvioServiceUrl || null);
  const normalized = ENV.fluvioServiceUrl.startsWith("http://") || ENV.fluvioServiceUrl.startsWith("https://")
    ? ENV.fluvioServiceUrl
    : `http://${ENV.fluvioServiceUrl}`;
  return probeUrl(normalized, "/health");
}

export async function probeServices() {
  const [mojaloop, tigerbeetle, lakehouse, verticalProvisioning, intakeOrchestrator] = await Promise.all([
    probeUrl(ENV.mojaloopServiceUrl),
    probeUrl(ENV.tigerbeetleServiceUrl),
    probeUrl(ENV.lakehouseServiceUrl),
    probeUrl(ENV.verticalProvisioningUrl),
    probeUrl(ENV.intakeOrchestratorUrl),
  ]);

  return {
    mojaloop,
    tigerbeetle,
    lakehouse,
    verticalProvisioning,
    intakeOrchestrator,
  };
}

export async function getLiveIntegrationStatus() {
  const [apisix, oidc, permify, redis, dapr, openSearch, temporal, fluvio, services] = await Promise.all([
    probeApisix(),
    probeExternalOidc(),
    probePermify(),
    probeRedis(),
    probeDapr(),
    probeOpenSearch(),
    probeTemporal(),
    probeFluvio(),
    probeServices(),
  ]);

  return {
    timestamp: new Date().toISOString(),
    edge: { apisix },
    identity: { oidc, permify },
    messaging: { redis, dapr, openSearch, temporal, fluvio },
    services,
  };
}
