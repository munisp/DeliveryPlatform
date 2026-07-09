from __future__ import annotations

import importlib.util
import pathlib
import unittest
from unittest.mock import patch

MODULE_PATH = pathlib.Path(__file__).resolve().parent / "main.py"
SPEC = importlib.util.spec_from_file_location("speech_runtime_main", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class SpeechRuntimeContractTests(unittest.TestCase):
    def test_resolve_stt_runtime_reports_missing_backend_honestly(self) -> None:
        with patch.object(MODULE, "STT_MODEL_PATH", ""), patch.object(MODULE, "WHISPER_CPP_BIN", ""):
            runtime = MODULE.resolve_stt_runtime("faster-whisper")
        self.assertEqual(runtime["engine"], "faster-whisper")
        self.assertFalse(runtime["ready"])
        self.assertEqual(runtime["reason"], "faster_whisper_module_or_model_missing")

    def test_build_transcription_result_exposes_engine_readiness_and_reason(self) -> None:
        with patch.object(
            MODULE,
            "resolve_stt_runtime",
            return_value={
                "engine": "whisper.cpp",
                "ready": False,
                "model_path": None,
                "binary": None,
                "reason": "whisper_cpp_binary_or_model_missing",
            },
        ):
            result = MODULE.build_transcription_result({"final": True})
        self.assertTrue(result["degraded_mode"])
        self.assertFalse(result["engine_ready"])
        self.assertEqual(result["degraded_reason"], "whisper_cpp_binary_or_model_missing")
        self.assertIn("not ready", result["error"])

    def test_synthesize_payload_reports_degraded_reason_when_piper_is_unavailable(self) -> None:
        with patch.object(
            MODULE,
            "resolve_tts_runtime",
            return_value={
                "engine": "piper",
                "ready": False,
                "binary": None,
                "model_path": None,
                "reason": "piper_binary_or_model_missing",
            },
        ), patch.object(MODULE, "resolve_piper_binary", return_value=None), patch.object(MODULE, "PIPER_MODEL", ""):
            result = MODULE.synthesize_payload({"text": "hello from longcat"})
        self.assertTrue(result["degraded_mode"])
        self.assertFalse(result["engine_ready"])
        self.assertEqual(result["degraded_reason"], "piper_binary_or_model_missing")
        self.assertFalse(result["synthesized"])


if __name__ == "__main__":
    unittest.main()
