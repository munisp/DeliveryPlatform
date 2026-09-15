"""Boot-time configuration validation for the market-economics service.

Fails fast at startup, naming every missing required environment variable,
instead of crash-looping one variable at a time or silently degrading on
first use. Mirrors services/python/verification-intelligence.
"""

from __future__ import annotations

import os

REQUIRED_ENV_VARS = (
    "INTERNAL_SERVICE_TOKEN",
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
