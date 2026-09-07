# Cross-Language Stakeholder Verification Design

**Date:** 2026-09-07
**Status:** Implementation design for local synthetic validation. No production provider is configured.

## Decision Boundary

The platform will not use OCR text, a document VLM, or a liveness signal as a sole automated approval or rejection decision. Those processors produce immutable, versioned evidence and route the case to manual review. PostgreSQL is authoritative for consent, evidence hashes, provider-check state, human decisions, expiry, and downstream eligibility gating.

## Stakeholder and Check Matrix

| Subject | Required external or human-verifiable checks | Platform decision rule |
|---|---|---|
| Driver / vehicle-access worker | Identity document, active liveness challenge, driving licence, criminal-record screening, sanctions screening | A verified case is required before new driver offers; any unavailable/ambiguous signal requires manual review rather than automatic approval. |
| Vehicle asset | Vehicle registry and commercial insurance | A verified current asset case is required before an asset becomes available. |
| Technician | Identity, liveness, criminal-record, sanctions, credential | May be assigned only after a verified current case once the field-service enforcement adapter is enabled. |
| Merchant / fleet provider | Legal-entity/beneficial-owner evidence and sanctions screening | Provider activation is restricted to verified casework after the migration. |
| Operator | Identity, liveness, criminal-record, sanctions, recertification | Privileged recertification is retained as an operator-controlled case; it must be independently reviewed. |

## Authority and Language Boundaries

| Component | Language | Responsibility | Cannot do |
|---|---|---|---|
| Verification authority | PostgreSQL | Consent receipts, evidence digests, case/check state, append-only events, manual decision, expiry, eligibility query and policy enforcement | Fetch remote documents, call providers, run ML, or expose secrets |
| Orchestrator | Go | Claim durable jobs, make bounded internal HTTP calls, persist normalized processor/provider outputs, retry safe transient work | Decide legal eligibility or bypass database controls |
| Policy evaluator | Rust | Deterministically evaluate completeness and reason codes, returning `blocked`, `pending`, or `manual_review_required` | Make a final verification decision or write case state |
| Document/liveness processor | Python | Run PaddleOCR, Docling, optional provider-neutral VLM evaluation, validate input hash, assess challenge-artifact coherence | Authenticate an issuer, match a person by biometrics, or approve a stakeholder |
| Operations/API | TypeScript | Authenticated case/evidence/check/review actions; object metadata only; role and actor binding | Write protected verification tables directly |

## Processor Contract

The Python service accepts controlled document bytes or storage-backed retrieval delegated by a trusted object-store adapter. It verifies `sha256(document_bytes) == declared_sha256` before parsing. It returns structured extraction metadata, parser/model versions, output digest, and a `manual_review_required` finding. A production runtime uses pinned PaddleOCR 3.x and Docling versions; missing dependencies return an explicit unavailable status, never simulated output. A provider-neutral VLM adapter is disabled unless a configured private endpoint and key exist.

For liveness, the service evaluates signed active-challenge artifacts: server-generated nonce hash, challenge identifier, capture digest, monotonic frame count/time bounds, distinct frame hashes, and device-attestation reference. The output is `liveness_artifact_complete` or a review/error reason. It does not identify people or use face similarity as a final decision.

## Provider Adapter Contract

Every external provider adapter must be selected by `provider_key`, declared supported check types, use a provider-specific sandbox contract, require a case consent receipt, use an idempotency key, verify callbacks/signatures, persist the vendor reference and a digest of the normalized response, and map its result to `passed`, `failed`, `manual_review`, `unavailable`, or `expired`. The local simulator implements the same schema but has a synthetic-only allowlist and is prohibited from real hostnames.

## Deployment Options

| Approach | Trade-offs | Cost | Setup complexity |
|---|---|---|---|
| Managed application workers plus provider sandbox adapters | Simplest platform operations; bounded HTTP workloads and DB-backed queues | Managed-runtime usage and provider sandbox costs | Moderate |
| Dedicated self-hosted document-processing service with PaddleOCR/Docling | Supports local processing and controlled document residency; requires native/model dependencies and capacity operations | Compute/storage and operational support | Higher |

The local code includes the service contracts and simulation. A production selection needs a jurisdiction, expected document volume, residency requirements, processor hardware profile, selected screening vendors, and sandbox credentials.

## References

[1] [PaddleOCR official documentation](https://www.paddleocr.ai/main/en/index.html) describes the current 3.x OCR/document-parsing capabilities and notes the 3.x interface change.

[2] [Docling official documentation](https://docling-project.github.io/docling/) describes local document conversion, OCR engines, VLM options, and API-service deployment.
