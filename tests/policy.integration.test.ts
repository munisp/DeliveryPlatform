import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
const createClientMock = vi.fn();

vi.mock("redis", () => ({
  createClient: createClientMock,
}));
vi.stubGlobal("fetch", fetchMock);

async function loadPolicyModule() {
  vi.resetModules();
  return import("../server/_core/policy");
}

describe("SwitchOS policy integration", () => {
	const originalEnv = {
		PERMIFY_ENDPOINT: process.env.PERMIFY_ENDPOINT,
		PERMIFY_AUTH_TOKEN: process.env.PERMIFY_AUTH_TOKEN,
		PERMIFY_SCHEMA_VERSION: process.env.PERMIFY_SCHEMA_VERSION,
    PERMIFY_DEPTH: process.env.PERMIFY_DEPTH,
    REDIS_URL: process.env.REDIS_URL,
    POLICY_CACHE_TTL_SECONDS: process.env.POLICY_CACHE_TTL_SECONDS,
  };

  beforeEach(() => {
    fetchMock.mockReset();
		createClientMock.mockReset();
		process.env.PERMIFY_ENDPOINT = "";
		process.env.PERMIFY_AUTH_TOKEN = "";
		process.env.PERMIFY_SCHEMA_VERSION = "switchos-v1";
    process.env.PERMIFY_DEPTH = "20";
    process.env.REDIS_URL = "";
    process.env.POLICY_CACHE_TTL_SECONDS = "30";
  });

		afterEach(() => {
		process.env.PERMIFY_ENDPOINT = originalEnv.PERMIFY_ENDPOINT;
		process.env.PERMIFY_AUTH_TOKEN = originalEnv.PERMIFY_AUTH_TOKEN;
		process.env.PERMIFY_SCHEMA_VERSION = originalEnv.PERMIFY_SCHEMA_VERSION;
    process.env.PERMIFY_DEPTH = originalEnv.PERMIFY_DEPTH;
    process.env.REDIS_URL = originalEnv.REDIS_URL;
    process.env.POLICY_CACHE_TTL_SECONDS = originalEnv.POLICY_CACHE_TTL_SECONDS;
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
      cacheEnabled: false,
      cacheTtlSeconds: 30,
    });
  });

  it("calls the configured external policy engine and caches the decision in Redis when available", async () => {
		process.env.PERMIFY_ENDPOINT = "http://127.0.0.1:3476";
		process.env.PERMIFY_AUTH_TOKEN = "permify-test-token";
		process.env.PERMIFY_SCHEMA_VERSION = "switchos-v2";
    process.env.REDIS_URL = "redis://127.0.0.1:6379";
    process.env.POLICY_CACHE_TTL_SECONDS = "45";

    const redisClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce("1"),
      set: vi.fn().mockResolvedValue("OK"),
    };
    createClientMock.mockReturnValue(redisClient);

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ can: "RESULT_ALLOWED" }),
    });

    const { checkPolicy, getPolicyIntegrationStatus } = await loadPolicyModule();

    const input = {
      subject: {
        id: 10,
        name: "External Operator",
        role: "operator",
        openId: "kc-user-10",
        tenantId: "switchos-core",
        scopes: ["platform:read"],
      },
      permission: "read_platform" as const,
      resource: { type: "tenant" as const, id: "switchos-core" },
    };

    await expect(checkPolicy(input)).resolves.toBe(true);
    await expect(checkPolicy(input)).resolves.toBe(true);

    expect(createClientMock).toHaveBeenCalledWith({ url: "redis://127.0.0.1:6379" });
    expect(redisClient.connect).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock).toHaveBeenCalledWith(
			"http://127.0.0.1:3476/v1/permissions/check",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({ Authorization: "Bearer permify-test-token" }),
			}),
    );

    const [, request] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(request.body))).toMatchObject({
      tenantId: "switchos-core",
      permission: "read_platform",
      metadata: {
        schemaVersion: "switchos-v2",
        depth: 20,
      },
      subject: {
        type: "user",
        id: "kc-user-10",
      },
    });

    expect(redisClient.set).toHaveBeenCalledWith(
      "switchos:policy:switchos-v2:switchos-core:kc-user-10:tenant:switchos-core:read_platform",
      "1",
      { EX: 45 },
    );

    expect(getPolicyIntegrationStatus()).toMatchObject({
      enabled: true,
      endpoint: "http://127.0.0.1:3476",
			schemaVersion: "switchos-v2",
			fallbackMode: false,
			authenticated: true,
			cacheConfigured: true,
      cacheEnabled: true,
      cacheTtlSeconds: 45,
    });
  });

  it("continues without cache when Redis is configured but unavailable", async () => {
		process.env.PERMIFY_ENDPOINT = "http://127.0.0.1:3476";
		process.env.PERMIFY_AUTH_TOKEN = "permify-test-token";
		process.env.REDIS_URL = "redis://127.0.0.1:6379";

    createClientMock.mockImplementation(() => {
      throw new Error("redis unavailable");
    });

    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ allowed: false }),
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
        permission: "write_platform",
        resource: { type: "tenant", id: "switchos-core" },
      }),
    ).resolves.toBe(false);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("throws when the external policy engine returns a failed response", async () => {
		process.env.PERMIFY_ENDPOINT = "http://127.0.0.1:3476";
		process.env.PERMIFY_AUTH_TOKEN = "permify-test-token";

		fetchMock.mockResolvedValue({
      ok: false,
      status: 503,
      text: async () => "policy unavailable",
    });

    const { checkPolicy } = await loadPolicyModule();

    await expect(
      checkPolicy({
        subject: {
          id: 12,
          name: "External Operator",
          role: "operator",
          tenantId: "switchos-core",
        },
        permission: "read_platform",
        resource: { type: "tenant", id: "switchos-core" },
      }),
		).rejects.toThrow(/Permify permission check failed: 503 policy unavailable/);
	});

	it("rejects an enabled policy engine without its service credential", async () => {
		process.env.PERMIFY_ENDPOINT = "http://127.0.0.1:3476";
		process.env.PERMIFY_AUTH_TOKEN = "";
		const { checkPolicy } = await loadPolicyModule();

		await expect(checkPolicy({
			subject: { id: 13, name: "Operator", role: "operator" },
			permission: "read_platform",
			resource: { type: "tenant", id: "switchos-core" },
		})).rejects.toThrow("Permify policy client requires PERMIFY_AUTH_TOKEN");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
