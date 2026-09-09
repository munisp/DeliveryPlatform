import { createHash, randomUUID } from "node:crypto";
import WebSocket from "ws";

import { ENV } from "./env";
import { vehicleTrackerMetrics } from "./vehicleTrackerMetrics";
import {
  bulkRecordVehicleTrackerProviderSignals,
  claimVehicleTrackerProviderIngest,
  completeVehicleTrackerProviderIngestBatch,
  releaseVehicleTrackerProviderIngestClaim,
  renewVehicleTrackerProviderIngestClaim,
  type BulkVehicleTrackerSignalInput,
  type ClaimedVehicleTrackerProviderIngest,
  type VehicleTrackerIngestSource,
} from "./vehicleAccess";

export class VehicleTrackerProviderConsumerError extends Error {
  constructor(
    public readonly code:
      | "vehicle_tracker_provider_consumers_disabled"
      | "vehicle_tracker_provider_credentials_unavailable"
      | "vehicle_tracker_provider_credentials_invalid"
      | "vehicle_tracker_provider_url_invalid"
      | "vehicle_tracker_provider_authentication_failed"
      | "vehicle_tracker_provider_response_invalid"
      | "vehicle_tracker_provider_transport_failed",
  ) {
    super(code);
  }
}

type GeotabCredentials = {
  apiUrl: string;
  database: string;
  username: string;
  password: string;
  resultsLimit: number;
};

type TraccarCredentials = {
  apiUrl: string;
  transport: "rest" | "websocket";
  auth:
    | { mode: "bearer"; token: string }
    | { mode: "basic"; username: string; password: string };
  websocketEmail?: string;
  websocketPassword?: string;
};

type GeotabSession = {
  credentials: Record<string, string>;
  apiUrl: string;
};

type RecordValue = Record<string, unknown>;

const geotabSessions = new Map<string, GeotabSession>();
const traccarSockets = new Map<string, { close: () => void }>();
let providerDispatchInFlight = false;

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function asRecord(
  value: unknown,
  code: VehicleTrackerProviderConsumerError["code"],
) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new VehicleTrackerProviderConsumerError(code);
  }
  return value as RecordValue;
}

function text(
  value: unknown,
  min: number,
  max: number,
  code: VehicleTrackerProviderConsumerError["code"],
) {
  const normalized = `${value ?? ""}`.trim();
  if (normalized.length < min || normalized.length > max) {
    throw new VehicleTrackerProviderConsumerError(code);
  }
  return normalized;
}

function number(
  value: unknown,
  min: number,
  max: number,
  fallback: number | null = null,
) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new VehicleTrackerProviderConsumerError(
      "vehicle_tracker_provider_response_invalid",
    );
  }
  return parsed;
}

function isoTimestamp(value: unknown) {
  const parsed = new Date(`${value ?? ""}`);
  if (
    Number.isNaN(parsed.getTime()) ||
    parsed.getTime() > Date.now() + 60_000 ||
    parsed.getTime() < Date.now() - 31 * 24 * 60 * 60 * 1000
  ) {
    throw new VehicleTrackerProviderConsumerError(
      "vehicle_tracker_provider_response_invalid",
    );
  }
  return parsed.toISOString();
}

function optionalBoolean(value: unknown) {
  if (value === undefined || value === null || value === "") return null;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new VehicleTrackerProviderConsumerError(
    "vehicle_tracker_provider_response_invalid",
  );
}

function safeApiUrl(value: unknown, requiredPath: string) {
  let url: URL;
  try {
    url = new URL(`${value ?? ""}`.trim());
  } catch {
    throw new VehicleTrackerProviderConsumerError(
      "vehicle_tracker_provider_url_invalid",
    );
  }
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
  if (
    url.username ||
    url.password ||
    (url.protocol !== "https:" && (ENV.isProduction || !loopback)) ||
    !url.pathname.replace(/\/$/, "").endsWith(requiredPath)
  ) {
    throw new VehicleTrackerProviderConsumerError(
      "vehicle_tracker_provider_url_invalid",
    );
  }
  url.search = "";
  url.hash = "";
  return url;
}

function parseCredentialMap(raw: string) {
  if (!raw) return new Map<string, RecordValue>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new VehicleTrackerProviderConsumerError(
      "vehicle_tracker_provider_credentials_invalid",
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new VehicleTrackerProviderConsumerError(
      "vehicle_tracker_provider_credentials_invalid",
    );
  }
  const entries = new Map<string, RecordValue>();
  for (const [reference, value] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]{7,160}$/.test(reference)) {
      throw new VehicleTrackerProviderConsumerError(
        "vehicle_tracker_provider_credentials_invalid",
      );
    }
    entries.set(
      reference,
      asRecord(value, "vehicle_tracker_provider_credentials_invalid"),
    );
  }
  return entries;
}

function geotabCredentials(reference: string): GeotabCredentials {
  const value = parseCredentialMap(ENV.vehicleTrackerGeotabCredentialsJson).get(
    reference,
  );
  if (!value) {
    throw new VehicleTrackerProviderConsumerError(
      "vehicle_tracker_provider_credentials_unavailable",
    );
  }
  const resultsLimit = number(value.results_limit ?? 5_000, 1, 50_000);
  return {
    apiUrl: safeApiUrl(value.api_url, "/apiv1").toString(),
    database: text(
      value.database,
      1,
      160,
      "vehicle_tracker_provider_credentials_invalid",
    ),
    username: text(
      value.username,
      1,
      320,
      "vehicle_tracker_provider_credentials_invalid",
    ),
    password: text(
      value.password,
      8,
      4096,
      "vehicle_tracker_provider_credentials_invalid",
    ),
    resultsLimit: resultsLimit!,
  };
}

function traccarCredentials(reference: string): TraccarCredentials {
  const value = parseCredentialMap(
    ENV.vehicleTrackerTraccarCredentialsJson,
  ).get(reference);
  if (!value) {
    throw new VehicleTrackerProviderConsumerError(
      "vehicle_tracker_provider_credentials_unavailable",
    );
  }
  const transport = `${value.transport ?? "rest"}`.trim();
  if (transport !== "rest" && transport !== "websocket") {
    throw new VehicleTrackerProviderConsumerError(
      "vehicle_tracker_provider_credentials_invalid",
    );
  }
  const apiUrl = safeApiUrl(value.api_url, "/api").toString();
  const authMode = `${value.auth_mode ?? "bearer"}`.trim();
  const auth =
    authMode === "bearer"
      ? {
          mode: "bearer" as const,
          token: text(
            value.token,
            16,
            4096,
            "vehicle_tracker_provider_credentials_invalid",
          ),
        }
      : authMode === "basic"
        ? {
            mode: "basic" as const,
            username: text(
              value.username,
              1,
              320,
              "vehicle_tracker_provider_credentials_invalid",
            ),
            password: text(
              value.password,
              1,
              4096,
              "vehicle_tracker_provider_credentials_invalid",
            ),
          }
        : null;
  if (!auth) {
    throw new VehicleTrackerProviderConsumerError(
      "vehicle_tracker_provider_credentials_invalid",
    );
  }
  const websocketEmail =
    value.websocket_email === undefined
      ? undefined
      : text(
          value.websocket_email,
          3,
          320,
          "vehicle_tracker_provider_credentials_invalid",
        );
  const websocketPassword =
    value.websocket_password === undefined
      ? undefined
      : text(
          value.websocket_password,
          1,
          4096,
          "vehicle_tracker_provider_credentials_invalid",
        );
  if (transport === "websocket" && (!websocketEmail || !websocketPassword)) {
    throw new VehicleTrackerProviderConsumerError(
      "vehicle_tracker_provider_credentials_invalid",
    );
  }
  return { apiUrl, transport, auth, websocketEmail, websocketPassword };
}

function authorizationHeader(credentials: TraccarCredentials) {
  return credentials.auth.mode === "bearer"
    ? `Bearer ${credentials.auth.token}`
    : `Basic ${Buffer.from(`${credentials.auth.username}:${credentials.auth.password}`).toString("base64")}`;
}

async function fetchJson(url: URL, init: RequestInit) {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new VehicleTrackerProviderConsumerError(
      "vehicle_tracker_provider_transport_failed",
    );
  }
  if (!response.ok) {
    throw new VehicleTrackerProviderConsumerError(
      response.status === 401 || response.status === 403
        ? "vehicle_tracker_provider_authentication_failed"
        : "vehicle_tracker_provider_transport_failed",
    );
  }
  const raw = Buffer.from(await response.arrayBuffer());
  try {
    return { raw, body: JSON.parse(raw.toString("utf8")) };
  } catch {
    throw new VehicleTrackerProviderConsumerError(
      "vehicle_tracker_provider_response_invalid",
    );
  }
}

async function geotabRpc(apiUrl: string, method: string, params: RecordValue) {
  const request = JSON.stringify({
    jsonrpc: "2.0",
    method,
    params,
    id: randomUUID(),
  });
  const { body } = await fetchJson(new URL(apiUrl), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: request,
  });
  const response = asRecord(body, "vehicle_tracker_provider_response_invalid");
  if (response.error) {
    const error = asRecord(
      response.error,
      "vehicle_tracker_provider_response_invalid",
    );
    const message = `${error.message ?? ""}`.toLowerCase();
    if (
      message.includes("login") ||
      message.includes("session") ||
      message.includes("credential")
    ) {
      throw new VehicleTrackerProviderConsumerError(
        "vehicle_tracker_provider_authentication_failed",
      );
    }
    throw new VehicleTrackerProviderConsumerError(
      "vehicle_tracker_provider_response_invalid",
    );
  }
  return response.result;
}

async function getGeotabSession(reference: string, config: GeotabCredentials) {
  const cached = geotabSessions.get(reference);
  if (cached) return cached;
  const result = asRecord(
    await geotabRpc(config.apiUrl, "Authenticate", {
      database: config.database,
      userName: config.username,
      password: config.password,
    }),
    "vehicle_tracker_provider_authentication_failed",
  );
  const credentials = asRecord(
    result.credentials,
    "vehicle_tracker_provider_authentication_failed",
  );
  const sessionId = text(
    credentials.sessionId,
    8,
    4096,
    "vehicle_tracker_provider_authentication_failed",
  );
  const database = text(
    credentials.database,
    1,
    160,
    "vehicle_tracker_provider_authentication_failed",
  );
  const userName = text(
    credentials.userName,
    1,
    320,
    "vehicle_tracker_provider_authentication_failed",
  );
  const path = `${result.path ?? "ThisServer"}`.trim();
  const apiUrl =
    path === "ThisServer"
      ? config.apiUrl
      : safeApiUrl(path, "/apiv1").toString();
  const session = { credentials: { database, userName, sessionId }, apiUrl };
  geotabSessions.set(reference, session);
  return session;
}

function providerEventId(prefix: string, value: unknown, payload: RecordValue) {
  const candidate = `${value ?? ""}`.trim();
  const identity = candidate || sha256(JSON.stringify(payload));
  return `${prefix}:${identity}`.slice(0, 160);
}

const TRACKER_BULK_RECORD_LIMIT = 250;

function chunks<T>(values: T[], size: number) {
  const result: T[][] = [];
  for (let start = 0; start < values.length; start += size) {
    result.push(values.slice(start, start + size));
  }
  return result;
}

async function persistProviderPositions(input: {
  provider: ClaimedVehicleTrackerProviderIngest;
  source: VehicleTrackerIngestSource;
  positions: BulkVehicleTrackerSignalInput[];
}) {
  let persisted = 0;
  for (const records of chunks(input.positions, TRACKER_BULK_RECORD_LIMIT)) {
    await renewVehicleTrackerProviderIngestClaim({
      trackerProviderId: input.provider.trackerProviderId,
      claimToken: input.provider.claimToken,
    });
    const result = await bulkRecordVehicleTrackerProviderSignals({
      trackerProviderId: input.provider.trackerProviderId,
      claimToken: input.provider.claimToken,
      source: input.source,
      records,
    });
    persisted += result.recorded + result.duplicates;
    vehicleTrackerMetrics.observeRecords(
      input.provider.providerKind,
      "recorded",
      result.recorded,
    );
    vehicleTrackerMetrics.observeRecords(
      input.provider.providerKind,
      "duplicate",
      result.duplicates,
    );
    vehicleTrackerMetrics.observeRecords(
      input.provider.providerKind,
      "unknown_device",
      result.unknownDevices,
    );
  }
  return persisted;
}

async function persistGeotabRecords(
  provider: ClaimedVehicleTrackerProviderIngest,
  records: unknown[],
) {
  const positions: BulkVehicleTrackerSignalInput[] = [];
  for (const raw of records) {
    const record = asRecord(raw, "vehicle_tracker_provider_response_invalid");
    const device = asRecord(
      record.device ?? { id: record.deviceId },
      "vehicle_tracker_provider_response_invalid",
    );
    const externalDeviceId = `${device.id ?? record.deviceId ?? ""}`.trim();
    if (!externalDeviceId) continue;
    const latitude = number(record.latitude, -90, 90);
    const longitude = number(record.longitude, -180, 180);
    if (latitude === null || longitude === null) continue;
    positions.push({
      externalDeviceId,
      externalEventId: providerEventId("geotab", record.id, record),
      observedAt: isoTimestamp(record.dateTime ?? record.date),
      signalKind: "position",
      latitude,
      longitude,
      speedKph: number(record.speed, 0, 400),
      headingDegrees: number(record.course, 0, 359.999),
      accuracyM: null,
      odometerKm: null,
      // LogRecord does not prove ignition state. Null deliberately keeps prevent-next-start fail-closed.
      ignitionOn: null,
      integrityScore: 80,
      payloadSha256Hex: sha256(JSON.stringify(record)),
      normalizedPayload: record,
    });
  }
  return persistProviderPositions({
    provider,
    source: "geotab_getfeed",
    positions,
  });
}

async function persistTraccarPositions(
  provider: ClaimedVehicleTrackerProviderIngest,
  source: "traccar_rest" | "traccar_websocket",
  rawPositions: unknown[],
) {
  const positions: BulkVehicleTrackerSignalInput[] = [];
  for (const raw of rawPositions) {
    const position = asRecord(raw, "vehicle_tracker_provider_response_invalid");
    const attributes =
      position.attributes === undefined
        ? {}
        : asRecord(
            position.attributes,
            "vehicle_tracker_provider_response_invalid",
          );
    const externalDeviceId = text(
      position.deviceId,
      1,
      160,
      "vehicle_tracker_provider_response_invalid",
    );
    const latitude = number(position.latitude, -90, 90);
    const longitude = number(position.longitude, -180, 180);
    if (latitude === null || longitude === null) continue;
    positions.push({
      externalDeviceId,
      externalEventId: providerEventId("traccar", position.id, position),
      observedAt: isoTimestamp(
        position.fixTime ?? position.deviceTime ?? position.serverTime,
      ),
      signalKind: "position",
      latitude,
      longitude,
      // Traccar Position.speed is expressed in knots; PostgreSQL authority stores km/h.
      speedKph: (() => {
        const speedKnots = number(position.speed, 0, 216);
        return speedKnots === null ? null : speedKnots * 1.852;
      })(),
      headingDegrees: number(position.course, 0, 359.999),
      accuracyM: number(position.accuracy, 0, 100_000),
      odometerKm: (() => {
        const odometerMeters = number(attributes.odometer, 0, 10_000_000_000);
        return odometerMeters === null ? null : odometerMeters / 1_000;
      })(),
      ignitionOn: optionalBoolean(attributes.ignition),
      integrityScore: 80,
      payloadSha256Hex: sha256(JSON.stringify(position)),
      normalizedPayload: position,
    });
  }
  return persistProviderPositions({ provider, source, positions });
}

async function releaseProviderClaim(
  provider: ClaimedVehicleTrackerProviderIngest,
  error: unknown,
) {
  const code =
    error instanceof VehicleTrackerProviderConsumerError
      ? error.code
      : "vehicle_tracker_provider_transport_failed";
  try {
    await releaseVehicleTrackerProviderIngestClaim({
      trackerProviderId: provider.trackerProviderId,
      claimToken: provider.claimToken,
      errorCode: code,
    });
  } catch {
    // The claim may have expired or been released by an earlier durable completion.
  }
}

export async function pollOneGeotabGetFeed(input: { workerId?: string } = {}) {
  if (!ENV.vehicleTrackerProviderConsumersEnabled) {
    throw new VehicleTrackerProviderConsumerError(
      "vehicle_tracker_provider_consumers_disabled",
    );
  }
  const provider = await claimVehicleTrackerProviderIngest({
    providerKind: "geotab_feed",
    workerId: input.workerId?.trim() || `geotab-feed-${randomUUID()}`,
  });
  if (!provider) return { outcome: "empty" as const };
  try {
    const config = geotabCredentials(provider.credentialRef);
    let session = await getGeotabSession(provider.credentialRef, config);
    let result: RecordValue;
    try {
      result = asRecord(
        await geotabRpc(session.apiUrl, "GetFeed", {
          typeName: "LogRecord",
          resultsLimit: config.resultsLimit,
          ...(provider.feedCursor ? { fromVersion: provider.feedCursor } : {}),
          credentials: session.credentials,
        }),
        "vehicle_tracker_provider_response_invalid",
      );
    } catch (error) {
      if (
        !(error instanceof VehicleTrackerProviderConsumerError) ||
        error.code !== "vehicle_tracker_provider_authentication_failed"
      ) {
        throw error;
      }
      geotabSessions.delete(provider.credentialRef);
      session = await getGeotabSession(provider.credentialRef, config);
      result = asRecord(
        await geotabRpc(session.apiUrl, "GetFeed", {
          typeName: "LogRecord",
          resultsLimit: config.resultsLimit,
          ...(provider.feedCursor ? { fromVersion: provider.feedCursor } : {}),
          credentials: session.credentials,
        }),
        "vehicle_tracker_provider_response_invalid",
      );
    }
    const records = Array.isArray(result.data) ? result.data : null;
    const nextCursor = text(
      result.toVersion,
      1,
      512,
      "vehicle_tracker_provider_response_invalid",
    );
    if (!records)
      throw new VehicleTrackerProviderConsumerError(
        "vehicle_tracker_provider_response_invalid",
      );
    const ingested = await persistGeotabRecords(provider, records);
    const raw = JSON.stringify(result);
    const batchKey = `geotab-${sha256(raw)}`;
    await completeVehicleTrackerProviderIngestBatch({
      trackerProviderId: provider.trackerProviderId,
      claimToken: provider.claimToken,
      source: "geotab_getfeed",
      batchKey,
      expectedCursor: provider.feedCursor,
      nextCursor,
      payloadSha256Hex: sha256(raw),
      recordCount: records.length,
    });
    return {
      outcome: "committed" as const,
      providerId: provider.trackerProviderId,
      records: records.length,
      ingested,
    };
  } catch (error) {
    await releaseProviderClaim(provider, error);
    throw error;
  }
}

async function getTraccarPositions(config: TraccarCredentials) {
  const url = new URL(
    "positions",
    config.apiUrl.endsWith("/") ? config.apiUrl : `${config.apiUrl}/`,
  );
  const { raw, body } = await fetchJson(url, {
    headers: {
      authorization: authorizationHeader(config),
      accept: "application/json",
    },
  });
  if (!Array.isArray(body)) {
    throw new VehicleTrackerProviderConsumerError(
      "vehicle_tracker_provider_response_invalid",
    );
  }
  return { raw, positions: body };
}

async function acquireTraccarSessionCookie(config: TraccarCredentials) {
  if (!config.websocketEmail || !config.websocketPassword) {
    throw new VehicleTrackerProviderConsumerError(
      "vehicle_tracker_provider_credentials_invalid",
    );
  }
  const url = new URL(
    "session",
    config.apiUrl.endsWith("/") ? config.apiUrl : `${config.apiUrl}/`,
  );
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body: new URLSearchParams({
        email: config.websocketEmail,
        password: config.websocketPassword,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new VehicleTrackerProviderConsumerError(
      "vehicle_tracker_provider_transport_failed",
    );
  }
  if (!response.ok) {
    throw new VehicleTrackerProviderConsumerError(
      "vehicle_tracker_provider_authentication_failed",
    );
  }
  const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
  if (!cookie || !/^JSESSIONID=/.test(cookie)) {
    throw new VehicleTrackerProviderConsumerError(
      "vehicle_tracker_provider_authentication_failed",
    );
  }
  return cookie;
}

function traccarWebSocketUrl(apiUrl: string) {
  const url = new URL(apiUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/socket`;
  url.search = "";
  return url.toString();
}

export async function pollOneTraccarRest(input: { workerId?: string } = {}) {
  if (!ENV.vehicleTrackerProviderConsumersEnabled) {
    throw new VehicleTrackerProviderConsumerError(
      "vehicle_tracker_provider_consumers_disabled",
    );
  }
  const provider = await claimVehicleTrackerProviderIngest({
    providerKind: "traccar_rest",
    workerId: input.workerId?.trim() || `traccar-rest-${randomUUID()}`,
  });
  if (!provider) return { outcome: "empty" as const };
  try {
    const config = traccarCredentials(provider.credentialRef);
    if (config.transport !== "rest") {
      await releaseVehicleTrackerProviderIngestClaim({
        trackerProviderId: provider.trackerProviderId,
        claimToken: provider.claimToken,
        errorCode: "vehicle_tracker_provider_transport_failed",
      });
      return {
        outcome: "websocket_configured" as const,
        providerId: provider.trackerProviderId,
      };
    }
    const { raw, positions } = await getTraccarPositions(config);
    const ingested = await persistTraccarPositions(
      provider,
      "traccar_rest",
      positions,
    );
    const digest = sha256(raw);
    await completeVehicleTrackerProviderIngestBatch({
      trackerProviderId: provider.trackerProviderId,
      claimToken: provider.claimToken,
      source: "traccar_rest",
      batchKey: `traccar-rest-${digest}`,
      expectedCursor: provider.feedCursor,
      nextCursor: digest,
      payloadSha256Hex: digest,
      recordCount: positions.length,
    });
    return {
      outcome: "committed" as const,
      providerId: provider.trackerProviderId,
      records: positions.length,
      ingested,
    };
  } catch (error) {
    await releaseProviderClaim(provider, error);
    throw error;
  }
}

export async function startOneTraccarWebSocketConsumer(
  input: { workerId?: string } = {},
) {
  if (!ENV.vehicleTrackerProviderConsumersEnabled) {
    throw new VehicleTrackerProviderConsumerError(
      "vehicle_tracker_provider_consumers_disabled",
    );
  }
  const provider = await claimVehicleTrackerProviderIngest({
    providerKind: "traccar_rest",
    workerId: input.workerId?.trim() || `traccar-websocket-${randomUUID()}`,
  });
  if (!provider) return { outcome: "empty" as const };
  try {
    const config = traccarCredentials(provider.credentialRef);
    if (config.transport !== "websocket") {
      await releaseVehicleTrackerProviderIngestClaim({
        trackerProviderId: provider.trackerProviderId,
        claimToken: provider.claimToken,
        errorCode: "vehicle_tracker_provider_transport_failed",
      });
      return {
        outcome: "rest_configured" as const,
        providerId: provider.trackerProviderId,
      };
    }
    if (traccarSockets.has(provider.trackerProviderId)) {
      await releaseVehicleTrackerProviderIngestClaim({
        trackerProviderId: provider.trackerProviderId,
        claimToken: provider.claimToken,
        errorCode: "vehicle_tracker_provider_transport_failed",
      });
      return {
        outcome: "already_connected" as const,
        providerId: provider.trackerProviderId,
      };
    }
    const cookie = await acquireTraccarSessionCookie(config);
    const socket = new WebSocket(traccarWebSocketUrl(config.apiUrl), {
      headers: { cookie },
      handshakeTimeout: 10_000,
    });
    let closed = false;
    let processing = Promise.resolve();
    const renewTimer = setInterval(() => {
      void renewVehicleTrackerProviderIngestClaim({
        trackerProviderId: provider.trackerProviderId,
        claimToken: provider.claimToken,
      }).catch(() => socket.close(4000));
    }, 60_000);
    const close = () => socket.close(1000);
    traccarSockets.set(provider.trackerProviderId, { close });
    socket.on("message", (data) => {
      processing = processing
        .then(async () => {
          const raw = Array.isArray(data)
            ? Buffer.concat(data)
            : Buffer.isBuffer(data)
              ? data
              : Buffer.from(data);
          const payload = asRecord(
            JSON.parse(raw.toString("utf8")),
            "vehicle_tracker_provider_response_invalid",
          );
          const positions = Array.isArray(payload.positions)
            ? payload.positions
            : [];
          const ingested = await persistTraccarPositions(
            provider,
            "traccar_websocket",
            positions,
          );
          const digest = sha256(raw);
          await completeVehicleTrackerProviderIngestBatch({
            trackerProviderId: provider.trackerProviderId,
            claimToken: provider.claimToken,
            source: "traccar_websocket",
            batchKey: `traccar-ws-${digest}`,
            expectedCursor: provider.feedCursor,
            nextCursor: digest,
            payloadSha256Hex: digest,
            recordCount: positions.length,
            keepClaim: true,
          });
          provider.feedCursor = digest;
          void ingested;
        })
        .catch(() => socket.close(1011));
    });
    socket.on("close", () => {
      if (closed) return;
      closed = true;
      clearInterval(renewTimer);
      traccarSockets.delete(provider.trackerProviderId);
      void processing.finally(() =>
        releaseProviderClaim(
          provider,
          new VehicleTrackerProviderConsumerError(
            "vehicle_tracker_provider_transport_failed",
          ),
        ),
      );
    });
    socket.on("error", () => undefined);
    return {
      outcome: "connected" as const,
      providerId: provider.trackerProviderId,
    };
  } catch (error) {
    await releaseProviderClaim(provider, error);
    throw error;
  }
}

export async function dispatchOneVehicleTrackerProviderIngest(input: {
  providerKind: "geotab_feed" | "traccar_rest";
  workerId?: string;
}) {
  return input.providerKind === "geotab_feed"
    ? pollOneGeotabGetFeed(input)
    : pollOneTraccarRest(input);
}

export function startVehicleTrackerProviderConsumers(
  input: { workerIdPrefix?: string } = {},
) {
  if (!ENV.vehicleTrackerProviderConsumersEnabled) return () => undefined;
  const intervalMs = Math.min(
    300_000,
    Math.max(5_000, ENV.vehicleTrackerProviderPollIntervalMs),
  );
  const workerIdPrefix = input.workerIdPrefix?.trim() || "vehicle-tracker";
  const run = async () => {
    if (providerDispatchInFlight) return;
    providerDispatchInFlight = true;
    const runGeotab = async () => {
      const startedAt = performance.now();
      try {
        const result = await pollOneGeotabGetFeed({
          workerId: `${workerIdPrefix}-geotab-${randomUUID()}`,
        });
        vehicleTrackerMetrics.observePoll(
          "geotab_feed",
          result.outcome === "committed" ? "committed" : "empty",
          (performance.now() - startedAt) / 1_000,
        );
      } catch {
        vehicleTrackerMetrics.observePoll(
          "geotab_feed",
          "failed",
          (performance.now() - startedAt) / 1_000,
        );
      }
    };
    const runTraccar = async () => {
      const startedAt = performance.now();
      try {
        const result = await pollOneTraccarRest({
          workerId: `${workerIdPrefix}-traccar-${randomUUID()}`,
        });
        if (result.outcome === "websocket_configured") {
          const websocket = await startOneTraccarWebSocketConsumer({
            workerId: `${workerIdPrefix}-traccar-websocket-${randomUUID()}`,
          });
          vehicleTrackerMetrics.observePoll(
            "traccar_rest",
            websocket.outcome === "connected" ? "connected" : "empty",
            (performance.now() - startedAt) / 1_000,
          );
          return;
        }
        vehicleTrackerMetrics.observePoll(
          "traccar_rest",
          result.outcome === "committed" ? "committed" : "empty",
          (performance.now() - startedAt) / 1_000,
        );
      } catch {
        vehicleTrackerMetrics.observePoll(
          "traccar_rest",
          "failed",
          (performance.now() - startedAt) / 1_000,
        );
      }
    };
    try {
      await Promise.all([runGeotab(), runTraccar()]);
    } finally {
      providerDispatchInFlight = false;
    }
  };
  const timer = setInterval(() => void run(), intervalMs);
  void run();
  return () => {
    clearInterval(timer);
    for (const entry of traccarSockets.values()) entry.close();
    traccarSockets.clear();
  };
}
