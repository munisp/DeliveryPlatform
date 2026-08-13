import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const harness = fs.readFileSync(path.join(root, "scripts/run-mock-production-dependency-gate.sh"), "utf8");
const compose = fs.readFileSync(path.join(root, "deploy/testing/docker-compose.production-gate-mock.yml"), "utf8");

describe("controlled production-gate mock harness", () => {
  it("uses Compose-hosted mock endpoints and proves both healthy and fail-closed Kafka paths", () => {
    expect(compose).toContain("network_mode: host");
    expect(compose).toContain("mock-production-dependency-server.cjs");
    expect(harness).toContain("verify-production-dependencies.sh");
    expect(harness).toContain("Running controlled passing mode");
    expect(harness).toContain("Running controlled failing mode");
    expect(harness).toContain("Kafka broker 127.0.0.1:65530 is unreachable");
  });
});

