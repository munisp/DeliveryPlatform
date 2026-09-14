import base64
import hashlib
import io
import json
import logging
import math
import os
import tempfile
from functools import lru_cache
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

import httpx
from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field

from config_validation import validate_boot_configuration

validate_boot_configuration()

INTERNAL_SERVICE_TOKEN = os.environ.get("INTERNAL_SERVICE_TOKEN", "")
MAX_EVIDENCE_BYTES = int(os.environ.get("VERIFICATION_MAX_EVIDENCE_BYTES", "10485760"))
VLM_DOCUMENT_URL = os.environ.get("VLM_DOCUMENT_URL", "").strip()
VLM_DOCUMENT_TOKEN = os.environ.get("VLM_DOCUMENT_TOKEN", "").strip()

if bool(VLM_DOCUMENT_URL) != bool(VLM_DOCUMENT_TOKEN):
    raise RuntimeError(
        "invalid boot configuration: VLM_DOCUMENT_URL and VLM_DOCUMENT_TOKEN must be configured together"
    )
if not VLM_DOCUMENT_URL:
    logging.getLogger("verification-intelligence").warning(
        "VLM_DOCUMENT_URL/VLM_DOCUMENT_TOKEN are not configured; the vlm_document processor is DISABLED "
        "(reflected as vlm_enabled=false on the health surface)"
    )

app = FastAPI(title="DeliveryPlatform Verification Intelligence", version="1.1.0")


class DocumentRequest(BaseModel):
    processor: Literal["paddleocr", "docling", "vlm_document", "document_forensics"]
    evidence_kind: str = Field(pattern=r"^[a-z][a-z0-9_.-]{2,63}$")
    content_type: Literal["application/pdf", "image/jpeg", "image/png", "image/heic"]
    sha256_hex: str = Field(pattern=r"^[a-f0-9]{64}$")
    object_body_base64: str = Field(min_length=4, max_length=16_777_216)
    capture_metadata: dict[str, Any] = Field(default_factory=dict)


class LivenessRequest(BaseModel):
    processor: Literal["liveness"] = "liveness"
    challenge_id: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$")
    challenge_nonce: str = Field(min_length=24, max_length=512)
    expected_nonce_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    capture_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    frame_sha256: list[str] = Field(min_length=3, max_length=12)
    captured_at_ms: int = Field(ge=0)
    expires_at_ms: int = Field(ge=0)
    device_attestation_ref: str = Field(pattern=r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$")


class ProcessResponse(BaseModel):
    state: Literal["completed", "manual_review", "failed"]
    outcome_code: str
    output_digest_hex: str | None
    output: dict[str, Any]


def require_internal(token: str | None) -> None:
    if not INTERNAL_SERVICE_TOKEN or token != INTERNAL_SERVICE_TOKEN:
        raise HTTPException(status_code=401, detail="invalid internal service token")


def canonical_digest(value: dict[str, Any]) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()


def decode_and_verify(body_base64: str, expected_digest: str) -> bytes:
    try:
        body = base64.b64decode(body_base64, validate=True)
    except Exception as error:
        raise HTTPException(status_code=400, detail="invalid evidence encoding") from error
    if not body or len(body) > MAX_EVIDENCE_BYTES:
        raise HTTPException(status_code=413, detail="invalid evidence size")
    if hashlib.sha256(body).hexdigest() != expected_digest:
        raise HTTPException(status_code=422, detail="evidence sha256 mismatch")
    return body


def synthetic_document_result(request: DocumentRequest, body: bytes) -> ProcessResponse:
    output = {
        "processor": request.processor,
        "processor_version": "synthetic-contract-v1",
        "evidence_kind": request.evidence_kind,
        "input_sha256": request.sha256_hex,
        "byte_count": len(body),
        "manual_review_required": True,
        "reason": "synthetic_processor_output_not_identity_verification",
    }
    return ProcessResponse(
        state="manual_review",
        outcome_code="document_extracted_review_required",
        output_digest_hex=canonical_digest(output),
        output=output,
    )


@lru_cache(maxsize=1)
def get_paddle_engine() -> Any:
    from paddleocr import PaddleOCR  # type: ignore

    return PaddleOCR(lang="en")


def paddleocr_result(request: DocumentRequest, body: bytes) -> ProcessResponse:
    try:
        engine = get_paddle_engine()
    except ImportError:
        return ProcessResponse(
            state="manual_review",
            outcome_code="paddleocr_unavailable_manual_review",
            output_digest_hex=None,
            output={"processor": "paddleocr", "manual_review_required": True},
        )
    suffix = ".pdf" if request.content_type == "application/pdf" else ".img"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
        handle.write(body)
        path = Path(handle.name)
    try:
        raw = engine.predict(str(path))
        output = {
            "processor": "paddleocr",
            "processor_version": "3.x",
            "input_sha256": request.sha256_hex,
            "raw": str(raw)[:100_000],
            "manual_review_required": True,
        }
        return ProcessResponse(
            state="manual_review",
            outcome_code="document_extracted_review_required",
            output_digest_hex=canonical_digest(output),
            output=output,
        )
    except Exception as error:
        output = {
            "processor": "paddleocr",
            "manual_review_required": True,
            "error_class": type(error).__name__,
        }
        return ProcessResponse(
            state="manual_review",
            outcome_code="paddleocr_processing_error_manual_review",
            output_digest_hex=canonical_digest(output),
            output=output,
        )
    finally:
        path.unlink(missing_ok=True)


def docling_result(request: DocumentRequest, body: bytes) -> ProcessResponse:
    try:
        from docling.document_converter import DocumentConverter  # type: ignore
    except ImportError:
        return ProcessResponse(
            state="manual_review",
            outcome_code="docling_unavailable_manual_review",
            output_digest_hex=None,
            output={"processor": "docling", "manual_review_required": True},
        )
    suffix = ".pdf" if request.content_type == "application/pdf" else ".img"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as handle:
        handle.write(body)
        path = Path(handle.name)
    try:
        converted = DocumentConverter().convert(str(path))
        output = {
            "processor": "docling",
            "processor_version": "docling",
            "input_sha256": request.sha256_hex,
            "document": str(converted.document.export_to_dict())[:100_000],
            "manual_review_required": True,
        }
        return ProcessResponse(
            state="manual_review",
            outcome_code="document_extracted_review_required",
            output_digest_hex=canonical_digest(output),
            output=output,
        )
    except Exception as error:
        output = {
            "processor": "docling",
            "manual_review_required": True,
            "error_class": type(error).__name__,
        }
        return ProcessResponse(
            state="manual_review",
            outcome_code="docling_processing_error_manual_review",
            output_digest_hex=canonical_digest(output),
            output=output,
        )
    finally:
        path.unlink(missing_ok=True)


MRZ_WEIGHTS = (7, 3, 1)


def mrz_character_value(character: str) -> int | None:
    if character == "<":
        return 0
    if "0" <= character <= "9":
        return ord(character) - ord("0")
    if "A" <= character <= "Z":
        return ord(character) - ord("A") + 10
    return None


def mrz_check_digit(value: str) -> int | None:
    total = 0
    for index, character in enumerate(value):
        numeric = mrz_character_value(character)
        if numeric is None:
            return None
        total += numeric * MRZ_WEIGHTS[index % len(MRZ_WEIGHTS)]
    return total % 10


def validate_td3_mrz(lines: list[str]) -> dict[str, Any]:
    normalized = [line.strip().replace(" ", "") for line in lines]
    if len(normalized) != 2 or any(len(line) != 44 for line in normalized):
        return {
            "present": bool(normalized),
            "format": "unsupported_or_malformed",
            "valid": False,
            "failures": ["mrz_td3_two_44_character_lines_required"],
        }
    first, second = normalized
    failures: list[str] = []
    if not first.startswith("P<"):
        failures.append("mrz_td3_document_prefix_invalid")
    checks = [
        ("document_number", second[0:9], second[9]),
        ("birth_date", second[13:19], second[19]),
        ("expiry_date", second[21:27], second[27]),
        ("personal_number", second[28:42], second[42]),
        ("composite", second[0:10] + second[13:20] + second[21:43], second[43]),
    ]
    for field_name, value, claimed_digit in checks:
        calculated = mrz_check_digit(value)
        if calculated is None or claimed_digit not in "0123456789" or calculated != int(claimed_digit):
            failures.append(f"mrz_{field_name}_checksum_invalid")
    return {
        "present": True,
        "format": "td3_passport",
        "valid": not failures,
        "failures": failures,
    }


def expected_file_signature(content_type: str, body: bytes) -> bool:
    if content_type == "image/jpeg":
        return body.startswith(b"\xff\xd8\xff")
    if content_type == "image/png":
        return body.startswith(b"\x89PNG\r\n\x1a\n")
    if content_type == "application/pdf":
        return body.startswith(b"%PDF-")
    if content_type == "image/heic":
        return len(body) >= 12 and body[4:8] == b"ftyp"
    return False


def image_forensics_artifacts(content_type: str, body: bytes) -> dict[str, Any]:
    artifacts: dict[str, Any] = {
        "file_signature_matches_content_type": expected_file_signature(content_type, body),
        "byte_count": len(body),
        "byte_sha256": hashlib.sha256(body).hexdigest(),
        "artifacts_version": "forensics-v1",
    }
    if content_type not in {"image/jpeg", "image/png", "image/heic"}:
        artifacts["image_decode"] = "not_attempted_non_image"
        return artifacts
    try:
        from PIL import Image  # type: ignore

        with Image.open(io.BytesIO(body)) as image:
            image.verify()
        with Image.open(io.BytesIO(body)) as image:
            width, height = image.size
            pixels = width * height
            histogram = image.convert("L").histogram()
            probabilities = [count / pixels for count in histogram if count]
            entropy = -sum(value * math.log2(value) for value in probabilities)
            artifacts.update(
                {
                    "image_decode": "ok",
                    "detected_format": image.format,
                    "width": width,
                    "height": height,
                    "mode": image.mode,
                    "exif_present": bool(image.getexif()),
                    "metadata_keys": sorted(str(key) for key in image.info.keys())[:32],
                    "grayscale_entropy": round(entropy, 4),
                }
            )
    except ImportError:
        artifacts["image_decode"] = "pillow_unavailable"
    except Exception as error:
        artifacts["image_decode"] = "decode_error"
        artifacts["decode_error_class"] = type(error).__name__
    return artifacts


def forensics_result(request: DocumentRequest, body: bytes) -> ProcessResponse:
    raw_mrz = request.capture_metadata.get("mrz_lines", [])
    mrz_lines = raw_mrz if isinstance(raw_mrz, list) and all(isinstance(item, str) and len(item) <= 64 for item in raw_mrz) else []
    output = {
        "processor": "document_forensics",
        "processor_version": "forensics-v1",
        "input_sha256": request.sha256_hex,
        "image_artifacts": image_forensics_artifacts(request.content_type, body),
        "mrz": validate_td3_mrz(mrz_lines),
        "manual_review_required": True,
        "decision_boundary": "forensic_signals_are_not_document_authenticity_verdicts",
    }
    return ProcessResponse(
        state="manual_review",
        outcome_code="document_forensics_review_required",
        output_digest_hex=canonical_digest(output),
        output=output,
    )


async def vlm_result(request: DocumentRequest, body: bytes) -> ProcessResponse:
    if not VLM_DOCUMENT_URL or not VLM_DOCUMENT_TOKEN:
        return ProcessResponse(
            state="manual_review",
            outcome_code="vlm_disabled_manual_review",
            output_digest_hex=None,
            output={"processor": "vlm_document", "manual_review_required": True},
        )
    payload = {
        "content_type": request.content_type,
        "sha256_hex": request.sha256_hex,
        "document_base64": base64.b64encode(body).decode("ascii"),
        "task": "extract_structure_only_no_identity_decision",
    }
    try:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.post(
                VLM_DOCUMENT_URL,
                json=payload,
                headers={"Authorization": f"Bearer {VLM_DOCUMENT_TOKEN}"},
            )
            response.raise_for_status()
            raw = response.json()
    except Exception as error:
        output = {
            "processor": "vlm_document",
            "manual_review_required": True,
            "error_class": type(error).__name__,
        }
        return ProcessResponse(
            state="manual_review",
            outcome_code="vlm_unavailable_manual_review",
            output_digest_hex=canonical_digest(output),
            output=output,
        )
    output = {
        "processor": "vlm_document",
        "input_sha256": request.sha256_hex,
        "extraction": raw,
        "manual_review_required": True,
    }
    return ProcessResponse(
        state="manual_review",
        outcome_code="document_extracted_review_required",
        output_digest_hex=canonical_digest(output),
        output=output,
    )


@app.get("/health")
def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "service": "verification-intelligence",
        "paddleocr_enabled": bool(os.environ.get("ENABLE_PADDLEOCR")),
        "docling_enabled": bool(os.environ.get("ENABLE_DOCLING")),
        "vlm_enabled": bool(VLM_DOCUMENT_URL and VLM_DOCUMENT_TOKEN),
        "document_forensics_enabled": True,
    }


@app.post("/v1/documents/process", response_model=ProcessResponse)
async def process_document(
    request: DocumentRequest,
    x_internal_service_token: str | None = Header(default=None),
) -> ProcessResponse:
    require_internal(x_internal_service_token)
    body = decode_and_verify(request.object_body_base64, request.sha256_hex)
    if os.environ.get("VERIFICATION_SYNTHETIC_MODE") == "true":
        return synthetic_document_result(request, body)
    if request.processor == "paddleocr":
        return paddleocr_result(request, body)
    if request.processor == "docling":
        return docling_result(request, body)
    if request.processor == "document_forensics":
        return forensics_result(request, body)
    return await vlm_result(request, body)


@app.post("/v1/liveness/process", response_model=ProcessResponse)
def process_liveness(
    request: LivenessRequest,
    x_internal_service_token: str | None = Header(default=None),
) -> ProcessResponse:
    require_internal(x_internal_service_token)
    nonce_digest = hashlib.sha256(request.challenge_nonce.encode("utf-8")).hexdigest()
    distinct_frames = len(set(request.frame_sha256)) == len(request.frame_sha256)
    hashes_valid = all(
        len(item) == 64 and all(char in "0123456789abcdef" for char in item)
        for item in request.frame_sha256
    )
    within_window = (
        request.captured_at_ms <= request.expires_at_ms
        and request.expires_at_ms - request.captured_at_ms <= 300_000
    )
    coherent = (
        nonce_digest == request.expected_nonce_sha256
        and hashes_valid
        and distinct_frames
        and within_window
    )
    output = {
        "processor": "liveness_artifact_v1",
        "challenge_id": request.challenge_id,
        "capture_sha256": request.capture_sha256,
        "frame_count": len(request.frame_sha256),
        "distinct_frames": distinct_frames,
        "within_window": within_window,
        "device_attestation_ref_present": bool(request.device_attestation_ref),
        "processed_at": datetime.now(timezone.utc).isoformat(),
        "manual_review_required": True,
    }
    return ProcessResponse(
        state="manual_review",
        outcome_code=(
            "liveness_artifact_complete_manual_review"
            if coherent
            else "liveness_artifact_incomplete_manual_review"
        ),
        output_digest_hex=canonical_digest(output),
        output=output,
    )
