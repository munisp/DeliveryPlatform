import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

const root = process.cwd();
const source = (relativePath: string) =>
  readFileSync(resolve(root, relativePath), "utf8");

// Files whose database pools previously disabled TLS certificate
// verification and now must follow the verified-by-default pattern.
const hardenedPoolFiles = [
  "server/lib/platformWorkspaces.ts",
  "server/lib/lakehouse.ts",
  "server/_core/operatorAuthStore.ts",
  "server/_core/operationalEvents.ts",
  "server/_core/longcatActions.ts",
  "server/_core/longcatVoice.ts",
];

describe("database TLS verification hardening", () => {
  it("verifies TLS certificates by default on every residual database pool", () => {
    for (const file of hardenedPoolFiles) {
      const body = source(file);
      expect(body, `${file} must verify TLS certificates by default`).toContain(
        "rejectUnauthorized: true",
      );
      expect(
        body,
        `${file} must support the DATABASE_SSL_CA trust anchor`,
      ).toContain("databaseSslCa");
      expect(
        body,
        `${file} must gate any skip-verify behind DATABASE_TLS_SKIP_VERIFY`,
      ).toContain("databaseTlsSkipVerify");
    }
  });

  it("never disables TLS verification outside the gated development override", () => {
    for (const file of hardenedPoolFiles) {
      const body = source(file);
      const insecureSites = body
        .split("\n")
        .filter((line) => line.includes("rejectUnauthorized: false"))
        .filter((line) => !line.includes("as const"));
      expect(
        insecureSites,
        `${file} has an ungated rejectUnauthorized: false`,
      ).toEqual([]);
    }
  });

  it("keeps insecure TLS overrides out of validation tooling as well", () => {
    const body = source("validation/longcat_nonvoice_e2e.ts");
    expect(body).toContain("rejectUnauthorized: true");
    expect(body).toContain("databaseTlsSkipVerify");
  });
});

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
  INTERNAL_SERVICE_TOKEN: "a-high-entropy-test-internal-token",
};

async function loadEnvironment(nodeEnv: string) {
  vi.resetModules();
  for (const [key, value] of Object.entries(productionEnvironment)) {
    vi.stubEnv(key, value);
  }
  vi.stubEnv("NODE_ENV", nodeEnv);
  return import("../server/_core/env");
}

describe("database TLS environment configuration", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("rejects DATABASE_TLS_SKIP_VERIFY in production", async () => {
    vi.stubEnv("DATABASE_TLS_SKIP_VERIFY", "true");
    await expect(loadEnvironment("production")).rejects.toThrow(
      "DATABASE_TLS_SKIP_VERIFY disables TLS certificate verification and must never be enabled in production",
    );
  });

  it("allows DATABASE_TLS_SKIP_VERIFY only outside production", async () => {
    vi.stubEnv("DATABASE_TLS_SKIP_VERIFY", "true");
    const { ENV } = await loadEnvironment("development");
    expect(ENV.databaseTlsSkipVerify).toBe(true);
  });

  it("honors DATABASE_SSL_CA and unescapes embedded newlines", async () => {
    vi.stubEnv(
      "DATABASE_SSL_CA",
      "-----BEGIN CERTIFICATE-----\\nMIIBszCCAVmgAwIBAgIU\\n-----END CERTIFICATE-----",
    );
    const { ENV } = await loadEnvironment("production");
    expect(ENV.databaseSslCa).toBe(
      "-----BEGIN CERTIFICATE-----\nMIIBszCCAVmgAwIBAgIU\n-----END CERTIFICATE-----",
    );
  });

  it("defaults DATABASE_SSL_CA to empty and skip-verify to false", async () => {
    const { ENV } = await loadEnvironment("production");
    expect(ENV.databaseSslCa).toBe("");
    expect(ENV.databaseTlsSkipVerify).toBe(false);
  });
});
