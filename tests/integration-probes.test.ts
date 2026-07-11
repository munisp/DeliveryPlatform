import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchMock = vi.fn();
const socketConnectMock = vi.fn();

class MockSocket {
  private handlers: Record<string, ((...args: any[]) => void) | undefined> = {};

  setTimeout = vi.fn();

  once(event: string, handler: (...args: any[]) => void) {
    this.handlers[event] = handler;
    return this;
  }

  removeAllListeners() {
    this.handlers = {};
    return this;
  }

  destroy() {
    return this;
  }

  connect(port: number, host: string) {
    socketConnectMock({ port, host, handlers: this.handlers });
    return this;
  }
}

vi.mock("node:net", () => ({ Socket: MockSocket }));
vi.stubGlobal("fetch", fetchMock);

async function loadModule() {
  vi.resetModules();
  return import("../server/_core/integrationProbes");
}

describe("SwitchOS live integration probes", () => {
  const originalEnv = {
    APISIX_ADMIN_URL: process.env.APISIX_ADMIN_URL,
    APISIX_CONTROL_URL: process.env.APISIX_CONTROL_URL,
    APISIX_ADMIN_KEY: process.env.APISIX_ADMIN_KEY,
    OPENAPPSEC_URL: process.env.OPENAPPSEC_URL,
    OPENAPPSEC_POLICY_PATH: process.env.OPENAPPSEC_POLICY_PATH,
    ENABLE_EXTERNAL_OIDC: process.env.ENABLE_EXTERNAL_OIDC,
    OIDC_ISSUER_URL: process.env.OIDC_ISSUER_URL,
    OIDC_DISCOVERY_URL: process.env.OIDC_DISCOVERY_URL,
    PERMIFY_ENDPOINT: process.env.PERMIFY_ENDPOINT,
    KAFKA_BROKERS: process.env.KAFKA_BROKERS,
    KAFKA_BOOTSTRAP_SERVERS: process.env.KAFKA_BOOTSTRAP_SERVERS,
    KAFKA_OPERATIONAL_EVENTS_TOPIC: process.env.KAFKA_OPERATIONAL_EVENTS_TOPIC,
    REDIS_URL: process.env.REDIS_URL,
    DAPR_HTTP_PORT: process.env.DAPR_HTTP_PORT,
    OPENSEARCH_URL: process.env.OPENSEARCH_URL,
    OPENSEARCH_USERNAME: process.env.OPENSEARCH_USERNAME,
    OPENSEARCH_PASSWORD: process.env.OPENSEARCH_PASSWORD,
    TEMPORAL_ADDRESS: process.env.TEMPORAL_ADDRESS,
    FLUVIO_SERVICE_URL: process.env.FLUVIO_SERVICE_URL,
    MOJALOOP_SERVICE_URL: process.env.MOJALOOP_SERVICE_URL,
    TIGERBEETLE_SERVICE_URL: process.env.TIGERBEETLE_SERVICE_URL,
    LAKEHOUSE_SERVICE_URL: process.env.LAKEHOUSE_SERVICE_URL,
    VERTICAL_PROVISIONING_URL: process.env.VERTICAL_PROVISIONING_URL,
    INTAKE_ORCHESTRATOR_URL: process.env.INTAKE_ORCHESTRATOR_URL,
    LONGCAT_VOICE_GATEWAY_URL: process.env.LONGCAT_VOICE_GATEWAY_URL,
    LONGCAT_SPEECH_SERVICE_URL: process.env.LONGCAT_SPEECH_SERVICE_URL,
  };

  beforeEach(() => {
    fetchMock.mockReset();
    socketConnectMock.mockReset();
    process.env.APISIX_ADMIN_URL = "";
    process.env.APISIX_CONTROL_URL = "";
    process.env.APISIX_ADMIN_KEY = "";
    process.env.OPENAPPSEC_URL = "";
    process.env.OPENAPPSEC_POLICY_PATH = "";
    process.env.ENABLE_EXTERNAL_OIDC = "false";
    process.env.OIDC_ISSUER_URL = "";
    process.env.OIDC_DISCOVERY_URL = "";
    process.env.PERMIFY_ENDPOINT = "";
    process.env.KAFKA_BROKERS = "";
    process.env.KAFKA_BOOTSTRAP_SERVERS = "";
    process.env.KAFKA_OPERATIONAL_EVENTS_TOPIC = "operational-events";
    process.env.REDIS_URL = "";
    process.env.DAPR_HTTP_PORT = "";
    process.env.OPENSEARCH_URL = "";
    process.env.OPENSEARCH_USERNAME = "";
    process.env.OPENSEARCH_PASSWORD = "";
    process.env.TEMPORAL_ADDRESS = "";
    process.env.FLUVIO_SERVICE_URL = "";
    process.env.MOJALOOP_SERVICE_URL = "http://127.0.0.1:8086";
    process.env.TIGERBEETLE_SERVICE_URL = "http://127.0.0.1:8087";
    process.env.LAKEHOUSE_SERVICE_URL = "http://127.0.0.1:8007";
    process.env.VERTICAL_PROVISIONING_URL = "http://127.0.0.1:8088";
    process.env.INTAKE_ORCHESTRATOR_URL = "http://127.0.0.1:8091";
    process.env.LONGCAT_VOICE_GATEWAY_URL = "";
    process.env.LONGCAT_SPEECH_SERVICE_URL = "";
  });

  afterEach(() => {
    Object.entries(originalEnv).forEach(([key, value]) => {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    });
  });

  it("returns unconfigured results when optional integrations are not enabled", async () => {
    const { getLiveIntegrationStatus } = await loadModule();
    const status = await getLiveIntegrationStatus();

    expect(status.edge.openAppSec.status).toBe("unconfigured");
    expect(status.identity.oidc.status).toBe("unconfigured");
    expect(status.identity.permify.status).toBe("unconfigured");
    expect(status.messaging.kafka.status).toBe("unconfigured");
    expect(status.messaging.redis.status).toBe("unconfigured");
    expect(status.messaging.dapr.status).toBe("unconfigured");
    expect(status.messaging.openSearch.status).toBe("unconfigured");
    expect(status.services.longcatVoiceGateway.status).toBe("unconfigured");
    expect(status.services.longcatSpeechRuntime.status).toBe("unconfigured");
  });

  it("reports healthy middleware checks when configured endpoints respond successfully", async () => {
    process.env.APISIX_CONTROL_URL = "http://127.0.0.1:9000";
    process.env.OPENAPPSEC_URL = "http://127.0.0.1:9443";
    process.env.ENABLE_EXTERNAL_OIDC = "true";
    process.env.OIDC_ISSUER_URL = "https://identity.switchos.example/realms/switchos";
    process.env.PERMIFY_ENDPOINT = "http://127.0.0.1:3476";
    process.env.KAFKA_BROKERS = "127.0.0.1:9092,127.0.0.1:9093";
    process.env.KAFKA_OPERATIONAL_EVENTS_TOPIC = "switchos.operational-events";
    process.env.DAPR_HTTP_PORT = "3500";
    process.env.OPENSEARCH_URL = "http://127.0.0.1:9200";
    process.env.OPENSEARCH_USERNAME = "admin";
    process.env.OPENSEARCH_PASSWORD = "admin-password";
    process.env.TEMPORAL_ADDRESS = "127.0.0.1:7233";
    process.env.FLUVIO_SERVICE_URL = "http://127.0.0.1:50055";
    process.env.LONGCAT_VOICE_GATEWAY_URL = "http://127.0.0.1:8104";
    process.env.LONGCAT_SPEECH_SERVICE_URL = "http://127.0.0.1:8105";

    fetchMock.mockImplementation(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const body =
        url === "http://127.0.0.1:9000/v1/schema"
          ? { routes: [] }
          : url === "http://127.0.0.1:9443/health"
            ? { status: "ok" }
            : url === process.env.OIDC_ISSUER_URL + "/.well-known/openid-configuration"
              ? { issuer: process.env.OIDC_ISSUER_URL, authorization_endpoint: "https://identity/auth", token_endpoint: "https://identity/token", jwks_uri: "https://identity/jwks" }
              : url === "http://127.0.0.1:3476/healthz"
                ? { status: "ok" }
                : url === "http://127.0.0.1:3500/v1.0/metadata"
                  ? { id: "dapr" }
                  : url === "http://127.0.0.1:9200/_cluster/health"
                    ? { status: "green" }
                    : url === "http://127.0.0.1:50055/health"
                      ? { status: "ok" }
                      : url === "http://127.0.0.1:8086/health"
                        ? { status: "ok" }
                        : url === "http://127.0.0.1:8087/health"
                          ? { status: "ok" }
                          : url === "http://127.0.0.1:8007/health"
                            ? { status: "ok" }
                            : url === "http://127.0.0.1:8088/health"
                              ? { status: "ok" }
                              : url === "http://127.0.0.1:8091/health"
                                ? { status: "ok" }
                                : url === "http://127.0.0.1:8104/health"
                                  ? { status: "ok", service: "longcat-voice-gateway", telephony_mode: "asterisk-audiosocket", speech_service_url: "http://127.0.0.1:8105" }
                                  : url === "http://127.0.0.1:8105/health"
                                    ? { status: "healthy", service: "longcat-speech-runtime", stt_engine: "faster-whisper", tts_engine: "piper", stt_ready: true, tts_ready: true }
                                    : null;
      if (!body) {
        return { ok: false, status: 404, text: async () => `unmocked ${url}`, headers: new Headers({ "content-type": "text/plain" }) };
      }
      return { ok: true, headers: new Headers({ "content-type": "application/json" }), json: async () => body };
    });

    socketConnectMock.mockImplementation(({ handlers }) => {
      handlers.connect?.();
    });

    const redisModule = await import("redis");
    vi.spyOn(redisModule, "createClient").mockReturnValue({
      connect: vi.fn().mockResolvedValue(undefined),
      ping: vi.fn().mockResolvedValue("PONG"),
      disconnect: vi.fn().mockResolvedValue(undefined),
    } as never);

    process.env.REDIS_URL = "redis://127.0.0.1:6379";

    const { getLiveIntegrationStatus } = await loadModule();
    const status = await getLiveIntegrationStatus();

    expect(status.edge.apisix.status).toBe("healthy");
    expect(status.edge.openAppSec.status).toBe("healthy");
    expect(status.identity.oidc.status).toBe("healthy");
    expect(status.identity.permify.status).toBe("healthy");
    expect(status.messaging.kafka.status).toBe("healthy");
    expect(status.messaging.kafka.details).toMatchObject({
      checked_broker: "127.0.0.1:9092",
      brokers: ["127.0.0.1:9092", "127.0.0.1:9093"],
      topic: "switchos.operational-events",
    });
    expect(status.messaging.redis.status).toBe("healthy");
    expect(status.messaging.dapr.status).toBe("healthy");
    expect(status.messaging.openSearch.status).toBe("healthy");
    expect(status.messaging.temporal.status).toBe("healthy");
    expect(status.messaging.temporal.details).toMatchObject({ protocol: "tcp" });
    expect(status.messaging.fluvio.status).toBe("healthy");
    expect(status.services.longcatVoiceGateway.status).toBe("healthy");
    expect(status.services.longcatSpeechRuntime.status).toBe("healthy");
    expect(status.services.longcatSpeechRuntime.details).toMatchObject({ stt_ready: true, tts_ready: true });
  });

  it("returns degraded results when configured services reject health checks", async () => {
    process.env.APISIX_ADMIN_URL = "http://127.0.0.1:9180";
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => "unavailable", headers: new Headers({ "content-type": "text/plain" }) });

    const { probeApisix } = await loadModule();
    const result = await probeApisix();

    expect(result.status).toBe("degraded");
    expect(result.error).toContain("503");
  });

  it("surfaces a degraded speech runtime when neither STT nor TTS engine is ready", async () => {
    process.env.LONGCAT_SPEECH_SERVICE_URL = "http://127.0.0.1:8105";
    fetchMock.mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => ({
        status: "degraded",
        service: "longcat-speech-runtime",
        stt_engine: "whisper.cpp",
        tts_engine: "piper",
        stt_ready: false,
        tts_ready: false,
        stt_runtime: { reason: "whisper_cpp_binary_or_model_missing" },
        tts_runtime: { reason: "piper_binary_or_model_missing" },
      }),
    });

    const { probeLongCatSpeechRuntime } = await loadModule();
    const result = await probeLongCatSpeechRuntime();

    expect(result.status).toBe("degraded");
    expect(result.details).toMatchObject({ stt_ready: false, tts_ready: false });
    expect(result.error).toContain("speech runtime reported status degraded");
  });
});
