from __future__ import annotations

import base64
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import wave
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
BASE_DIR = Path(__file__).resolve().parent
PIPER_BIN = os.getenv("PIPER_BIN", "")
PIPER_MODEL = os.getenv("PIPER_MODEL", "")
LOCAL_PIPER_MODEL = BASE_DIR / "models" / "en_US-lessac-medium.onnx"
STT_MODEL_PATH = os.getenv("LONGCAT_SPEECH_STT_MODEL", "").strip() or os.getenv("WHISPER_MODEL", "").strip() or os.getenv("FASTER_WHISPER_MODEL", "").strip() or "tiny.en"
WHISPER_CPP_BIN = os.getenv("WHISPER_CPP_BIN", "").strip()
STREAM_SESSION_TIMEOUT_SECONDS = int(os.getenv("LONGCAT_SPEECH_STREAM_TIMEOUT_SECONDS", "30"))
FASTER_WHISPER_DEVICE = os.getenv("LONGCAT_SPEECH_STT_DEVICE", "cpu").strip() or "cpu"
FASTER_WHISPER_COMPUTE_TYPE = os.getenv("LONGCAT_SPEECH_STT_COMPUTE_TYPE", "int8").strip() or "int8"
_faster_whisper_models: dict[str, Any] = {}

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
    stt_runtime = resolve_stt_runtime()
    tts_runtime = resolve_tts_runtime()
    overall_status = "healthy" if stt_runtime["ready"] or tts_runtime["ready"] else "degraded"
    return {
        "status": overall_status,
        "service": "longcat-speech-runtime",
        "stt_engine": stt_runtime["engine"],
        "tts_engine": tts_runtime["engine"],
        "stt_ready": stt_runtime["ready"],
        "tts_ready": tts_runtime["ready"],
        "stt_runtime": stt_runtime,
        "tts_runtime": tts_runtime,
        "stream_timeout_seconds": STREAM_SESSION_TIMEOUT_SECONDS,
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
    stt_runtime = resolve_stt_runtime(str(payload.get("engine") or "").strip() or None)
    engine = str(stt_runtime["engine"])
    final = bool(payload.get("final", True))

    if transcript:
        return {
            "transcript": transcript,
            "final": final,
            "engine": engine,
            "latency_ms": int((time.time() - started) * 1000),
            "degraded_mode": False,
            "engine_ready": stt_runtime["ready"],
            "degraded_reason": None,
            "stream_timeout_seconds": STREAM_SESSION_TIMEOUT_SECONDS,
        }

    if stt_runtime["ready"]:
        try:
            live_transcript = transcribe_with_runtime(payload, stt_runtime)
            return {
                "transcript": live_transcript,
                "final": final,
                "engine": engine,
                "latency_ms": int((time.time() - started) * 1000),
                "degraded_mode": False,
                "engine_ready": True,
                "degraded_reason": None,
                "stream_timeout_seconds": STREAM_SESSION_TIMEOUT_SECONDS,
            }
        except Exception as error:  # noqa: BLE001
            return {
                "transcript": "",
                "final": final,
                "engine": engine,
                "latency_ms": int((time.time() - started) * 1000),
                "degraded_mode": True,
                "engine_ready": False,
                "degraded_reason": str(error),
                "stream_timeout_seconds": STREAM_SESSION_TIMEOUT_SECONDS,
                "error": f"Streaming STT execution failed: {error}",
            }

    return {
        "transcript": "",
        "final": final,
        "engine": engine,
        "latency_ms": int((time.time() - started) * 1000),
        "degraded_mode": True,
        "engine_ready": stt_runtime["ready"],
        "degraded_reason": stt_runtime["reason"],
        "stream_timeout_seconds": STREAM_SESSION_TIMEOUT_SECONDS,
        "error": f"Streaming STT engine is not ready: {stt_runtime['reason']}. Provide transcript_hint or install a compatible self-hosted runtime.",
    }


def synthesize_payload(payload: dict[str, Any]) -> dict[str, Any]:
    started = time.time()
    text = str(payload.get("text") or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is required")

    tts_runtime = resolve_tts_runtime(str(payload.get("engine") or "").strip() or None)
    engine = str(tts_runtime["engine"])
    piper_bin = resolve_piper_binary()
    piper_model = resolve_piper_model_path()
    if piper_bin and piper_model:
        try:
            audio_base64 = synthesize_with_piper(piper_bin, piper_model, text)
            return {
                "requested": True,
                "synthesized": True,
                "engine": engine,
                "audio_format": "wav",
                "audio_base64": audio_base64,
                "playback_text": text,
                "latency_ms": int((time.time() - started) * 1000),
                "degraded_mode": False,
                "engine_ready": True,
                "degraded_reason": None,
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
                "engine_ready": False,
                "degraded_reason": str(error),
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
        "engine_ready": tts_runtime["ready"],
        "degraded_reason": tts_runtime["reason"],
        "error": "Piper binary or model is not configured. Install Piper and set PIPER_BIN and PIPER_MODEL for real self-hosted TTS.",
    }


def resolve_stt_runtime(engine_override: str | None = None) -> dict[str, Any]:
    engine = (engine_override or os.getenv("LONGCAT_SPEECH_STT_ENGINE", "faster-whisper")).strip() or "faster-whisper"
    normalized = engine.lower()
    model_path = resolve_stt_model_path()
    faster_whisper_available = importlib.util.find_spec("faster_whisper") is not None
    whisper_cpp_binary = resolve_whisper_cpp_binary()
    if "faster-whisper" in normalized:
        ready = faster_whisper_available and bool(model_path)
        reason = None if ready else "faster_whisper_module_or_model_missing"
    elif "whisper" in normalized:
        ready = bool(whisper_cpp_binary and model_path)
        reason = None if ready else "whisper_cpp_binary_or_model_missing"
    else:
        ready = bool(model_path)
        reason = None if ready else "stt_model_missing"
    return {
        "engine": engine,
        "ready": ready,
        "model_path": model_path,
        "binary": whisper_cpp_binary,
        "reason": reason,
    }


def resolve_tts_runtime(engine_override: str | None = None) -> dict[str, Any]:
    engine = (engine_override or os.getenv("LONGCAT_SPEECH_TTS_ENGINE", "piper")).strip() or "piper"
    piper_bin = resolve_piper_binary()
    piper_model = resolve_piper_model_path()
    ready = bool(piper_bin and piper_model)
    return {
        "engine": engine,
        "ready": ready,
        "binary": piper_bin,
        "model_path": piper_model,
        "reason": None if ready else "piper_binary_or_model_missing",
    }


def transcribe_with_runtime(payload: dict[str, Any], stt_runtime: dict[str, Any]) -> str:
    engine = str(stt_runtime.get("engine") or "").strip().lower()
    if "faster-whisper" in engine:
        return transcribe_with_faster_whisper(payload, str(stt_runtime.get("model_path") or STT_MODEL_PATH))
    raise RuntimeError(f"unsupported_stt_engine:{engine or 'unknown'}")


def transcribe_with_faster_whisper(payload: dict[str, Any], model_path: str) -> str:
    if not model_path:
        raise RuntimeError("faster_whisper_model_not_configured")
    audio_bytes = decode_audio_bytes(payload)
    if not audio_bytes:
        raise RuntimeError("audio_chunk_missing")
    sample_rate_hz = int(payload.get("sample_rate_hz") or 16000)
    audio_wav = render_pcm16_mono_wav(audio_bytes, sample_rate_hz)
    model = get_faster_whisper_model(model_path)
    with tempfile.NamedTemporaryFile(prefix="longcat-stt-", suffix=".wav", delete=True) as handle:
        handle.write(audio_wav)
        handle.flush()
        segments, _ = model.transcribe(handle.name, language=str(payload.get("language") or "en"), vad_filter=True)
        transcript = " ".join(segment.text.strip() for segment in segments if segment.text and segment.text.strip()).strip()
    return transcript


def get_faster_whisper_model(model_path: str):
    cached = _faster_whisper_models.get(model_path)
    if cached is not None:
        return cached
    from faster_whisper import WhisperModel

    model = WhisperModel(model_path, device=FASTER_WHISPER_DEVICE, compute_type=FASTER_WHISPER_COMPUTE_TYPE)
    _faster_whisper_models[model_path] = model
    return model


def resolve_stt_model_path() -> str | None:
    candidate = STT_MODEL_PATH.strip()
    return candidate or None


def resolve_piper_model_path() -> str | None:
    if PIPER_MODEL.strip():
        return PIPER_MODEL.strip()
    if LOCAL_PIPER_MODEL.exists():
        return str(LOCAL_PIPER_MODEL)
    return None


def decode_audio_bytes(payload: dict[str, Any]) -> bytes:
    audio_base64 = str(payload.get("audio_base64") or "").strip()
    if not audio_base64:
        return b""
    return base64.b64decode(audio_base64, validate=False)


def render_pcm16_mono_wav(audio_bytes: bytes, sample_rate_hz: int) -> bytes:
    with io.BytesIO() as buffer:
        with wave.open(buffer, "wb") as wav_file:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(max(8000, sample_rate_hz or 16000))
            wav_file.writeframes(audio_bytes)
        return buffer.getvalue()


def estimate_audio_bytes(payload: dict[str, Any]) -> int:
    try:
        return len(decode_audio_bytes(payload))
    except Exception:  # noqa: BLE001
        return 0


def resolve_whisper_cpp_binary() -> str | None:
    if WHISPER_CPP_BIN and shutil.which(WHISPER_CPP_BIN):
        return shutil.which(WHISPER_CPP_BIN)
    for candidate in ("whisper-cpp", "whisper-cli", "main"):
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
    return None


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
