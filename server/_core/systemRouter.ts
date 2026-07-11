import { publicProcedure, router } from "./trpc";
import { ENV } from "./env";
import { getLiveIntegrationStatus } from "./integrationProbes";
import { getPolicyIntegrationStatus } from "./policy";
import { getOperationalEventStatus } from "./operationalEvents";

function configured(value: string | null | undefined) {
  return typeof value === "string" && value.trim().length > 0;
}

function splitAndTrim(value: string | null | undefined) {
  if (!value) return [];
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
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
      kafkaBrokers: splitAndTrim(ENV.kafkaBrokers),
      kafkaConfigured: configured(ENV.kafkaBrokers),
      kafkaOperationalEventsTopic: ENV.kafkaOperationalEventsTopic || null,
      fluvioServiceUrl: ENV.fluvioServiceUrl || null,
      fluvioConfigured: configured(ENV.fluvioServiceUrl),
      daprHttpPort: ENV.daprHttpPort || null,
      daprConfigured: configured(ENV.daprHttpPort),
      temporalAddress: process.env.TEMPORAL_ADDRESS || null,
      temporalConfigured: configured(process.env.TEMPORAL_ADDRESS),
      redisUrl: ENV.redisUrl || null,
      redisConfigured: configured(ENV.redisUrl),
      openSearchUrl: ENV.opensearchUrl || null,
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
