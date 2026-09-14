from __future__ import annotations

import asyncio
import hmac
import logging
import os
from contextlib import asynccontextmanager, suppress

from fastapi import FastAPI, Header, HTTPException, Request, Response

from config_validation import validate_boot_configuration
from correlation import begin_request_context, log_event, restore_request_context

import sys
from pathlib import Path

_SHARED_DIR = Path(__file__).resolve().parent.parent / "shared"
if str(_SHARED_DIR) not in sys.path:
    sys.path.insert(0, str(_SHARED_DIR))

from switchos_resilience import MetricsRegistry
from service import (
    InvalidWebhookSignature,
    PaymentConfig,
    PaymentError,
    PaymentWebhookService,
    ProviderVerificationError,
    UnknownPayment,
)

LOGGER = logging.getLogger("payment-webhook")
MAX_WEBHOOK_BYTES = 1_048_576
INTERNAL_SERVICE_TOKEN = os.getenv("INTERNAL_SERVICE_TOKEN", "").strip()


def create_app(config: PaymentConfig) -> FastAPI:
    service = PaymentWebhookService(config)
    payout_task: asyncio.Task[None] | None = None
    verification_task: asyncio.Task[None] | None = None

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        nonlocal payout_task, verification_task
        await asyncio.to_thread(service.initialize)
        verification_task = asyncio.create_task(_webhook_verification_loop(service, config.webhook_verify_interval_seconds))
        if config.payout_enabled:
            payout_task = asyncio.create_task(_payout_loop(service, config.payout_release_interval_seconds))
        try:
            yield
        finally:
            for task in (verification_task, payout_task):
                if task is not None:
                    task.cancel()
                    with suppress(asyncio.CancelledError):
                        await task
            await asyncio.to_thread(service.close)

    app = FastAPI(title="SwitchOS Ride Payment Webhook", version="1.0.0", lifespan=lifespan)

    metrics_registry = MetricsRegistry("payment-webhook", os.getenv("SERVICE_VERSION", "1.0.0"))
    app.middleware("http")(metrics_registry.fastapi_middleware())

    @app.get("/metrics")
    async def metrics() -> Response:
        return Response(content=metrics_registry.render(), media_type="text/plain; version=0.0.4; charset=utf-8")

    @app.get("/health")
    async def health() -> dict[str, str]:
        try:
            await asyncio.to_thread(service.check)
        except PaymentError as error:
            raise HTTPException(status_code=503, detail=str(error)) from error
        except Exception as error:
            LOGGER.exception("payment health check failed")
            raise HTTPException(status_code=503, detail="payment persistence is unavailable") from error
        return {"status": "healthy", "service": "ride-payment-webhook"}

    @app.post("/webhooks/payments", status_code=202)
    async def payment_webhook(request: Request, response: Response) -> dict[str, object]:
        context_tokens = begin_request_context(request.headers.get("x-request-id"), request.headers.get("x-resilience-run-id"))
        _, _, request_id, resilience_run_id = context_tokens
        response.headers["X-Request-Id"] = request_id
        if resilience_run_id:
            response.headers["X-Resilience-Run-Id"] = resilience_run_id
        try:
            content_length = request.headers.get("content-length")
            try:
                declared_length = int(content_length) if content_length else 0
            except ValueError as error:
                raise HTTPException(status_code=400, detail="invalid webhook content length") from error
            if declared_length > MAX_WEBHOOK_BYTES:
                raise HTTPException(status_code=413, detail="webhook payload is too large")
            raw_body = await request.body()
            if len(raw_body) > MAX_WEBHOOK_BYTES:
                raise HTTPException(status_code=413, detail="webhook payload is too large")
            try:
                signature = request.headers.get(config.webhook_signature_header)
                result = await asyncio.to_thread(service.ingest_webhook, raw_body, signature, resilience_run_id=resilience_run_id, request_id=request_id)
            except InvalidWebhookSignature as error:
                log_event(LOGGER, "payment.webhook.signature_rejected", error_class=error.__class__.__name__)
                raise HTTPException(status_code=401, detail="invalid webhook signature") from error
            except UnknownPayment as error:
                log_event(LOGGER, "payment.webhook.unknown_payment", error_class=error.__class__.__name__)
                raise HTTPException(status_code=404, detail="unknown payment reference") from error
            except ProviderVerificationError as error:
                log_event(LOGGER, "payment.webhook.provider_verification_failed", error_class=error.__class__.__name__)
                raise HTTPException(status_code=503, detail="provider verification unavailable") from error
            except PaymentError as error:
                log_event(LOGGER, "payment.webhook.rejected", error_class=error.__class__.__name__)
                raise HTTPException(status_code=400, detail="invalid payment webhook") from error
            except Exception as error:
                log_event(LOGGER, "payment.webhook.persistence_failed", error_class=error.__class__.__name__)
                raise HTTPException(status_code=503, detail="payment processing unavailable") from error
            log_event(LOGGER, "payment.webhook.accepted", duplicate=bool(result["duplicate"]), queued=bool(result["queued"]), event_type=str(result["event_type"]))
            return result
        finally:
            restore_request_context(context_tokens)

    @app.get("/internal/webhooks/verification-status")
    async def webhook_verification_status(x_internal_service_token: str | None = Header(default=None)) -> dict[str, int]:
        _require_internal_access(x_internal_service_token)
        return await asyncio.to_thread(service.webhook_queue_metrics)

    @app.post("/internal/payouts/release")
    async def release_due_payouts(x_internal_service_token: str | None = Header(default=None)) -> dict[str, int]:
        _require_internal_access(x_internal_service_token)
        processed = await asyncio.to_thread(service.process_due_payouts)
        return {"processed": processed}

    @app.post("/internal/payments/{reference}/reconcile")
    async def reconcile_payment(reference: str, x_internal_service_token: str | None = Header(default=None)) -> dict[str, object]:
        _require_internal_access(x_internal_service_token)
        if not reference or len(reference) > 160:
            raise HTTPException(status_code=400, detail="invalid provider reference")
        try:
            return await asyncio.to_thread(service.reconcile_provider_reference, reference)
        except UnknownPayment as error:
            raise HTTPException(status_code=404, detail="unknown payment reference") from error
        except ProviderVerificationError as error:
            raise HTTPException(status_code=503, detail="provider verification unavailable") from error
        except PaymentError as error:
            raise HTTPException(status_code=409, detail="payment reconciliation conflict") from error

    return app


async def _webhook_verification_loop(service: PaymentWebhookService, interval_seconds: int) -> None:
    while True:
        try:
            processed = await asyncio.to_thread(service.process_pending_webhooks)
            if processed:
                LOGGER.info("verified payment webhooks count=%d", processed)
        except Exception:
            LOGGER.exception("background payment webhook verification pass failed")
        await asyncio.sleep(interval_seconds)


async def _payout_loop(service: PaymentWebhookService, interval_seconds: int) -> None:
    while True:
        try:
            processed = await asyncio.to_thread(service.process_due_payouts)
            if processed:
                LOGGER.info("processed driver payouts count=%d", processed)
        except Exception:
            LOGGER.exception("background payout release pass failed")
        await asyncio.sleep(interval_seconds)


def _require_internal_access(provided: str | None) -> None:
    if len(INTERNAL_SERVICE_TOKEN) < 32:
        raise HTTPException(status_code=503, detail="internal authentication is not configured")
    if not provided or not hmac.compare_digest(provided, INTERNAL_SERVICE_TOKEN):
        raise HTTPException(status_code=401, detail="invalid internal service token")


validate_boot_configuration()
app = create_app(PaymentConfig.from_environment())


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.getenv("BIND_HOST", "127.0.0.1"), port=int(os.getenv("PORT", "8122")))
