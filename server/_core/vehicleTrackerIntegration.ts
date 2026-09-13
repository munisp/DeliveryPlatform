import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";

import { ENV } from "./env";
import {
  claimVehiclePreventNextStartCommand,
  completeVehiclePreventNextStartCommand,
  failClaimedVehiclePreventNextStartCommand,
  ingestVehicleTrackerSignal,
  markVehiclePreventNextStartDispatched,
  resolveActiveVehicleTrackerForIngress,
  type VehicleTrackerSignalKind,
} from "./vehicleAccess";

export class VehicleTrackerIntegrationError extends Error {
  constructor(
    public readonly code:
      | "vehicle_tracker_ingress_disabled"
      | "vehicle_tracker_webhook_secret_unavailable"
      | "vehicle_tracker_signature_invalid"
      | "vehicle_tracker_timestamp_invalid"
      | "vehicle_tracker_payload_invalid"
      | "vehicle_tracker_command_adapter_unavailable"
      | "vehicle_tracker_command_adapter_invalid_response",
  ) {
    super(code);
  }
}

type WebhookSecret = { secret: string; signature?: "generic" | "samsara_v1" };
type NormalizedTrackerEvent = {
  externalDeviceId: string;
  externalEventId: string;
  signalKind: VehicleTrackerSignalKind;
  observedAt: string;
  latitude?: number | null;
  longitude?: number | null;
  speedKph?: number | null;
  headingDegrees?: number | null;
  accuracyM?: number | null;
  odometerKm?: number | null;
  ignitionOn?: boolean | null;
  integrityScore: number;
  normalizedPayload: Record<string, unknown>;
};

function text(value: unknown, name: string, min: number, max: number) {
  const normalized = `${value ?? ""}`.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new VehicleTrackerIntegrationError("vehicle_tracker_payload_invalid");
  }
  return normalized;
}

function finite(
  value: unknown,
  min: number,
  max: number,
  fallback: number | null = null,
) {
  if (value === null || value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new VehicleTrackerIntegrationError("vehicle_tracker_payload_invalid");
  }
  return parsed;
}

function optionalBoolean(value: unknown) {
  if (value === null || value === undefined || value === "") return null;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new VehicleTrackerIntegrationError("vehicle_tracker_payload_invalid");
}

function isoTimestamp(value: unknown) {
  const numeric =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim())
        ? Number(value)
        : null;
  const milliseconds =
    numeric === null || !Number.isFinite(numeric)
      ? null
      : numeric >= 1_000_000_000_000
        ? numeric
        : numeric >= 1_000_000_000
          ? numeric * 1_000
          : null;
  const parsed = milliseconds === null ? new Date(`${value ?? ""}`) : new Date(milliseconds);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getTime() > Date.now() + 60_000 ||
    parsed.getTime() < Date.now() - 31 * 24 * 60 * 60 * 1000
  ) {
    throw new VehicleTrackerIntegrationError("vehicle_tracker_payload_invalid");
  }
  return parsed.toISOString();
}

function normalizeKind(value: unknown): VehicleTrackerSignalKind {
  const normalized = `${value ?? ""}`.trim().toLowerCase();
  if (
    [
      "position",
      "engine",
      "tamper",
      "emergency",
      "provider_geofence",
      "command_ack",
    ].includes(normalized)
  ) {
    return normalized as VehicleTrackerSignalKind;
  }
  throw new VehicleTrackerIntegrationError("vehicle_tracker_payload_invalid");
}

function parseSecrets(): Record<string, WebhookSecret> {
  if (!ENV.vehicleTrackerWebhookSecretsJson) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(ENV.vehicleTrackerWebhookSecretsJson);
  } catch {
    throw new VehicleTrackerIntegrationError(
      "vehicle_tracker_webhook_secret_unavailable",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new VehicleTrackerIntegrationError(
      "vehicle_tracker_webhook_secret_unavailable",
    );
  }
  const result: Record<string, WebhookSecret> = {};
  for (const [key, raw] of Object.entries(parsed)) {
    if (
      !/^[a-z][a-z0-9_.-]{2,80}$/.test(key) ||
      !raw ||
      typeof raw !== "object" ||
      Array.isArray(raw)
    ) {
      throw new VehicleTrackerIntegrationError(
        "vehicle_tracker_webhook_secret_unavailable",
      );
    }
    const candidate = raw as Record<string, unknown>;
    const secret = `${candidate.secret ?? ""}`.trim();
    const signature = candidate.signature;
    if (
      secret.length < 16 ||
      (signature !== undefined &&
        signature !== "generic" &&
        signature !== "samsara_v1")
    ) {
      throw new VehicleTrackerIntegrationError(
        "vehicle_tracker_webhook_secret_unavailable",
      );
    }
    result[key] = {
      secret,
      signature: signature as WebhookSecret["signature"],
    };
  }
  return result;
}

function equalHexSignature(received: string, expected: string) {
  const normalized = received.trim();
  const left = Buffer.from(normalized, "utf8");
  const right = Buffer.from(expected, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

function verifyGenericSignature(
  rawBody: Buffer,
  signature: string,
  secret: string,
) {
  const expected = `sha256=${createHmac("sha256", secret)
    .update(rawBody)
    .digest("hex")}`;
  return equalHexSignature(signature, expected);
}

function verifySamsaraV1Signature(
  rawBody: Buffer,
  timestamp: string,
  signature: string,
  base64Secret: string,
) {
  if (!/^\d{10}$/.test(timestamp)) return false;
  const timestampMs = Number(timestamp) * 1_000;
  if (Math.abs(Date.now() - timestampMs) > 5 * 60 * 1_000) return false;
  let secret: Buffer;
  try {
    secret = Buffer.from(base64Secret, "base64");
  } catch {
    return false;
  }
  if (secret.length < 16) return false;
  const expected = `v1=${createHmac("sha256", secret)
    .update(Buffer.concat([Buffer.from(`v1:${timestamp}:`), rawBody]))
    .digest("hex")}`;
  return equalHexSignature(signature, expected);
}

function asRecord(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VehicleTrackerIntegrationError("vehicle_tracker_payload_invalid");
  }
  return value as Record<string, unknown>;
}

function normalizeGenericEvent(
  payload: Record<string, unknown>,
): NormalizedTrackerEvent {
  const location =
    payload.location === undefined ? {} : asRecord(payload.location);
  const signalKind = normalizeKind(payload.kind ?? payload.signalKind);
  const latitude = finite(payload.latitude ?? location.latitude, -90, 90);
  const longitude = finite(payload.longitude ?? location.longitude, -180, 180);
  if ((latitude === null) !== (longitude === null)) {
    throw new VehicleTrackerIntegrationError("vehicle_tracker_payload_invalid");
  }
  if (signalKind === "position" && latitude === null) {
    throw new VehicleTrackerIntegrationError("vehicle_tracker_payload_invalid");
  }
  return {
    externalDeviceId: text(
      payload.deviceId ?? payload.device_id,
      "device_id",
      3,
      160,
    ),
    externalEventId: text(
      payload.eventId ?? payload.event_id,
      "event_id",
      8,
      160,
    ),
    signalKind,
    observedAt: isoTimestamp(payload.observedAt ?? payload.observed_at),
    latitude,
    longitude,
    speedKph: finite(payload.speedKph ?? payload.speed_kph, 0, 400),
    headingDegrees: finite(
      payload.headingDegrees ?? payload.heading_degrees,
      0,
      359.999,
    ),
    accuracyM: finite(payload.accuracyM ?? payload.accuracy_m, 0, 100_000),
    odometerKm: finite(
      payload.odometerKm ?? payload.odometer_km,
      0,
      10_000_000,
    ),
    ignitionOn: optionalBoolean(payload.ignitionOn ?? payload.ignition_on),
    integrityScore: finite(
      payload.integrityScore ?? payload.integrity_score,
      0,
      100,
      100,
    )!,
    normalizedPayload: payload,
  };
}

function normalizeSamsaraEvent(
  payload: Record<string, unknown>,
): NormalizedTrackerEvent {
  const event = asRecord(payload.event);
  const device = asRecord(event.device);
  const condition = `${event.alertConditionId ?? ""}`.trim();
  const signalKind: VehicleTrackerSignalKind =
    condition === "DeviceLocationInsideGeofence" ||
    condition === "DeviceLocationOutsideGeofence"
      ? "provider_geofence"
      : condition.toLowerCase().includes("tamper")
        ? "tamper"
        : condition.toLowerCase().includes("panic") ||
            condition.toLowerCase().includes("emergency")
          ? "emergency"
          : "engine";
  return {
    externalDeviceId: text(device.id ?? device.serial, "device_id", 3, 160),
    externalEventId: text(payload.eventId, "event_id", 8, 160),
    signalKind,
    observedAt: isoTimestamp(Number(payload.eventMs) || payload.eventMs),
    integrityScore: 100,
    normalizedPayload: payload,
  };
}

function normalizeTrackerEvent(
  providerKind: string,
  payload: Record<string, unknown>,
): NormalizedTrackerEvent {
  if (providerKind === "samsara_webhook") return normalizeSamsaraEvent(payload);
  return normalizeGenericEvent(payload);
}

export async function ingestSignedVehicleTrackerEvent(input: {
  integrationKey: string;
  rawBody: Buffer;
  parsedBody: unknown;
  genericSignature?: string;
  samsaraSignature?: string;
  samsaraTimestamp?: string;
}) {
  if (!ENV.vehicleTrackerIngressEnabled) {
    throw new VehicleTrackerIntegrationError(
      "vehicle_tracker_ingress_disabled",
    );
  }
  if (!input.rawBody.length) {
    throw new VehicleTrackerIntegrationError("vehicle_tracker_payload_invalid");
  }
  const integrationKey = text(input.integrationKey, "integration_key", 3, 81);
  const secret = parseSecrets()[integrationKey];
  if (!secret) {
    throw new VehicleTrackerIntegrationError(
      "vehicle_tracker_webhook_secret_unavailable",
    );
  }
  const payload = asRecord(input.parsedBody);
  const unresolvedDeviceId =
    payload.deviceId ??
    payload.device_id ??
    (payload.event && typeof payload.event === "object"
      ? (payload.event as Record<string, unknown>).device &&
        typeof (payload.event as Record<string, unknown>).device === "object"
        ? ((
            (payload.event as Record<string, unknown>).device as Record<
              string,
              unknown
            >
          ).id ??
          (
            (payload.event as Record<string, unknown>).device as Record<
              string,
              unknown
            >
          ).serial)
        : undefined
      : undefined);
  const tracker = await resolveActiveVehicleTrackerForIngress({
    integrationKey,
    externalDeviceId: text(unresolvedDeviceId, "device_id", 3, 160),
  });
  if (!tracker) {
    throw new VehicleTrackerIntegrationError("vehicle_tracker_payload_invalid");
  }
  const signatureMode =
    secret.signature ??
    (tracker.providerKind === "samsara_webhook" ? "samsara_v1" : "generic");
  const valid =
    signatureMode === "samsara_v1"
      ? verifySamsaraV1Signature(
          input.rawBody,
          input.samsaraTimestamp ?? "",
          input.samsaraSignature ?? "",
          secret.secret,
        )
      : verifyGenericSignature(
          input.rawBody,
          input.genericSignature ?? "",
          secret.secret,
        );
  if (!valid) {
    throw new VehicleTrackerIntegrationError(
      "vehicle_tracker_signature_invalid",
    );
  }
  const event = normalizeTrackerEvent(tracker.providerKind, payload);
  if (event.externalDeviceId !== `${unresolvedDeviceId}`.trim()) {
    throw new VehicleTrackerIntegrationError("vehicle_tracker_payload_invalid");
  }
  const id = await ingestVehicleTrackerSignal({
    trackerId: tracker.trackerId,
    externalEventId: event.externalEventId,
    signalKind: event.signalKind,
    observedAt: event.observedAt,
    latitude: event.latitude,
    longitude: event.longitude,
    speedKph: event.speedKph,
    headingDegrees: event.headingDegrees,
    accuracyM: event.accuracyM,
    odometerKm: event.odometerKm,
    ignitionOn: event.ignitionOn,
    integrityScore: event.integrityScore,
    payloadSha256Hex: createHash("sha256").update(input.rawBody).digest("hex"),
    normalizedPayload: event.normalizedPayload,
  });
  return { id, accepted: true };
}

function controlledCommandAdapterUrl() {
  if (
    !ENV.vehicleTrackerCommandDispatchEnabled ||
    !ENV.vehicleTrackerCommandAdapterUrl ||
    !ENV.vehicleTrackerCommandAdapterToken
  ) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(ENV.vehicleTrackerCommandAdapterUrl);
  } catch {
    return null;
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && (ENV.isProduction || !loopback))
  ) {
    return null;
  }
  url.pathname = `${url.pathname.replace(/\/$/, "")}/v1/commands/prevent-next-start`;
  return url;
}

function responseDigest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function responseReason(value: unknown, fallback: string) {
  const normalized = `${value ?? ""}`.trim();
  return normalized.length >= 3 && normalized.length <= 1_000
    ? normalized
    : fallback;
}

export async function dispatchOneVehiclePreventNextStartCommand(input: {
  workerId?: string;
}) {
  const workerId =
    input.workerId?.trim() || `vehicle-tracker-adapter-${randomUUID()}`;
  const claimed = await claimVehiclePreventNextStartCommand({ workerId });
  if (!claimed) return { outcome: "empty" as const };
  const endpoint = controlledCommandAdapterUrl();
  if (!endpoint) {
    await failClaimedVehiclePreventNextStartCommand({
      commandId: claimed.commandId,
      claimToken: claimed.claimToken,
      reason: "configured command adapter unavailable; no device command sent",
    });
    return { outcome: "blocked" as const, commandId: claimed.commandId };
  }
  await markVehiclePreventNextStartDispatched({
    commandId: claimed.commandId,
    claimToken: claimed.claimToken,
    providerCommandId: claimed.commandId,
  });
  const requestBody = JSON.stringify({
    command_id: claimed.commandId,
    action: "prevent_next_start",
    tracker_id: claimed.trackerId,
    provider_kind: claimed.providerKind,
    external_device_id: claimed.externalDeviceId,
  });
  let response: Response;
  let rawResponse = "";
  try {
    response = await fetch(endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        authorization: `Bearer ${ENV.vehicleTrackerCommandAdapterToken}`,
        "content-type": "application/json",
        "idempotency-key": claimed.commandId,
      },
      body: requestBody,
      signal: AbortSignal.timeout(8_000),
    });
    rawResponse = await response.text();
  } catch {
    // The provider may have received the command even when this request times out.
    // Leave the command dispatched and never retry automatically.
    return { outcome: "uncertain" as const, commandId: claimed.commandId };
  }
  if (!response.ok) {
    await completeVehiclePreventNextStartCommand({
      commandId: claimed.commandId,
      claimToken: claimed.claimToken,
      success: false,
      acknowledgementSha256Hex: responseDigest(rawResponse),
      reason: `adapter rejected prevent-next-start command with HTTP ${response.status}`,
    });
    return {
      outcome: "rejected" as const,
      commandId: claimed.commandId,
      status: response.status,
    };
  }
  let body: unknown;
  try {
    body = JSON.parse(rawResponse);
  } catch {
    return { outcome: "dispatched" as const, commandId: claimed.commandId };
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { outcome: "dispatched" as const, commandId: claimed.commandId };
  }
  const acknowledgement = body as Record<string, unknown>;
  if (acknowledgement.acknowledged !== true) {
    return { outcome: "dispatched" as const, commandId: claimed.commandId };
  }
  const acknowledgementSha256Hex = `${
    acknowledgement.acknowledgement_sha256_hex ?? ""
  }`.trim();
  if (!/^[a-f0-9]{64}$/.test(acknowledgementSha256Hex)) {
    throw new VehicleTrackerIntegrationError(
      "vehicle_tracker_command_adapter_invalid_response",
    );
  }
  const state = await completeVehiclePreventNextStartCommand({
    commandId: claimed.commandId,
    claimToken: claimed.claimToken,
    success: true,
    acknowledgementSha256Hex,
    reason: responseReason(
      acknowledgement.acknowledgement_reason,
      "adapter acknowledged prevent-next-start command",
    ),
  });
  return { outcome: state, commandId: claimed.commandId };
}
