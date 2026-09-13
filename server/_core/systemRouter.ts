import { authenticatedProcedure, publicProcedure, router } from "./trpc";
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

  // Authenticated only: this payload describes internal infrastructure
  // topology. Raw connection strings (redisUrl, broker lists, search URLs)
  // can embed credentials and are never returned — only configured/not
  // configured booleans and non-secret settings are exposed.
  integrationStatus: authenticatedProcedure.query(async () => ({
    timestamp: new Date().toISOString(),
    edge: {
      apisixAdminUrl: ENV.apisixAdminUrl,
      apisixControlUrl: ENV.apisixControlUrl || null,
      apisixConfigured: configured(ENV.apisixAdminUrl) || configured(ENV.apisixControlUrl),
      openAppSecConfigured: configured(ENV.openAppSecUrl) || configured(ENV.openAppSecPolicyPath),
      openAppSecUrl: ENV.openAppSecUrl || null,
      openAppSecPolicyPath: ENV.openAppSecPolicyPath || null,
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
      kafkaConfigured: configured(ENV.kafkaBrokers),
      kafkaOperationalEventsTopic: ENV.kafkaOperationalEventsTopic || null,
      fluvioConfigured: configured(ENV.fluvioServiceUrl),
      daprConfigured: configured(ENV.daprHttpPort),
      temporalConfigured: configured(process.env.TEMPORAL_ADDRESS),
      redisConfigured: configured(ENV.redisUrl),
      openSearchConfigured: configured(ENV.opensearchUrl),
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
