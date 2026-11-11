/**
 * PowerSync mobile client tests (vitest, node environment — no native
 * modules, no @powersync/* runtime imports required).
 *
 * Covers the fixed backend contract (server/_core/powersyncToken.ts +
 * powersyncUpload.ts):
 *   - token URL construction + bearer header
 *   - credential prefetch TTL math (30s window)
 *   - 401/403 park (signed out), null-endpoint park (service not deployed,
 *     warn ONCE), missing-token throw
 *   - upload envelope serialization: the `entries` key explicitly, FIFO
 *     order, optional data
 *   - upload retry-on-throw for non-2xx and complete()-only-on-2xx
 *   - support_tickets local-write whitelist validation (the ONLY write path)
 *   - schema coverage vs the 19-table publication (static)
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  selectSqliteBackend,
} from "../lib/powersync/backend";
import {
  CREDENTIAL_PREFETCH_WINDOW_MS,
  MobilePowerSyncConnector,
  parseTokenPayload,
  resolvePowerSyncUrl,
  serializeCrudTransaction,
  shouldRefreshCredentials,
  type FetchLike,
} from "../lib/powersync/connector";
import {
  isLocalPendingSupportCase,
  LOCAL_SUPPORT_CASE_ID_PREFIX,
  newLocalSupportCaseId,
  queueSupportCaseDraft,
  SupportCaseDraftValidationError,
  validateSupportCaseDraft,
  type SupportCaseDraft,
} from "../lib/powersync/localWrites";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Fetch fakes
// ---------------------------------------------------------------------------

type FetchCall = { url: string; init: { method?: string; headers?: Record<string, string>; body?: string } };

function fakeFetch(
  handler: (call: FetchCall) => { status: number; body?: unknown },
): { fetchImpl: FetchLike; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: string, init?: FetchCall["init"]) => {
    const call: FetchCall = { url, init: init ?? {} };
    calls.push(call);
    const result = handler(call);
    return {
      ok: result.status >= 200 && result.status < 300,
      status: result.status,
      json: async () => result.body,
    };
  }) as FetchLike;
  return { fetchImpl, calls };
}

function connectorWith(
  handler: (call: FetchCall) => { status: number; body?: unknown },
  overrides: Partial<ConstructorParameters<typeof MobilePowerSyncConnector>[0]> = {},
) {
  const { fetchImpl, calls } = fakeFetch(handler);
  const warnings: string[] = [];
  const connector = new MobilePowerSyncConnector({
    getBaseUrl: () => "https://api.test",
    getSessionToken: async () => "session-jwt",
    fetchImpl,
    onWarn: (message) => warnings.push(message),
    ...overrides,
  });
  return { connector, calls, warnings };
}

const TOKEN_OK = {
  endpoint: "https://powersync.test",
  token: "ps-jwt",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  expiresIn: 3600,
};

// ---------------------------------------------------------------------------
// URL construction
// ---------------------------------------------------------------------------

describe("resolvePowerSyncUrl", () => {
  it("joins base and path with exactly one slash", () => {
    expect(resolvePowerSyncUrl("https://api.test/", "/api/powersync/token")).toBe(
      "https://api.test/api/powersync/token",
    );
    expect(resolvePowerSyncUrl("https://api.test", "api/powersync/token")).toBe(
      "https://api.test/api/powersync/token",
    );
  });

  it("produces an origin-relative path when no base URL is configured", () => {
    expect(resolvePowerSyncUrl("", "/api/powersync/upload")).toBe("/api/powersync/upload");
  });
});

// ---------------------------------------------------------------------------
// Prefetch TTL math
// ---------------------------------------------------------------------------

describe("shouldRefreshCredentials", () => {
  const now = 1_700_000_000_000;

  it("keeps credentials comfortably outside the prefetch window", () => {
    expect(
      shouldRefreshCredentials(new Date(now + 120_000), now, CREDENTIAL_PREFETCH_WINDOW_MS),
    ).toBe(false);
  });

  it("refreshes at or inside the 30s prefetch window", () => {
    expect(shouldRefreshCredentials(new Date(now + 30_000), now)).toBe(true);
    expect(shouldRefreshCredentials(new Date(now + 1_000), now)).toBe(true);
    expect(shouldRefreshCredentials(new Date(now - 1_000), now)).toBe(true);
  });

  it("refreshes when expiry is missing or invalid", () => {
    expect(shouldRefreshCredentials(null, now)).toBe(true);
    expect(shouldRefreshCredentials(new Date("not-a-date"), now)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Token payload parsing
// ---------------------------------------------------------------------------

describe("parseTokenPayload", () => {
  it("parses a full payload", () => {
    const parsed = parseTokenPayload(TOKEN_OK);
    expect(parsed?.token).toBe("ps-jwt");
    expect(parsed?.endpoint).toBe("https://powersync.test");
    expect(parsed?.expiresAt).toBeInstanceOf(Date);
  });

  it("returns null for a null endpoint (service not deployed)", () => {
    expect(parseTokenPayload({ ...TOKEN_OK, endpoint: null })).toBeNull();
    expect(parseTokenPayload({ ...TOKEN_OK, endpoint: "" })).toBeNull();
  });

  it("throws when the token is missing", () => {
    expect(() => parseTokenPayload({ ...TOKEN_OK, token: undefined })).toThrow(
      "powersync_token_invalid:missing_token",
    );
    expect(() => parseTokenPayload({ ...TOKEN_OK, token: "" })).toThrow(
      "powersync_token_invalid:missing_token",
    );
  });

  it("throws on an unparseable expiresAt", () => {
    expect(() => parseTokenPayload({ ...TOKEN_OK, expiresAt: "junk" })).toThrow(
      "powersync_token_invalid:bad_expires_at",
    );
  });
});

// ---------------------------------------------------------------------------
// fetchCredentials
// ---------------------------------------------------------------------------

describe("connector fetchCredentials", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("GETs the token endpoint with the bearer session token", async () => {
    const { connector, calls } = connectorWith(() => ({ status: 200, body: TOKEN_OK }));
    const credentials = await connector.fetchCredentials();
    expect(credentials?.token).toBe("ps-jwt");
    expect(calls[0].url).toBe("https://api.test/api/powersync/token");
    expect(calls[0].init.method).toBe("GET");
    expect(calls[0].init.headers?.authorization).toBe("Bearer session-jwt");
  });

  it("sends no authorization header when signed out locally", async () => {
    const { connector, calls } = connectorWith(() => ({ status: 401, body: {} }), {
      getSessionToken: async () => null,
    });
    expect(await connector.fetchCredentials()).toBeNull();
    expect(calls[0].init.headers?.authorization).toBeUndefined();
  });

  it("caches credentials while fresh and refetches inside the prefetch window", async () => {
    let now = 1_700_000_000_000;
    const expiring = {
      ...TOKEN_OK,
      expiresAt: new Date(now + 3_600_000).toISOString(),
    };
    const { connector, calls } = connectorWith(() => ({ status: 200, body: expiring }), {
      now: () => now,
    });
    await connector.fetchCredentials();
    await connector.fetchCredentials();
    expect(calls).toHaveLength(1); // cache hit

    now += 3_600_000 - 20_000; // inside the 30s prefetch window
    await connector.fetchCredentials();
    expect(calls).toHaveLength(2); // refreshed
  });

  it.each([401, 403])("parks (null) on %i without throwing", async (status) => {
    const { connector } = connectorWith(() => ({ status, body: { error: "authentication_required" } }));
    await expect(connector.fetchCredentials()).resolves.toBeNull();
  });

  it("parks on a null endpoint with exactly one warning", async () => {
    const { connector, warnings } = connectorWith(() => ({
      status: 200,
      body: { ...TOKEN_OK, endpoint: null },
    }));
    expect(await connector.fetchCredentials()).toBeNull();
    expect(connector.isParkedOnNullEndpoint).toBe(true);
    // Second call re-checks (no cache) but does not warn again.
    expect(await connector.fetchCredentials()).toBeNull();
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("parked");
  });

  it("throws on a 5xx token response so the SDK retries", async () => {
    const { connector } = connectorWith(() => ({ status: 503, body: { error: "powersync_not_configured" } }));
    await expect(connector.fetchCredentials()).rejects.toThrow("powersync_token_fetch_failed:503");
  });
});

// ---------------------------------------------------------------------------
// Upload envelope serialization
// ---------------------------------------------------------------------------

describe("serializeCrudTransaction", () => {
  it("uses the `entries` envelope key and preserves FIFO order", () => {
    const wire = serializeCrudTransaction({
      crud: [
        { op: "PUT", table: "support_tickets", id: "pslocal-1", opData: { subject: "a" } },
        { op: "PUT", table: "support_tickets", id: "pslocal-2", opData: { subject: "b" } },
        { op: "DELETE", table: "support_tickets", id: "pslocal-1" },
      ],
    });
    expect(Object.keys(wire)).toEqual(["entries"]);
    expect(wire.entries.map((entry) => [entry.id, entry.op, entry.table])).toEqual([
      ["pslocal-1", "PUT", "support_tickets"],
      ["pslocal-2", "PUT", "support_tickets"],
      ["pslocal-1", "DELETE", "support_tickets"],
    ]);
    expect(wire.entries[0].data).toEqual({ subject: "a" });
    expect(wire.entries[2].data).toBeUndefined();
    // The backend rejects unknown envelope keys — pin the serialized shape.
    expect(JSON.stringify(wire)).toContain('"entries"');
    expect(JSON.stringify(wire)).not.toContain('"operations"');
  });
});

// ---------------------------------------------------------------------------
// uploadData
// ---------------------------------------------------------------------------

function fakeDatabase(crud: unknown[] | null) {
  const complete = vi.fn(async () => {});
  return {
    complete,
    database: {
      getNextCrudTransaction: async () =>
        crud === null ? null : ({ crud, complete } as never),
    },
  };
}

describe("connector uploadData", () => {
  const onePut = [
    {
      op: "PUT",
      table: "support_tickets",
      id: "pslocal-abc",
      opData: { type: "general", subject: "s", description: "d" },
    },
  ];

  it("POSTs the entries envelope with bearer auth and completes on 2xx", async () => {
    const { connector, calls } = connectorWith(() => ({ status: 200, body: { applied: 1 } }));
    const { database, complete } = fakeDatabase(onePut);
    await connector.uploadData(database);

    expect(calls[0].url).toBe("https://api.test/api/powersync/upload");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers?.authorization).toBe("Bearer session-jwt");
    const body = JSON.parse(String(calls[0].init.body));
    expect(body).toEqual({
      entries: [
        {
          id: "pslocal-abc",
          op: "PUT",
          table: "support_tickets",
          data: { type: "general", subject: "s", description: "d" },
        },
      ],
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 422, 500, 503])(
    "throws on %i and does NOT complete (SDK retries)",
    async (status) => {
      const { connector } = connectorWith(() => ({ status, body: {} }));
      const { database, complete } = fakeDatabase(onePut);
      await expect(connector.uploadData(database)).rejects.toThrow(
        `powersync_upload_failed:${status}`,
      );
      expect(complete).not.toHaveBeenCalled();
    },
  );

  it("is a no-op when the queue is empty", async () => {
    const { connector, calls } = connectorWith(() => ({ status: 200, body: {} }));
    const { database } = fakeDatabase(null);
    await connector.uploadData(database);
    expect(calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// localWrites — support_tickets whitelist path
// ---------------------------------------------------------------------------

function validDraft(): SupportCaseDraft {
  return {
    customerId: 42,
    orderId: 1001,
    type: "order_issue",
    subject: "Order arrived damaged",
    description: "Two items were broken on arrival; photos attached in chat.",
  };
}

describe("validateSupportCaseDraft", () => {
  it("accepts a valid draft (orderId optional/nullable)", () => {
    expect(() => validateSupportCaseDraft(validDraft())).not.toThrow();
    expect(() =>
      validateSupportCaseDraft({ ...validDraft(), orderId: null }),
    ).not.toThrow();
    const withoutOrder = validDraft();
    delete withoutOrder.orderId;
    expect(() => validateSupportCaseDraft(withoutOrder)).not.toThrow();
  });

  it.each([
    ["bad type", (d: SupportCaseDraft) => ((d as { type: string }).type = "warranty")],
    ["empty subject", (d: SupportCaseDraft) => (d.subject = "")],
    ["subject > 255", (d: SupportCaseDraft) => (d.subject = "x".repeat(256))],
    ["empty description", (d: SupportCaseDraft) => (d.description = "")],
    ["description > 4000", (d: SupportCaseDraft) => (d.description = "x".repeat(4001))],
    ["non-positive orderId", (d: SupportCaseDraft) => (d.orderId = 0)],
    ["fractional orderId", (d: SupportCaseDraft) => (d.orderId = 1.5)],
    ["bad customerId", (d: SupportCaseDraft) => (d.customerId = -1)],
  ])("rejects %s", (_label, mutate) => {
    const draft = validDraft();
    mutate(draft);
    expect(() => validateSupportCaseDraft(draft)).toThrow(SupportCaseDraftValidationError);
  });
});

describe("queueSupportCaseDraft", () => {
  it("inserts a pending_upload placeholder row that enters the upload queue", async () => {
    const statements: { sql: string; params: unknown[] }[] = [];
    const db = {
      execute: async (sql: string, params: unknown[] = []) => {
        statements.push({ sql, params });
        return {};
      },
    };
    const id = await queueSupportCaseDraft(db, validDraft(), new Date("2026-11-12T00:00:00Z"));

    expect(id.startsWith(LOCAL_SUPPORT_CASE_ID_PREFIX)).toBe(true);
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toContain("INSERT INTO support_tickets");
    const params = statements[0].params;
    expect(params[0]).toBe(id);
    expect(params[2]).toBe(42); // customer_id
    expect(params[3]).toBe(1001); // order_id
    expect(params[4]).toBe("order_issue");
    expect(params[6]).toBe("pending_upload");
    expect(params[7]).toBe("Order arrived damaged");
    expect(isLocalPendingSupportCase({ id, status: "pending_upload" })).toBe(true);
    expect(isLocalPendingSupportCase({ id: "12345", status: "open" })).toBe(false);
  });

  it("validates before writing", async () => {
    const execute = vi.fn(async () => ({}));
    await expect(
      queueSupportCaseDraft({ execute }, { ...validDraft(), subject: "" }),
    ).rejects.toThrow(SupportCaseDraftValidationError);
    expect(execute).not.toHaveBeenCalled();
  });

  it("generates collision-resistant local ids", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newLocalSupportCaseId()));
    expect(ids.size).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Storage backend selection
// ---------------------------------------------------------------------------

describe("selectSqliteBackend", () => {
  it("uses op-sqlite on dev clients and production builds", () => {
    expect(selectSqliteBackend({ platform: "ios", appOwnership: null })).toBe("op-sqlite");
    expect(selectSqliteBackend({ platform: "android", appOwnership: "standalone" })).toBe(
      "op-sqlite",
    );
  });

  it("falls back to sql-js inside Expo Go", () => {
    expect(selectSqliteBackend({ platform: "ios", appOwnership: "expo" })).toBe("sql-js");
    expect(selectSqliteBackend({ platform: "android", appOwnership: "expo" })).toBe("sql-js");
  });

  it("parks on web (the PWA owns the web sync path)", () => {
    expect(selectSqliteBackend({ platform: "web", appOwnership: null })).toBe("unsupported");
  });
});

// ---------------------------------------------------------------------------
// Schema coverage vs the deployed publication + sync rules (static)
// ---------------------------------------------------------------------------

describe("schema coverage (static)", () => {
  const schemaSource = readFileSync(join(HERE, "../lib/powersync/schema.ts"), "utf8");

  const PUBLICATION_TABLES = [
    // user_own
    "orders",
    "order_tracking_events",
    "notifications",
    "support_tickets",
    "loyalty_points",
    "loyalty_transactions",
    "loyalty_rewards",
    "loyalty_redemptions",
    "consumer_memberships",
    "consumer_reviews",
    // courier
    "drivers",
    "driver_reviews",
    "driver_performance_scores",
    "delivery_tracking_events",
    // merchant (declared for stability)
    "service_providers",
    "provider_catalog_items",
    // global_reference
    "service_verticals",
    "vertical_service_templates",
    "membership_plans",
  ];

  it("declares every table in the v1 publication (19 tables)", () => {
    expect(PUBLICATION_TABLES).toHaveLength(19);
    for (const table of PUBLICATION_TABLES) {
      expect(schemaSource).toMatch(new RegExp(`(^|\\s)${table}[:,]`));
    }
  });

  it("maps money/numeric columns to text and booleans to integer", () => {
    for (const column of ["total_amount", "price", "monthly_price", "tier_progress"]) {
      expect(schemaSource).toMatch(new RegExp(`${column}: column\\.text`));
    }
    for (const column of ["is_active", "is_available", "is_read", "license_verified"]) {
      expect(schemaSource).toMatch(new RegExp(`${column}: column\\.integer`));
    }
  });
});
