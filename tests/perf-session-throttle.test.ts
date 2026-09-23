import { describe, expect, it, vi, beforeEach } from "vitest";

describe("W2b perf gates: operator session last_seen_at throttle", () => {
  const pgState = vi.hoisted(() => ({
    statements: [] as string[],
    updateReturnsRow: true,
    sessionActive: true,
    poolConfig: null as Record<string, unknown> | null,
  }));

  vi.mock("pg", () => {
    class MockPool {
      constructor(config: Record<string, unknown>) {
        pgState.poolConfig = config;
      }
      async query(text: string) {
        pgState.statements.push(text);
        if (text.includes("UPDATE operator_security_sessions SET last_seen_at")) {
          return { rows: pgState.updateReturnsRow ? [{ id: "s-1" }] : [] };
        }
        if (text.includes("SELECT id FROM operator_security_sessions")) {
          return { rows: pgState.sessionActive ? [{ id: "s-1" }] : [] };
        }
        if (text.includes("SELECT id FROM operator_credentials")) {
          return { rows: [{ id: 1 }] };
        }
        return { rows: [], rowCount: 0 };
      }
      async connect() {
        return { query: this.query.bind(this), release: () => undefined };
      }
    }
    return { default: { Pool: MockPool }, Pool: MockPool };
  });

  beforeEach(() => {
    pgState.statements.length = 0;
    pgState.updateReturnsRow = true;
    pgState.sessionActive = true;
    pgState.poolConfig = null;
    vi.resetModules();
  });

  const updates = () =>
    pgState.statements.filter((stmt) =>
      stmt.includes("UPDATE operator_security_sessions SET last_seen_at"),
    );

  it("writes last_seen_at once, then serves the second request within 60s without an UPDATE", async () => {
    const store = await import("../server/_core/operatorAuthStore");
    await expect(
      store.isOperatorSecuritySessionActive(7, "session-throttle-a"),
    ).resolves.toBe(true);
    expect(updates()).toHaveLength(1);
    expect(updates()[0]).toContain("INTERVAL '60 seconds'");

    await expect(
      store.isOperatorSecuritySessionActive(7, "session-throttle-a"),
    ).resolves.toBe(true);
    // Second request inside the throttle window: no UPDATE at all — only the
    // read-only activity confirmation.
    expect(updates()).toHaveLength(1);
    expect(
      pgState.statements.some((stmt) =>
        stmt.includes("SELECT id FROM operator_security_sessions"),
      ),
    ).toBe(true);
  });

  it("falls back to a read-only activity check when the DB-side freshness guard absorbs the write", async () => {
    pgState.updateReturnsRow = false;
    const store = await import("../server/_core/operatorAuthStore");
    await expect(
      store.isOperatorSecuritySessionActive(7, "session-throttle-b"),
    ).resolves.toBe(true);
    expect(updates()).toHaveLength(1);
    expect(
      pgState.statements.some((stmt) =>
        stmt.includes("SELECT id FROM operator_security_sessions"),
      ),
    ).toBe(true);
  });

  it("still rejects revoked or expired sessions inside the throttle window", async () => {
    const store = await import("../server/_core/operatorAuthStore");
    await store.isOperatorSecuritySessionActive(7, "session-throttle-c");
    pgState.sessionActive = false;
    await expect(
      store.isOperatorSecuritySessionActive(7, "session-throttle-c"),
    ).resolves.toBe(false);
  });

  it("bounds the operator-auth satellite pool with a statement_timeout", async () => {
    const store = await import("../server/_core/operatorAuthStore");
    store.getOperatorAuthPool();
    expect(pgState.poolConfig).toMatchObject({
      max: 5,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 30000,
    });
    expect(`${pgState.poolConfig?.options}`).toContain("statement_timeout");
  });
});

