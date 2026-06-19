import { describe, expect, it } from "vitest";
import { IncomingMessage, ServerResponse } from "http";

import { systemRouter } from "../server/_core/systemRouter";

function createContext() {
  return {
    req: new IncomingMessage(null as never),
    res: new ServerResponse({} as never),
    user: null,
  };
}

describe("SwitchOS system integration status", () => {
  it("reports health for the operator edge", async () => {
    const caller = systemRouter.createCaller(createContext());
    await expect(caller.health()).resolves.toMatchObject({ ok: true, service: "switchos-operator-dashboard" });
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
  });
});
