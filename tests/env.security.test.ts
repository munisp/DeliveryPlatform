import { afterEach, describe, expect, it, vi } from "vitest";

const productionEnvironment = {
  NODE_ENV: "production",
	JWT_SECRET: "a-high-entropy-test-jwt-secret",
	OAUTH_SERVER_URL: "https://auth.switchos.test",
	BOOTSTRAP_OPERATOR_PASSWORD: "a-high-entropy-test-operator-password",
	PERMIFY_ENDPOINT: "https://permify.switchos.test",
	PERMIFY_AUTH_TOKEN: "a-high-entropy-test-permify-token",
};

async function loadEnvironment(internalServiceToken?: string, permifyOverrides: Partial<Record<"endpoint" | "authToken", string>> = {}) {
	vi.resetModules();
	for (const [key, value] of Object.entries(productionEnvironment)) {
		vi.stubEnv(key, value);
	}
	vi.stubEnv("INTERNAL_SERVICE_TOKEN", internalServiceToken ?? "");
	if (permifyOverrides.endpoint !== undefined) vi.stubEnv("PERMIFY_ENDPOINT", permifyOverrides.endpoint);
	if (permifyOverrides.authToken !== undefined) vi.stubEnv("PERMIFY_AUTH_TOKEN", permifyOverrides.authToken);
  return import("../server/_core/env");
}

describe("production internal-service credential configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("rejects a missing internal-service token in production", async () => {
    await expect(loadEnvironment()).rejects.toThrow("INTERNAL_SERVICE_TOKEN is required in production");
  });

  it("rejects the former placeholder token in production", async () => {
    await expect(loadEnvironment("switchos-internal-dev-token-change-before-production")).rejects.toThrow(
      "INTERNAL_SERVICE_TOKEN must be rotated before running in production",
    );
  });

	it("accepts an explicitly configured non-placeholder production token", async () => {
		const { ENV } = await loadEnvironment("a-high-entropy-test-internal-token");
		expect(ENV.internalServiceToken).toBe("a-high-entropy-test-internal-token");
	});

	it("rejects a missing Permify endpoint in production", async () => {
		await expect(loadEnvironment("a-high-entropy-test-internal-token", { endpoint: "" })).rejects.toThrow(
			"PERMIFY_ENDPOINT is required in production",
		);
	});

	it("rejects a missing Permify service credential in production", async () => {
		await expect(loadEnvironment("a-high-entropy-test-internal-token", { authToken: "" })).rejects.toThrow(
			"PERMIFY_AUTH_TOKEN is required in production",
		);
	});
});
