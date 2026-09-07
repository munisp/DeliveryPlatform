# Machine-Learning-First Document Forensics Integration

**Author:** Manus AI
**Date:** 2026-09-07
**Status:** Architecture and deployment requirements; no third-party forensic provider has been selected, configured, or contacted.

## Purpose and Decision Boundary

The platform can use machine learning to create **counterfeit-risk evidence**, not an automatic eligibility or adverse-decision verdict. The implemented `document_forensics` processor validates content-type signatures, bounded image-decode metadata, image dimensions, metadata presence/keys, grayscale entropy, and optional ICAO TD3 machine-readable-zone checksums. It always returns `manual_review`.

> A model result identifies risk for review. It does not prove a document is authentic, a document is forged, or that an applicant is the document holder.

The PostgreSQL verification case remains the authority. It requires purpose-bound active consent, current unexpired required checks, an authorized reviewer, an explicit reason, immutable decision evidence, and an outbox event for every final decision. Consent withdrawal suspends a previously verified case.

## Recommended ML-First Service Boundary

The preferred operating design is a self-hosted or region-constrained **document-forensics inference service** behind the Go verification orchestrator. PaddleOCR/Docling first extract bounded structure. The forensics service then scores document template alignment and tamper artifacts. It returns only a bounded contract:

```json
{
  "model_id": "document-forensics-ng-la-id-v1",
  "model_version": "2026.09.0",
  "input_sha256": "<64 lowercase hexadecimal characters>",
  "risk_band": "low|medium|high|unavailable",
  "signals": ["template_mismatch", "mrz_document_number_checksum_invalid"],
  "output_digest_hex": "<64 lowercase hexadecimal characters>",
  "manual_review_required": true
}
```

The returned contract must never include face embeddings, full raw OCR text, a decision score with no explanation, or an unsupported claim of document authenticity. Store the output digest and bounded evidence signals in the existing processor-job completion output; retain raw images only in encrypted object storage under a documented retention rule.

| Component | Responsibility | Data minimization control |
|---|---|---|
| TypeScript API | Receives consent, case/evidence metadata, and processing request. | Never receives or logs image bytes; binds the request to the subject identity. |
| PostgreSQL | Persists consent, object key, SHA-256, job claim, evidence state, reviewer decision, and audit events. | Stores integrity digests and bounded metadata, not binary documents. |
| Go orchestrator | Claims a token-fenced job, retrieves a hash-bound object, sends it to the selected internal processor, and completes with the same claim token. | Fixed object allowlist in local simulation; production uses short-lived scoped access. |
| Python intelligence | Extracts deterministic artifact features and OCR/document structure. | Bounded input/output, temporary local file removal, no automatic decision. |
| ML forensics inference | Scores template/tamper risk and reports explainable signals. | Prefer self-hosted or jurisdiction-approved processing; return only bounded evidence. |
| Rust policy | Verifies required signals/checks are present and routes cases to review. | No image bytes or final decision authority. |

## Training and Evaluation Requirements

Do not train on customer evidence merely because it was submitted for verification. A model-development dataset must have a documented lawful basis, explicit data use purpose, provenance, retention/deletion schedule, access approval, and a documented jurisdiction/document-type scope. Where real counterfeit examples are restricted, use only appropriately licensed or regulator/issuer-authorized examples and keep them separate from production evidence.

Evaluation must split data by individual, issuing authority, and capture device to avoid leakage. Report false-accept, false-reject, calibration, and manual-review workload by document type, jurisdiction, image-quality band, and model version. Test copy/recapture, crop/recompression, text overlay, template substitution, barcode/MRZ conflict, screenshot, and metadata removal separately. Every high-risk model output must remain reviewable with its signals, model version, and evidence digest.

## Third-Party API Alternative

A third-party API can be acceptable only after a provider-specific adapter passes a security/privacy assessment. The adapter must use mTLS or authenticated HTTPS, request signing where supported, strict egress allowlisting, a 10-second bounded timeout, idempotency key, raw response SHA-256, provider reference, callback HMAC verification, retry/dead-letter behavior, and separate secrets per provider/environment. It must not silently fall back to an alternate provider or transform a provider error into `passed`.

Before transmitting personal or biometric data to a third party, obtain a documented processor agreement, data residency/transfer assessment, subprocessor list, retention/deletion commitment, breach-notification terms, and an approved DPIA. The Nigeria Data Protection Act covers processing by automated means, provides rules on lawful basis/consent, sensitive personal data, data privacy impact assessments, consent withdrawal, and automated decision making.[1] For EEA processing, the GDPR contains special-category and solely automated decision safeguards.[2]

## Deployment Gates

| Gate | Evidence required before enabling an ML model |
|---|---|
| Consent and disclosure | Versioned disclosure, documented purpose, explicit withdrawal path, and database evidence. |
| Security | Isolated namespace/service account, default-deny egress, KMS-backed secrets, malware scanning, encrypted object storage, and access audit. |
| Model governance | Model card, data provenance, test set, measured error rates, approval threshold, version rollback, drift monitoring, and incident runbook. |
| Provider contract | Sandbox test tenant, DPA, residency/transfer review, endpoint/HMAC/idempotency contract, and callback replay tests. |
| Human safeguards | Trained reviewers, dual-review rules for adverse outcomes, appeal/reconsideration path, and evidence retention/deletion policy. |

## Current Implementation Status

The local code implements bounded forensics and MRZ integrity checks, token-fenced jobs, a synthetic-only cross-language test, consent withdrawal, and manual-review-only results. It does **not** include a trained counterfeit-detection model, a selected third-party forensic provider, a production model registry, a real issuer template corpus, or certification that any document is authentic. Those require the deployment gates above.

## References

[1]: [Nigeria Data Protection Act, 2023 (Official Gazette)](https://cert.gov.ng/ngcert/resources/Nigeria_Data_Protection_Act_2023.pdf)
[2]: [Regulation (EU) 2016/679 — General Data Protection Regulation (EUR-Lex)](https://eur-lex.europa.eu/eli/reg/2016/679/oj/eng)
