import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  environment: {
    isProduction: false,
    vehicleTrackerProviderConsumersEnabled: true,
    vehicleTrackerProviderPollIntervalMs: 60_000,
    vehicleTrackerGeotabCredentialsJson: JSON.stringify({
      "secrets/geotab/fleet": {
        api_url: "https://geotab.example.test/apiv1",
        database: "fleet_db",
        username: "deliveryplatform-service",
        password: "not-a-real-geotab-password",
        results_limit: 100,
      },
    }),
    vehicleTrackerTraccarCredentialsJson: JSON.stringify({
      "secrets/traccar/fleet": {
        api_url: "https://traccar.example.test/api",
        transport: "rest",
        auth_mode: "bearer",
        token: "traccar-test-token-at-least-16-chars",
      },
    }),
  },
  geotabCredentialRef: "secrets/geotab/fleet",
  claims: [] as Array<Record<string, unknown>>,
  completed: [] as Array<Record<string, unknown>>,
  released: [] as Array<Record<string, unknown>>,
  ingested: [] as Array<Record<string, unknown>>,
  bulk: [] as Array<Record<string, unknown>>,
}));

vi.mock("../server/_core/env", () => ({ ENV: state.environment }));
vi.mock("../server/_core/vehicleAccess", () => ({
  claimVehicleTrackerProviderIngest: vi.fn(async ({ providerKind }) => {
    if (providerKind === "geotab_feed") {
      return {
        trackerProviderId: "11111111-1111-4111-8111-111111111111",
        integrationKey: "geotab_fleet",
        credentialRef: state.geotabCredentialRef,
        providerKind: "geotab_feed",
        feedCursor: "0000000000000001",
        claimToken: "22222222-2222-4222-8222-222222222222",
      };
    }
    return {
      trackerProviderId: "33333333-3333-4333-8333-333333333333",
      integrationKey: "traccar_fleet",
      credentialRef: "secrets/traccar/fleet",
      providerKind: "traccar_rest",
      feedCursor: null,
      claimToken: "44444444-4444-4444-8444-444444444444",
    };
  }),
  bulkRecordVehicleTrackerProviderSignals: vi.fn(async (input) => {
    state.bulk.push(input);
    return {
      recorded: input.records.length,
      duplicates: 0,
      unknownDevices: 0,
      outcomes: input.records.map((record, index) => ({
        index: index + 1,
        external_event_id: record.externalEventId,
        outcome: "recorded",
      })),
    };
  }),
  completeVehicleTrackerProviderIngestBatch: vi.fn(async (input) => {
    state.completed.push(input);
    return input.nextCursor ?? "";
  }),
  releaseVehicleTrackerProviderIngestClaim: vi.fn(async (input) => {
    state.released.push(input);
  }),
  renewVehicleTrackerProviderIngestClaim: vi.fn(),
}));

import {
  pollOneGeotabGetFeed,
  pollOneTraccarRest,
  VehicleTrackerProviderConsumerError,
} from "../server/_core/vehicleTrackerProviderConsumers";

function response(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function resetState() {
  state.completed.length = 0;
  state.released.length = 0;
  state.ingested.length = 0;
  state.bulk.length = 0;
  state.environment.vehicleTrackerProviderConsumersEnabled = true;
  state.geotabCredentialRef = "secrets/geotab/fleet";
}

describe("vehicle tracker provider consumers", () => {
  it("authenticates a Geotab service account, uses the durable feed cursor, and commits only normalized records", async () => {
    resetState();
    let authenticationCalls = 0;
    let getFeedCalls = 0;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(`${init?.body ?? "{}"}`) as {
          method: string;
          params: Record<string, unknown>;
        };
        if (request.method === "Authenticate") {
          authenticationCalls += 1;
          expect(request.params).toMatchObject({
            database: "fleet_db",
            userName: "deliveryplatform-service",
            password: "not-a-real-geotab-password",
          });
          return response({
            jsonrpc: "2.0",
            result: {
              path: "ThisServer",
              credentials: {
                database: "fleet_db",
                userName: "deliveryplatform-service",
                sessionId: `geotab-session-token-${authenticationCalls}`,
              },
            },
          });
        }
        getFeedCalls += 1;
        expect(request.method).toBe("GetFeed");
        expect(request.params).toMatchObject({
          typeName: "LogRecord",
          fromVersion: "0000000000000001",
          resultsLimit: 100,
          credentials: { sessionId: `geotab-session-token-${getFeedCalls}` },
        });
        if (getFeedCalls === 1) {
          return response({
            jsonrpc: "2.0",
            error: { message: "session expired" },
          });
        }
        return response({
          jsonrpc: "2.0",
          result: {
            data: [
              {
                id: "log-record-0001",
                device: { id: "device-001" },
                dateTime: new Date().toISOString(),
                latitude: 6.5244,
                longitude: 3.3792,
                speed: 0,
                course: 180,
              },
            ],
            toVersion: "0000000000000002",
          },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollOneGeotabGetFeed({
      workerId: "geotab-test-worker",
    });

    expect(result).toMatchObject({
      outcome: "committed",
      records: 1,
      ingested: 1,
    });
    expect(state.bulk).toEqual([
      expect.objectContaining({
        source: "geotab_getfeed",
        records: [
          expect.objectContaining({
            externalDeviceId: "device-001",
            externalEventId: "geotab:log-record-0001",
            speedKph: 0,
            ignitionOn: null,
          }),
        ],
      }),
    ]);
    expect(authenticationCalls).toBe(2);
    expect(getFeedCalls).toBe(2);
    expect(state.completed).toEqual([
      expect.objectContaining({
        source: "geotab_getfeed",
        expectedCursor: "0000000000000001",
        nextCursor: "0000000000000002",
        recordCount: 1,
      }),
    ]);
  });

  it("splits a Geotab feed above the authority limit into bounded bulk calls before completing its cursor", async () => {
    resetState();
    state.geotabCredentialRef = "secrets/geotab/bounded-batch";
    const previousCredentials =
      state.environment.vehicleTrackerGeotabCredentialsJson;
    state.environment.vehicleTrackerGeotabCredentialsJson = JSON.stringify({
      "secrets/geotab/bounded-batch": {
        api_url: "https://geotab.example.test/apiv1",
        database: "fleet_db",
        username: "deliveryplatform-service",
        password: "not-a-real-geotab-password",
        results_limit: 250,
      },
    });
    const now = new Date().toISOString();
    const records = Array.from({ length: 251 }, (_, index) => ({
      id: `bulk-log-${index + 1}`,
      device: { id: "device-001" },
      dateTime: now,
      latitude: 6.5244,
      longitude: 3.3792,
      speed: 0,
      course: 180,
    }));
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(`${init?.body ?? "{}"}`) as {
          method: string;
        };
        if (request.method === "Authenticate") {
          return response({
            jsonrpc: "2.0",
            result: {
              path: "ThisServer",
              credentials: {
                database: "fleet_db",
                userName: "deliveryplatform-service",
                sessionId: "geotab-bounded-session",
              },
            },
          });
        }
        return response({
          jsonrpc: "2.0",
          result: { data: records, toVersion: "0000000000000251" },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await pollOneGeotabGetFeed({
        workerId: "geotab-bounded-batch-worker",
      });
      expect(result).toMatchObject({
        outcome: "committed",
        records: 251,
        ingested: 251,
      });
      expect(state.bulk).toHaveLength(2);
      expect(state.bulk.map((call) => call.records.length)).toEqual([250, 1]);
      expect(state.completed).toEqual([
        expect.objectContaining({ recordCount: 251 }),
      ]);
    } finally {
      state.environment.vehicleTrackerGeotabCredentialsJson =
        previousCredentials;
      state.geotabCredentialRef = "secrets/geotab/fleet";
    }
  });

  it("releases the matching Geotab lease without cursor completion when the refreshed session authentication also fails", async () => {
    resetState();
    state.geotabCredentialRef = "secrets/geotab/refresh-failure";
    const previousCredentials =
      state.environment.vehicleTrackerGeotabCredentialsJson;
    state.environment.vehicleTrackerGeotabCredentialsJson = JSON.stringify({
      "secrets/geotab/fleet":
        JSON.parse(previousCredentials)["secrets/geotab/fleet"],
      "secrets/geotab/refresh-failure": {
        api_url: "https://geotab.example.test/apiv1",
        database: "fleet_db",
        username: "deliveryplatform-service",
        password: "not-a-real-geotab-password",
        results_limit: 100,
      },
    });
    let authenticationCalls = 0;
    let getFeedCalls = 0;
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(`${init?.body ?? "{}"}`) as {
          method: string;
          params: Record<string, unknown>;
        };
        if (request.method === "Authenticate") {
          authenticationCalls += 1;
          if (authenticationCalls === 2) {
            return response({
              jsonrpc: "2.0",
              error: { message: "credential rejected" },
            });
          }
          return response({
            jsonrpc: "2.0",
            result: {
              path: "ThisServer",
              credentials: {
                database: "fleet_db",
                userName: "deliveryplatform-service",
                sessionId: "geotab-expired-session",
              },
            },
          });
        }
        getFeedCalls += 1;
        return response({
          jsonrpc: "2.0",
          error: { message: "session expired" },
        });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(
        pollOneGeotabGetFeed({ workerId: "geotab-refresh-failure-worker" }),
      ).rejects.toEqual(
        new VehicleTrackerProviderConsumerError(
          "vehicle_tracker_provider_authentication_failed",
        ),
      );
      expect(authenticationCalls).toBe(2);
      expect(getFeedCalls).toBe(1);
      expect(state.completed).toHaveLength(0);
      expect(state.released).toEqual([
        expect.objectContaining({
          trackerProviderId: "11111111-1111-4111-8111-111111111111",
          claimToken: "22222222-2222-4222-8222-222222222222",
          errorCode: "vehicle_tracker_provider_authentication_failed",
        }),
      ]);
    } finally {
      state.environment.vehicleTrackerGeotabCredentialsJson =
        previousCredentials;
      state.geotabCredentialRef = "secrets/geotab/fleet";
    }
  });

  it("uses Traccar bearer authentication and converts documented position speed from knots to km/h before authority ingestion", async () => {
    resetState();
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        expect(`${input}`).toBe("https://traccar.example.test/api/positions");
        expect(init?.headers).toMatchObject({
          authorization: "Bearer traccar-test-token-at-least-16-chars",
        });
        return response([
          {
            id: 12345,
            deviceId: 42,
            fixTime: new Date().toISOString(),
            latitude: 6.5244,
            longitude: 3.3792,
            speed: 10,
            course: 90,
            accuracy: 7,
            attributes: { ignition: false, odometer: 12345 },
          },
        ]);
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await pollOneTraccarRest({
      workerId: "traccar-test-worker",
    });

    expect(result).toMatchObject({
      outcome: "committed",
      records: 1,
      ingested: 1,
    });
    expect(state.bulk).toEqual([
      expect.objectContaining({
        source: "traccar_rest",
        records: [
          expect.objectContaining({
            externalDeviceId: "42",
            externalEventId: "traccar:12345",
            speedKph: 18.52,
            ignitionOn: false,
            odometerKm: 12.345,
          }),
        ],
      }),
    ]);
    expect(state.completed).toEqual([
      expect.objectContaining({
        source: "traccar_rest",
        expectedCursor: null,
        recordCount: 1,
      }),
    ]);
  });

  it("fails closed without claiming or contacting a provider when consumers are not explicitly enabled", async () => {
    resetState();
    state.environment.vehicleTrackerProviderConsumersEnabled = false;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(pollOneGeotabGetFeed()).rejects.toEqual(
      new VehicleTrackerProviderConsumerError(
        "vehicle_tracker_provider_consumers_disabled",
      ),
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.completed).toHaveLength(0);
  });
});
