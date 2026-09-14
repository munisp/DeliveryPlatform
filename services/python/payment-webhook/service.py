from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import secrets
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Callable, Mapping

import psycopg
from psycopg_pool import ConnectionPool
import requests

from correlation import begin_request_context, correlation_fields, restore_request_context

import sys as _sys
from pathlib import Path as _Path

_SHARED_DIR = _Path(__file__).resolve().parents[1] / "shared"
if str(_SHARED_DIR) not in _sys.path:
    _sys.path.insert(0, str(_SHARED_DIR))

from switchos_resilience import ResilientSession

LOGGER = logging.getLogger("payment-webhook")


class PaymentError(RuntimeError):
    """Base error for a payment state or provider failure."""


class InvalidWebhookSignature(PaymentError):
    """Raised when a provider callback fails raw-body signature validation."""


class UnknownPayment(PaymentError):
    """Raised when a verified provider reference is not a platform payment."""


class ProviderVerificationError(PaymentError):
    """Raised when provider verification proves a callback is invalid or inconsistent."""


class ProviderVerificationUnavailable(ProviderVerificationError):
    """Raised for retryable provider transport, rate-limit, or pending-result failures."""


class TerminalWebhookError(PaymentError):
    """Raised when an accepted callback must be quarantined without financial effects."""


@dataclass(frozen=True)
class PaymentConfig:
    database_url: str
    provider_name: str
    webhook_secret: str
    provider_api_key: str
    verify_url_template: str
    transfer_verify_url_template: str
    transfer_submit_url: str
    payout_enabled: bool
    webhook_signature_header: str
    payout_release_interval_seconds: int
    payout_hold_minutes: int
    request_timeout_seconds: int
    database_pool_max_size: int
    webhook_verify_interval_seconds: int
    webhook_verify_batch_size: int
    webhook_max_attempts: int

    @classmethod
    def from_environment(cls) -> "PaymentConfig":
        database_url = os.getenv("DATABASE_URL", "").strip()
        webhook_secret = os.getenv("PAYMENT_WEBHOOK_SECRET", "").strip()
        provider_api_key = os.getenv("PAYMENT_PROVIDER_API_KEY", "").strip()
        verify_url_template = os.getenv("PAYMENT_VERIFY_URL_TEMPLATE", "").strip()
        transfer_verify_url_template = os.getenv("PAYMENT_TRANSFER_VERIFY_URL_TEMPLATE", "").strip()
        transfer_submit_url = os.getenv("PAYMENT_TRANSFER_SUBMIT_URL", "").strip()
        provider_name = os.getenv("PAYMENT_PROVIDER_NAME", "").strip().lower()
        if not database_url:
            raise PaymentError("DATABASE_URL must be explicitly configured")
        if not provider_name:
            raise PaymentError("PAYMENT_PROVIDER_NAME must be explicitly configured")
        if len(webhook_secret) < 32:
            raise PaymentError("PAYMENT_WEBHOOK_SECRET must be explicitly configured with at least 32 characters")
        if len(provider_api_key) < 32:
            raise PaymentError("PAYMENT_PROVIDER_API_KEY must be explicitly configured with at least 32 characters")
        if "{reference}" not in verify_url_template:
            raise PaymentError("PAYMENT_VERIFY_URL_TEMPLATE must contain {reference}")
        if "{reference}" not in transfer_verify_url_template:
            raise PaymentError("PAYMENT_TRANSFER_VERIFY_URL_TEMPLATE must contain {reference}")
        if not transfer_submit_url:
            raise PaymentError("PAYMENT_TRANSFER_SUBMIT_URL must be explicitly configured")
        payout_enabled = _parse_required_bool("PAYOUTS_ENABLED")
        return cls(
            database_url=database_url,
            provider_name=provider_name,
            webhook_secret=webhook_secret,
            provider_api_key=provider_api_key,
            verify_url_template=verify_url_template,
            transfer_verify_url_template=transfer_verify_url_template,
            transfer_submit_url=transfer_submit_url,
            payout_enabled=payout_enabled,
            webhook_signature_header=os.getenv("PAYMENT_WEBHOOK_SIGNATURE_HEADER", "x-paystack-signature").strip().lower() or "x-paystack-signature",
            payout_release_interval_seconds=_bounded_int("PAYOUT_RELEASE_INTERVAL_SECONDS", 15, 2, 300),
            payout_hold_minutes=_bounded_int("PAYOUT_HOLD_MINUTES", 60, 0, 4320),
            request_timeout_seconds=_bounded_int("PAYMENT_PROVIDER_TIMEOUT_SECONDS", 8, 2, 30),
            database_pool_max_size=_bounded_int("PAYMENT_DB_POOL_MAX_SIZE", 8, 2, 48),
            webhook_verify_interval_seconds=_bounded_int("PAYMENT_WEBHOOK_VERIFY_INTERVAL_SECONDS", 1, 1, 60),
            webhook_verify_batch_size=_bounded_int("PAYMENT_WEBHOOK_VERIFY_BATCH_SIZE", 25, 1, 100),
            webhook_max_attempts=_bounded_int("PAYMENT_WEBHOOK_MAX_ATTEMPTS", 8, 1, 20),
        )


@dataclass(frozen=True)
class VerifiedCollection:
    reference: str
    event_id: str
    status: str
    amount_kobo: int
    currency: str
    paid_at: datetime | None
    split_reference: str | None


@dataclass(frozen=True)
class VerifiedTransfer:
    reference: str
    event_id: str
    status: str
    amount_kobo: int
    currency: str
    settled_at: datetime | None


class ProviderClient:
    """Provider-neutral HTTPS adapter. It never trusts webhook data without verification."""

    def __init__(self, config: PaymentConfig, request: Callable[..., requests.Response] = requests.request) -> None:
        self._config = config
        self._request = request
        self._session = (
            ResilientSession(
                default_timeout=config.request_timeout_seconds,
                max_attempts=3,
                failure_threshold=5,
                reset_timeout_seconds=30.0,
            )
            if request is requests.request
            else None
        )

    def verify_collection(self, reference: str) -> VerifiedCollection:
        body = self._verified_get(self._config.verify_url_template.format(reference=reference))
        data = _provider_data(body)
        status = str(data.get("status", "")).lower()
        if status not in {"success", "successful", "paid"}:
            if status in {"pending", "processing", "in_progress"}:
                raise ProviderVerificationUnavailable(f"collection {reference} remains pending")
            raise ProviderVerificationError(f"collection {reference} has unverified status {status!r}")
        amount = _provider_amount(data)
        currency = str(data.get("currency", "NGN")).upper()
        if currency != "NGN":
            raise ProviderVerificationError("only NGN payment verification is enabled for the Lagos beta")
        return VerifiedCollection(
            reference=str(data.get("reference") or reference),
            event_id=str(data.get("id") or data.get("transaction_id") or reference),
            status=status,
            amount_kobo=amount,
            currency=currency,
            paid_at=_parse_provider_time(data.get("paid_at") or data.get("created_at")),
            split_reference=_extract_split_reference(data),
        )

    def submit_transfer(self, *, reference: str, recipient: str, amount_kobo: int, currency: str) -> str:
        payload = {
            "reference": reference,
            "recipient": recipient,
            "amount": amount_kobo,
            "currency": currency,
            "reason": "Ride-hailing driver earnings settlement",
        }
        requester = self._session.request if self._session is not None else self._request
        response = requester(
            "POST",
            self._config.transfer_submit_url,
            headers=self._headers(),
            json=payload,
            timeout=self._config.request_timeout_seconds,
        )
        if response.status_code < 200 or response.status_code >= 300:
            raise ProviderVerificationError(f"transfer submission returned HTTP {response.status_code}")
        body = _json_response(response)
        data = _provider_data(body)
        provider_reference = str(data.get("reference") or data.get("transfer_code") or "").strip()
        if not provider_reference:
            raise ProviderVerificationError("transfer submission omitted provider reference")
        return provider_reference

    def verify_transfer(self, reference: str) -> VerifiedTransfer:
        body = self._verified_get(self._config.transfer_verify_url_template.format(reference=reference))
        data = _provider_data(body)
        status = str(data.get("status", "")).lower()
        if status not in {"success", "successful", "completed"}:
            if status in {"pending", "processing", "in_progress"}:
                raise ProviderVerificationUnavailable(f"transfer {reference} remains pending")
            raise ProviderVerificationError(f"transfer {reference} has unverified status {status!r}")
        amount = _provider_amount(data)
        currency = str(data.get("currency", "NGN")).upper()
        if currency != "NGN":
            raise ProviderVerificationError("only NGN driver payouts are enabled for the Lagos beta")
        return VerifiedTransfer(
            reference=str(data.get("reference") or reference),
            event_id=str(data.get("id") or data.get("transfer_code") or reference),
            status=status,
            amount_kobo=amount,
            currency=currency,
            settled_at=_parse_provider_time(data.get("paid_at") or data.get("completed_at") or data.get("created_at")),
        )

    def _verified_get(self, url: str) -> Mapping[str, Any]:
        requester = self._session.request if self._session is not None else self._request
        try:
            response = requester("GET", url, headers=self._headers(), timeout=self._config.request_timeout_seconds)
        except requests.RequestException as error:
            raise ProviderVerificationUnavailable("provider verification request failed") from error
        if response.status_code in {408, 425, 429} or response.status_code >= 500:
            raise ProviderVerificationUnavailable(f"provider verification returned transient HTTP {response.status_code}")
        if response.status_code < 200 or response.status_code >= 300:
            raise ProviderVerificationError(f"provider verification returned HTTP {response.status_code}")
        return _json_response(response)

    def close(self) -> None:
        if self._session is not None:
            self._session.close()

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self._config.provider_api_key}",
            "Content-Type": "application/json",
            "Accept": "application/json",
        }


class PaymentWebhookService:
    """Durable webhook processing and driver payout release service."""

    def __init__(self, config: PaymentConfig, provider: ProviderClient | None = None) -> None:
        self.config = config
        self.provider = provider or ProviderClient(config)
        self._pool = ConnectionPool(
            conninfo=config.database_url,
            min_size=1,
            max_size=config.database_pool_max_size,
            timeout=config.request_timeout_seconds,
            open=False,
        )

    def initialize(self) -> None:
        self._pool.open(wait=True, timeout=self.config.request_timeout_seconds)
        with self._connection() as connection:
            connection.execute("SELECT 1")

    def close(self) -> None:
        self._pool.close()
        provider_close = getattr(self.provider, "close", None)
        if callable(provider_close):
            provider_close()

    def check(self) -> None:
        with self._connection() as connection:
            connection.execute("SELECT 1")

    def validate_signature(self, raw_body: bytes, signature: str | None) -> None:
        if not signature:
            raise InvalidWebhookSignature("missing provider webhook signature")
        expected = hmac.new(self.config.webhook_secret.encode("utf-8"), raw_body, hashlib.sha512).hexdigest()
        if not hmac.compare_digest(expected, signature.strip()):
            raise InvalidWebhookSignature("invalid provider webhook signature")

    def ingest_webhook(self, raw_body: bytes, signature: str | None, *, resilience_run_id: str = "", request_id: str = "") -> dict[str, Any]:
        self.validate_signature(raw_body, signature)
        try:
            payload = json.loads(raw_body)
        except json.JSONDecodeError as error:
            raise PaymentError("provider webhook body is not valid JSON") from error
        if not isinstance(payload, dict):
            raise PaymentError("provider webhook payload must be an object")
        event_type = str(payload.get("event", "")).strip().lower()
        data = payload.get("data")
        if not event_type or not isinstance(data, dict):
            raise PaymentError("provider webhook requires event and object data")
        event_id = str(data.get("id") or data.get("event_id") or payload.get("id") or "").strip()
        reference = str(data.get("reference") or data.get("transfer_code") or "").strip()
        if not reference:
            raise PaymentError("provider webhook omitted an immutable reference")
        if not event_id:
            event_id = hashlib.sha256(raw_body).hexdigest()
        payload_digest = hashlib.sha512(raw_body).digest()
        inserted = self._record_webhook_event(event_id, payload_digest, payload, event_type, reference, resilience_run_id, request_id)
        return {
            "accepted": True,
            "duplicate": not inserted,
            "queued": inserted,
            "event_type": event_type,
            "reference": reference,
        }

    def process_pending_webhooks(self, maximum: int | None = None) -> int:
        """Claim a bounded batch with SKIP LOCKED and verify it outside the callback path."""
        processed = 0
        for event_id, event_type, reference, resilience_run_id, request_id in self._claim_pending_webhooks(maximum or self.config.webhook_verify_batch_size):
            context_tokens = begin_request_context(request_id, resilience_run_id)
            try:
                if event_type in {"charge.success", "payment.success", "transaction.success"}:
                    self._process_collection(reference, event_id)
                elif event_type in {"transfer.success", "transfer.completed"}:
                    self._process_transfer(reference, event_id)
                elif event_type in {"transfer.failed", "transfer.failure"}:
                    self._mark_transfer_failed(reference, event_id)
                elif event_type in {"charge.dispute.create", "chargeback.created"}:
                    self._open_chargeback(reference, event_id)
                else:
                    raise TerminalWebhookError(f"unsupported provider webhook event {event_type!r}")
                self._mark_webhook_processed(event_id, None)
                LOGGER.info(json.dumps({"service": "ride-payment-webhook", "event": "payment.webhook.verified", "provider_event_id": event_id, "provider_reference": reference, **correlation_fields()}, sort_keys=True, separators=(",", ":")))
                processed += 1
            except Exception as error:
                message = str(error)[:512] or error.__class__.__name__
                if _is_terminal_webhook_error(error):
                    LOGGER.error(json.dumps({"service": "ride-payment-webhook", "event": "payment.webhook.quarantined", "provider_event_id": event_id, "provider_reference": reference, "error_class": error.__class__.__name__, **correlation_fields()}, sort_keys=True, separators=(",", ":")))
                    self._mark_webhook_processed(event_id, f"terminal: {message}")
                elif self._reschedule_webhook_event(event_id, message):
                    LOGGER.warning(json.dumps({"service": "ride-payment-webhook", "event": "payment.webhook.deferred", "provider_event_id": event_id, "provider_reference": reference, "error_class": error.__class__.__name__, **correlation_fields()}, sort_keys=True, separators=(",", ":")))
                else:
                    LOGGER.error(json.dumps({"service": "ride-payment-webhook", "event": "payment.webhook.retry_exhausted", "provider_event_id": event_id, "provider_reference": reference, "error_class": error.__class__.__name__, **correlation_fields()}, sort_keys=True, separators=(",", ":")))
                    self._mark_webhook_processed(event_id, f"retry_exhausted: {message}")
            finally:
                restore_request_context(context_tokens)
        return processed

    def webhook_queue_metrics(self) -> dict[str, int]:
        """Return bounded operational counters for the protected verification-status endpoint."""
        with self._connection() as connection:
            row = connection.execute(
                """
                SELECT
                  COUNT(*) FILTER (WHERE processed_at IS NULL) AS pending,
                  COUNT(*) FILTER (WHERE processed_at IS NULL AND processing_started_at IS NOT NULL) AS in_progress,
                  COUNT(*) FILTER (WHERE processed_at IS NOT NULL AND processing_error IS NULL) AS verified,
                  COUNT(*) FILTER (WHERE processing_error LIKE 'terminal:%') AS quarantined,
                  COUNT(*) FILTER (WHERE processing_error LIKE 'retry_exhausted:%') AS retry_exhausted,
                  COALESCE(EXTRACT(EPOCH FROM MAX(NOW() - received_at) FILTER (WHERE processed_at IS NULL)), 0)::bigint AS oldest_pending_seconds
                FROM mobility.provider_webhook_event
                WHERE provider = %s
                """,
                (self.config.provider_name,),
            ).fetchone()
        if row is None:
            return {"pending": 0, "in_progress": 0, "verified": 0, "quarantined": 0, "retry_exhausted": 0, "oldest_pending_seconds": 0}
        return {
            "pending": int(row[0]), "in_progress": int(row[1]), "verified": int(row[2]),
            "quarantined": int(row[3]), "retry_exhausted": int(row[4]), "oldest_pending_seconds": int(row[5]),
        }

    def process_due_payouts(self, maximum: int = 25) -> int:
        if not self.config.payout_enabled:
            return 0
        processed = 0
        for payout in self._claim_due_payouts(maximum):
            try:
                provider_reference = self.provider.submit_transfer(
                    reference=payout["provider_transfer_reference"],
                    recipient=payout["provider_recipient_reference"],
                    amount_kobo=payout["amount_kobo"],
                    currency=payout["currency"],
                )
                self._mark_payout_submitted(payout["id"], provider_reference)
                verified = self.provider.verify_transfer(provider_reference)
                if verified.amount_kobo != payout["amount_kobo"] or verified.currency != payout["currency"]:
                    raise ProviderVerificationError("provider transfer amount or currency mismatch")
                self._settle_payout(payout["id"], verified)
                processed += 1
            except Exception as error:
                LOGGER.exception("driver payout processing failed payout_id=%s", payout["id"])
                self._fail_payout(payout["id"], str(error)[:256])
        return processed

    def reconcile_provider_reference(self, reference: str) -> dict[str, Any]:
        """Internal controlled re-verification endpoint; no state moves without provider proof."""
        payment = self.provider.verify_collection(reference)
        return self._apply_verified_collection(payment, payment.event_id)

    def _process_collection(self, reference: str, event_id: str) -> dict[str, Any]:
        payment = self.provider.verify_collection(reference)
        return self._apply_verified_collection(payment, event_id)

    def _apply_verified_collection(self, verified: VerifiedCollection, event_id: str) -> dict[str, Any]:
        with self._connection() as connection, connection.transaction():
            payment_row = connection.execute(
                """
                SELECT pp.id::text, pp.trip_id::text, pp.amount_kobo, pp.currency, pp.state::text,
                       rt.state::text, rt.assigned_driver_user_id, ts.driver_earnings_kobo, ts.platform_commission_kobo,
                       ts.tax_and_statutory_kobo, ts.provider_fee_kobo, ts.payout_hold_until,
                       d.account_state, d.safety_state, de.eligible, de.eligible_until,
                       recipient.provider_recipient_reference, recipient.state
                FROM mobility.provider_payment pp
                JOIN mobility.ride_trip rt ON rt.id = pp.trip_id
                JOIN mobility.trip_settlement ts ON ts.trip_id = pp.trip_id
                JOIN mobility.driver_profile d ON d.user_id = rt.assigned_driver_user_id
                JOIN mobility.driver_eligibility de ON de.driver_user_id = rt.assigned_driver_user_id
                JOIN mobility.driver_payout_recipient recipient ON recipient.driver_user_id = rt.assigned_driver_user_id
                WHERE pp.provider = %s AND pp.provider_reference = %s
                FOR UPDATE
                """,
                (self.config.provider_name, verified.reference),
            ).fetchone()
            if payment_row is None:
                raise UnknownPayment(f"provider reference {verified.reference} is not a known ride payment")
            (
                payment_id, trip_id, expected_amount, currency, payment_state, trip_state, driver_id,
                driver_earnings, platform_commission, tax_amount, provider_fee, payout_hold_until,
                account_state, safety_state, eligible, eligible_until, recipient_reference, recipient_state,
            ) = payment_row
            if trip_state not in {"completed_pending_payment", "completed"}:
                raise PaymentError(f"trip {trip_id} is not in a billable completed state")
            if expected_amount != verified.amount_kobo or currency != verified.currency:
                raise ProviderVerificationError("verified collection amount or currency differs from immutable payment")
            if payment_state in {"captured", "settlement_pending", "settled"}:
                return {"payment_id": payment_id, "trip_id": trip_id, "state": payment_state, "idempotent": True}
            if payment_state not in {"created", "authorisation_pending", "authorised", "capture_pending"}:
                raise PaymentError(f"payment {payment_id} cannot transition from {payment_state}")
            if account_state != "active" or safety_state != "clear" or not eligible or eligible_until is None or eligible_until <= datetime.now(timezone.utc) or recipient_state != "verified":
                payout_state = "blocked"
                payout_error = "driver is not currently payout eligible"
            else:
                payout_state = "held"
                payout_error = None
            connection.execute(
                """
                UPDATE mobility.provider_payment
                SET state = 'captured', raw_provider_status = %s, provider_event_id = %s,
                    provider_split_reference = COALESCE(%s, provider_split_reference),
                    captured_at = COALESCE(captured_at, %s), verified_at = NOW(), updated_at = NOW()
                WHERE id = %s::uuid
                """,
                (verified.status, event_id, verified.split_reference, verified.paid_at or datetime.now(timezone.utc), payment_id),
            )
            self._post_capture_ledger(
                connection=connection,
                trip_id=trip_id,
                payment_id=payment_id,
                driver_id=driver_id,
                gross_amount=expected_amount,
                driver_earnings=driver_earnings,
                platform_commission=platform_commission,
                tax_amount=tax_amount,
                provider_fee=provider_fee,
            )
            transfer_reference = _transfer_reference(trip_id, driver_id)
            connection.execute(
                """
                INSERT INTO mobility.driver_payout_instruction (
                    driver_user_id, trip_id, provider, provider_recipient_reference, provider_transfer_reference,
                    amount_kobo, currency, state, eligible_at, failure_code
                ) VALUES (%s,%s::uuid,%s,%s,%s,%s,%s,%s,%s,%s)
                ON CONFLICT (trip_id) DO NOTHING
                """,
                (
                    driver_id, trip_id, self.config.provider_name, recipient_reference, transfer_reference,
                    driver_earnings, currency, payout_state,
                    max(payout_hold_until, datetime.now(timezone.utc) + timedelta(minutes=self.config.payout_hold_minutes)), payout_error,
                ),
            )
            _insert_outbox(connection, "ride_trip", trip_id, "payment.collection_captured", {"trip_id": trip_id, "payment_id": payment_id, "driver_user_id": driver_id, "payout_state": payout_state})
            return {"payment_id": payment_id, "trip_id": trip_id, "state": "captured", "payout_state": payout_state, "idempotent": False}

    def _process_transfer(self, reference: str, event_id: str) -> dict[str, Any]:
        verified = self.provider.verify_transfer(reference)
        return self._settle_payout_by_reference(reference, verified, event_id)

    def _settle_payout(self, payout_id: str, verified: VerifiedTransfer) -> None:
        self._settle_payout_by_reference(verified.reference, verified, verified.event_id, expected_payout_id=payout_id)

    def _settle_payout_by_reference(self, reference: str, verified: VerifiedTransfer, event_id: str, expected_payout_id: str | None = None) -> dict[str, Any]:
        with self._connection() as connection, connection.transaction():
            payout = connection.execute(
                """
                SELECT p.id::text, p.trip_id::text, p.driver_user_id, p.amount_kobo, p.currency, p.state::text
                FROM mobility.driver_payout_instruction p
                WHERE p.provider = %s AND p.provider_transfer_reference = %s
                FOR UPDATE
                """,
                (self.config.provider_name, reference),
            ).fetchone()
            if payout is None:
                raise UnknownPayment(f"provider transfer {reference} is not known")
            payout_id, trip_id, driver_id, amount, currency, state = payout
            if expected_payout_id and payout_id != expected_payout_id:
                raise PaymentError("provider transfer resolved to an unexpected payout instruction")
            if amount != verified.amount_kobo or currency != verified.currency:
                raise ProviderVerificationError("verified transfer amount or currency differs from payout instruction")
            if state == "settled":
                return {"payout_id": payout_id, "trip_id": trip_id, "state": "settled", "idempotent": True}
            if state not in {"submitted", "queued"}:
                raise PaymentError(f"payout {payout_id} cannot transition from {state}")
            connection.execute(
                "UPDATE mobility.driver_payout_instruction SET state = 'settled', settled_at = COALESCE(settled_at, %s), updated_at = NOW() WHERE id = %s::uuid",
                (verified.settled_at or datetime.now(timezone.utc), payout_id),
            )
            self._post_payout_ledger(connection, trip_id, payout_id, driver_id, amount)
            _insert_outbox(connection, "ride_trip", trip_id, "payment.driver_payout_settled", {"trip_id": trip_id, "payout_id": payout_id, "driver_user_id": driver_id, "provider_event_id": event_id})
            return {"payout_id": payout_id, "trip_id": trip_id, "state": "settled", "idempotent": False}

    def _mark_transfer_failed(self, reference: str, event_id: str) -> dict[str, Any]:
        with self._connection() as connection, connection.transaction():
            row = connection.execute(
                """UPDATE mobility.driver_payout_instruction
                   SET state = 'failed', failure_code = 'provider_transfer_failed', updated_at = NOW()
                   WHERE provider = %s AND provider_transfer_reference = %s AND state IN ('queued', 'submitted')
                   RETURNING id::text, trip_id::text""",
                (self.config.provider_name, reference),
            ).fetchone()
            if row is None:
                return {"state": "ignored", "reference": reference}
            payout_id, trip_id = row
            _insert_outbox(connection, "ride_trip", trip_id, "payment.driver_payout_failed", {"trip_id": trip_id, "payout_id": payout_id, "provider_event_id": event_id})
            return {"payout_id": payout_id, "trip_id": trip_id, "state": "failed"}

    def _open_chargeback(self, reference: str, event_id: str) -> dict[str, Any]:
        with self._connection() as connection, connection.transaction():
            row = connection.execute(
                """UPDATE mobility.provider_payment
                   SET state = 'chargeback_open', provider_event_id = %s, verified_at = NOW(), updated_at = NOW()
                   WHERE provider = %s AND provider_reference = %s
                   RETURNING id::text, trip_id::text""",
                (event_id, self.config.provider_name, reference),
            ).fetchone()
            if row is None:
                raise UnknownPayment(f"chargeback reference {reference} is not known")
            payment_id, trip_id = row
            connection.execute(
                """UPDATE mobility.driver_payout_instruction
                   SET state = 'blocked', failure_code = 'chargeback_open', updated_at = NOW()
                   WHERE trip_id = %s::uuid AND state IN ('held', 'queued', 'submitted')""",
                (trip_id,),
            )
            _insert_outbox(connection, "ride_trip", trip_id, "payment.chargeback_open", {"trip_id": trip_id, "payment_id": payment_id, "provider_event_id": event_id})
            return {"payment_id": payment_id, "trip_id": trip_id, "state": "chargeback_open"}

    def _claim_due_payouts(self, maximum: int) -> list[dict[str, Any]]:
        with self._connection() as connection, connection.transaction():
            rows = connection.execute(
                """
                WITH due AS (
                  SELECT p.id
                  FROM mobility.driver_payout_instruction p
                  JOIN mobility.provider_payment pp ON pp.trip_id = p.trip_id
                  JOIN mobility.driver_profile d ON d.user_id = p.driver_user_id
                  JOIN mobility.driver_eligibility de ON de.driver_user_id = p.driver_user_id
                  JOIN mobility.driver_payout_recipient recipient ON recipient.driver_user_id = p.driver_user_id
                  WHERE p.state = 'held' AND p.eligible_at <= NOW()
                    AND pp.state IN ('captured', 'settlement_pending', 'settled')
                    AND d.account_state = 'active' AND d.safety_state = 'clear'
                    AND de.eligible = true AND de.eligible_until > NOW()
                    AND recipient.state = 'verified'
                  ORDER BY p.eligible_at, p.created_at
                  FOR UPDATE SKIP LOCKED
                  LIMIT %s
                )
                UPDATE mobility.driver_payout_instruction p
                SET state = 'queued', updated_at = NOW()
                FROM due
                WHERE p.id = due.id
                RETURNING p.id::text, p.provider_recipient_reference, p.provider_transfer_reference, p.amount_kobo, p.currency
                """,
                (maximum,),
            ).fetchall()
            return [
                {
                    "id": row[0], "provider_recipient_reference": row[1], "provider_transfer_reference": row[2],
                    "amount_kobo": row[3], "currency": row[4],
                }
                for row in rows
            ]

    def _mark_payout_submitted(self, payout_id: str, provider_reference: str) -> None:
        with self._connection() as connection, connection.transaction():
            connection.execute(
                """UPDATE mobility.driver_payout_instruction
                   SET provider_transfer_reference = %s, state = 'submitted', submitted_at = NOW(), updated_at = NOW()
                   WHERE id = %s::uuid AND state = 'queued'""",
                (provider_reference, payout_id),
            )

    def _fail_payout(self, payout_id: str, failure_code: str) -> None:
        with self._connection() as connection, connection.transaction():
            connection.execute(
                """UPDATE mobility.driver_payout_instruction
                   SET state = 'failed', failure_code = %s, updated_at = NOW()
                   WHERE id = %s::uuid AND state IN ('queued', 'submitted')""",
                (failure_code, payout_id),
            )

    def _record_webhook_event(self, event_id: str, payload_digest: bytes, payload: Mapping[str, Any], event_type: str, reference: str, resilience_run_id: str, request_id: str) -> bool:
        with self._connection() as connection, connection.transaction():
            row = connection.execute(
                """
                INSERT INTO mobility.provider_webhook_event (
                    provider, provider_event_id, payload_sha512, signature_valid,
                    raw_payload, event_type, provider_reference, resilience_run_id, request_id, next_attempt_at
                ) VALUES (%s,%s,%s,true,%s::jsonb,%s,%s,NULLIF(%s,''),NULLIF(%s,''),NOW())
                ON CONFLICT (provider, provider_event_id) DO NOTHING
                RETURNING id
                """,
                (self.config.provider_name, event_id, payload_digest, json.dumps(payload, separators=(",", ":")), event_type, reference, resilience_run_id, request_id),
            ).fetchone()
            return row is not None

    def _claim_pending_webhooks(self, maximum: int) -> list[tuple[str, str, str, str, str]]:
        with self._connection() as connection, connection.transaction():
            rows = connection.execute(
                """
                WITH claim AS (
                  SELECT id FROM mobility.provider_webhook_event
                  WHERE provider=%s AND processed_at IS NULL AND processing_attempts < %s AND next_attempt_at <= NOW()
                    AND (processing_started_at IS NULL OR processing_started_at < NOW() - INTERVAL '2 minutes')
                  ORDER BY received_at
                  FOR UPDATE SKIP LOCKED
                  LIMIT %s
                )
                UPDATE mobility.provider_webhook_event event
                SET processing_started_at=NOW(), processing_attempts=event.processing_attempts+1
                FROM claim
                WHERE event.id=claim.id
                RETURNING event.provider_event_id, event.event_type, event.provider_reference,
                          COALESCE(event.resilience_run_id, ''), COALESCE(event.request_id, '')
                """,
                (self.config.provider_name, self.config.webhook_max_attempts, maximum),
            ).fetchall()
            return [(str(row[0]), str(row[1]), str(row[2]), str(row[3]), str(row[4])) for row in rows]

    def _reschedule_webhook_event(self, event_id: str, error: str) -> bool:
        with self._connection() as connection, connection.transaction():
            row = connection.execute(
                """
                UPDATE mobility.provider_webhook_event
                SET processing_error=%s,
                    processing_started_at=NULL,
                    next_attempt_at=NOW()
                      + (LEAST(300, 2 ^ LEAST(processing_attempts, 8)) * INTERVAL '1 second')
                      + ((floor(random() * 1000)::integer) * INTERVAL '1 millisecond')
                WHERE provider=%s AND provider_event_id=%s AND processed_at IS NULL
                  AND processing_attempts < %s
                RETURNING id
                """,
                (error, self.config.provider_name, event_id, self.config.webhook_max_attempts),
            ).fetchone()
            return row is not None

    def _mark_webhook_processed(self, event_id: str, error: str | None) -> None:
        with self._connection() as connection, connection.transaction():
            connection.execute(
                """UPDATE mobility.provider_webhook_event
                   SET processed_at = NOW(), processing_error = %s, processing_started_at = NULL
                   WHERE provider = %s AND provider_event_id = %s""",
                (error, self.config.provider_name, event_id),
            )

    def _post_capture_ledger(
        self, *, connection: psycopg.Connection[Any], trip_id: str, payment_id: str, driver_id: int,
        gross_amount: int, driver_earnings: int, platform_commission: int, tax_amount: int, provider_fee: int,
    ) -> None:
        transaction_key = f"ride:{trip_id}:capture"
        transaction_id = _create_ledger_transaction(connection, transaction_key, trip_id, "fare_capture", "Verified rider collection")
        clearing = _ensure_ledger_account(connection, f"asset:provider_collection_clearing:{self.config.provider_name}", "asset", "provider", self.config.provider_name)
        driver_payable = _ensure_ledger_account(connection, f"liability:driver_earnings_payable:{driver_id}", "liability", "driver", str(driver_id))
        commission = _ensure_ledger_account(connection, "revenue:ride_platform_commission", "revenue", "platform", "deliveryplatform")
        tax_payable = _ensure_ledger_account(connection, "liability:tax_and_statutory_payable", "liability", "tax_authority", "lagos-nigeria")
        _post_pair(connection, transaction_id, clearing, "debit", driver_payable, "credit", driver_earnings)
        _post_pair(connection, transaction_id, clearing, "debit", commission, "credit", platform_commission)
        _post_pair(connection, transaction_id, clearing, "debit", tax_payable, "credit", tax_amount)
        if driver_earnings + platform_commission + tax_amount != gross_amount:
            raise PaymentError("immutable trip settlement does not balance to payment amount")
        if provider_fee:
            expense = _ensure_ledger_account(connection, "expense:payment_processing_fee", "expense", "platform", "deliveryplatform")
            _post_pair(connection, transaction_id, expense, "debit", clearing, "credit", provider_fee)
        _assert_balanced(connection, transaction_id)

    def _post_payout_ledger(self, connection: psycopg.Connection[Any], trip_id: str, payout_id: str, driver_id: int, amount: int) -> None:
        transaction_id = _create_ledger_transaction(connection, f"ride:{trip_id}:payout:{payout_id}", trip_id, "payout_settlement", "Verified driver payout")
        payable = _ensure_ledger_account(connection, f"liability:driver_earnings_payable:{driver_id}", "liability", "driver", str(driver_id))
        clearing = _ensure_ledger_account(connection, f"asset:provider_collection_clearing:{self.config.provider_name}", "asset", "provider", self.config.provider_name)
        _post_pair(connection, transaction_id, payable, "debit", clearing, "credit", amount)
        _assert_balanced(connection, transaction_id)

    def _connection(self):
        return self._pool.connection()


def _create_ledger_transaction(connection: psycopg.Connection[Any], key: str, trip_id: str, transaction_type: str, description: str) -> str:
    row = connection.execute(
        """
        INSERT INTO mobility.ledger_transaction (idempotency_key, trip_id, transaction_type, description)
        VALUES (%s,%s::uuid,%s,%s)
        ON CONFLICT (idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
        RETURNING id::text
        """,
        (key, trip_id, transaction_type, description),
    ).fetchone()
    if row is None:
        raise PaymentError("could not create immutable ledger transaction")
    return str(row[0])


def _ensure_ledger_account(connection: psycopg.Connection[Any], code: str, account_class: str, owner_kind: str, owner_key: str) -> str:
    row = connection.execute(
        """
        INSERT INTO mobility.ledger_account (account_code, account_class, currency, owner_kind, owner_key)
        VALUES (%s,%s,'NGN',%s,%s)
        ON CONFLICT (account_code) DO UPDATE SET account_code = EXCLUDED.account_code
        RETURNING id::text
        """,
        (code, account_class, owner_kind, owner_key),
    ).fetchone()
    if row is None:
        raise PaymentError("could not load ledger account")
    return str(row[0])


def _post_pair(connection: psycopg.Connection[Any], transaction_id: str, debit_account: str, debit_direction: str, credit_account: str, credit_direction: str, amount: int) -> None:
    if amount <= 0:
        return
    connection.execute(
        """INSERT INTO mobility.ledger_posting (transaction_id, account_id, direction, amount_kobo)
           VALUES (%s::uuid,%s::uuid,%s,%s),(%s::uuid,%s::uuid,%s,%s)""",
        (transaction_id, debit_account, debit_direction, amount, transaction_id, credit_account, credit_direction, amount),
    )


def _assert_balanced(connection: psycopg.Connection[Any], transaction_id: str) -> None:
    connection.execute("SELECT mobility.assert_balanced_ledger(%s::uuid)", (transaction_id,))


def _insert_outbox(connection: psycopg.Connection[Any], aggregate_type: str, aggregate_id: str, event_type: str, payload: Mapping[str, Any]) -> None:
    connection.execute(
        """INSERT INTO mobility.outbox_event (aggregate_type, aggregate_id, event_type, payload)
           VALUES (%s,%s::uuid,%s,%s::jsonb)""",
        (aggregate_type, aggregate_id, event_type, json.dumps(payload, separators=(",", ":"))),
    )


def _provider_data(body: Mapping[str, Any]) -> Mapping[str, Any]:
    data = body.get("data", body)
    if not isinstance(data, Mapping):
        raise ProviderVerificationError("provider response omitted object data")
    return data


def _provider_amount(data: Mapping[str, Any]) -> int:
    amount = data.get("amount")
    if isinstance(amount, bool) or amount is None:
        raise ProviderVerificationError("provider response omitted amount in kobo")
    try:
        parsed = int(amount)
    except (TypeError, ValueError) as error:
        raise ProviderVerificationError("provider amount is invalid") from error
    if parsed <= 0:
        raise ProviderVerificationError("provider amount must be positive")
    return parsed


def _extract_split_reference(data: Mapping[str, Any]) -> str | None:
    split = data.get("split")
    if isinstance(split, Mapping):
        value = split.get("split_code") or split.get("id")
        if value:
            return str(value)
    return None


def _json_response(response: requests.Response) -> Mapping[str, Any]:
    try:
        body = response.json()
    except ValueError as error:
        raise ProviderVerificationError("provider response is not JSON") from error
    if not isinstance(body, Mapping):
        raise ProviderVerificationError("provider response is not an object")
    if body.get("status") is False:
        raise ProviderVerificationError("provider returned an unsuccessful envelope")
    return body


def _parse_provider_time(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        normalized = str(value).replace("Z", "+00:00")
        parsed = datetime.fromisoformat(normalized)
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _transfer_reference(trip_id: str, driver_id: int) -> str:
    return f"ride:{trip_id}:driver:{driver_id}:payout:1"


def _is_terminal_webhook_error(error: Exception) -> bool:
    """Only provider/database availability failures are retryable; all financial-rule failures are quarantined."""
    if isinstance(error, (ProviderVerificationUnavailable, psycopg.OperationalError, psycopg.InterfaceError, ConnectionError, TimeoutError)):
        return False
    return True


def _parse_required_bool(name: str) -> bool:
    raw = os.getenv(name, "").strip().lower()
    if raw not in {"true", "false"}:
        raise PaymentError(f"{name} must be explicitly set to true or false")
    return raw == "true"


def _bounded_int(name: str, default: int, lower: int, upper: int) -> int:
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        value = int(raw)
    except ValueError as error:
        raise PaymentError(f"{name} must be an integer") from error
    if value < lower or value > upper:
        raise PaymentError(f"{name} must be between {lower} and {upper}")
    return value
