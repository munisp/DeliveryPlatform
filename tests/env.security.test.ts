import { afterEach, describe, expect, it, vi } from "vitest";

const productionEnvironment = {
  NODE_ENV: "production",
  JWT_SECRET: "a-high-entropy-test-jwt-secret",
  OAUTH_SERVER_URL: "https://auth.switchos.test",
  BOOTSTRAP_OPERATOR_PASSWORD: "a-high-entropy-test-operator-password",
};

async function loadEnvironment(internalServiceToken?: string) {
  vi.resetModules();
  for (const [key, value] of Object.entries(productionEnvironment)) {
    vi.stubEnv(key, value);
  }
  vi.stubEnv("INTERNAL_SERVICE_TOKEN", internalServiceToken ?? "");
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
});
