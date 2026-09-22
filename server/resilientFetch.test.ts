import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CircuitBreaker,
  CircuitOpenError,
  FAIL_OPEN_FAST,
  breakerFor,
  resetBreakers,
  resetFailOpenFastBreaker,
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

describe("FAIL_OPEN_FAST preset", () => {
  afterEach(() => {
    resetFailOpenFastBreaker();
  });

  it("carries a 1500ms timeout and a failureThreshold-2 breaker", () => {
    expect(FAIL_OPEN_FAST.timeoutMs).toBe(1_500);
    expect(FAIL_OPEN_FAST.breaker).toBeInstanceOf(CircuitBreaker);
  });

  it("fails fast after 2 probes: the third call never reaches fetch (~0ms)", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    for (let i = 0; i < 2; i += 1) {
      await expect(
        resilientFetch("http://optional.test/screen", {
          ...FAIL_OPEN_FAST,
          method: "POST",
          body: "{}",
          sleep: noSleep,
        }),
      ).rejects.toThrow("fetch failed");
    }
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const startedAt = Date.now();
    await expect(
      resilientFetch("http://optional.test/screen", {
        ...FAIL_OPEN_FAST,
        method: "POST",
        body: "{}",
        sleep: noSleep,
      }),
    ).rejects.toBeInstanceOf(CircuitOpenError);
    expect(Date.now() - startedAt).toBeLessThan(50);
    expect(fetchMock).toHaveBeenCalledTimes(2); // open breaker: no HTTP attempt
  });

  it("aborts a hung dependency after 1500ms instead of the 10s default", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn().mockImplementation(
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => {
              reject(new DOMException("The operation was aborted.", "AbortError"));
            });
          }),
      );
      vi.stubGlobal("fetch", fetchMock);

      const pending = resilientFetch("http://optional.test/hang", {
        ...FAIL_OPEN_FAST,
        method: "POST",
        body: "{}",
      });
      const assertion = expect(pending).rejects.toThrow(/abort/i);
      await vi.advanceTimersByTimeAsync(1_499);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a success after a failure keeps the breaker closed", async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("fetch failed"))
      .mockResolvedValueOnce(jsonResponse(200, '{"ok":true}'))
      .mockRejectedValue(new TypeError("fetch failed"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      resilientFetch("http://optional.test/screen", { ...FAIL_OPEN_FAST, method: "POST", body: "{}" }),
    ).rejects.toThrow("fetch failed");
    const ok = await resilientFetch("http://optional.test/screen", {
      ...FAIL_OPEN_FAST,
      method: "POST",
      body: "{}",
    });
    expect(ok.status).toBe(200);
    // The success reset the consecutive-failure count, so a single failure
    // is tolerated again...
    await expect(
      resilientFetch("http://optional.test/screen", { ...FAIL_OPEN_FAST, method: "POST", body: "{}" }),
    ).rejects.toThrow("fetch failed");
    expect(FAIL_OPEN_FAST.breaker?.getState()).toBe("closed");
    // ...and the second consecutive failure opens it.
    await expect(
      resilientFetch("http://optional.test/screen", { ...FAIL_OPEN_FAST, method: "POST", body: "{}" }),
    ).rejects.toThrow("fetch failed");
    expect(FAIL_OPEN_FAST.breaker?.getState()).toBe("open");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
