import { generateKeyPairSync, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

/**
 * PowerSync integration contract pins.
 *
 * Static pins lock the integration contract: the `powersync` publication
 * (migration 0103), the four sync-rule role groups within bucket limits, the
 * Postgres bucket-storage service config, the fail-closed token/upload
 * endpoints, and the strict upload whitelist. Behavioral tests exercise the
 * JWT claims/expiry math with an in-test RS256 keypair and the whitelist
 * dispatch with a mocked data-access layer — no database required.
 */

const dbMocks = vi.hoisted(() => ({ getPool: vi.fn() }));
const consumerMocks = vi.hoisted(() => ({ openConsumerSupportCase: vi.fn() }));
// Upload-bridge tests flip this to exercise the configured path; the token
// endpoint test leaves it false to prove fail-closed behavior.
const configFlags = vi.hoisted(() => ({ powerSyncConfigured: false }));

vi.mock("../server/db", () => dbMocks);
vi.mock("../server/_core/consumerQueries", () => consumerMocks);
vi.mock("../server/_core/powersyncToken", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../server/_core/powersyncToken")>();
  return {
    ...actual,
    isPowerSyncConfigured: () => configFlags.powerSyncConfigured,
  };
});

import {
  POWERSYNC_TOKEN_MAX_TTL_SECONDS,
  buildPowerSyncJwt,
  clampPowerSyncTokenTtlSeconds,
  isPowerSyncConfigured,
  powerSyncTokenHandler,
} from "../server/_core/powersyncToken";
import {
  POWERSYNC_UPLOAD_WHITELIST,
  isPowerSyncUploadAllowed,
  powerSyncUploadHandler,
} from "../server/_core/powersyncUpload";

function mockRes() {
  const res: { status: ReturnType<typeof vi.fn>; json: ReturnType<typeof vi.fn> } = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res;
}

const root = resolve(import.meta.dirname, "..");
const read = (path: string) => readFileSync(resolve(root, path), "utf8");

describe("powersync publication migration (0103)", () => {
  const sql = read("drizzle/0103_powersync_sync_support.sql");

  it("creates the contractually-named powersync publication", () => {
    expect(sql).toContain("CREATE PUBLICATION powersync");
    expect(sql).toContain("pg_publication");
  });

  it("publishes the v1 consumer/courier read-sync table set", () => {
    for (const table of [
      "orders",
      "order_tracking_events",
      "delivery_tracking_events",
      "notifications",
      "support_tickets",
      "loyalty_points",
      "loyalty_transactions",
      "loyalty_rewards",
      "loyalty_redemptions",
      "consumer_memberships",
      "consumer_reviews",
      "drivers",
      "driver_reviews",
      "driver_performance_scores",
      "service_providers",
      "provider_catalog_items",
      "service_verticals",
      "vertical_service_templates",
      "membership_plans",
    ]) {
      expect(sql).toContain(`powersync ADD TABLE public.${table}`);
    }
  });

  it("is idempotent via guarded DO blocks and never publishes money/PII/session tables", () => {
    expect(sql).toContain("IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname = 'powersync_replication')");
    expect(sql).toContain("pg_publication_tables");
    for (const excluded of [
      "transactions",
      "wallets",
      "ledger_entries",
      "mojaloop_transfers",
      "payout_settlements",
      "rider_verifications",
      "session_revocations",
      "delivery_proofs",
    ]) {
      expect(sql).not.toContain(`ADD TABLE public.${excluded}`);
    }
  });
});

describe("powersync service + sync rules config", () => {
  const service = read("deploy/powersync/service.yaml");
  const rules = read("deploy/powersync/sync-rules.yaml");

  it("uses Postgres bucket storage and the JWKS client-auth block", () => {
    expect(service).toContain("type: postgresql");
    expect(service).toContain("port: 8080");
    expect(service).toContain("jwks_uri:");
    expect(service).toContain("sync-rules.yaml");
    expect(service).toContain("!env PS_SOURCE_URI");
    expect(service).toContain("!env PS_STORAGE_URI");
    expect(service).not.toContain("mongodb");
  });

  it("ships the four role bucket groups parameterized by token claims", () => {
    for (const group of ["global_reference", "user_own", "courier_assignments", "merchant_store", "operator_admin"]) {
      expect(rules).toContain(`${group}:`);
    }
    expect(rules).toContain("token_parameters.user_id");
    expect(rules).toContain("token_parameters.driver_id");
    expect(rules).toContain("token_parameters.provider_id");
    expect(rules).toContain("token_parameters.role = 'courier'");
    expect(rules).toContain("token_parameters.role = 'merchant'");
    expect(rules).toContain("token_parameters.role = 'operator'");
  });

  it("documents the 1000-bucket / 1000-parameter-row limits and stays far below them", () => {
    expect(rules).toContain("<=1000 buckets/connection");
    expect(rules).toContain("<=1000 parameter-query rows");
    // One parameter row per user per group -> at most 5 buckets/connection.
    const parameterQueries = rules.match(/parameters:/g) ?? [];
    expect(parameterQueries.length).toBeLessThanOrEqual(4);
  });
});

describe("powersync JWT minting", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();

  function decode(token: string) {
    const [h, p, s] = token.split(".");
    return {
      header: JSON.parse(Buffer.from(h, "base64url").toString()),
      payload: JSON.parse(Buffer.from(p, "base64url").toString()),
      signingInput: `${h}.${p}`,
      signature: Buffer.from(s, "base64url"),
    };
  }

  it("mints RS256 tokens with sub/aud/role claims and verifiable signatures", () => {
    const { token, expiresAt, kid } = buildPowerSyncJwt({
      subject: "42",
      audience: "powersync",
      role: "courier",
      driverId: 7,
      ttlSeconds: 3600,
      privateKeyPem,
      issuedAtEpochSeconds: 1_800_000_000,
    });
    const { header, payload, signingInput, signature } = decode(token);
    expect(header.alg).toBe("RS256");
    expect(header.kid).toBe(kid);
    expect(payload.sub).toBe("42");
    expect(payload.aud).toBe("powersync");
    expect(payload.role).toBe("courier");
    expect(payload.driver_id).toBe(7);
    expect(payload.exp).toBe(expiresAt);
    expect(payload.exp - payload.iat).toBe(3600);
    expect(
      cryptoVerify("RSA-SHA256", Buffer.from(signingInput), publicKeyPem, signature),
    ).toBe(true);
  });

  it("clamps TTL to the <=3600s envelope in both directions", () => {
    expect(POWERSYNC_TOKEN_MAX_TTL_SECONDS).toBe(3600);
    expect(clampPowerSyncTokenTtlSeconds(86_400)).toBe(3600);
    expect(clampPowerSyncTokenTtlSeconds(1)).toBe(60);
    expect(clampPowerSyncTokenTtlSeconds(undefined)).toBe(3600);
    const { payload } = decode(
      buildPowerSyncJwt({
        subject: "1",
        audience: "powersync",
        role: "consumer",
        ttlSeconds: 86_400,
        privateKeyPem,
      }).token,
    );
    expect(payload.exp - payload.iat).toBeLessThanOrEqual(3600);
  });

  it("supports the HS256 dev fallback and fails closed with no key material", () => {
    const { token } = buildPowerSyncJwt({
      subject: "9",
      audience: "powersync",
      role: "consumer",
      ttlSeconds: 300,
      hs256Secret: "dev-secret",
      issuedAtEpochSeconds: 1_800_000_000,
    });
    expect(decode(token).header.alg).toBe("HS256");
    expect(() =>
      buildPowerSyncJwt({
        subject: "9",
        audience: "powersync",
        role: "consumer",
        ttlSeconds: 300,
      }),
    ).toThrow("powersync_not_configured");
  });

  it("token endpoint fails closed 503 when unconfigured and 401 without a session", async () => {
    // configFlags.powerSyncConfigured is false here -> 503 fail-closed.
    expect(isPowerSyncConfigured()).toBe(false);
    const res = mockRes();
    await powerSyncTokenHandler(
      { user: { id: 1 }, query: {}, body: {} } as never,
      res as never,
    );
    expect(res.status).toHaveBeenCalledWith(503);
    expect(res.json).toHaveBeenCalledWith({ error: "powersync_not_configured" });

    const unauthRes = mockRes();
    await powerSyncTokenHandler({ user: null, query: {}, body: {} } as never, unauthRes as never);
    expect(unauthRes.status).toHaveBeenCalledWith(401);
  });
});

describe("powersync upload bridge whitelist", () => {
  it("ships exactly the v1 whitelist: support_tickets PUT only", () => {
    expect(Object.keys(POWERSYNC_UPLOAD_WHITELIST)).toEqual(["support_tickets"]);
    expect(isPowerSyncUploadAllowed("support_tickets", "PUT")).toBe(true);
    expect(isPowerSyncUploadAllowed("support_tickets", "PATCH")).toBe(false);
    expect(isPowerSyncUploadAllowed("support_tickets", "DELETE")).toBe(false);
    expect(isPowerSyncUploadAllowed("orders", "PUT")).toBe(false);
    expect(isPowerSyncUploadAllowed("loyalty_points", "PATCH")).toBe(false);
    expect(isPowerSyncUploadAllowed("transactions", "PUT")).toBe(false);
  });

  it("dispatches support_tickets PUT with an entry-derived idempotency key", async () => {
    configFlags.powerSyncConfigured = true;
    await POWERSYNC_UPLOAD_WHITELIST.support_tickets.PUT!(7, {
      id: 42,
      op: "PUT",
      table: "support_tickets",
      data: { type: "general", subject: "late order", description: "2h late" },
    });
    expect(consumerMocks.openConsumerSupportCase).toHaveBeenCalledWith({
      consumerUserId: 7,
      orderId: null,
      type: "general",
      subject: "late order",
      description: "2h late",
      idempotencyKey: "powersync-upload-42",
    });
  });

  it("rejects unknown tables with 400 and bad envelopes with 400", async () => {
    configFlags.powerSyncConfigured = true;
    const unknownRes = mockRes();
    await powerSyncUploadHandler(
      {
        user: { id: 1 },
        body: { entries: [{ id: 1, op: "PUT", table: "orders", data: {} }] },
      } as never,
      unknownRes as never,
    );
    expect(unknownRes.status).toHaveBeenCalledWith(400);
    expect(unknownRes.json).toHaveBeenCalledWith(
      expect.objectContaining({ error: "powersync_upload_not_allowed" }),
    );

    const badEnvelopeRes = mockRes();
    await powerSyncUploadHandler(
      { user: { id: 1 }, body: { entries: [] } } as never,
      badEnvelopeRes as never,
    );
    expect(badEnvelopeRes.status).toHaveBeenCalledWith(400);
  });

  it("returns non-2xx when a handler fails so the SDK retries", async () => {
    configFlags.powerSyncConfigured = true;
    consumerMocks.openConsumerSupportCase.mockRejectedValueOnce(new Error("db down"));
    const res = mockRes();
    await powerSyncUploadHandler(
      {
        user: { id: 1 },
        body: {
          entries: [
            {
              id: 1,
              op: "PUT",
              table: "support_tickets",
              data: { type: "general", subject: "s", description: "d" },
            },
          ],
        },
      } as never,
      res as never,
    );
    const status = res.status.mock.calls[0][0] as number;
    expect(status).toBeGreaterThanOrEqual(400);
  });
});

describe("server wiring", () => {
  const index = read("server/_core/index.ts");
  const env = read("server/_core/env.ts");
  const envExample = read(".env.example");

  it("mounts the token, JWKS, and upload endpoints with rate limits", () => {
    expect(index).toContain('app.get("/api/powersync/jwks.json", rateLimit(60), powerSyncJwksHandler)');
    expect(index).toContain('app.get("/api/powersync/token", rateLimit(60), powerSyncTokenHandler)');
    expect(index).toContain('app.post("/api/powersync/token", rateLimit(60), powerSyncTokenHandler)');
    expect(index).toContain('app.post("/api/powersync/upload", rateLimit(120), powerSyncUploadHandler)');
  });

  it("declares the POWERSYNC_* env surface fail-closed", () => {
    for (const name of [
      "POWERSYNC_JWT_AUDIENCE",
      "POWERSYNC_JWT_PRIVATE_KEY",
      "POWERSYNC_JWT_SECRET",
      "POWERSYNC_SERVICE_URL",
    ]) {
      expect(env).toContain(name);
      expect(envExample).toContain(name);
    }
  });
});
