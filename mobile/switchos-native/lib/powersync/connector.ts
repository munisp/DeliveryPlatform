/**
 * PowerSync backend connector for SwitchOS Native (Expo RN).
 *
 * Fixed backend contract (server/_core/powersyncToken.ts + powersyncUpload.ts
 * on main — do not deviate):
 *   GET  /api/powersync/token  -> { endpoint: string | null, token,
 *                                  expiresAt: ISO string, expiresIn: number }
 *   POST /api/powersync/upload <- EXACTLY
 *        { entries: [{ id: string|number, op: "PUT"|"PATCH"|"DELETE",
 *                      table: string, data?: object }] }   (1..100 entries)
 *
 * Semantics mirrored from the PWA twin (client/src/lib/powersync.ts):
 *   - Credentials are cached and refreshed once they are within the 30s
 *     prefetch window of expiry (the SDK's own keepalive window).
 *   - 401/403 from the token endpoint => the session is gone: return null so
 *     the SDK parks the connection until re-login (no retry loop).
 *   - A null `endpoint` means POWERSYNC_SERVICE_URL is unset server-side
 *     (service not deployed): park with ONE console.warn — never crash, never
 *     spin.
 *   - uploadData is FIFO and head-of-line blocking: the batch is POSTed in
 *     queue order, any non-2xx throws so the SDK retries with backoff (the
 *     backend applies idempotently via powersync-upload-<entry.id>), and the
 *     transaction is completed ONLY after a 2xx.
 *
 * Authentication: bearer session token from expo-secure-store
 * (lib/_core/auth.getSessionToken) — the same mechanism the tRPC client uses
 * for /api calls on native. On web the token is null and the request relies
 * on the session cookie (credentials: "include"), same as lib/trpc.ts.
 *
 * This module has no runtime @powersync/* imports so vitest can exercise it
 * in a plain Node environment; SDK types are imported type-only.
 */
import type {
  AbstractPowerSyncDatabase,
  PowerSyncCredentials,
} from "@powersync/common";

export const POWERSYNC_TOKEN_PATH = "/api/powersync/token";
export const POWERSYNC_UPLOAD_PATH = "/api/powersync/upload";

/**
 * Mirrors the PowerSync SDK keepalive: the SDK calls fetchCredentials again
 * once the token is within ~30s of expiry, so cached credentials older than
 * this window must be refreshed instead of reused.
 */
export const CREDENTIAL_PREFETCH_WINDOW_MS = 30_000;

/** Envelope field name required by POST /api/powersync/upload. */
export const UPLOAD_ENVELOPE_KEY = "entries" as const;

type FetchResponseLike = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
};

export type FetchLike = (
  input: string,
  init?: {
    method?: string;
    credentials?: "include" | "omit" | "same-origin";
    cache?: "no-store";
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<FetchResponseLike>;

export type PowerSyncConnectorOptions = {
  /** Resolves the API origin (e.g. getApiBaseUrl()); empty = same-origin. */
  getBaseUrl?: () => string;
  /** Bearer session token provider (SecureStore); null = signed out/web. */
  getSessionToken: () => Promise<string | null>;
  /** Injectable fetch for tests; defaults to globalThis.fetch. */
  fetchImpl?: FetchLike;
  /** Injectable clock (ms epoch) for tests; defaults to Date.now. */
  now?: () => number;
  /** Override the credential prefetch window (defaults to 30s). */
  prefetchWindowMs?: number;
  /** Warning sink (defaults to console.warn). */
  onWarn?: (message: string) => void;
};

/** Joins an optional API base URL with a fixed contract path. */
export function resolvePowerSyncUrl(baseUrl: string, path: string): string {
  const trimmedBase = baseUrl.replace(/\/+$/, "");
  const trimmedPath = path.replace(/^\/+/, "");
  return trimmedBase ? `${trimmedBase}/${trimmedPath}` : `/${trimmedPath}`;
}

/**
 * Prefetch TTL math: credentials must be refreshed when they are missing an
 * expiry or when their remaining lifetime is at or below the prefetch window.
 */
export function shouldRefreshCredentials(
  expiresAt: Date | null | undefined,
  nowMs: number,
  prefetchWindowMs: number = CREDENTIAL_PREFETCH_WINDOW_MS,
): boolean {
  if (!expiresAt || Number.isNaN(expiresAt.getTime())) return true;
  return expiresAt.getTime() - nowMs <= prefetchWindowMs;
}

type TokenPayload = {
  endpoint?: unknown;
  token?: unknown;
  expiresAt?: unknown;
  expiresIn?: unknown;
};

/**
 * Parses the token endpoint payload. Returns null for the park cases
 * (null endpoint). Throws for a malformed payload (missing token / bad
 * expiresAt) — those are server contract violations, not transient states.
 */
export function parseTokenPayload(payload: TokenPayload): PowerSyncCredentials | null {
  if (typeof payload?.token !== "string" || payload.token.length === 0) {
    throw new Error("powersync_token_invalid:missing_token");
  }
  // A null/empty endpoint means the PowerSync service is not deployed
  // (POWERSYNC_SERVICE_URL unset server-side). Park — return null so the SDK
  // stays disconnected — instead of throwing, which would put the SDK into
  // an infinite retry loop against an endpoint that does not exist.
  if (typeof payload?.endpoint !== "string" || payload.endpoint.length === 0) {
    return null;
  }
  let expiresAt: Date | undefined;
  if (typeof payload.expiresAt === "string" && payload.expiresAt.length > 0) {
    const parsed = new Date(payload.expiresAt);
    if (Number.isNaN(parsed.getTime())) {
      throw new Error("powersync_token_invalid:bad_expires_at");
    }
    expiresAt = parsed;
  }
  return { token: payload.token, endpoint: payload.endpoint, expiresAt };
}

export type PowerSyncUploadEntryWire = {
  id: string | number;
  op: "PUT" | "PATCH" | "DELETE";
  table: string;
  data?: Record<string, unknown>;
};

/**
 * Serializes one queued CRUD transaction into the fixed upload contract.
 * `transaction.crud` is already in FIFO commit order; that order is
 * preserved so the backend applies operations exactly as committed locally.
 * The envelope key is `entries` — the backend rejects anything else.
 */
export function serializeCrudTransaction(transaction: {
  crud: Array<{
    op: string;
    table: string;
    id: string;
    opData?: Record<string, unknown>;
  }>;
}): { entries: PowerSyncUploadEntryWire[] } {
  return {
    [UPLOAD_ENVELOPE_KEY]: transaction.crud.map((entry) => ({
      id: entry.id,
      op: String(entry.op) as PowerSyncUploadEntryWire["op"],
      table: entry.table,
      ...(entry.opData !== undefined ? { data: entry.opData } : {}),
    })),
  };
}

/**
 * Connector between the PowerSync client SDK and the DeliveryPlatform
 * backend (bearer-token variant of the PWA connector).
 */
export class MobilePowerSyncConnector {
  private cachedCredentials: PowerSyncCredentials | null = null;
  private nullEndpointWarned = false;

  constructor(private readonly options: PowerSyncConnectorOptions) {}

  private url(path: string): string {
    return resolvePowerSyncUrl(this.options.getBaseUrl?.() ?? "", path);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private warn(message: string): void {
    (this.options.onWarn ?? console.warn)(message);
  }

  private get fetchImpl(): FetchLike {
    const impl = this.options.fetchImpl ?? globalThis.fetch;
    if (!impl) throw new Error("powersync_fetch_unavailable");
    return impl.bind(globalThis) as FetchLike;
  }

  private async authHeaders(): Promise<Record<string, string>> {
    const token = await this.options.getSessionToken();
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  /**
   * Called by the SDK on connect, when the token is within ~30s of expiry,
   * and on a 401 from the sync service. Returns cached credentials while
   * they are comfortably fresh (prefetch window), otherwise fetches a new
   * token. Returns null when signed out (401/403) or when the service is
   * not deployed (null endpoint) — the SDK parks instead of retry-looping.
   */
  async fetchCredentials(): Promise<PowerSyncCredentials | null> {
    const prefetchWindow =
      this.options.prefetchWindowMs ?? CREDENTIAL_PREFETCH_WINDOW_MS;
    if (
      this.cachedCredentials &&
      !shouldRefreshCredentials(
        this.cachedCredentials.expiresAt ?? null,
        this.now(),
        prefetchWindow,
      )
    ) {
      return this.cachedCredentials;
    }

    const response = await this.fetchImpl(this.url(POWERSYNC_TOKEN_PATH), {
      method: "GET",
      credentials: "include",
      cache: "no-store",
      headers: {
        accept: "application/json",
        ...(await this.authHeaders()),
      },
    });

    if (response.status === 401 || response.status === 403) {
      this.cachedCredentials = null;
      return null;
    }
    if (!response.ok) {
      throw new Error(`powersync_token_fetch_failed:${response.status}`);
    }

    const parsed = parseTokenPayload((await response.json()) as TokenPayload);
    if (!parsed) {
      // Service not deployed: park. Do not cache — a later connect attempt
      // re-checks in case the service has come online since. Warn once per
      // connector instance so logs are not flooded by SDK re-polls.
      this.cachedCredentials = null;
      if (!this.nullEndpointWarned) {
        this.nullEndpointWarned = true;
        this.warn(
          "[powersync] token endpoint returned no service endpoint; " +
            "offline data sync parked (online-only mode).",
        );
      }
      return null;
    }
    this.cachedCredentials = parsed;
    return this.cachedCredentials;
  }

  /**
   * FIFO batch upload of the oldest queued local transaction. Throwing on
   * any non-2xx response makes the SDK retry with backoff; the batch is
   * marked complete ONLY after the backend has durably applied it (2xx).
   *
   * Whitelist reality (server/_core/powersyncUpload.ts): v1 accepts ONLY
   * support_tickets PUT; every other (table, op) pair answers 400. Do not
   * queue writes for other tables — see lib/powersync/localWrites.ts.
   */
  async uploadData(
    database: Pick<AbstractPowerSyncDatabase, "getNextCrudTransaction">,
  ): Promise<void> {
    const transaction = await database.getNextCrudTransaction();
    if (!transaction) return;

    const response = await this.fetchImpl(this.url(POWERSYNC_UPLOAD_PATH), {
      method: "POST",
      credentials: "include",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(await this.authHeaders()),
      },
      body: JSON.stringify(serializeCrudTransaction(transaction)),
    });

    if (!response.ok) {
      // Thrown errors make the SDK retry with backoff; the queue head is
      // kept so operations are never reordered or dropped silently. A 400
      // (non-whitelisted table) means the local write came from an
      // unsupported path — it will keep failing until the app stops writing
      // it; surfacing loudly beats silent loss.
      throw new Error(`powersync_upload_failed:${response.status}`);
    }

    await transaction.complete();
  }

  /** Test/observability hook: is the connector parked on a null endpoint? */
  get isParkedOnNullEndpoint(): boolean {
    return this.nullEndpointWarned && this.cachedCredentials === null;
  }
}
