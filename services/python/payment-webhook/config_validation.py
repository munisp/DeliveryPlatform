"""Boot-time configuration validation for the payment-webhook service.

Fails fast at startup, naming every missing required environment variable,
instead of crash-looping one variable at a time or silently degrading on
first use. The static manifest contract check
(scripts/testing/check-config-contract.py) reads REQUIRED_ENV_VARS to
cross-check the Kubernetes manifests against the code.
"""

from __future__ import annotations

import os

REQUIRED_ENV_VARS = (
    "DATABASE_URL",
    "INTERNAL_SERVICE_TOKEN",
    "PAYMENT_PROVIDER_NAME",
    "PAYMENT_WEBHOOK_SECRET",
    "PAYMENT_PROVIDER_API_KEY",
    "PAYMENT_VERIFY_URL_TEMPLATE",
    "PAYMENT_TRANSFER_VERIFY_URL_TEMPLATE",
    "PAYMENT_TRANSFER_SUBMIT_URL",
)


def missing_required_env_vars() -> list[str]:
    return [name for name in REQUIRED_ENV_VARS if not os.getenv(name, "").strip()]


def validate_boot_configuration() -> None:
    missing = missing_required_env_vars()
    if missing:
        raise RuntimeError(
            "invalid boot configuration: missing required environment variables: "
            + ", ".join(missing)
        )
