"""Unit tests for the shared Python resilience standard."""

from __future__ import annotations

import sys
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

import requests

from switchos_resilience import (
    CircuitBreaker,
    CircuitOpenError,
    MetricsRegistry,
    ResilientSession,
)


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += seconds


class CircuitBreakerTest(unittest.TestCase):
    def test_closed_to_open_after_threshold(self) -> None:
        breaker = CircuitBreaker(failure_threshold=3, reset_timeout_seconds=60, clock=FakeClock())
        self.assertEqual(breaker.state, CircuitBreaker.CLOSED)
        for _ in range(2):
            self.assertTrue(breaker.allow())
            breaker.report_failure()
            self.assertEqual(breaker.state, CircuitBreaker.CLOSED)
        self.assertTrue(breaker.allow())
        breaker.report_failure()
        self.assertEqual(breaker.state, CircuitBreaker.OPEN)
        self.assertFalse(breaker.allow())

    def test_success_resets_consecutive_failures(self) -> None:
        breaker = CircuitBreaker(failure_threshold=2, clock=FakeClock())
        breaker.allow()
        breaker.report_failure()
        breaker.allow()
        breaker.report_success()
        breaker.allow()
        breaker.report_failure()
        self.assertEqual(breaker.state, CircuitBreaker.CLOSED)

    def test_half_open_probe_closes_on_success(self) -> None:
        clock = FakeClock()
        breaker = CircuitBreaker(failure_threshold=1, reset_timeout_seconds=30, clock=clock)
        breaker.allow()
        breaker.report_failure()
        self.assertEqual(breaker.state, CircuitBreaker.OPEN)
        self.assertFalse(breaker.allow())
        clock.advance(31)
        self.assertEqual(breaker.state, CircuitBreaker.HALF_OPEN)
        self.assertTrue(breaker.allow())
        self.assertFalse(breaker.allow(), "only one concurrent probe allowed")
        breaker.report_success()
        self.assertEqual(breaker.state, CircuitBreaker.CLOSED)

    def test_half_open_probe_failure_reopens(self) -> None:
        clock = FakeClock()
        breaker = CircuitBreaker(failure_threshold=1, reset_timeout_seconds=10, clock=clock)
        breaker.allow()
        breaker.report_failure()
        clock.advance(11)
        self.assertTrue(breaker.allow())
        breaker.report_failure()
        self.assertEqual(breaker.state, CircuitBreaker.OPEN)
        self.assertFalse(breaker.allow())


def _response(status: int) -> requests.Response:
    response = requests.Response()
    response.status_code = status
    response.url = "http://example.test/"
    return response


class ResilientSessionTest(unittest.TestCase):
    def test_retries_idempotent_get_until_success(self) -> None:
        session = ResilientSession(sleeper=lambda _: None, backoff_base=0.001)
        with mock.patch.object(requests.Session, "request", side_effect=[requests.ConnectionError("down"), _response(200)]) as call:
            response = session.request("GET", "http://example.test/a")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(call.call_count, 2)

    def test_does_not_retry_post(self) -> None:
        session = ResilientSession(sleeper=lambda _: None)
        with mock.patch.object(requests.Session, "request", side_effect=requests.ConnectionError("down")) as call:
            with self.assertRaises(requests.ConnectionError):
                session.request("POST", "http://example.test/a", data="{}")
        self.assertEqual(call.call_count, 1)

    def test_opens_breaker_and_short_circuits(self) -> None:
        session = ResilientSession(sleeper=lambda _: None, max_attempts=1, failure_threshold=2)
        with mock.patch.object(requests.Session, "request", return_value=_response(503)):
            session.request("GET", "http://flaky.test/a")
            session.request("GET", "http://flaky.test/a")
        self.assertEqual(session.breaker_for("http://flaky.test/a").state, CircuitBreaker.OPEN)
        with self.assertRaises(CircuitOpenError):
            session.request("GET", "http://flaky.test/a")

    def test_applies_default_timeout(self) -> None:
        session = ResilientSession(default_timeout=7.5, sleeper=lambda _: None)
        with mock.patch.object(requests.Session, "request", return_value=_response(200)) as call:
            session.request("GET", "http://example.test/a")
        self.assertEqual(call.call_args.kwargs["timeout"], 7.5)


class MetricsRegistryTest(unittest.TestCase):
    def test_exposition_contains_core_series(self) -> None:
        registry = MetricsRegistry("svc", "1.0.0")
        registry.inc("http_requests_total", "Total HTTP requests handled.", {"method": "GET", "path": "/a", "status": "200", "service": "svc"})
        registry.inc("http_requests_total", "Total HTTP requests handled.", {"method": "GET", "path": "/a", "status": "200", "service": "svc"})
        registry.inc("http_errors_total", "Total HTTP 5xx responses.", {"method": "GET", "path": "/b", "status": "500", "service": "svc"})
        registry.observe("http_request_duration_seconds", 0.03, {"method": "GET", "path": "/a", "service": "svc"})
        output = registry.render()
        self.assertIn('service_info{service="svc",version="1.0.0"} 1', output)
        self.assertIn('service_uptime_seconds{service="svc"}', output)
        self.assertIn('http_requests_total{method="GET",path="/a",service="svc",status="200"} 2', output)
        self.assertIn("http_errors_total{", output)
        self.assertIn('http_request_duration_seconds_bucket{method="GET",path="/a",service="svc",le="0.05"} 1', output)
        self.assertIn('le="+Inf"} 1', output)
        self.assertIn("http_request_duration_seconds_count{", output)

    def test_fastapi_middleware_records(self) -> None:
        import asyncio

        registry = MetricsRegistry("svc")

        class FakeURL:
            path = "/route"

        class FakeRequest:
            method = "POST"
            url = FakeURL()

        class FakeResponse:
            status_code = 503

        async def call_next(_request: object) -> FakeResponse:
            return FakeResponse()

        middleware = registry.fastapi_middleware()
        asyncio.run(middleware(FakeRequest(), call_next))
        output = registry.render()
        self.assertIn('http_requests_total{method="POST",path="/route",service="svc",status="503"} 1', output)
        self.assertIn("http_errors_total{", output)


if __name__ == "__main__":
    unittest.main()
