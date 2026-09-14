import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CircuitBreaker,
  CircuitOpenError,
  breakerFor,
  resetBreakers,
  resilientFetch,
} from "./_core/resilientFetch";

const noSleep = () => Promise.resolve();

function jsonResponse(status: number, body = "{}"): Response {
  return new Response(body, { status, headers: { "content-type": "application/json" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetBreakers();
});

describe("CircuitBreaker", () => {
  it("opens after the consecutive failure threshold and rejects while open", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 60_000 });
    expect(breaker.getState()).toBe("closed");
    breaker.allow();
    breaker.reportFailure();
    breaker.allow();
    breaker.reportFailure();
    expect(breaker.getState()).toBe("closed");
    breaker.allow();
    breaker.reportFailure();
    expect(breaker.getState()).toBe("open");
    expect(breaker.allow()).toBe(false);
  });

  it("resets the failure count on success", () => {
    const breaker = new CircuitBreaker({ failureThreshold: 2 });
    breaker.allow();
    breaker.reportFailure();
    breaker.allow();
    breaker.reportSuccess();
    breaker.allow();
    breaker.reportFailure();
    expect(breaker.getState()).toBe("closed");
  });

  it("allows a half-open probe after the reset timeout and closes on success", () => {
    let now = 1_000;
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 30_000, now: () => now });
    breaker.allow();
    breaker.reportFailure();
    expect(breaker.getState()).toBe("open");
    expect(breaker.allow()).toBe(false);
    now += 31_000;
    expect(breaker.getState()).toBe("half-open");
    expect(breaker.allow()).toBe(true);
    expect(breaker.allow()).toBe(false); // single probe at a time
    breaker.reportSuccess();
    expect(breaker.getState()).toBe("closed");
  });

  it("re-opens when a half-open probe fails", () => {
    let now = 0;
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10_000, now: () => now });
    breaker.allow();
    breaker.reportFailure();
    now += 11_000;
    expect(breaker.allow()).toBe(true);
    breaker.reportFailure();
    expect(breaker.getState()).toBe("open");
    expect(breaker.allow()).toBe(false);
  });
});

describe("resilientFetch", () => {
  it("retries idempotent GET requests after failures", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse(200, '{"ok":true}'));
    vi.stubGlobal("fetch", fetchMock);

    const response = await resilientFetch("http://internal.test/health", {
      sleep: noSleep,
      backoffBaseMs: 1,
    });
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-idempotent POST requests", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resilientFetch("http://internal.test/submit", { method: "POST", body: "{}", sleep: noSleep }),
    ).rejects.toThrow("fetch failed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("opens the breaker after repeated 5xx and short-circuits", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(503));
    vi.stubGlobal("fetch", fetchMock);
    const breaker = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 60_000 });

    for (let i = 0; i < 2; i += 1) {
      const response = await resilientFetch("http://flaky.test/api", {
        breaker,
        sleep: noSleep,
        backoffBaseMs: 1,
        maxAttempts: 1,
      });
      expect(response.status).toBe(503);
    }
    expect(breaker.getState()).toBe("open");
    await expect(
      resilientFetch("http://flaky.test/api", { breaker, sleep: noSleep }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("shares breakers per host via breakerFor", () => {
    expect(breakerFor("a.test:443")).toBe(breakerFor("a.test:443"));
    expect(breakerFor("a.test:443")).not.toBe(breakerFor("b.test"));
  });

  it("aborts attempts that exceed the timeout", async () => {
    const fetchMock = vi.fn().mockImplementation(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            reject(new DOMException("The operation was aborted.", "AbortError"));
          });
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resilientFetch("http://slow.test/hang", {
        timeoutMs: 20,
        maxAttempts: 1,
        breaker: new CircuitBreaker(),
      }),
    ).rejects.toThrow(/abort/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
