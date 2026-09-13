import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("multi-platform commerce driver handoff contracts", () => {
  const migration = read("drizzle/0065_multiplatform_commerce_driver_handoff.sql");
  const gateway = read("server/_core/commerceFulfillment.ts");
  const routes = read("server/_core/index.ts");
  const router = read("server/routers.ts");

  it("keeps inbound platform events immutable, digest-identified, and transactionally idempotent", () => {
    expect(migration).toContain("commerce.external_platform_event");
    expect(migration).toContain("UNIQUE (connection_id, external_event_id)");
    expect(migration).toContain("commerce_external_platform_event_append_only");
    expect(migration).toContain("pg_advisory_xact_lock");
    expect(migration).toContain("external event identifier reused with different payload");
  });

  it("requires operator authorization and binds a provider-matching delivery order to an eligible driver", () => {
    expect(migration).toContain("commerce.assign_fulfillment_delivery_driver");
    expect(migration).toContain("operator role required");
    expect(migration).toContain("provider-matching delivery order required");
    expect(migration).toContain("eligible online driver required");
    expect(migration).toContain("delivery order already assigned to another driver");
    expect(migration).toContain("developer.enqueue_webhook_deliveries");
  });

  it("uses bounded HMAC configuration and raw-body verification before database ingestion", () => {
    expect(gateway).toContain("ENV.externalCommerceIngressEnabled");
    expect(gateway).toContain("createHmac(\"sha256\"");
    expect(gateway).toContain("timingSafeEqual");
    expect(gateway).toContain("external_commerce_webhook_secrets_too_many");
    expect(routes).toContain("/api/internal/commerce/platforms/:connectionKey/events");
    expect(routes).toContain("express.raw({ type: \"application/json\"");
  });

  it("exposes typed protected registration and assignment operations", () => {
    expect(router).toContain("registerExternalPlatform: protectedProcedure");
    expect(router).toContain("assignDriver: protectedProcedure");
    expect(router).toContain("at least one sync direction is required");
  });
});
