import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

async function loadModule() {
  vi.resetModules();
  return import("../server/_core/operationalEvents");
}

describe("SwitchOS operational event bridge", () => {
  const originalEnv = {
    DATABASE_URL: process.env.DATABASE_URL,
    DAPR_HTTP_PORT: process.env.DAPR_HTTP_PORT,
    DAPR_PUBSUB_NAME: process.env.DAPR_PUBSUB_NAME,
    DAPR_OPERATIONAL_EVENTS_TOPIC: process.env.DAPR_OPERATIONAL_EVENTS_TOPIC,
    OPENSEARCH_URL: process.env.OPENSEARCH_URL,
    OPENSEARCH_USERNAME: process.env.OPENSEARCH_USERNAME,
    OPENSEARCH_PASSWORD: process.env.OPENSEARCH_PASSWORD,
    OPENSEARCH_OPERATIONAL_EVENTS_INDEX: process.env.OPENSEARCH_OPERATIONAL_EVENTS_INDEX,
  };

  beforeEach(() => {
    fetchMock.mockReset();
    process.env.DATABASE_URL = "";
    process.env.DAPR_HTTP_PORT = "";
    process.env.DAPR_PUBSUB_NAME = "switchos-bus";
    process.env.DAPR_OPERATIONAL_EVENTS_TOPIC = "operational-events";
    process.env.OPENSEARCH_URL = "";
    process.env.OPENSEARCH_USERNAME = "";
    process.env.OPENSEARCH_PASSWORD = "";
    process.env.OPENSEARCH_OPERATIONAL_EVENTS_INDEX = "switchos-operational-events";
  });

  afterEach(() => {
    process.env.DATABASE_URL = originalEnv.DATABASE_URL;
    process.env.DAPR_HTTP_PORT = originalEnv.DAPR_HTTP_PORT;
    process.env.DAPR_PUBSUB_NAME = originalEnv.DAPR_PUBSUB_NAME;
    process.env.DAPR_OPERATIONAL_EVENTS_TOPIC = originalEnv.DAPR_OPERATIONAL_EVENTS_TOPIC;
    process.env.OPENSEARCH_URL = originalEnv.OPENSEARCH_URL;
    process.env.OPENSEARCH_USERNAME = originalEnv.OPENSEARCH_USERNAME;
    process.env.OPENSEARCH_PASSWORD = originalEnv.OPENSEARCH_PASSWORD;
    process.env.OPENSEARCH_OPERATIONAL_EVENTS_INDEX = originalEnv.OPENSEARCH_OPERATIONAL_EVENTS_INDEX;
  });

  it("reports fallback status when only PostgreSQL persistence is configured", async () => {
    process.env.DATABASE_URL = "postgresql://switchos:switchos@localhost:5432/switchos?sslmode=disable";
    const { getOperationalEventStatus } = await loadModule();

    expect(getOperationalEventStatus()).toMatchObject({
      postgresConfigured: true,
      daprConfigured: false,
      openSearchConfigured: false,
    });
  });

  it("publishes operational events to Dapr and OpenSearch when configured", async () => {
    process.env.DAPR_HTTP_PORT = "3500";
    process.env.DAPR_PUBSUB_NAME = "switchos-pubsub";
    process.env.DAPR_OPERATIONAL_EVENTS_TOPIC = "ops-events";
    process.env.OPENSEARCH_URL = "http://127.0.0.1:9200";
    process.env.OPENSEARCH_OPERATIONAL_EVENTS_INDEX = "ops-index";
    process.env.OPENSEARCH_USERNAME = "admin";
    process.env.OPENSEARCH_PASSWORD = "admin-password";

    fetchMock
      .mockResolvedValueOnce({ ok: true, text: async () => "" })
      .mockResolvedValueOnce({ ok: true, text: async () => "" });

    const { recordOperationalEvent, getOperationalEventStatus } = await loadModule();

    await expect(
      recordOperationalEvent({
        eventType: "auth.local.login",
        actorId: "7",
        actorRole: "operator",
        tenantId: "switchos-core",
        route: "/api/auth/login",
        outcome: "success",
        payload: { email: "ops@switchos.local" },
      }),
    ).resolves.toMatchObject({
      persisted: false,
      daprPublished: true,
      openSearchIndexed: true,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe("http://127.0.0.1:3500/v1.0/publish/switchos-pubsub/ops-events");
    expect(fetchMock.mock.calls[1][0]).toBe("http://127.0.0.1:9200/ops-index/_doc");

    expect(getOperationalEventStatus()).toMatchObject({
      daprConfigured: true,
      openSearchConfigured: true,
      daprHttpPort: "3500",
      daprPubsubName: "switchos-pubsub",
      openSearchOperationalEventsIndex: "ops-index",
    });
  });

  it("does not fail the caller when downstream middleware forwarding endpoints reject an event", async () => {
    process.env.DAPR_HTTP_PORT = "3500";
    process.env.OPENSEARCH_URL = "http://127.0.0.1:9200";

    fetchMock
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => "dapr unavailable" })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "opensearch unavailable" });

    const { recordOperationalEvent } = await loadModule();

    await expect(
      recordOperationalEvent({
        eventType: "system.health.checked",
        route: "/api/health",
        outcome: "info",
      }),
    ).resolves.toMatchObject({
      daprPublished: false,
      openSearchIndexed: false,
    });
  });
});
