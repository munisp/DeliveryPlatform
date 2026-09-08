import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  environment: {
    vehicleTrackerIngressEnabled: true,
    vehicleTrackerWebhookSecretsJson: JSON.stringify({
      fleet_tracker: {
        secret: "tracker-test-signing-secret-at-least-32-bytes",
        signature: "generic",
      },
    }),
    vehicleTrackerCommandDispatchEnabled: false,
    vehicleTrackerCommandAdapterUrl: "",
    vehicleTrackerCommandAdapterToken: "",
    isProduction: false,
  },
  tracker: {
    trackerId: "11111111-1111-4111-8111-111111111111",
    providerKind: "generic_webhook" as const,
  },
  ingested: [] as Array<Record<string, unknown>>,
  failedClaims: [] as Array<Record<string, unknown>>,
  command: {
    commandId: "22222222-2222-4222-8222-222222222222",
    controlCaseId: "33333333-3333-4333-8333-333333333333",
    claimToken: "44444444-4444-4444-8444-444444444444",
    trackerId: "11111111-1111-4111-8111-111111111111",
    providerKind: "generic_webhook" as const,
    externalDeviceId: "device-001",
  },
}));

vi.mock("../server/_core/env", () => ({ ENV: state.environment }));
vi.mock("../server/_core/vehicleAccess", () => ({
  resolveActiveVehicleTrackerForIngress: vi.fn(async () => state.tracker),
  ingestVehicleTrackerSignal: vi.fn(async (input) => {
    state.ingested.push(input);
    return "55555555-5555-4555-8555-555555555555";
  }),
  claimVehiclePreventNextStartCommand: vi.fn(async () => state.command),
  failClaimedVehiclePreventNextStartCommand: vi.fn(async (input) => {
    state.failedClaims.push(input);
    return "failed";
  }),
  markVehiclePreventNextStartDispatched: vi.fn(),
  completeVehiclePreventNextStartCommand: vi.fn(),
}));

import {
  dispatchOneVehiclePreventNextStartCommand,
  ingestSignedVehicleTrackerEvent,
  VehicleTrackerIntegrationError,
} from "../server/_core/vehicleTrackerIntegration";

function genericPayload() {
  return {
    eventId: "event-0001",
    deviceId: "device-001",
    kind: "position",
    observedAt: new Date().toISOString(),
    latitude: 6.5244,
    longitude: 3.3792,
    speedKph: 0,
    ignitionOn: false,
    integrityScore: 98,
  };
}

describe("vehicle tracker integration", () => {
  it("verifies the exact raw webhook body and records normalized immutable position evidence", async () => {
    const body = Buffer.from(JSON.stringify(genericPayload()));
    const signature = `sha256=${createHmac(
      "sha256",
      "tracker-test-signing-secret-at-least-32-bytes",
    )
      .update(body)
      .digest("hex")}`;

    const result = await ingestSignedVehicleTrackerEvent({
      integrationKey: "fleet_tracker",
      rawBody: body,
      parsedBody: JSON.parse(body.toString("utf8")),
      genericSignature: signature,
    });

    expect(result).toEqual({
      id: "55555555-5555-4555-8555-555555555555",
      accepted: true,
    });
    expect(state.ingested).toHaveLength(1);
    expect(state.ingested[0]).toMatchObject({
      trackerId: state.tracker.trackerId,
      externalEventId: "event-0001",
      signalKind: "position",
      latitude: 6.5244,
      longitude: 3.3792,
      speedKph: 0,
      ignitionOn: false,
      integrityScore: 98,
    });
    expect(state.ingested[0]?.payloadSha256Hex).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects a malformed signature before normalized tracker evidence is written", async () => {
    const body = Buffer.from(JSON.stringify(genericPayload()));
    await expect(
      ingestSignedVehicleTrackerEvent({
        integrationKey: "fleet_tracker",
        rawBody: body,
        parsedBody: JSON.parse(body.toString("utf8")),
        genericSignature: "sha256=bad",
      }),
    ).rejects.toEqual(
      new VehicleTrackerIntegrationError("vehicle_tracker_signature_invalid"),
    );
    expect(state.ingested).toHaveLength(1);
  });

  it("fails closed before network dispatch when no command adapter is explicitly enabled", async () => {
    const result = await dispatchOneVehiclePreventNextStartCommand({
      workerId: "tracker-test-worker",
    });

    expect(result).toEqual({
      outcome: "blocked",
      commandId: state.command.commandId,
    });
    expect(state.failedClaims).toEqual([
      {
        commandId: state.command.commandId,
        claimToken: state.command.claimToken,
        reason:
          "configured command adapter unavailable; no device command sent",
      },
    ]);
  });
});
