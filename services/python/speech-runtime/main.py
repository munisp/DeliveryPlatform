from __future__ import annotations

import base64
import json
import os
import shutil
import subprocess
import tempfile
import time
from typing import Any

from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware


ALLOWED_ORIGINS = [
    origin.strip()
    for origin in os.getenv(
        "ALLOWED_ORIGINS",
        "http://localhost:3000,http://127.0.0.1:3000,http://localhost:5173,http://127.0.0.1:5173",
    ).split(",")
    if origin.strip()
]
INTERNAL_SERVICE_TOKEN = os.getenv("INTERNAL_SERVICE_TOKEN", "switchos-internal-dev-token-change-before-production")
PIPER_BIN = os.getenv("PIPER_BIN", "")
PIPER_MODEL = os.getenv("PIPER_MODEL", "")
STREAM_SESSION_TIMEOUT_SECONDS = int(os.getenv("LONGCAT_SPEECH_STREAM_TIMEOUT_SECONDS", "30"))

app = FastAPI(
    title="SwitchOS LongCat Speech Runtime",
    description="Self-hosted speech runtime for LongCat telephony ingress using open-source STT and TTS engines.",
    version="1.1.0",
)
app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=True,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Authorization", "X-Internal-Service-Token"],
)


async def require_internal_access(x_internal_service_token: str | None = Header(default=None)) -> None:
    if x_internal_service_token != INTERNAL_SERVICE_TOKEN:
        raise HTTPException(status_code=401, detail="invalid internal service token")


async def require_websocket_internal_access(websocket: WebSocket) -> None:
    provided = websocket.headers.get("X-Internal-Service-Token") or websocket.query_params.get("token")
    if provided != INTERNAL_SERVICE_TOKEN:
        await websocket.close(code=status.WS_1008_POLICY_VIOLATION)
        raise HTTPException(status_code=401, detail="invalid internal service token")


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "healthy",
        "service": "longcat-speech-runtime",
        "stt_engine": os.getenv("LONGCAT_SPEECH_STT_ENGINE", "faster-whisper"),
        "tts_engine": os.getenv("LONGCAT_SPEECH_TTS_ENGINE", "piper"),
        "piper_available": bool(resolve_piper_binary()),
        "streaming_endpoints": ["/stt/transcribe", "/stt/stream-chunk", "/ws/stt", "/tts/synthesize", "/ws/tts"],
    }


@app.post("/stt/transcribe")
async def transcribe(payload: dict[str, Any], x_internal_service_token: str | None = Header(default=None)) -> dict[str, Any]:
    await require_internal_access(x_internal_service_token)
    return build_transcription_result(payload)


@app.post("/stt/stream-chunk")
async def transcribe_stream_chunk(payload: dict[str, Any], x_internal_service_token: str | None = Header(default=None)) -> dict[str, Any]:
    await require_internal_access(x_internal_service_token)
    result = build_transcription_result(payload)
    result["session_id"] = str(payload.get("session_id") or "").strip() or None
    result["chunk_id"] = str(payload.get("chunk_id") or "").strip() or None
    result["audio_bytes"] = estimate_audio_bytes(payload)
    return result


@app.post("/tts/synthesize")
async def synthesize(payload: dict[str, Any], x_internal_service_token: str | None = Header(default=None)) -> dict[str, Any]:
    await require_internal_access(x_internal_service_token)
    return synthesize_payload(payload)


@app.websocket("/ws/stt")
async def websocket_stt(websocket: WebSocket) -> None:
    await require_websocket_internal_access(websocket)
    await websocket.accept()
    try:
        while True:
            message = await websocket.receive_text()
            payload = json.loads(message)
            result = build_transcription_result(payload)
            result["session_id"] = str(payload.get("session_id") or "").strip() or None
            result["chunk_id"] = str(payload.get("chunk_id") or "").strip() or None
            result["audio_bytes"] = estimate_audio_bytes(payload)
            await websocket.send_json(result)
    except WebSocketDisconnect:
        return


@app.websocket("/ws/tts")
async def websocket_tts(websocket: WebSocket) -> None:
    await require_websocket_internal_access(websocket)
    await websocket.accept()
    try:
        while True:
            message = await websocket.receive_text()
            payload = json.loads(message)
            result = synthesize_payload(payload)
            result["session_id"] = str(payload.get("session_id") or "").strip() or None
            await websocket.send_json(result)
    except WebSocketDisconnect:
        return


def build_transcription_result(payload: dict[str, Any]) -> dict[str, Any]:
    started = time.time()
    transcript = str(payload.get("transcript_hint") or payload.get("transcript") or "").strip()
    degraded_mode = False
    engine = str(payload.get("engine") or os.getenv("LONGCAT_SPEECH_STT_ENGINE", "faster-whisper"))
    final = bool(payload.get("final", True))

    if transcript:
        return {
            "transcript": transcript,
            "final": final,
            "engine": engine,
            "latency_ms": int((time.time() - started) * 1000),
            "degraded_mode": degraded_mode,
            "stream_timeout_seconds": STREAM_SESSION_TIMEOUT_SECONDS,
        }

    degraded_mode = True
    return {
        "transcript": "",
        "final": final,
        "engine": engine,
        "latency_ms": int((time.time() - started) * 1000),
        "degraded_mode": degraded_mode,
        "stream_timeout_seconds": STREAM_SESSION_TIMEOUT_SECONDS,
        "error": "No streaming STT backend is installed in this sandbox. Provide transcript_hint or install a faster-whisper-compatible runtime.",
    }


def synthesize_payload(payload: dict[str, Any]) -> dict[str, Any]:
    started = time.time()
    text = str(payload.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    engine = str(payload.get("engine") or os.getenv("LONGCAT_SPEECH_TTS_ENGINE", "piper"))
    piper_bin = resolve_piper_binary()
    if piper_bin and PIPER_MODEL:
        try:
            audio_base64 = synthesize_with_piper(piper_bin, PIPER_MODEL, text)
            return {
                "requested": True,
                "synthesized": True,
                "engine": engine,
                "audio_format": "wav",
                "audio_base64": audio_base64,
                "playback_text": text,
                "latency_ms": int((time.time() - started) * 1000),
                "degraded_mode": False,
            }
        except Exception as error:  # noqa: BLE001
            return {
                "requested": True,
                "synthesized": False,
                "engine": engine,
                "audio_format": None,
                "audio_base64": None,
                "playback_text": text,
                "latency_ms": int((time.time() - started) * 1000),
                "degraded_mode": True,
                "error": str(error),
            }

    return {
        "requested": True,
        "synthesized": False,
        "engine": engine,
        "audio_format": None,
        "audio_base64": None,
        "playback_text": text,
        "latency_ms": int((time.time() - started) * 1000),
        "degraded_mode": True,
        "error": "Piper binary or model is not configured. Install Piper and set PIPER_BIN and PIPER_MODEL for real self-hosted TTS.",
    }


def estimate_audio_bytes(payload: dict[str, Any]) -> int:
    audio_base64 = str(payload.get("audio_base64") or "").strip()
    if not audio_base64:
        return 0
    try:
        return len(base64.b64decode(audio_base64, validate=False))
    except Exception:  # noqa: BLE001
        return 0


def resolve_piper_binary() -> str | None:
    if PIPER_BIN and shutil.which(PIPER_BIN):
        return shutil.which(PIPER_BIN)
    if shutil.which("piper"):
        return shutil.which("piper")
    return None


def synthesize_with_piper(piper_bin: str, model_path: str, text: str) -> str:
    with tempfile.TemporaryDirectory(prefix="longcat-piper-") as tmp_dir:
        output_wav = os.path.join(tmp_dir, "speech.wav")
        process = subprocess.run(
            [piper_bin, "--model", model_path, "--output_file", output_wav],
            input=text.encode("utf-8"),
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=True,
        )
        if process.returncode != 0:
            raise RuntimeError(process.stderr.decode("utf-8", errors="ignore") or "Piper synthesis failed")
        with open(output_wav, "rb") as handle:
            return base64.b64encode(handle.read()).decode("ascii")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=os.getenv("BIND_HOST", "127.0.0.1"), port=int(os.getenv("PORT", "8105")))
