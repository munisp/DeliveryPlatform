import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Unit tests for the OPA decision cache + read-path timeout in
 * server/_core/policy.ts (perf wave W2). Mirrors the env-driven module
 * loading pattern of tests/policy.integration.test.ts.
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

async function loadPolicyModule() {
  vi.resetModules();
  return import("./_core/policy");
}

const SUBJECT = {
  id: 7,
  name: "Operator",
  role: "operator",
  scopes: ["platform:read"],
};

const INPUT = {
  subject: SUBJECT,
  permission: "read_platform" as const,
  resource: { type: "tenant" as const, id: "switchos-core" },
};

describe("policy OPA decision cache", () => {
  const originalEnv = {
    PERMIFY_ENDPOINT: process.env.PERMIFY_ENDPOINT,
    OPA_ENDPOINT: process.env.OPA_ENDPOINT,
    OPA_AUTH_TOKEN: process.env.OPA_AUTH_TOKEN,
  };

  beforeEach(() => {
    fetchMock.mockReset();
    process.env.PERMIFY_ENDPOINT = "";
    process.env.OPA_ENDPOINT = "http://127.0.0.1:8181";
    process.env.OPA_AUTH_TOKEN = "opa-test-token";
  });

  afterEach(() => {
    process.env.PERMIFY_ENDPOINT = originalEnv.PERMIFY_ENDPOINT;
    process.env.OPA_ENDPOINT = originalEnv.OPA_ENDPOINT;
    process.env.OPA_AUTH_TOKEN = originalEnv.OPA_AUTH_TOKEN;
  });

  it("serves a repeated (subject, permission, resource) decision from cache, skipping HTTP", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ result: true }),
    });
    const { checkPolicy } = await loadPolicyModule();

    await expect(checkPolicy(INPUT)).resolves.toBe(true);
    await expect(checkPolicy(INPUT)).resolves.toBe(true);
    await expect(checkPolicy(INPUT)).resolves.toBe(true);
    // 1 OPA POST; no Permify call (PERMIFY_ENDPOINT unset -> scope fallback).
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cached denials deny without an HTTP call (denial behavior unchanged)", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ result: false }),
    });
    const { checkPolicy } = await loadPolicyModule();

    await expect(checkPolicy(INPUT)).resolves.toBe(false);
    await expect(checkPolicy(INPUT)).resolves.toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keys decisions per subject/permission/resource", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ result: true }),
    });
    const { checkPolicy } = await loadPolicyModule();

    await checkPolicy(INPUT);
    await checkPolicy({
      ...INPUT,
      subject: { ...SUBJECT, id: 8 },
    });
    await checkPolicy({
      ...INPUT,
      resource: { type: "workspace", id: "ws-1" },
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("invalidateOpaDecisionCache forces a fresh OPA call", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ result: true }),
    });
    const { checkPolicy, invalidateOpaDecisionCache } = await loadPolicyModule();

    await checkPolicy(INPUT);
    invalidateOpaDecisionCache();
    await checkPolicy(INPUT);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("bounds the OPA read at a 500ms timeout", async () => {
    const { checkPolicy } = await loadPolicyModule();

    fetchMock.mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );

    const startedAt = Date.now();
    await expect(checkPolicy(INPUT)).rejects.toThrow(/abort/i);
    const elapsed = Date.now() - startedAt;
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(2_000);
  });

  it("an OPA failure still propagates (fail-closed) and is not cached", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500 });
    const { checkPolicy } = await loadPolicyModule();

    await expect(checkPolicy(INPUT)).rejects.toThrow(/OPA policy check failed: 500/);
    await expect(checkPolicy(INPUT)).rejects.toThrow(/OPA policy check failed: 500/);
    expect(fetchMock).toHaveBeenCalledTimes(2); // failure was not cached
  });
});
