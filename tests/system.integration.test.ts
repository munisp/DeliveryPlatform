import { describe, expect, it } from "vitest";
import { IncomingMessage, ServerResponse } from "http";

import { systemRouter } from "../server/_core/systemRouter";

function createContext(authenticated = true) {
  return {
    req: new IncomingMessage(null as never),
    res: new ServerResponse({} as never),
    user: authenticated
      ? { id: 7, name: "Ops", role: "admin", openId: "operator:7" }
      : null,
  };
}

describe("SwitchOS system integration status", () => {
  it("reports health for the operator edge", async () => {
    const caller = systemRouter.createCaller(createContext());
    await expect(caller.health()).resolves.toMatchObject({ ok: true, service: "switchos-operator-dashboard" });
  });

  it("rejects integration status for unauthenticated callers", async () => {
    const caller = systemRouter.createCaller(createContext(false));
    await expect(caller.integrationStatus()).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("reports integration posture for edge, identity, messaging, and services", async () => {
    const caller = systemRouter.createCaller(createContext());
    const status = await caller.integrationStatus();

    expect(status).toMatchObject({
      edge: {
        apisixConfigured: true,
        cacheControlIndexHtml: expect.any(String),
      },
      identity: {
        externalOidcEnabled: expect.any(Boolean),
        keycloakReady: expect.any(Boolean),
        permifyConfigured: expect.any(Boolean),
      },
      messaging: {
        kafkaConfigured: expect.any(Boolean),
        daprConfigured: expect.any(Boolean),
        temporalConfigured: expect.any(Boolean),
        redisConfigured: expect.any(Boolean),
        openSearchConfigured: expect.any(Boolean),
      },
      services: {
        mojaloopServiceUrl: expect.any(String),
        lakehouseServiceUrl: expect.any(String),
      },
    });

    // No connection strings or credential-bearing URLs may leak: the
    // payload carries configured/not-configured booleans only.
    const serialized = JSON.stringify(status);
    expect(serialized).not.toContain("redisUrl");
    expect(serialized).not.toContain("redis://");
    expect(status.messaging).not.toHaveProperty("redisUrl");
    expect(status.messaging).not.toHaveProperty("kafkaBrokers");
    expect(status.messaging).not.toHaveProperty("openSearchUrl");
    expect(status.messaging).not.toHaveProperty("temporalAddress");
  });
});
