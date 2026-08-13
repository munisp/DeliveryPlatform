import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const stack = fs.readFileSync(path.join(root, "deploy/platform/docker-compose.stack.yml"), "utf8");
const gate = fs.readFileSync(path.join(root, "scripts/verify-production-dependencies.sh"), "utf8");

describe("production dependency gates", () => {
  it("rejects insecure stack defaults for edge, identity, Redis, and OpenSearch", () => {
    expect(stack).not.toContain("change-me-before-production");
    expect(stack).not.toContain('plugins.security.disabled: "true"');
    expect(stack).not.toContain('KEYCLOAK_ADMIN: ${KEYCLOAK_ADMIN:-');
    expect(stack).toContain("--requirepass");
    expect(stack).toContain("REDIS_PASSWORD");
    expect(stack).toContain("OPENSEARCH_INITIAL_ADMIN_PASSWORD");
  });

  it("requires all financial middleware dependencies and invokes the edge verifier", () => {
    for (const dependency of ["POSTGRES_PASSWORD", "REDIS_URL", "TEMPORAL_ADDRESS", "KAFKA_BROKERS", "FLUVIO_KAFKA_BROKERS"]) {
      expect(gate).toContain(dependency);
    }
    expect(gate).toContain("verify-staging-edge.sh");
    expect(gate).toContain("sslmode=require");
    expect(gate).toContain("redis-cli");
  });
});
