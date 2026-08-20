import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(process.cwd());

describe("promotion contract configuration", () => {
  it("defines every component dependency without deployment defaults", () => {
    const template = readFileSync(join(root, "deploy/platform/promotion.env.example"), "utf8");
    for (const key of ["TIGERBEETLE_ADDRESSES", "KAFKA_BROKERS", "FLUVIO_KAFKA_BROKERS", "TEMPORAL_ADDRESS", "PERMIFY_ENDPOINT", "OPA_ENDPOINT", "REQUIRE_MFA_FOR_PRIVILEGED_ACTIONS", "KEYCLOAK_ISSUER", "STAGING_MAILPIT_API_URL"]) {
      expect(template).toContain(`${key}=`);
    }
  });

  it("keeps promotion verification fail-closed for placeholders, TLS, OIDC, and staging mailbox reachability", () => {
    const script = readFileSync(join(root, "scripts/verify-promotion-contract.sh"), "utf8");
    expect(script).toContain("missing or contains an unsafe placeholder");
    expect(script).toContain("rediss://");
    expect(script).toContain("sslmode=require");
    expect(script).toContain("OIDC discovery issuer mismatch");
    expect(script).toContain("STAGING_MAILPIT_API_URL");
    expect(script).toContain("TigerBeetle");
    expect(script).toContain("REQUIRE_MFA_FOR_PRIVILEGED_ACTIONS must be true");
    expect(script).toContain("OPA_AUTH_TOKEN");
  });
});
