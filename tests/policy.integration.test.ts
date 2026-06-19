import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

async function loadPolicyModule() {
  vi.resetModules();
  return import("../server/_core/policy");
}

describe("SwitchOS policy integration", () => {
  const originalEnv = {
    PERMIFY_ENDPOINT: process.env.PERMIFY_ENDPOINT,
    PERMIFY_SCHEMA_VERSION: process.env.PERMIFY_SCHEMA_VERSION,
    REDIS_URL: process.env.REDIS_URL,
  };

  beforeEach(() => {
    fetchMock.mockReset();
    process.env.PERMIFY_ENDPOINT = "";
    process.env.PERMIFY_SCHEMA_VERSION = "switchos-v1";
    process.env.REDIS_URL = "";
  });

  afterEach(() => {
    process.env.PERMIFY_ENDPOINT = originalEnv.PERMIFY_ENDPOINT;
    process.env.PERMIFY_SCHEMA_VERSION = originalEnv.PERMIFY_SCHEMA_VERSION;
    process.env.REDIS_URL = originalEnv.REDIS_URL;
  });

  it("falls back to local scope evaluation when the external policy engine is not configured", async () => {
    const { checkPolicy, getPolicyIntegrationStatus } = await loadPolicyModule();

    await expect(
      checkPolicy({
        subject: {
          id: 1,
          name: "Operator",
          role: "operator",
          scopes: ["platform:read", "analytics:read"],
        },
        permission: "read_platform",
        resource: { type: "tenant", id: "switchos-core" },
      }),
    ).resolves.toBe(true);

    await expect(
      checkPolicy({
        subject: {
          id: 2,
          name: "Operator",
          role: "operator",
          scopes: ["platform:read"],
        },
        permission: "read_analytics",
        resource: { type: "tenant", id: "switchos-core" },
      }),
    ).resolves.toBe(false);

    expect(getPolicyIntegrationStatus()).toMatchObject({
      enabled: false,
      fallbackMode: true,
      cacheConfigured: false,
    });
  });

  it("calls the configured external policy engine for permission decisions", async () => {
    process.env.PERMIFY_ENDPOINT = "http://127.0.0.1:3476";
    process.env.PERMIFY_SCHEMA_VERSION = "switchos-v2";
    process.env.REDIS_URL = "redis://127.0.0.1:6379";

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ can: "RESULT_ALLOWED" }),
    });

    const { checkPolicy, getPolicyIntegrationStatus } = await loadPolicyModule();

    await expect(
      checkPolicy({
        subject: {
          id: 10,
          name: "External Operator",
          role: "operator",
          openId: "kc-user-10",
          tenantId: "switchos-core",
          scopes: ["platform:read"],
        },
        permission: "read_platform",
        resource: { type: "tenant", id: "switchos-core" },
      }),
    ).resolves.toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3476/v1/permissions/check",
      expect.objectContaining({ method: "POST" }),
    );

    const [, request] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(request.body))).toMatchObject({
      tenantId: "switchos-core",
      permission: "read_platform",
      metadata: {
        schemaVersion: "switchos-v2",
      },
      subject: {
        type: "user",
        id: "kc-user-10",
      },
    });

    expect(getPolicyIntegrationStatus()).toMatchObject({
      enabled: true,
      endpoint: "http://127.0.0.1:3476",
      schemaVersion: "switchos-v2",
      fallbackMode: false,
      cacheConfigured: true,
    });
  });

  it("throws when the external policy engine returns a failed response", async () => {
    process.env.PERMIFY_ENDPOINT = "http://127.0.0.1:3476";

    fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "policy unavailable",
    });

    const { checkPolicy } = await loadPolicyModule();

    await expect(
      checkPolicy({
        subject: {
          id: 11,
          name: "External Operator",
          role: "operator",
          tenantId: "switchos-core",
        },
        permission: "read_platform",
        resource: { type: "tenant", id: "switchos-core" },
      }),
    ).rejects.toThrow(/Permify permission check failed: 503 policy unavailable/);
  });
});
