/**
 * Shared client-side resilience standard for server-side calls to internal
 * services and external APIs: per-host circuit breaker (closed/open/half-open),
 * per-attempt timeout via AbortController, and bounded retries with
 * exponential backoff + jitter for idempotent HTTP methods only.
 *
 * No new dependencies; wraps global fetch.
 */

export type BreakerState = "closed" | "open" | "half-open";

export class CircuitOpenError extends Error {
  readonly host: string;

  constructor(host: string) {
    super(`circuit breaker is open for host ${host}`);
    this.name = "CircuitOpenError";
    this.host = host;
  }
}

export type BreakerOptions = {
  /** Consecutive failures before the breaker opens. Default 5. */
  failureThreshold?: number;
  /** How long the breaker stays open before half-open probes. Default 30000ms. */
  resetTimeoutMs?: number;
  /** Concurrent probe requests allowed while half-open. Default 1. */
  halfOpenMaxProbes?: number;
  /** Injectable clock for tests. */
  now?: () => number;
};

export class CircuitBreaker {
  private state: BreakerState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private halfOpenInFlight = 0;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly halfOpenMaxProbes: number;
  private readonly now: () => number;

  constructor(options: BreakerOptions = {}) {
    this.failureThreshold = Math.max(1, options.failureThreshold ?? 5);
    this.resetTimeoutMs = options.resetTimeoutMs ?? 30_000;
    this.halfOpenMaxProbes = Math.max(1, options.halfOpenMaxProbes ?? 1);
    this.now = options.now ?? Date.now;
  }

  getState(): BreakerState {
    if (this.state === "open" && this.now() - this.openedAt >= this.resetTimeoutMs) {
      this.state = "half-open";
      this.halfOpenInFlight = 0;
    }
    return this.state;
  }

  allow(): boolean {
    const state = this.getState();
    if (state === "closed") return true;
    if (state === "half-open") {
      if (this.halfOpenInFlight >= this.halfOpenMaxProbes) return false;
      this.halfOpenInFlight += 1;
      return true;
    }
    return false;
  }

  reportSuccess(): void {
    if (this.state === "half-open") {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      this.state = "closed";
    }
    this.consecutiveFailures = 0;
  }

  reportFailure(): void {
    if (this.state === "half-open") {
      this.halfOpenInFlight = Math.max(0, this.halfOpenInFlight - 1);
      this.open();
      return;
    }
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.open();
    }
  }

  /** Return to closed with no recorded failures (test support). */
  reset(): void {
    this.state = "closed";
    this.consecutiveFailures = 0;
    this.openedAt = 0;
    this.halfOpenInFlight = 0;
  }

  private open(): void {
    this.state = "open";
    this.openedAt = this.now();
    this.consecutiveFailures = 0;
    this.halfOpenInFlight = 0;
  }
}

const breakers = new Map<string, CircuitBreaker>();

/** Return (creating if needed) the shared breaker for a URL host. */
export function breakerFor(host: string): CircuitBreaker {
  let breaker = breakers.get(host);
  if (!breaker) {
    breaker = new CircuitBreaker();
    breakers.set(host, breaker);
  }
  return breaker;
}

/** Reset all shared breakers (test support). */
export function resetBreakers(): void {
  breakers.clear();
}

const IDEMPOTENT_METHODS = new Set(["GET", "HEAD", "OPTIONS", "PUT", "DELETE"]);

export type ResilientFetchOptions = {
  /** Per-attempt timeout. Default 10000ms. */
  timeoutMs?: number;
  /** Total attempts including the first (idempotent methods only). Default 3. */
  maxAttempts?: number;
  /** Base backoff before the first retry. Default 100ms. */
  backoffBaseMs?: number;
  /** Backoff ceiling. Default 2000ms. */
  backoffCapMs?: number;
  /** Override the breaker (defaults to the shared per-host breaker). */
  breaker?: CircuitBreaker;
  /** Injectable sleep for tests. */
  sleep?: (ms: number) => Promise<void>;
};

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * FAIL_OPEN_FAST — options preset for callers that treat a dependency as
 * optional (fail-open/fail-fast semantics; perf wave W2, audit finding 16).
 *
 *   { timeoutMs: 1500, breaker failureThreshold: 2 }
 *
 * Rationale: the defaults (10s timeout, breaker opens after 5 consecutive
 * failures) mean the first ~5 requests to a dead dependency each burn up to
 * 10s before the breaker opens. With this preset a dead dependency costs at
 * most 2 probes of <=1.5s, then every call fails in ~0ms (CircuitOpenError)
 * until the breaker half-opens after the reset timeout.
 *
 * The preset's breaker is SHARED across all FAIL_OPEN_FAST callers (not
 * per-host): once the environment has killed two optional-dependency calls,
 * all fail-open callers fail fast together. Spread it into the call:
 * `resilientFetch(url, { ...FAIL_OPEN_FAST, method: "POST", ... })`.
 * Whether the caller then fails open or closed is its own decision — the
 * preset only bounds the latency of finding out.
 */
const failOpenFastBreaker = new CircuitBreaker({ failureThreshold: 2 });

export const FAIL_OPEN_FAST: ResilientFetchOptions = Object.freeze({
  timeoutMs: 1_500,
  breaker: failOpenFastBreaker,
});

/** Reset the shared FAIL_OPEN_FAST breaker (test support). */
export function resetFailOpenFastBreaker(): void {
  failOpenFastBreaker.reset();
}

function backoffMs(retryIndex: number, base: number, cap: number): number {
  const ceiling = Math.min(cap, base * 2 ** (retryIndex - 1));
  return Math.random() * ceiling;
}

/**
 * fetch with timeout, bounded retry-with-backoff (idempotent methods only)
 * and a per-host circuit breaker. Rejects with CircuitOpenError when the
 * breaker is open. A terminal 5xx response (after retries) is returned to the
 * caller like any other response.
 */
export async function resilientFetch(
  input: string | URL,
  init: RequestInit & ResilientFetchOptions = {},
): Promise<Response> {
  const {
    timeoutMs = 10_000,
    maxAttempts = 3,
    backoffBaseMs = 100,
    backoffCapMs = 2_000,
    sleep = defaultSleep,
    ...fetchInit
  } = init;
  const url = typeof input === "string" ? input : input.toString();
  const host = new URL(url).host;
  const breaker = init.breaker ?? breakerFor(host);
  const method = (fetchInit.method ?? "GET").toUpperCase();
  const attempts = IDEMPOTENT_METHODS.has(method) ? Math.max(1, maxAttempts) : 1;

  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (attempt > 1) {
      await sleep(backoffMs(attempt - 1, backoffBaseMs, backoffCapMs));
    }
    if (!breaker.allow()) {
      throw new CircuitOpenError(host);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const callerSignal = fetchInit.signal;
    const onCallerAbort = () => controller.abort();
    if (callerSignal) {
      if (callerSignal.aborted) {
        clearTimeout(timer);
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }

    try {
      const response = await fetch(url, { ...fetchInit, signal: controller.signal });
      if (response.status >= 500) {
        breaker.reportFailure();
        if (attempt < attempts) {
          lastError = new Error(`upstream returned status ${response.status}`);
          // Drain the body so keep-alive connections can be reused.
          await response.arrayBuffer().catch(() => undefined);
          continue;
        }
        return response;
      }
      breaker.reportSuccess();
      return response;
    } catch (error) {
      breaker.reportFailure();
      lastError = error;
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  }
  throw lastError;
}
