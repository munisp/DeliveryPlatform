import { ENV } from "./env";
import type { SessionUser } from "./trpc";

type RedisPolicyCacheClient = {
  connect(): Promise<void>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, options?: { EX?: number }): Promise<unknown>;
};

export type PolicyResource = {
  type: "tenant" | "workspace";
  id: string;
};

export type PolicyCheckInput = {
  subject: SessionUser;
  permission: "read_platform" | "write_platform" | "read_analytics" | "write_analytics" | "read" | "operate" | "analytics";
  resource: PolicyResource;
};

let redisPolicyCacheClientPromise: Promise<RedisPolicyCacheClient | null> | null = null;

function normalizePermifyEndpoint() {
	return ENV.permifyEndpoint;
}

function getPermifyAuthToken() {
	return ENV.permifyAuthToken;
}

function buildAuthzModelId() {
  return `${process.env.PERMIFY_SCHEMA_VERSION ?? "switchos-v1"}`.trim();
}

function getPolicyCacheTtlSeconds() {
  const parsed = Number.parseInt(`${process.env.POLICY_CACHE_TTL_SECONDS ?? "30"}`.trim(), 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return 30;
  }
  return parsed;
}

function isPolicyEngineEnabled() {
  return normalizePermifyEndpoint().length > 0;
}

function isPolicyCacheEnabled() {
  return Boolean(ENV.redisUrl?.trim()) && isPolicyEngineEnabled();
}

function scopeFallbackAllows(subject: SessionUser, permission: PolicyCheckInput["permission"]) {
  const role = `${subject.role ?? ""}`.trim().toLowerCase();
  if (role === "admin") return true;

  const scopes = new Set((subject.scopes ?? []).map((scope) => scope.trim()));
  const requiredScope = permission === "read_analytics" || permission === "analytics"
    ? "analytics:read"
    : permission === "write_analytics"
      ? "analytics:write"
      : permission === "write_platform" || permission === "operate"
        ? "platform:write"
        : "platform:read";

  return scopes.has(requiredScope);
}

function getPolicyCacheKey(input: PolicyCheckInput) {
  return [
    "switchos",
    "policy",
    buildAuthzModelId(),
    input.subject.tenantId ?? "switchos-core",
    input.subject.openId ?? input.subject.id,
    input.resource.type,
    input.resource.id,
    input.permission,
  ].join(":");
}

async function getRedisPolicyCacheClient(): Promise<RedisPolicyCacheClient | null> {
  if (!isPolicyCacheEnabled()) {
    return null;
  }

  if (!redisPolicyCacheClientPromise) {
    redisPolicyCacheClientPromise = (async () => {
      try {
        const { createClient } = await import("redis");
        const client = createClient({ url: ENV.redisUrl });
        await client.connect();
        return client as unknown as RedisPolicyCacheClient;
      } catch (error) {
        console.warn("[SwitchOS] Failed to initialize Redis policy cache", error);
        redisPolicyCacheClientPromise = null;
        return null;
      }
    })();
  }

  return redisPolicyCacheClientPromise;
}

async function readCachedPolicyDecision(input: PolicyCheckInput): Promise<boolean | null> {
  const client = await getRedisPolicyCacheClient();
  if (!client) {
    return null;
  }

  try {
    const cached = await client.get(getPolicyCacheKey(input));
    if (cached == null) {
      return null;
    }
    return cached === "1";
  } catch (error) {
    console.warn("[SwitchOS] Failed to read Redis policy cache", error);
    return null;
  }
}

async function writeCachedPolicyDecision(input: PolicyCheckInput, allowed: boolean) {
  const client = await getRedisPolicyCacheClient();
  if (!client) {
    return;
  }

  try {
    await client.set(getPolicyCacheKey(input), allowed ? "1" : "0", {
      EX: getPolicyCacheTtlSeconds(),
    });
  } catch (error) {
    console.warn("[SwitchOS] Failed to write Redis policy cache", error);
  }
}

export async function checkPolicy(input: PolicyCheckInput): Promise<boolean> {
	if (!isPolicyEngineEnabled()) {
		return scopeFallbackAllows(input.subject, input.permission);
	}
	const authToken = getPermifyAuthToken();
	if (authToken === "") {
		throw new Error("Permify policy client requires PERMIFY_AUTH_TOKEN when PERMIFY_ENDPOINT is configured");
	}

  const cachedDecision = await readCachedPolicyDecision(input);
  if (cachedDecision != null) {
    return cachedDecision;
  }

  const endpoint = normalizePermifyEndpoint();
  const response = await fetch(`${endpoint}/v1/permissions/check`, {
    method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${authToken}`,
    },
    body: JSON.stringify({
      tenantId: input.subject.tenantId ?? "switchos-core",
      metadata: {
        schemaVersion: buildAuthzModelId(),
        snapToken: "",
        depth: Number(process.env.PERMIFY_DEPTH ?? "20"),
      },
      entity: {
        type: input.resource.type,
        id: input.resource.id,
      },
      permission: input.permission,
      subject: {
        type: "user",
        id: String(input.subject.openId ?? input.subject.id),
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Permify permission check failed: ${response.status} ${text}`.trim());
  }

  const payload = await response.json() as { can?: string; allowed?: boolean };
  const allowed = typeof payload.allowed === "boolean"
    ? payload.allowed
    : `${payload.can ?? ""}`.toUpperCase() === "RESULT_ALLOWED";

  await writeCachedPolicyDecision(input, allowed);
  return allowed;
}

export function getPolicyIntegrationStatus() {
  return {
    enabled: isPolicyEngineEnabled(),
    endpoint: normalizePermifyEndpoint() || null,
    schemaVersion: buildAuthzModelId(),
		fallbackMode: !isPolicyEngineEnabled(),
		authenticated: getPermifyAuthToken() !== "",
    cacheConfigured: Boolean(ENV.redisUrl),
    cacheEnabled: isPolicyCacheEnabled(),
    cacheTtlSeconds: getPolicyCacheTtlSeconds(),
  };
}
