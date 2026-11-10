# MiniCPM-OCR 1.0 — Document Field Extraction (KYC + Receipt/Delivery Proof)

## What it is

MiniCPM-OCR 1.0 is a 1.3B-parameter vision-language OCR model, served locally
through the platform's **existing Ollama runtime** (the same Ollama deployment
the LongCat speech-runtime uses). In key-information-extraction (KIE) mode you
prompt it with the field names you want, and it returns a JSON object — fields
it cannot find on the document come back as `###`, which this integration maps
to `null`.

An optional companion judge model, **MiniCPM-OCR Jev (2B)**, scores how
correct an extracted value is for its region on the document (0–1). That score
is the **only** confidence signal in this pipeline.

## License

**Apache-2.0, including the model weights** — safe for commercial use in the
platform. No usage-restriction rider, no copyleft on outputs. Keep the license
attribution in deployment artifacts.

## Hardware

- **GPU recommended.** On CPU, extraction is ~21 s/page — acceptable for
  async KYC case review, painful for interactive capture.
- 1.3B (extractor) + 2B (judge) fit comfortably on a single small GPU
  (GGUF, ~2–3 GB combined at q4 quantization).
- Point `MINICPM_OCR_OLLAMA_URL` at a GPU-backed Ollama replica if the shared
  `OLLAMA_URL` host is CPU-only.

## Language limitation — read before rolling out

MiniCPM-OCR 1.0 supports **English and Chinese only**. This is fine for
Nigerian official documents (NIN slips, driver's licenses, voter cards, CAC
documents, receipts — all English-script) but the model is **not suitable for
Arabic-script documents** (e.g. Hausa Ajami manuscripts, Arabic
certificates). Do not route such documents through this pipeline; they need
human review.

## Ollama setup

```bash
# Extraction model
ollama pull minicpm-ocr:1.0

# Optional judge (confidence scoring)
ollama pull minicpm-ocr-jev:2b
```

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `MINICPM_OCR_OLLAMA_URL` | *(falls back to `OLLAMA_URL`)* | Ollama base URL. Unset (both) ⇒ every call throws `ocr_not_configured` (fail closed). `OLLAMA_URL` is the speech-runtime's existing variable — reused intentionally. |
| `MINICPM_OCR_MODEL` | `minicpm-ocr:1.0` | Ollama tag for the extractor. |
| `MINICPM_OCR_TIMEOUT_MS` | `60000` | Clamped to 5 000–300 000. Raise for CPU-only hosts (21 s/page). |
| `MINICPM_OCR_JEV_ENABLED` | `false` | `true` enables the judge pass. |
| `MINICPM_OCR_JEV_MODEL` | `minicpm-ocr-jev:2b` | Ollama tag for the judge. |
| `MINICPM_OCR_REVIEW_THRESHOLD` | `0.7` | Clamped to 0–1. Fields scoring **below** this are flagged `needsReview`. |

## API

tRPC router `documentOcr` (mounted by the orchestrator):

- `documentOcr.extract` — **authenticated**. Drivers/renters extract fields
  from their own document image.
- `documentOcr.extractForCase` — **operator** (`operatorMutationProcedure("operate")`,
  the same policy tier as verification case actions). Adds `caseId` +
  `imageObjectKey`; every call is audit-logged via `recordOperationalEvent`
  (`ai.document_ocr.extracted`). Extracted field **values are never written
  to the audit stream** — metadata only.

Input (both procedures):

```jsonc
{
  "imageBase64": "...",            // strict base64, no data: prefix; decoded ≤ 6 MB
  "contentType": "image/jpeg",     // jpeg | png | webp only
  "fields": ["full_name", "nin"],  // 1–32 names, /^[a-zA-Z][a-zA-Z0-9_ ]{0,60}$/
  "documentHint": "NIN slip",      // optional
  "idempotencyKey": "abc-123-xyz"  // optional
}
```

Result per field:

```jsonc
{
  "value": "Adaeze Obi",   // null when the model reports the field missing
  "raw": "Adaeze Obi",     // verbatim model output (kept for audit/debug)
  "confidence": 0.91,      // Jev score 0–1, or null (see below)
  "needsReview": false     // confidence !== null && confidence < threshold
}
```

## KIE usage examples

**NIN slip** — `documentHint: "NIN slip"`,
fields: `nin`, `full_name`, `date_of_birth`, `address`

**Driver's license** — `documentHint: "Nigerian driver's license"`,
fields: `license_number`, `full_name`, `date_of_birth`, `expiry_date`, `class`

**Delivery receipt / proof of delivery** — `documentHint: "delivery receipt"`,
fields: `receipt_number`, `recipient_name`, `total_amount`, `date`, `signature_present`

## Jev confidence routing semantics

With `MINICPM_OCR_JEV_ENABLED=true`, each extracted (non-null) field gets a
judge pass and a 0–1 score:

- `confidence >= threshold` → `needsReview: false`
- `confidence < threshold` → `needsReview: true` (route to a human reviewer)
- boundary: exactly `0.7` with the default threshold is **not** flagged

## Honesty note: no Jev, no confidence

When the judge is disabled (the default) or unreachable, **`confidence` is
`null` and `needsReview` is `false`**. This is deliberate: MiniCPM-OCR 1.0
emits no intrinsic per-field confidence, and this integration refuses to
fabricate one. `needsReview: false` with `confidence: null` means
*unverified*, not *correct* — downstream UIs must render the two states
differently, and high-stakes KYC flows should enable the judge.

## Fail-closed error contract

No silent fallbacks; every failure throws a coded `DocumentOcrError`:

| Code | Cause |
| --- | --- |
| `ocr_not_configured` | Neither `MINICPM_OCR_OLLAMA_URL` nor `OLLAMA_URL` set |
| `ocr_backend_unavailable` | Network error or timeout talking to Ollama |
| `ocr_backend_error` | Ollama returned non-200 (status attached) |
| `ocr_response_unparseable` | Model output contained no JSON object |
| `ocr_unsupported_content_type` / `ocr_invalid_image_base64` / `ocr_image_too_large` | Input rejected before any model call |
| `ocr_invalid_field_name` / `ocr_no_fields` / `ocr_too_many_fields` | Field list rejected before any model call |
