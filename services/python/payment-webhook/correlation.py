from __future__ import annotations

import json
import logging
import re
import uuid
from contextvars import ContextVar, Token
from typing import Any, Mapping

_REQUEST_ID: ContextVar[str] = ContextVar("payment_request_id", default="")
_RESILIENCE_RUN_ID: ContextVar[str] = ContextVar("payment_resilience_run_id", default="")
_IDENTIFIER = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{2,80}$")


def normalized_identifier(value: str | None) -> str:
    candidate = (value or "").strip()
    return candidate if _IDENTIFIER.fullmatch(candidate) else ""


def begin_request_context(request_id: str | None, resilience_run_id: str | None) -> tuple[Token[str], Token[str], str, str]:
    normalized_request_id = normalized_identifier(request_id) or str(uuid.uuid4())
    normalized_run_id = normalized_identifier(resilience_run_id)
    return (
        _REQUEST_ID.set(normalized_request_id),
        _RESILIENCE_RUN_ID.set(normalized_run_id),
        normalized_request_id,
        normalized_run_id,
    )


def restore_request_context(tokens: tuple[Token[str], Token[str], str, str]) -> None:
    request_token, run_token, _, _ = tokens
    _REQUEST_ID.reset(request_token)
    _RESILIENCE_RUN_ID.reset(run_token)


def current_request_id() -> str:
    return _REQUEST_ID.get()


def current_resilience_run_id() -> str:
    return _RESILIENCE_RUN_ID.get()


def log_event(logger: logging.Logger, event: str, **fields: Any) -> None:
    payload: dict[str, Any] = {
        "service": "ride-payment-webhook",
        "event": event,
        "request_id": current_request_id() or None,
        "resilience_run_id": current_resilience_run_id() or None,
    }
    for key, value in fields.items():
        if not _IDENTIFIER.fullmatch(key):
            continue
        if isinstance(value, str):
            payload[key] = value.replace("\x00", " ").replace("\n", " ").replace("\r", " ")[:256]
        elif isinstance(value, bool) or isinstance(value, int) or value is None:
            payload[key] = value
    logger.info(json.dumps(payload, sort_keys=True, separators=(",", ":")))


def correlation_fields() -> Mapping[str, str]:
    values: dict[str, str] = {}
    if current_request_id():
        values["request_id"] = current_request_id()
    if current_resilience_run_id():
        values["resilience_run_id"] = current_resilience_run_id()
    return values
