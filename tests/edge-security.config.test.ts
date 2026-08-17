import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const source = (relativePath: string) => readFile(resolve(root, relativePath), "utf8");

describe("Caddy and API gateway security configuration", () => {
  it("keeps Caddy as the hardened public TLS edge", async () => {
    const [caddyfile, compose] = await Promise.all([
      source("deploy/gateway/caddy/Caddyfile"),
      source("deploy/platform/docker-compose.stack.yml"),
    ]);

    expect(caddyfile).toContain("admin off");
    expect(caddyfile).toContain("Strict-Transport-Security");
    expect(caddyfile).toContain("X-Content-Type-Options");
    expect(caddyfile).toContain("reverse_proxy apisix:9080");
    expect(caddyfile).toContain("reverse_proxy keycloak:8080");
    expect(compose).toContain("caddy:");
    expect(compose).toContain('"443:443"');
    expect(compose).not.toContain('"9080:9080"');
    expect(compose).not.toContain('"9180:9180"');
    expect(compose).not.toContain('"5432:5432"');
    expect(compose).not.toContain('"6379:6379"');
  });

  it("disables APISIX management listeners and restricts browser access to HTTPS edge origins", async () => {
    const [config, routes] = await Promise.all([
      source("deploy/gateway/apisix/config.yaml"),
      source("deploy/gateway/apisix/apisix.yaml"),
    ]);

    expect(config).toContain("enable_admin: false");
    expect(config).toContain("enable_control: false");
    expect(routes).toContain("https://switchos.localhost");
    expect(routes).not.toContain("http://localhost:3000");
    expect(routes).toContain('X-Forwarded-Proto: "https"');
    expect(routes).toContain("limit-req:");
  });

  it("removes seeded Keycloak users and applies prevention-mode WAF coverage to Caddy hostnames", async () => {
    const [realm, policy] = await Promise.all([
      source("deploy/identity/keycloak-realm-switchos.json"),
      source("deploy/gateway/openappsec/policy.json"),
    ]);

    expect(realm).toContain('"users": []');
    expect(realm).not.toContain("ChangeMe123!");
    expect(realm).not.toContain("change-me-before-production");
    expect(realm).toContain("https://switchos.localhost/api/auth/oidc/callback");
    expect(policy).toContain('"suspiciousAutomation": "prevent"');
    expect(policy).toContain('"host": "switchos.localhost"');
    expect(policy).toContain('"host": "auth.localhost"');
  });

  it("pins Permify and requires durable PostgreSQL plus authenticated service access", async () => {
    const compose = await source("deploy/platform/docker-compose.stack.yml");

    expect(compose).toContain("ghcr.io/permify/permify:v1.7.2");
    expect(compose).not.toContain("ghcr.io/permify/permify:latest");
    expect(compose).toContain("PERMIFY_DATABASE_ENGINE: postgres");
    expect(compose).toContain("PERMIFY_DATABASE_URI:");
    expect(compose).toContain('PERMIFY_DATABASE_AUTO_MIGRATE: "true"');
    expect(compose).toContain('PERMIFY_AUTHN_ENABLED: "true"');
    expect(compose).toContain("PERMIFY_AUTHN_PRESHARED_KEYS:");
    expect(compose).toContain("grpc_health_probe");
  });
});
