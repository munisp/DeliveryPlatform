from __future__ import annotations

import base64
import importlib.util
import json
import os
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parent
MODULE_PATH = ROOT / "main.py"


def load_module():
    spec = importlib.util.spec_from_file_location("speech_runtime_main", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def convert_to_pcm16_mono_base64(input_audio: pathlib.Path) -> str:
    with tempfile.NamedTemporaryFile(prefix="longcat-smoke-", suffix=".s16", delete=True) as handle:
        subprocess.run(
            [
                "ffmpeg",
                "-y",
                "-i",
                str(input_audio),
                "-f",
                "s16le",
                "-acodec",
                "pcm_s16le",
                "-ac",
                "1",
                "-ar",
                "16000",
                handle.name,
            ],
            check=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        pcm_bytes = pathlib.Path(handle.name).read_bytes()
    return base64.b64encode(pcm_bytes).decode("ascii")


def main() -> int:
    sample_audio = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / "sample_harvard.wav"
    os.environ.setdefault("LONGCAT_SPEECH_STT_ENGINE", "faster-whisper")
    os.environ.setdefault("LONGCAT_SPEECH_STT_MODEL", "tiny.en")
    module = load_module()

    payload = {
        "engine": "faster-whisper",
        "sample_rate_hz": 16000,
        "audio_base64": convert_to_pcm16_mono_base64(sample_audio),
        "final": True,
        "language": "en",
        "session_id": "smoke-session",
        "chunk_id": "smoke-chunk-1",
    }
    result = module.build_transcription_result(payload)
    print(json.dumps(result, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
