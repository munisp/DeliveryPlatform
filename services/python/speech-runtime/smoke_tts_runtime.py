from __future__ import annotations

import importlib.util
import json
import logging
import pathlib
import sys

logger = logging.getLogger("switchos.speech_runtime.smoke_tts")
ROOT = pathlib.Path(__file__).resolve().parent
MODULE_PATH = ROOT / "main.py"


def load_module():
    spec = importlib.util.spec_from_file_location("speech_runtime_main", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def main() -> int:
    text = sys.argv[1] if len(sys.argv) > 1 else "switchos longcat confirms your noodle order"
    module = load_module()
    result = module.synthesize_payload({"text": text, "engine": "piper"})
    printable = dict(result)
    audio_base64 = printable.get("audio_base64")
    printable["audio_base64_length"] = len(audio_base64) if isinstance(audio_base64, str) else 0
    if "audio_base64" in printable:
        printable["audio_base64"] = "<omitted>"
    logger.info("tts_smoke_result=%s", json.dumps(printable, sort_keys=True))
    return 0


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
    raise SystemExit(main())
