import { ENV } from "./env";
import type { SessionUser } from "./trpc";

export type PolicyResource = {
  type: "tenant" | "workspace";
  id: string;
};

export type PolicyCheckInput = {
  subject: SessionUser;
  permission: "read_platform" | "write_platform" | "read_analytics" | "write_analytics" | "read" | "operate" | "analytics";
  resource: PolicyResource;
};

function normalizePermifyEndpoint() {
  const endpoint = `${process.env.PERMIFY_ENDPOINT ?? ""}`.trim();
  return endpoint.replace(/\/$/, "");
}

function buildAuthzModelId() {
  return `${process.env.PERMIFY_SCHEMA_VERSION ?? "switchos-v1"}`.trim();
}

function isPolicyEngineEnabled() {
  return normalizePermifyEndpoint().length > 0;
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

export async function checkPolicy(input: PolicyCheckInput): Promise<boolean> {
  if (!isPolicyEngineEnabled()) {
    return scopeFallbackAllows(input.subject, input.permission);
  }

  const endpoint = normalizePermifyEndpoint();
  const response = await fetch(`${endpoint}/v1/permissions/check`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
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
  if (typeof payload.allowed === "boolean") {
    return payload.allowed;
  }
  return `${payload.can ?? ""}`.toUpperCase() === "RESULT_ALLOWED";
}

export function getPolicyIntegrationStatus() {
  return {
    enabled: isPolicyEngineEnabled(),
    endpoint: normalizePermifyEndpoint() || null,
    schemaVersion: buildAuthzModelId(),
    fallbackMode: !isPolicyEngineEnabled(),
    cacheConfigured: Boolean(ENV.redisUrl),
  };
}
