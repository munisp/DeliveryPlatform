import { publicProcedure, router } from "./trpc";
import { ENV } from "./env";
import { getLiveIntegrationStatus } from "./integrationProbes";
import { getPolicyIntegrationStatus } from "./policy";
import { getOperationalEventStatus } from "./operationalEvents";

function configured(value: string | null | undefined) {
  return typeof value === "string" && value.trim().length > 0;
}

export const systemRouter = router({
  health: publicProcedure.query(() => ({
    ok: true,
    service: "switchos-operator-dashboard",
    timestamp: new Date().toISOString(),
  })),

  integrationStatus: publicProcedure.query(async () => ({
    timestamp: new Date().toISOString(),
    edge: {
      apisixAdminUrl: ENV.apisixAdminUrl,
      apisixConfigured: configured(ENV.apisixAdminUrl),
      openAppSecConfigured: configured(process.env.OPENAPPSEC_POLICY_PATH),
      cacheControlIndexHtml: ENV.cacheControlIndexHtml,
    },
    identity: {
      externalOidcEnabled: ENV.enableExternalOidc,
      oidcIssuerUrl: ENV.oidcIssuerUrl || null,
      oidcClientId: ENV.oidcClientId || null,
      keycloakReady: ENV.enableExternalOidc && configured(ENV.oidcIssuerUrl),
      permifyConfigured: configured(ENV.permifyEndpoint),
      policy: getPolicyIntegrationStatus(),
    },
    messaging: {
      kafkaBootstrapServers: process.env.KAFKA_BOOTSTRAP_SERVERS || null,
      kafkaConfigured: configured(process.env.KAFKA_BOOTSTRAP_SERVERS),
      fluvioServiceUrl: ENV.fluvioServiceUrl || null,
      fluvioConfigured: configured(ENV.fluvioServiceUrl),
      daprHttpPort: process.env.DAPR_HTTP_PORT || null,
      daprConfigured: configured(process.env.DAPR_HTTP_PORT),
      temporalAddress: process.env.TEMPORAL_ADDRESS || null,
      temporalConfigured: configured(process.env.TEMPORAL_ADDRESS),
      redisUrl: ENV.redisUrl || null,
      redisConfigured: configured(ENV.redisUrl),
      openSearchUrl: process.env.OPENSEARCH_URL || null,
      openSearchConfigured: configured(process.env.OPENSEARCH_URL),
    },
    services: {
      mojaloopServiceUrl: ENV.mojaloopServiceUrl,
      tigerbeetleServiceUrl: ENV.tigerbeetleServiceUrl,
      lakehouseServiceUrl: ENV.lakehouseServiceUrl,
      verticalProvisioningUrl: ENV.verticalProvisioningUrl,
      intakeOrchestratorUrl: ENV.intakeOrchestratorUrl,
    },
    operationalEvents: getOperationalEventStatus(),
    liveChecks: await getLiveIntegrationStatus(),
  })),
});
