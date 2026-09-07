import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    response.setHeader("content-type", "application/json");
    if (url.pathname === "/.well-known/openid-configuration") {
      response.end(
        JSON.stringify({
          issuer: baseUrl,
          authorization_endpoint: `${baseUrl}/authorize`,
          token_endpoint: `${baseUrl}/token`,
          jwks_uri: `${baseUrl}/jwks`,
        }),
      );
      return;
    }
    if (url.pathname === "/v1.0/metadata") {
      response.end(JSON.stringify({ id: "local-dapr-simulator" }));
      return;
    }
    if (url.pathname === "/v1/schema") {
      response.end(JSON.stringify({ version: "simulated" }));
      return;
    }
    if (url.pathname === "/_cluster/health") {
      response.end(JSON.stringify({ status: "green" }));
      return;
    }
    response.end(
      JSON.stringify({
        status: "healthy",
        service: "local-external-contract-simulator",
        stt_ready: true,
        tts_ready: true,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("simulator did not bind a TCP port");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
});

async function loadProbes() {
  vi.resetModules();
  Object.assign(process.env, {
    NODE_ENV: "test",
    ENABLE_EXTERNAL_OIDC: "true",
    OIDC_ISSUER_URL: baseUrl,
    APISIX_CONTROL_URL: baseUrl,
    APISIX_ADMIN_URL: "",
    OPENAPPSEC_URL: baseUrl,
    PERMIFY_ENDPOINT: baseUrl,
    DAPR_HTTP_PORT: String(new URL(baseUrl).port),
    FLUVIO_SERVICE_URL: baseUrl,
    OPENSEARCH_URL: baseUrl,
    MOJALOOP_SERVICE_URL: baseUrl,
    TIGERBEETLE_SERVICE_URL: baseUrl,
    LAKEHOUSE_SERVICE_URL: baseUrl,
    VERTICAL_PROVISIONING_URL: baseUrl,
    INTAKE_ORCHESTRATOR_URL: baseUrl,
    LONGCAT_VOICE_GATEWAY_URL: baseUrl,
    LONGCAT_SPEECH_SERVICE_URL: baseUrl,
    LOCAL_COMMERCE_GATEWAY_URL: baseUrl,
    RETAIL_FORECAST_SERVICE_URL: baseUrl,
    DISPATCH_OPTIMIZER_URL: baseUrl,
    PROCUREMENT_PLANNER_SERVICE_URL: baseUrl,
    INVENTORY_CONTROL_SERVICE_URL: baseUrl,
  });
  return import("../server/_core/integrationProbes");
}

describe("external integration probe contracts", () => {
  it("reports configured HTTP destinations healthy through their real probe paths", async () => {
    const probes = await loadProbes();
    const [
      oidc,
      apisix,
      openAppSec,
      permify,
      dapr,
      fluvio,
      opensearch,
      services,
    ] = await Promise.all([
      probes.probeExternalOidc(),
      probes.probeApisix(),
      probes.probeOpenAppSec(),
      probes.probePermify(),
      probes.probeDapr(),
      probes.probeFluvio(),
      probes.probeOpenSearch(),
      probes.probeServices(),
    ]);

    expect(oidc.status).toBe("healthy");
    expect(apisix.status).toBe("healthy");
    expect(openAppSec.status).toBe("healthy");
    expect(permify.status).toBe("healthy");
    expect(dapr.status).toBe("healthy");
    expect(fluvio.status).toBe("healthy");
    expect(opensearch.status).toBe("healthy");
    expect(services).toEqual(
      expect.objectContaining({
        mojaloop: expect.objectContaining({ status: "healthy" }),
        tigerbeetle: expect.objectContaining({ status: "healthy" }),
        lakehouse: expect.objectContaining({ status: "healthy" }),
        verticalProvisioning: expect.objectContaining({ status: "healthy" }),
        intakeOrchestrator: expect.objectContaining({ status: "healthy" }),
        longcatVoiceGateway: expect.objectContaining({ status: "healthy" }),
        longcatSpeechRuntime: expect.objectContaining({ status: "healthy" }),
        localCommerceGateway: expect.objectContaining({ status: "healthy" }),
        retailForecastService: expect.objectContaining({ status: "healthy" }),
        dispatchOptimizer: expect.objectContaining({ status: "healthy" }),
        procurementPlanner: expect.objectContaining({ status: "healthy" }),
        inventoryControl: expect.objectContaining({ status: "healthy" }),
      }),
    );
  });
});
