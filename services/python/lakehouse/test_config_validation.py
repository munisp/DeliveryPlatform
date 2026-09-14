from __future__ import annotations

import os
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import config_validation  # noqa: E402


class BootConfigurationTests(unittest.TestCase):
    def test_missing_variables_are_all_named(self) -> None:
        saved = {name: os.environ.pop(name, None) for name in config_validation.REQUIRED_ENV_VARS}
        try:
            with self.assertRaises(RuntimeError) as raised:
                config_validation.validate_boot_configuration()
            for name in config_validation.REQUIRED_ENV_VARS:
                self.assertIn(name, str(raised.exception))
        finally:
            for name, value in saved.items():
                if value is not None:
                    os.environ[name] = value

    def test_complete_environment_passes(self) -> None:
        saved = {name: os.environ.get(name) for name in config_validation.REQUIRED_ENV_VARS}
        try:
            os.environ["DATABASE_URL"] = "postgresql://example.invalid/switchos"
            os.environ["INTERNAL_SERVICE_TOKEN"] = "a" * 32
            config_validation.validate_boot_configuration()
        finally:
            for name, value in saved.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value

    def test_service_has_no_hardcoded_credential_fallback(self) -> None:
        saved = os.environ.pop("DATABASE_URL", None)
        try:
            from service import LakehouseService

            with self.assertRaises(RuntimeError) as raised:
                LakehouseService()
            self.assertIn("DATABASE_URL", str(raised.exception))
        finally:
            if saved is not None:
                os.environ["DATABASE_URL"] = saved


if __name__ == "__main__":
    unittest.main()
