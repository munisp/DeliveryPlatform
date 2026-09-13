"""Controlled, test-only traffic for the real vehicle tracker webhook ingress.

This workload never contacts a provider API, payment endpoint, or vehicle-command
endpoint. It sends unique, HMAC-signed generic position events to the application
route /api/vehicle-trackers/events/{integrationKey}.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import quote

from locust import HttpUser, between, events, task

RUN_ID = os.environ.get("TRACKER_REHEARSAL_RUN_ID", "").strip()
INTEGRATION_KEY = os.environ.get("TRACKER_REHEARSAL_INTEGRATION_KEY", "").strip()
WEBHOOK_SECRET = os.environ.get("TRACKER_REHEARSAL_WEBHOOK_SECRET", "")
DEVICE_IDS = tuple(
    value.strip()
    for value in os.environ.get("TRACKER_REHEARSAL_DEVICE_IDS", "").split(",")
    if value.strip()
)


def require_test_configuration() -> None:
    if not RUN_ID or len(RUN_ID) < 8:
        raise RuntimeError("TRACKER_REHEARSAL_RUN_ID must contain at least eight characters")
    if not INTEGRATION_KEY or len(INTEGRATION_KEY) < 3:
        raise RuntimeError("TRACKER_REHEARSAL_INTEGRATION_KEY must contain at least three characters")
    if len(WEBHOOK_SECRET) < 16:
        raise RuntimeError("TRACKER_REHEARSAL_WEBHOOK_SECRET must contain at least sixteen characters")
    if not DEVICE_IDS or any(len(device_id) < 3 for device_id in DEVICE_IDS):
        raise RuntimeError("TRACKER_REHEARSAL_DEVICE_IDS must contain registered test tracker device IDs")


require_test_configuration()


class TrackerIngressUser(HttpUser):
    """Posts one immutable, unique telemetry event per task invocation."""

    wait_time = between(0.05, 0.20)

    def on_start(self) -> None:
        self.worker_nonce = uuid.uuid4().hex
        self.sequence = 0
        self.device_offset = int(self.worker_nonce[:8], 16) % len(DEVICE_IDS)

    @task
    def submit_signed_position(self) -> None:
        self.sequence += 1
        event_id = f"{RUN_ID}-{self.worker_nonce}-{self.sequence}"
        device_id = DEVICE_IDS[(self.device_offset + self.sequence) % len(DEVICE_IDS)]
        body = {
            "deviceId": device_id,
            "eventId": event_id,
            "kind": "position",
            "observedAt": datetime.now(timezone.utc).isoformat(),
            "latitude": 6.5244 + ((self.sequence % 1000) * 0.000001),
            "longitude": 3.3792 + ((self.sequence % 1000) * 0.000001),
            "speedKph": 0,
            "headingDegrees": 0,
            "accuracyM": 5,
            "odometerKm": self.sequence,
            "ignitionOn": False,
            "integrityScore": 100,
        }
        raw_body = json.dumps(body, separators=(",", ":"), sort_keys=True).encode("utf-8")
        signature = "sha256=" + hmac.new(
            WEBHOOK_SECRET.encode("utf-8"), raw_body, hashlib.sha256
        ).hexdigest()
        with self.client.post(
            f"/api/vehicle-trackers/events/{quote(INTEGRATION_KEY, safe='')}",
            data=raw_body,
            headers={
                "content-type": "application/json",
                "x-vehicle-tracker-signature": signature,
                "x-rehearsal-run-id": RUN_ID,
            },
            name="POST /api/vehicle-trackers/events/:integrationKey",
            catch_response=True,
            timeout=15,
        ) as response:
            if response.status_code != 202:
                response.failure(f"expected HTTP 202, received HTTP {response.status_code}: {response.text[:300]}")
                return
            try:
                result = response.json()
            except ValueError:
                response.failure("accepted response was not JSON")
                return
            if result.get("accepted") is not True or not result.get("id"):
                response.failure("accepted response omitted accepted=true or id")


@events.quitting.add_listener
def require_zero_request_failures(environment, **_kwargs) -> None:
    total = environment.stats.total
    if total.num_failures:
        environment.process_exit_code = 1
    # Emit a single machine-readable line into the Locust log so the shell
    # harness can reconcile accepted requests with durable tracker evidence.
    print(
        "vehicle_tracker_locust_summary "
        f"requests={total.num_requests} failures={total.num_failures} "
        f"run_id={RUN_ID} observed_at={int(time.time())}"
    )
