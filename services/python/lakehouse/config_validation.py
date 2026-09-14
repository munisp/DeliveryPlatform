"""Boot-time configuration validation for the lakehouse service.

Fails fast, naming every missing required environment variable, instead of
silently falling back to hardcoded credentials or degrading on first use.
The static manifest contract check
(scripts/testing/check-config-contract.py) reads REQUIRED_ENV_VARS to
cross-check the Kubernetes manifests against the code.
"""

from __future__ import annotations

import os

REQUIRED_ENV_VARS = (
    "DATABASE_URL",
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
