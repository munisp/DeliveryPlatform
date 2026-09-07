from __future__ import annotations

import hashlib
from concurrent.futures import ThreadPoolExecutor
import hmac
import json
import os
import sys
import unittest
import uuid
from datetime import datetime, timezone
from pathlib import Path

import psycopg

SERVICE_DIR = Path(__file__).resolve().parent
if str(SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(SERVICE_DIR))

from service import (  # noqa: E402
    InvalidWebhookSignature,
    PaymentConfig,
    PaymentWebhookService,
    ProviderVerificationUnavailable,
    VerifiedCollection,
    VerifiedTransfer,
)

TEST_DATABASE_URL = os.getenv("PAYMENT_TEST_DATABASE_URL", "").strip()


class FakeProvider:
    def __init__(self) -> None:
        self.collection_calls = 0
        self.transfer_calls = 0

    def verify_collection(self, reference: str) -> VerifiedCollection:
        self.collection_calls += 1
        return VerifiedCollection(
            reference=reference,
            event_id="provider-collection-event-1",
            status="success",
            amount_kobo=120_000,
            currency="NGN",
            paid_at=datetime.now(timezone.utc),
            split_reference="split-beta-1",
        )

    def submit_transfer(self, *, reference: str, recipient: str, amount_kobo: int, currency: str) -> str:
        self.transfer_calls += 1
        self.last_transfer = (reference, recipient, amount_kobo, currency)
        return reference

    def verify_transfer(self, reference: str) -> VerifiedTransfer:
        return VerifiedTransfer(
            reference=reference,
            event_id="provider-transfer-event-1",
            status="success",
            amount_kobo=80_000,
            currency="NGN",
            settled_at=datetime.now(timezone.utc),
        )


class UnavailableProvider(FakeProvider):
    def verify_collection(self, reference: str) -> VerifiedCollection:
        self.collection_calls += 1
        raise ProviderVerificationUnavailable("fixture provider outage")


class UnknownPaymentProvider(FakeProvider):
    def verify_collection(self, reference: str) -> VerifiedCollection:
        self.collection_calls += 1
        return VerifiedCollection(
            reference=reference,
            event_id="provider-unknown-event-1",
            status="success",
            amount_kobo=120_000,
            currency="NGN",
            paid_at=datetime.now(timezone.utc),
            split_reference=None,
        )


@unittest.skipUnless(TEST_DATABASE_URL, "PAYMENT_TEST_DATABASE_URL is required for database integration tests")
class PaymentWebhookIntegrationTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.config = PaymentConfig(
            database_url=TEST_DATABASE_URL,
            provider_name="testpay",
            webhook_secret="a" * 40,
            provider_api_key="b" * 40,
            verify_url_template="https://provider.test/transaction/{reference}",
            transfer_verify_url_template="https://provider.test/transfer/{reference}",
            transfer_submit_url="https://provider.test/transfer",
            payout_enabled=True,
            webhook_signature_header="x-test-signature",
            payout_release_interval_seconds=2,
            payout_hold_minutes=0,
            request_timeout_seconds=2,
            database_pool_max_size=4,
            webhook_verify_interval_seconds=1,
            webhook_verify_batch_size=25,
            webhook_max_attempts=3,
        )

    def setUp(self) -> None:
        self.provider = FakeProvider()
        self.service = PaymentWebhookService(self.config, provider=self.provider)
        self.service.initialize()
        with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as connection:
            for table in (
                "mobility.outbox_event", "mobility.driver_payout_instruction", "mobility.provider_webhook_event",
                "mobility.provider_payment", "mobility.trip_settlement", "mobility.ledger_posting",
                "mobility.ledger_transaction", "mobility.ledger_account", "mobility.driver_payout_recipient",
                "mobility.ride_trip", "mobility.fare_quote", "mobility.fare_rule_version",
                "mobility.driver_presence", "mobility.driver_eligibility", "mobility.vehicle",
                "mobility.driver_profile", "mobility.service_zone",
            ):
                connection.execute(f"DELETE FROM {table}")
            connection.execute("DELETE FROM public.users WHERE id IN (99001, 99002)")
            self._seed(connection)

    def tearDown(self) -> None:
        self.service.close()

    def _seed(self, connection: psycopg.Connection) -> None:
        trip_id = "10000000-0000-0000-0000-000000000041"
        zone_id = "10000000-0000-0000-0000-000000000001"
        vehicle_id = "10000000-0000-0000-0000-000000000011"
        fare_rule_id = "10000000-0000-0000-0000-000000000021"
        quote_id = "10000000-0000-0000-0000-000000000031"
        connection.execute("INSERT INTO public.users (id, open_id) VALUES (99001, 'payment-driver'), (99002, 'payment-rider')")
        connection.execute(
            """INSERT INTO mobility.service_zone (id, city_code, zone_code, version, display_name, boundary, active, dispatch_enabled, policy_version, effective_from)
               VALUES (%s::uuid,'LAG','payment-zone',1,'Payment Zone',ST_Multi(ST_GeomFromText('POLYGON((3.30 6.45,3.50 6.45,3.50 6.60,3.30 6.60,3.30 6.45))',4326)),true,true,'beta-v1',NOW())""",
            (zone_id,),
        )
        connection.execute("INSERT INTO mobility.driver_profile (user_id, legal_name, display_name, account_state, safety_state, payout_state) VALUES (99001, 'Driver', 'Driver', 'active', 'clear', 'verified')")
        connection.execute("INSERT INTO mobility.vehicle (id, driver_user_id, registration_number, make, model, manufacture_year, colour, passenger_capacity, vehicle_class, active) VALUES (%s::uuid,99001,'PAY-99001','Test','Car',2024,'Blue',4,'beta_standard',true)", (vehicle_id,))
        connection.execute("INSERT INTO mobility.driver_eligibility (driver_user_id, active_vehicle_id, eligible, eligible_until, policy_version) VALUES (99001,%s::uuid,true,NOW()+INTERVAL '1 day','beta-v1')", (vehicle_id,))
        connection.execute("INSERT INTO mobility.driver_payout_recipient (driver_user_id, provider, provider_recipient_reference, state, verified_at) VALUES (99001,'testpay','recipient-driver-99001','verified',NOW())")
        connection.execute("INSERT INTO mobility.fare_rule_version (id, zone_id, version, base_kobo, per_km_kobo, per_minute_kobo, minimum_kobo, cancellation_kobo, demand_cap_basis_points, effective_from) VALUES (%s::uuid,%s::uuid,'beta-v1',1000,200,50,1000,500,15000,NOW())", (fare_rule_id, zone_id))
        connection.execute("INSERT INTO mobility.fare_quote (id, rider_user_id, zone_id, fare_rule_id, route_provider, route_provider_version, quoted_distance_m, quoted_duration_s, base_kobo, distance_kobo, time_kobo, demand_kobo, taxes_and_fees_kobo, total_kobo, disclosure_version, calculation, expires_at) VALUES (%s::uuid,99002,%s::uuid,%s::uuid,'test','v1',1000,300,1000,200,50,0,0,1250,'beta-v1','{}',NOW()+INTERVAL '5 minutes')", (quote_id, zone_id, fare_rule_id))
        connection.execute("INSERT INTO mobility.ride_trip (id, rider_user_id, state, zone_id, fare_quote_id, pickup, destination, pickup_address, destination_address, assigned_driver_user_id, assigned_vehicle_id, requested_at, completed_at) VALUES (%s::uuid,99002,'completed_pending_payment',%s::uuid,%s::uuid,ST_SetSRID(ST_MakePoint(3.3792,6.5244),4326)::geography,ST_SetSRID(ST_MakePoint(3.4000,6.5400),4326)::geography,'Pickup','Destination',99001,%s::uuid,NOW(),NOW())", (trip_id, zone_id, quote_id, vehicle_id))
        connection.execute("INSERT INTO mobility.provider_payment (trip_id, provider, provider_reference, amount_kobo, currency, state) VALUES (%s::uuid,'testpay','ride-payment-1',120000,'NGN','capture_pending')", (trip_id,))
        connection.execute("INSERT INTO mobility.trip_settlement (trip_id, allocation_policy_version, gross_fare_kobo, driver_earnings_kobo, platform_commission_kobo, tax_and_statutory_kobo, provider_fee_kobo, payout_hold_until) VALUES (%s::uuid,'beta-v1',120000,80000,23000,17000,0,NOW())", (trip_id,))

    def _signed_payload(self, event_type: str = "charge.success", event_id: str = "webhook-event-1", reference: str = "ride-payment-1") -> tuple[bytes, str]:
        raw = json.dumps({"event": event_type, "data": {"id": event_id, "reference": reference}}, separators=(",", ":")).encode("utf-8")
        signature = hmac.new(self.config.webhook_secret.encode("utf-8"), raw, hashlib.sha512).hexdigest()
        return raw, signature

    def test_signed_collection_is_idempotent_and_settles_driver_payout(self) -> None:
        raw, signature = self._signed_payload()
        first = self.service.ingest_webhook(raw, signature)
        second = self.service.ingest_webhook(raw, signature)
        self.assertTrue(first["accepted"])
        self.assertTrue(first["queued"])
        self.assertFalse(first["duplicate"])
        self.assertTrue(second["duplicate"])
        self.assertEqual(self.provider.collection_calls, 0)
        self.assertEqual(self.service.process_pending_webhooks(), 1)
        self.assertEqual(self.provider.collection_calls, 1)
        self.assertEqual(self.service.process_due_payouts(), 1)
        self.assertEqual(self.provider.transfer_calls, 1)
        with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as connection:
            payment_state = connection.execute("SELECT state::text FROM mobility.provider_payment WHERE provider_reference = 'ride-payment-1'").fetchone()[0]
            payout_state = connection.execute("SELECT state::text FROM mobility.driver_payout_instruction WHERE trip_id = '10000000-0000-0000-0000-000000000041'::uuid").fetchone()[0]
            balance_check = connection.execute("SELECT SUM(CASE WHEN direction='debit' THEN amount_kobo ELSE -amount_kobo END) FROM mobility.ledger_posting").fetchone()[0]
            webhook_count = connection.execute("SELECT COUNT(*) FROM mobility.provider_webhook_event").fetchone()[0]
        self.assertEqual(payment_state, "captured")
        self.assertEqual(payout_state, "settled")
        self.assertEqual(balance_check, 0)
        self.assertEqual(webhook_count, 1)

    def test_resilience_correlation_is_persisted_for_asynchronous_verification(self) -> None:
        raw, signature = self._signed_payload(event_id="webhook-correlation")
        accepted = self.service.ingest_webhook(raw, signature, resilience_run_id="chaos-run-20260903-001", request_id="request-20260903-001")
        self.assertTrue(accepted["queued"])
        self.assertEqual(self.service.process_pending_webhooks(), 1)
        with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as connection:
            event = connection.execute(
                "SELECT resilience_run_id, request_id, processed_at, processing_error FROM mobility.provider_webhook_event WHERE provider_event_id = 'webhook-correlation'"
            ).fetchone()
        self.assertEqual(event[0], "chaos-run-20260903-001")
        self.assertEqual(event[1], "request-20260903-001")
        self.assertIsNotNone(event[2])
        self.assertIsNone(event[3])

    def test_transient_provider_outage_is_rescheduled_without_financial_state_change(self) -> None:
        self.service.close()
        self.provider = UnavailableProvider()
        self.service = PaymentWebhookService(self.config, provider=self.provider)
        self.service.initialize()
        raw, signature = self._signed_payload()
        self.service.ingest_webhook(raw, signature)
        self.assertEqual(self.service.process_pending_webhooks(), 0)
        with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as connection:
            event = connection.execute("SELECT processed_at, processing_attempts, processing_error FROM mobility.provider_webhook_event").fetchone()
            payment_state = connection.execute("SELECT state::text FROM mobility.provider_payment WHERE provider_reference = 'ride-payment-1'").fetchone()[0]
            ledger_count = connection.execute("SELECT COUNT(*) FROM mobility.ledger_transaction").fetchone()[0]
        self.assertIsNone(event[0])
        self.assertEqual(event[1], 1)
        self.assertIn("fixture provider outage", event[2])
        self.assertEqual(payment_state, "capture_pending")
        self.assertEqual(ledger_count, 0)

    def test_unknown_verified_payment_is_terminally_quarantined_without_financial_effect(self) -> None:
        self.service.close()
        self.provider = UnknownPaymentProvider()
        self.service = PaymentWebhookService(self.config, provider=self.provider)
        self.service.initialize()
        raw, signature = self._signed_payload(event_id="webhook-unknown-payment", reference="unrecognized-provider-reference")
        self.service.ingest_webhook(raw, signature)
        self.assertEqual(self.service.process_pending_webhooks(), 0)
        with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as connection:
            event = connection.execute("SELECT processed_at, processing_error FROM mobility.provider_webhook_event").fetchone()
            payment_state = connection.execute("SELECT state::text FROM mobility.provider_payment WHERE provider_reference = 'ride-payment-1'").fetchone()[0]
            ledger_count = connection.execute("SELECT COUNT(*) FROM mobility.ledger_transaction").fetchone()[0]
        self.assertIsNotNone(event[0])
        self.assertIn("terminal: provider reference", event[1])
        self.assertEqual(payment_state, "capture_pending")
        self.assertEqual(ledger_count, 0)

    def test_retry_exhaustion_is_terminal_and_financially_inert(self) -> None:
        self.service.close()
        self.provider = UnavailableProvider()
        self.service = PaymentWebhookService(self.config, provider=self.provider)
        self.service.initialize()
        raw, signature = self._signed_payload()
        self.service.ingest_webhook(raw, signature)
        for expected_attempts in range(1, self.config.webhook_max_attempts + 1):
            self.assertEqual(self.service.process_pending_webhooks(), 0)
            with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as connection:
                connection.execute("UPDATE mobility.provider_webhook_event SET next_attempt_at = NOW() WHERE processed_at IS NULL")
        with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as connection:
            event = connection.execute("SELECT processed_at, processing_attempts, processing_error FROM mobility.provider_webhook_event").fetchone()
            ledger_count = connection.execute("SELECT COUNT(*) FROM mobility.ledger_transaction").fetchone()[0]
        self.assertIsNotNone(event[0])
        self.assertEqual(event[1], self.config.webhook_max_attempts)
        self.assertIn("retry_exhausted: fixture provider outage", event[2])
        self.assertEqual(ledger_count, 0)

    def test_unsupported_event_is_terminally_quarantined_without_provider_call(self) -> None:
        raw, signature = self._signed_payload(event_type="invoice.create")
        self.service.ingest_webhook(raw, signature)
        self.assertEqual(self.service.process_pending_webhooks(), 0)
        with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as connection:
            event = connection.execute("SELECT processed_at, processing_error FROM mobility.provider_webhook_event").fetchone()
            payment_state = connection.execute("SELECT state::text FROM mobility.provider_payment WHERE provider_reference = 'ride-payment-1'").fetchone()[0]
        self.assertIsNotNone(event[0])
        self.assertIn("terminal: unsupported provider webhook event", event[1])
        self.assertEqual(self.provider.collection_calls, 0)
        self.assertEqual(payment_state, "capture_pending")

    def test_concurrent_workers_claim_one_callback_once(self) -> None:
        raw, signature = self._signed_payload()
        self.service.ingest_webhook(raw, signature)
        with ThreadPoolExecutor(max_workers=2) as executor:
            results = list(executor.map(lambda _: self.service.process_pending_webhooks(maximum=1), range(2)))
        self.assertEqual(sum(results), 1)
        self.assertEqual(self.provider.collection_calls, 1)
        with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM mobility.ledger_transaction WHERE transaction_type = 'fare_capture'").fetchone()[0], 1)

    def test_invalid_signature_is_rejected_before_persistence(self) -> None:
        raw, _ = self._signed_payload()
        with self.assertRaises(InvalidWebhookSignature):
            self.service.ingest_webhook(raw, "not-a-valid-signature")
        with psycopg.connect(TEST_DATABASE_URL, autocommit=True) as connection:
            self.assertEqual(connection.execute("SELECT COUNT(*) FROM mobility.provider_webhook_event").fetchone()[0], 0)


if __name__ == "__main__":
    unittest.main()
