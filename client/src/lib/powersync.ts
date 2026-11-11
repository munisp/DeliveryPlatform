/**
 * PowerSync web client for the DeliveryPlatform PWA (offline data sync).
 *
 * Storage engine: wa-sqlite (WASM SQLite) running in a web worker using the
 * OPFSCoopSyncVFS (Origin Private File System) VFS — the only PowerSync web
 * VFS with reliable multi-tab support, including Safari/iOS. Multi-tab sync
 * coordination uses a SharedWorker where available (desktop Chrome/Firefox);
 * on Safari and mobile browsers the SDK falls back to BroadcastChannel-based
 * coordination automatically.
 *
 * DEPLOYMENT REQUIREMENT — COOP/COEP headers (server middleware lands
 * separately; do not remove this note until verified in production):
 * OPFS on Safari requires cross-origin isolation. The HTML shell and static
 * assets must be served with:
 *   Cross-Origin-Opener-Policy: same-origin
 *   Cross-Origin-Embedder-Policy: require-corp
 * Without those headers `detectPowerSyncSupport` reports unsupported, a
 * warning is logged, and the app continues in online-only mode — this module
 * must never crash the app.
 *
 * Backend contract (fixed interface, implemented server-side):
 *   GET  /api/powersync/token  (session cookie auth) -> { token, expiresAt, endpoint }
 *   POST /api/powersync/upload <- { entries: [{ op, table, id, data }] }
 * Any non-2xx upload response throws so the PowerSync SDK retries with
 * backoff. The upload queue is FIFO and head-of-line blocking, so the
 * backend must apply batches idempotently.
 *
 * This module is intentionally free of runtime `@powersync/*` imports: the
 * SDK and the WASM schema are loaded lazily via dynamic import so that
 * unsupported browsers never download the SDK, and vitest can exercise the
 * connector logic in a Node environment.
 */
import type {
  AbstractPowerSyncDatabase,
  PowerSyncCredentials,
} from "@powersync/web";

import { reportClientError } from "./logger";

export const POWERSYNC_TOKEN_PATH = "/api/powersync/token";
export const POWERSYNC_UPLOAD_PATH = "/api/powersync/upload";

/**
 * Mirrors the PowerSync SDK keepalive: the SDK calls fetchCredentials again
 * once the token is within ~30s of expiry, so cached credentials older than
 * this window must be refreshed instead of reused.
 */
export const CREDENTIAL_PREFETCH_WINDOW_MS = 30_000;

const POWERSYNC_DB_FILENAME = "deliveryplatform-powersync.db";

type FetchLike = (
  input: string,
  init?: {
    method?: string;
    credentials?: "include" | "omit" | "same-origin";
    cache?: "no-store";
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export type PowerSyncConnectorOptions = {
  /** Override the API origin (defaults to same-origin relative paths). */
  baseUrl?: string;
  /** Injectable fetch for tests; defaults to globalThis.fetch. */
  fetchImpl?: FetchLike;
  /** Injectable clock (ms epoch) for tests; defaults to Date.now. */
  now?: () => number;
  /** Override the credential prefetch window (defaults to 30s). */
  prefetchWindowMs?: number;
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
  token?: unknown;
  endpoint?: unknown;
  expiresAt?: unknown;
};

function parseTokenPayload(payload: TokenPayload): PowerSyncCredentials | null {
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

/**
 * Serializes one queued CRUD transaction into the fixed upload contract.
 * `transaction.crud` is already in FIFO commit order; that order is preserved
 * so the backend applies operations exactly as they were committed locally.
 */
export function serializeCrudTransaction(transaction: {
  crud: Array<{
    op: string;
    table: string;
    id: string;
    opData?: Record<string, unknown>;
  }>;
}): { entries: Array<{ op: string; table: string; id: string; data?: Record<string, unknown> }> } {
  return {
    entries: transaction.crud.map((entry) => ({
      op: String(entry.op),
      table: entry.table,
      id: entry.id,
      data: entry.opData,
    })),
  };
}

/**
 * Connector between the PowerSync client SDK and the DeliveryPlatform
 * backend. Session authentication is cookie-based (same as the tRPC client),
 * so no Authorization header is needed.
 */
export class DeliveryPlatformPowerSyncConnector {
  private cachedCredentials: PowerSyncCredentials | null = null;

  constructor(private readonly options: PowerSyncConnectorOptions = {}) {}

  private url(path: string): string {
    return resolvePowerSyncUrl(this.options.baseUrl ?? "", path);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private get fetchImpl(): FetchLike {
    const impl = this.options.fetchImpl ?? globalThis.fetch;
    if (!impl) throw new Error("powersync_fetch_unavailable");
    return impl.bind(globalThis) as FetchLike;
  }

  /**
   * Called by the SDK on connect, when the token is within ~30s of expiry,
   * on a 401 from the sync service, and after an expired-while-offline
   * reconnect. Returns the cached token while it is comfortably fresh
   * (prefetch window), otherwise fetches a new one. Returns null when the
   * session is gone so the SDK parks the connection instead of retrying.
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
      headers: { accept: "application/json" },
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
      // re-checks in case the service has come online since.
      this.cachedCredentials = null;
      console.warn(
        "[powersync] token endpoint returned no service endpoint; " +
          "offline sync parked (online-only mode).",
      );
      return null;
    }
    this.cachedCredentials = parsed;
    return this.cachedCredentials;
  }

  /**
   * FIFO batch upload of the oldest queued local transaction. Throwing on
   * any non-2xx response makes the SDK retry with backoff; the batch is only
   * marked complete after the backend has durably applied it.
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
      },
      body: JSON.stringify(serializeCrudTransaction(transaction)),
    });

    if (!response.ok) {
      // Thrown errors make the SDK retry with backoff; the queue head is
      // kept so operations are never reordered or dropped silently.
      throw new Error(`powersync_upload_failed:${response.status}`);
    }

    await transaction.complete();
  }
}

export type PowerSyncSupportEnvironment = {
  secureContext: boolean;
  hasWorker: boolean;
  hasOpfs: boolean;
  crossOriginIsolated: boolean;
};

export type PowerSyncSupport =
  | { supported: true; reason: null }
  | { supported: false; reason: string };

/**
 * Feature detection for the OPFS-based sync path. Anything unsupported here
 * degrades to online-only mode with a logged warning — never a crash.
 */
export function detectPowerSyncSupport(
  env: PowerSyncSupportEnvironment,
): PowerSyncSupport {
  if (!env.secureContext) {
    return { supported: false, reason: "requires a secure context (HTTPS)" };
  }
  if (!env.hasWorker) {
    return { supported: false, reason: "web workers are unavailable" };
  }
  if (!env.hasOpfs) {
    return {
      supported: false,
      reason: "origin private file system (OPFS) is unavailable",
    };
  }
  if (!env.crossOriginIsolated) {
    return {
      supported: false,
      reason:
        "cross-origin isolation headers (COOP/COEP) are missing; OPFS sync access handles require them on Safari",
    };
  }
  return { supported: true, reason: null };
}

function readPowerSyncEnvironment(): PowerSyncSupportEnvironment {
  const nav = typeof navigator !== "undefined" ? navigator : undefined;
  return {
    secureContext:
      typeof window !== "undefined" && window.isSecureContext === true,
    hasWorker: typeof Worker !== "undefined",
    hasOpfs: typeof nav?.storage?.getDirectory === "function",
    crossOriginIsolated:
      (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated ===
      true,
  };
}

let databasePromise: Promise<AbstractPowerSyncDatabase | null> | null = null;

async function createPowerSyncDatabase(): Promise<AbstractPowerSyncDatabase | null> {
  const support = detectPowerSyncSupport(readPowerSyncEnvironment());
  if (!support.supported) {
    console.warn(
      `[powersync] offline sync disabled: ${support.reason}. Continuing in online-only mode.`,
    );
    return null;
  }

  try {
    const [{ PowerSyncDatabase, WASQLiteOpenFactory, WASQLiteVFS }, schemaModule] =
      await Promise.all([
        import("@powersync/web"),
        import("./powersyncSchema"),
      ]);
    const factory = new WASQLiteOpenFactory({
      dbFilename: POWERSYNC_DB_FILENAME,
      vfs: WASQLiteVFS.OPFSCoopSyncVFS,
      flags: {
        // SharedWorker multi-tab coordination is desktop-only; on Safari and
        // mobile browsers the SDK coordinates tabs over BroadcastChannel.
        enableMultiTabs: typeof SharedWorker !== "undefined",
      },
    });
    return new PowerSyncDatabase({
      database: factory,
      schema: schemaModule.PowerSyncAppSchema,
    });
  } catch (error) {
    // Allow a later retry after a transient failure (e.g. WASM fetch hiccup).
    databasePromise = null;
    console.warn(
      "[powersync] failed to initialise offline sync; continuing in online-only mode.",
      error,
    );
    reportClientError("powersync.init_failed", error);
    return null;
  }
}

/**
 * Lazily-initialised singleton database. Returns null (with a logged
 * warning) when the browser cannot support the OPFS sync path.
 */
export function getPowerSyncDatabase(): Promise<AbstractPowerSyncDatabase | null> {
  if (!databasePromise) {
    databasePromise = createPowerSyncDatabase();
  }
  return databasePromise;
}

let connector: DeliveryPlatformPowerSyncConnector | null = null;

/** Shared connector instance used by the sync provider. */
export function getPowerSyncConnector(): DeliveryPlatformPowerSyncConnector {
  connector ??= new DeliveryPlatformPowerSyncConnector();
  return connector;
}

/** Stops syncing (e.g. on logout). Local data is kept for the next sign-in. */
export async function disconnectPowerSync(): Promise<void> {
  if (!databasePromise) return;
  const pending = databasePromise;
  databasePromise = null;
  const db = await pending.catch(() => null);
  try {
    await db?.disconnect();
  } catch (error) {
    reportClientError("powersync.disconnect_failed", error);
  }
}
