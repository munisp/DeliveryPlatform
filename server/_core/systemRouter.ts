import { publicProcedure, router } from "./trpc";
import { ENV } from "./env";

function configured(value: string | null | undefined) {
  return typeof value === "string" && value.trim().length > 0;
}

export const systemRouter = router({
  health: publicProcedure.query(() => ({
    ok: true,
    service: "switchos-operator-dashboard",
    timestamp: new Date().toISOString(),
  })),

  integrationStatus: publicProcedure.query(() => ({
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
      permifyConfigured: configured(process.env.PERMIFY_ENDPOINT),
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
      redisUrl: process.env.REDIS_URL || null,
      redisConfigured: configured(process.env.REDIS_URL),
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
  })),
});
