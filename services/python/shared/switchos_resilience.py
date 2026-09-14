"""SwitchOS shared Python resilience + metrics standard.

Dependency-free helpers for the polyglot services:

- ``CircuitBreaker``: closed/open/half-open breaker with a consecutive
  failure threshold and reset timeout.
- ``ResilientSession``: a ``requests.Session`` subclass adding per-host
  circuit breaking plus bounded retries with exponential backoff and jitter
  for idempotent HTTP methods only (GET/HEAD/OPTIONS/PUT/DELETE).
- ``request_with_resilience`` (async): the same standard for ``httpx``
  asyncio call sites.
- ``MetricsRegistry``: hand-rolled Prometheus text exposition (request
  counts, latency histogram, error counts, uptime/version gauges) with a
  FastAPI/Starlette middleware factory. Used where ``prometheus_client`` is
  not already a dependency.
"""

from __future__ import annotations

import asyncio
import random
import threading
import time
from typing import Any, Callable, Mapping

import requests

IDEMPOTENT_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "PUT", "DELETE"})


class CircuitOpenError(RuntimeError):
    """Raised when a call is rejected by an open circuit breaker."""

    def __init__(self, host: str) -> None:
        super().__init__(f"circuit breaker is open for host {host!r}")
        self.host = host


class CircuitBreaker:
    """Thread-safe closed/open/half-open circuit breaker."""

    CLOSED = "closed"
    OPEN = "open"
    HALF_OPEN = "half-open"

    def __init__(
        self,
        failure_threshold: int = 5,
        reset_timeout_seconds: float = 30.0,
        half_open_max_probes: int = 1,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        if failure_threshold < 1:
            raise ValueError("failure_threshold must be >= 1")
        self._failure_threshold = failure_threshold
        self._reset_timeout = reset_timeout_seconds
        self._half_open_max_probes = half_open_max_probes
        self._clock = clock
        self._lock = threading.Lock()
        self._state = self.CLOSED
        self._consecutive_failures = 0
        self._opened_at = 0.0
        self._half_open_in_flight = 0

    @property
    def state(self) -> str:
        with self._lock:
            return self._state_locked()

    def _state_locked(self) -> str:
        if self._state == self.OPEN and self._clock() - self._opened_at >= self._reset_timeout:
            self._state = self.HALF_OPEN
            self._half_open_in_flight = 0
        return self._state

    def allow(self) -> bool:
        """Return True if a call may proceed (reserving a half-open probe slot)."""
        with self._lock:
            state = self._state_locked()
            if state == self.CLOSED:
                return True
            if state == self.HALF_OPEN:
                if self._half_open_in_flight >= self._half_open_max_probes:
                    return False
                self._half_open_in_flight += 1
                return True
            return False

    def report_success(self) -> None:
        with self._lock:
            if self._state == self.HALF_OPEN:
                self._half_open_in_flight = max(0, self._half_open_in_flight - 1)
                self._state = self.CLOSED
            self._consecutive_failures = 0

    def report_failure(self) -> None:
        with self._lock:
            if self._state == self.HALF_OPEN:
                self._half_open_in_flight = max(0, self._half_open_in_flight - 1)
                self._open_locked()
                return
            self._consecutive_failures += 1
            if self._consecutive_failures >= self._failure_threshold:
                self._open_locked()

    def _open_locked(self) -> None:
        self._state = self.OPEN
        self._opened_at = self._clock()
        self._consecutive_failures = 0
        self._half_open_in_flight = 0


def _host_of(url: str) -> str:
    from urllib.parse import urlparse

    return urlparse(url).netloc or url


def _backoff_seconds(retry_index: int, base: float, cap: float) -> float:
    """Full-jitter exponential backoff for the given 1-based retry index."""
    ceiling = min(cap, base * (2 ** (retry_index - 1)))
    return random.uniform(0, ceiling)


class ResilientSession(requests.Session):
    """requests.Session with timeout default, per-host circuit breaking and
    bounded retry-with-backoff for idempotent methods only."""

    def __init__(
        self,
        *,
        default_timeout: float = 10.0,
        max_attempts: int = 3,
        backoff_base: float = 0.1,
        backoff_cap: float = 2.0,
        failure_threshold: int = 5,
        reset_timeout_seconds: float = 30.0,
        sleeper: Callable[[float], None] = time.sleep,
    ) -> None:
        super().__init__()
        self.default_timeout = default_timeout
        self.max_attempts = max(1, max_attempts)
        self.backoff_base = backoff_base
        self.backoff_cap = backoff_cap
        self.failure_threshold = failure_threshold
        self.reset_timeout_seconds = reset_timeout_seconds
        self._sleeper = sleeper
        self._breakers: dict[str, CircuitBreaker] = {}
        self._breakers_lock = threading.Lock()

    def breaker_for(self, url: str) -> CircuitBreaker:
        host = _host_of(url)
        with self._breakers_lock:
            breaker = self._breakers.get(host)
            if breaker is None:
                breaker = CircuitBreaker(self.failure_threshold, self.reset_timeout_seconds)
                self._breakers[host] = breaker
            return breaker

    def request(self, method: str, url: str, **kwargs: Any) -> requests.Response:  # noqa: A003 - match requests API
        kwargs.setdefault("timeout", self.default_timeout)
        breaker = self.breaker_for(url)
        retryable = method.upper() in IDEMPOTENT_METHODS
        attempts = self.max_attempts if retryable else 1

        last_error: Exception | None = None
        for attempt in range(1, attempts + 1):
            if attempt > 1:
                self._sleeper(_backoff_seconds(attempt - 1, self.backoff_base, self.backoff_cap))
            if not breaker.allow():
                raise CircuitOpenError(_host_of(url))
            try:
                response = super().request(method, url, **kwargs)
            except requests.RequestException as error:
                breaker.report_failure()
                last_error = error
                continue
            if response.status_code >= 500:
                breaker.report_failure()
                last_error = requests.HTTPError(
                    f"upstream returned status {response.status_code}", response=response
                )
                if attempt < attempts:
                    response.close()
                    continue
                return response
            breaker.report_success()
            return response
        assert last_error is not None
        raise last_error


async def request_with_resilience(
    client: Any,
    method: str,
    url: str,
    *,
    max_attempts: int = 3,
    backoff_base: float = 0.1,
    backoff_cap: float = 2.0,
    breaker: CircuitBreaker | None = None,
    **kwargs: Any,
) -> Any:
    """Async equivalent of ResilientSession.request for httpx.AsyncClient."""
    retryable = method.upper() in IDEMPOTENT_METHODS
    attempts = max(1, max_attempts) if retryable else 1
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        if attempt > 1:
            await asyncio.sleep(_backoff_seconds(attempt - 1, backoff_base, backoff_cap))
        if breaker is not None and not breaker.allow():
            raise CircuitOpenError(_host_of(url))
        try:
            response = await client.request(method, url, **kwargs)
        except Exception as error:  # httpx.TransportError and friends
            if breaker is not None:
                breaker.report_failure()
            last_error = error
            continue
        if response.status_code >= 500:
            if breaker is not None:
                breaker.report_failure()
            if attempt < attempts:
                last_error = RuntimeError(f"upstream returned status {response.status_code}")
                continue
            return response
        if breaker is not None:
            breaker.report_success()
        return response
    assert last_error is not None
    raise last_error


DEFAULT_BUCKETS = (0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0)


class MetricsRegistry:
    """Dependency-free Prometheus text exposition registry."""

    def __init__(self, service: str, version: str = "unknown") -> None:
        self.service = service
        self.version = version or "unknown"
        self._started = time.monotonic()
        self._lock = threading.Lock()
        self._counters: dict[tuple[str, tuple[tuple[str, str], ...]], list[float]] = {}
        self._counter_help: dict[str, str] = {}
        self._histograms: dict[str, dict[tuple[tuple[str, str], ...], dict[str, Any]]] = {}

    def inc(self, name: str, help_text: str, labels: Mapping[str, str] | None = None, amount: float = 1.0) -> None:
        key = (name, tuple(sorted((labels or {}).items())))
        with self._lock:
            self._counter_help.setdefault(name, help_text)
            bucket = self._counters.setdefault(key, [0.0])
            bucket[0] += amount

    def observe(self, name: str, seconds: float, labels: Mapping[str, str] | None = None) -> None:
        key = tuple(sorted((labels or {}).items()))
        with self._lock:
            series = self._histograms.setdefault(name, {})
            entry = series.setdefault(key, {"buckets": [0] * (len(DEFAULT_BUCKETS) + 1), "sum": 0.0})
            entry["sum"] += seconds
            for index, bound in enumerate(DEFAULT_BUCKETS):
                if seconds <= bound:
                    entry["buckets"][index] += 1
                    break
            else:
                entry["buckets"][len(DEFAULT_BUCKETS)] += 1

    @staticmethod
    def _render_labels(labels: tuple[tuple[str, str], ...]) -> str:
        if not labels:
            return ""
        inner = ",".join(f'{key}="{value}"' for key, value in labels)
        return "{" + inner + "}"

    def render(self) -> str:
        with self._lock:
            lines: list[str] = []
            lines.append("# HELP service_info Static service metadata gauge (always 1).")
            lines.append("# TYPE service_info gauge")
            lines.append(f'service_info{{service="{self.service}",version="{self.version}"}} 1')
            lines.append("# HELP service_uptime_seconds Seconds since the service process started.")
            lines.append("# TYPE service_uptime_seconds gauge")
            lines.append(
                f'service_uptime_seconds{{service="{self.service}"}} {time.monotonic() - self._started:.3f}'
            )
            for (name, labels), bucket in sorted(self._counters.items()):
                lines.append(f"# HELP {name} {self._counter_help.get(name, name)}")
                lines.append(f"# TYPE {name} counter")
                lines.append(f"{name}{self._render_labels(labels)} {bucket[0]:g}")
            for name in sorted(self._histograms):
                lines.append(f"# HELP {name} Latency in seconds.")
                lines.append(f"# TYPE {name} histogram")
                for labels, entry in sorted(self._histograms[name].items()):
                    total = sum(entry["buckets"])
                    cumulative = 0
                    for index, bound in enumerate(DEFAULT_BUCKETS):
                        cumulative += entry["buckets"][index]
                        bucket_labels = tuple(labels) + (("le", f"{bound:g}"),)
                        lines.append(f"{name}_bucket{self._render_labels(bucket_labels)} {cumulative}")
                    inf_labels = tuple(labels) + (("le", "+Inf"),)
                    lines.append(f"{name}_bucket{self._render_labels(inf_labels)} {total}")
                    lines.append(f"{name}_sum{self._render_labels(labels)} {entry['sum']:g}")
                    lines.append(f"{name}_count{self._render_labels(labels)} {total}")
            return "\n".join(lines) + "\n"

    def fastapi_middleware(self) -> Callable[..., Any]:
        """Return an async FastAPI/Starlette HTTP middleware recording counts,
        latency and 5xx errors for every request."""
        registry = self

        async def middleware(request: Any, call_next: Callable[..., Any]) -> Any:
            started = time.monotonic()
            response = await call_next(request)
            elapsed = time.monotonic() - started
            labels = {
                "service": registry.service,
                "method": request.method,
                "path": request.url.path,
            }
            registry.inc(
                "http_requests_total",
                "Total HTTP requests handled.",
                {**labels, "status": str(response.status_code)},
            )
            registry.observe("http_request_duration_seconds", elapsed, labels)
            if response.status_code >= 500:
                registry.inc(
                    "http_errors_total",
                    "Total HTTP 5xx responses.",
                    {**labels, "status": str(response.status_code)},
                )
            return response

        return middleware
