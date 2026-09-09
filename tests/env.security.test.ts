import { afterEach, describe, expect, it, vi } from "vitest";

const productionEnvironment = {
  NODE_ENV: "production",
	JWT_SECRET: "a-high-entropy-test-jwt-secret",
	OAUTH_SERVER_URL: "https://auth.switchos.test",
	BOOTSTRAP_OPERATOR_PASSWORD: "a-high-entropy-test-operator-password",
	PERMIFY_ENDPOINT: "https://permify.switchos.test",
	PERMIFY_AUTH_TOKEN: "a-high-entropy-test-permify-token",
	OPA_ENDPOINT: "https://opa.switchos.test",
	OPA_AUTH_TOKEN: "a-high-entropy-test-opa-token",
	PUBLIC_APP_ORIGIN: "https://app.switchos.test",
	PICKUP_CODE_HMAC_KEY: "test-pickup-code-hmac-key-with-sufficient-entropy-20260905",
	SAFETY_CONTACT_ENCRYPTION_KEY: "test-safety-contact-encryption-key-with-sufficient-entropy-20260905",
	SAFETY_SHARE_TOKEN_KEY: "test-safety-share-token-key-with-sufficient-entropy-20260905",
	MEDUSA_MERCHANT_API_URL: "https://merchant-gateway.switchos.test",
	MEDUSA_MERCHANT_API_TOKEN: "a-high-entropy-test-medusa-merchant-token",
};

async function loadEnvironment(
	internalServiceToken?: string,
	permifyOverrides: Partial<Record<"endpoint" | "authToken", string>> = {},
	lifecycleOverrides: Partial<Record<"publicOrigin" | "signupEnabled" | "notificationDispatcher", string>> = {},
	opaOverrides: Partial<Record<"endpoint" | "authToken", string>> = {},
) {
	vi.resetModules();
	for (const [key, value] of Object.entries(productionEnvironment)) {
		vi.stubEnv(key, value);
	}
	vi.stubEnv("INTERNAL_SERVICE_TOKEN", internalServiceToken ?? "");
	if (permifyOverrides.endpoint !== undefined) vi.stubEnv("PERMIFY_ENDPOINT", permifyOverrides.endpoint);
	if (permifyOverrides.authToken !== undefined) vi.stubEnv("PERMIFY_AUTH_TOKEN", permifyOverrides.authToken);
	if (opaOverrides.endpoint !== undefined) vi.stubEnv("OPA_ENDPOINT", opaOverrides.endpoint);
	if (opaOverrides.authToken !== undefined) vi.stubEnv("OPA_AUTH_TOKEN", opaOverrides.authToken);
	if (lifecycleOverrides.publicOrigin !== undefined) vi.stubEnv("PUBLIC_APP_ORIGIN", lifecycleOverrides.publicOrigin);
	if (lifecycleOverrides.signupEnabled !== undefined) vi.stubEnv("ENABLE_SELF_SERVICE_SIGNUP", lifecycleOverrides.signupEnabled);
	if (lifecycleOverrides.notificationDispatcher !== undefined) vi.stubEnv("NOTIFICATION_DISPATCHER_URL", lifecycleOverrides.notificationDispatcher);
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

	it("rejects missing OPA endpoint or service credentials in production", async () => {
			await expect(loadEnvironment("a-high-entropy-test-internal-token", {}, {}, { endpoint: "" })).rejects.toThrow("OPA_ENDPOINT is required in production");
			await expect(loadEnvironment("a-high-entropy-test-internal-token", {}, {}, { authToken: "" })).rejects.toThrow("OPA_AUTH_TOKEN is required in production");
		});

	it("rejects a missing public origin for lifecycle links in production", async () => {
		await expect(loadEnvironment("a-high-entropy-test-internal-token", {}, { publicOrigin: "" })).rejects.toThrow(
			"PUBLIC_APP_ORIGIN is required in production for account lifecycle links",
		);
	});

	it("requires transactional email delivery when self-service signup is enabled", async () => {
		await expect(loadEnvironment("a-high-entropy-test-internal-token", {}, { signupEnabled: "true", notificationDispatcher: "" })).rejects.toThrow(
			"NOTIFICATION_DISPATCHER_URL is required in production when self-service signup is enabled",
		);
	});
});
